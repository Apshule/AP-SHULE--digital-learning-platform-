import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { verifyFirebaseCaller, type FirebaseCaller } from "../lib/firebase-auth";
import { getFirebaseAdminToken } from "../lib/firebase-admin-token";

const router = Router();
const project = process.env["FIREBASE_PROJECT_ID"] ?? "apshule-app";
const firestoreBase =
  `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;

type FirestoreField = Record<string, unknown>;
type FirestoreDocument = {
  name?: string;
  fields?: Record<string, FirestoreField>;
};

type SkillCourse = {
  id: string;
  title: string;
  description: string;
  duration: string;
  feeUgx: number;
  featured: boolean;
};

type Provider = {
  id: string;
  name: string;
  description: string;
  badgeUrl: string;
  logoUrl: string;
  physicalAddress: string;
  contactEmail: string;
  contactPhone: string;
  referralCode: string;
  status: "pending" | "active" | "suspended";
  courses: SkillCourse[];
  rating: number;
  reviewCount: number;
  createdAt: string;
  updatedAt: string;
};

function firestoreValue(value: unknown): FirestoreField {
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number" && Number.isInteger(value)) {
    return { integerValue: String(value) };
  }
  if (typeof value === "number") return { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(firestoreValue) } };
  if (value && typeof value === "object") {
    return {
      mapValue: {
        fields: Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, firestoreValue(item)]),
        ),
      },
    };
  }
  return { stringValue: String(value ?? "") };
}

function firestoreFields(data: Record<string, unknown>): string {
  return JSON.stringify({
    fields: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, firestoreValue(value)])),
  });
}

function decodeValue(field: FirestoreField | undefined): unknown {
  if (!field) return undefined;
  if ("stringValue" in field) return field.stringValue;
  if ("booleanValue" in field) return field.booleanValue;
  if ("integerValue" in field) return Number(field.integerValue);
  if ("doubleValue" in field) return field.doubleValue;
  if ("timestampValue" in field) return field.timestampValue;
  if ("arrayValue" in field) {
    const values = (field.arrayValue as { values?: FirestoreField[] } | undefined)?.values ?? [];
    return values.map(decodeValue);
  }
  if ("mapValue" in field) {
    const fields = (field.mapValue as { fields?: Record<string, FirestoreField> } | undefined)?.fields ?? {};
    return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeValue(value)]));
  }
  return undefined;
}

function documentData(document: FirestoreDocument): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(document.fields ?? {}).map(([key, value]) => [key, decodeValue(value)]),
  );
}

function documentId(document: FirestoreDocument): string {
  return document.name?.split("/documents/")[1]?.split("/").pop() ?? "";
}

async function firestoreRequest(
  path: string,
  options: RequestInit = {},
  callerToken?: string,
): Promise<unknown> {
  const token = (await getFirebaseAdminToken()) ?? callerToken;
  if (!token) throw new Error("Firebase server credentials are not configured");
  const response = await fetch(`${firestoreBase}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Firestore request failed (${response.status}): ${body.slice(0, 300)}`);
  }
  return body ? JSON.parse(body) : {};
}

function cleanText(value: unknown, maxLength = 500): string {
  return String(value ?? "").trim().slice(0, maxLength);
}

function cleanCourses(value: unknown): SkillCourse[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 40)
    .map((course, index) => {
      const row = course && typeof course === "object" ? course as Record<string, unknown> : {};
      return {
        id: cleanText(row.id || `course-${index + 1}`, 80).toLowerCase().replace(/[^a-z0-9-]+/g, "-"),
        title: cleanText(row.title, 120),
        description: cleanText(row.description, 500),
        duration: cleanText(row.duration, 80),
        feeUgx: Math.max(0, Math.min(100_000_000, Math.floor(Number(row.feeUgx) || 0))),
        featured: row.featured === true,
      };
    })
    .filter((course) => course.title);
}

function providerView(id: string, data: Record<string, unknown>): Provider {
  const status = String(data.status ?? "pending");
  return {
    id,
    name: cleanText(data.name, 160),
    description: cleanText(data.description, 800),
    badgeUrl: cleanText(data.badgeUrl, 1000),
    logoUrl: cleanText(data.logoUrl, 1000),
    physicalAddress: cleanText(data.physicalAddress, 240),
    contactEmail: cleanText(data.contactEmail, 160),
    contactPhone: cleanText(data.contactPhone, 80),
    referralCode: cleanText(data.referralCode, 120),
    status: status === "active" || status === "suspended" ? status : "pending",
    courses: cleanCourses(data.courses),
    rating: Math.max(0, Math.min(5, Number(data.rating) || 0)),
    reviewCount: Math.max(0, Math.floor(Number(data.reviewCount) || 0)),
    createdAt: cleanText(data.createdAt, 80),
    updatedAt: cleanText(data.updatedAt, 80),
  };
}

async function requireSuperAdmin(req: Request, res: Response): Promise<FirebaseCaller | null> {
  const caller = await verifyFirebaseCaller(req.headers.authorization);
  if (!("uid" in caller)) {
    res.status(caller.status).json({ ok: false, error: caller.reason });
    return null;
  }
  if (caller.role !== "superadmin") {
    res.status(403).json({ ok: false, error: "Only Super Admins can manage vocational providers" });
    return null;
  }
  return caller;
}

function providerCode(name: string, address: string): string {
  const first = `${name}-${address}`
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 4)
    .join("-");
  return first || `PROVIDER-${randomUUID().slice(0, 8).toUpperCase()}`;
}

async function readProviders(callerToken: string): Promise<Provider[]> {
  const response = await firestoreRequest("/providers?pageSize=500", {}, callerToken) as {
    documents?: FirestoreDocument[];
  };
  return (response.documents ?? [])
    .map((document) => providerView(documentId(document), documentData(document)))
    .filter((provider) => provider.id);
}

router.get("/skills/admin/providers", async (req, res) => {
  const caller = await requireSuperAdmin(req, res);
  if (!caller) return;
  try {
    res.json({ ok: true, providers: await readProviders(caller.token) });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "Unable to load providers" });
  }
});

router.post("/skills/admin/providers", async (req, res) => {
  const caller = await requireSuperAdmin(req, res);
  if (!caller) return;
  const name = cleanText(req.body?.name, 160);
  if (!name) {
    res.status(400).json({ ok: false, error: "Provider name is required" });
    return;
  }

  try {
    const existing = await readProviders(caller.token);
    const baseCode = providerCode(name, cleanText(req.body?.physicalAddress, 120));
    const referralCode = existing.some((provider) => provider.referralCode === baseCode)
      ? `${baseCode}-${randomUUID().slice(0, 4).toUpperCase()}`
      : baseCode;
    const id = `provider_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const now = new Date().toISOString();
    const provider = {
      name,
      description: cleanText(req.body?.description, 800),
      badgeUrl: cleanText(req.body?.badgeUrl, 1000),
      logoUrl: cleanText(req.body?.logoUrl, 1000),
      physicalAddress: cleanText(req.body?.physicalAddress, 240),
      contactEmail: cleanText(req.body?.contactEmail, 160),
      contactPhone: cleanText(req.body?.contactPhone, 80),
      referralCode,
      status: "pending",
      courses: cleanCourses(req.body?.courses),
      rating: 0,
      reviewCount: 0,
      createdAt: now,
      updatedAt: now,
      createdBy: caller.uid,
    };
    await firestoreRequest(`/providers/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: firestoreFields(provider),
    }, caller.token);
    res.status(201).json({ ok: true, provider: providerView(id, provider) });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "Unable to create provider" });
  }
});

router.post("/skills/admin/provider-status", async (req, res) => {
  const caller = await requireSuperAdmin(req, res);
  if (!caller) return;
  const providerId = cleanText(req.body?.providerId, 120);
  const status = cleanText(req.body?.status, 20);
  if (!providerId || !["pending", "active", "suspended"].includes(status)) {
    res.status(400).json({ ok: false, error: "A provider and valid status are required" });
    return;
  }

  try {
    const updatedAt = new Date().toISOString();
    await firestoreRequest(`/providers/${encodeURIComponent(providerId)}`, {
      method: "PATCH",
      body: firestoreFields({
        status,
        updatedAt,
        reviewedAt: updatedAt,
        reviewedBy: caller.uid,
      }),
    }, caller.token);
    res.json({ ok: true, providerId, status, updatedAt });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "Unable to update provider status" });
  }
});

router.get("/skills/admin/enrollments", async (req, res) => {
  const caller = await requireSuperAdmin(req, res);
  if (!caller) return;
  try {
    const response = await firestoreRequest("/skills_enrollments?pageSize=1000", {}, caller.token) as {
      documents?: FirestoreDocument[];
    };
    const enrollments = (response.documents ?? []).map((document) => ({
      id: documentId(document),
      ...documentData(document),
    }));
    res.json({ ok: true, enrollments });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "Unable to load enrollments" });
  }
});

router.post("/skills/enrollments", async (req, res) => {
  const caller = await verifyFirebaseCaller(req.headers.authorization);
  if (!("uid" in caller)) {
    res.status(caller.status).json({ ok: false, error: caller.reason });
    return;
  }
  const providerId = cleanText(req.body?.providerId, 120);
  const referralCode = cleanText(req.body?.referralCode, 120);
  const courseId = cleanText(req.body?.courseId, 80);
  if (!providerId || !referralCode || !courseId) {
    res.status(400).json({ ok: false, error: "Provider, referral code, and course are required" });
    return;
  }

  try {
    const providerResponse = await firestoreRequest(`/providers/${encodeURIComponent(providerId)}`, {}, caller.token) as FirestoreDocument;
    const provider = providerView(providerId, documentData(providerResponse));
    const course = provider.courses.find((item) => item.id === courseId);
    if (provider.status !== "active" || provider.referralCode !== referralCode || !course) {
      res.status(400).json({ ok: false, error: "That provider course link is no longer active" });
      return;
    }
    const id = `enrollment_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const createdAt = new Date().toISOString();
    const enrollment = {
      studentId: caller.uid,
      providerId,
      providerName: provider.name,
      referralCode: provider.referralCode,
      courseId: course.id,
      courseTitle: course.title,
      amountUgx: course.feeUgx,
      status: "pending",
      createdAt,
    };
    await firestoreRequest(`/skills_enrollments/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: firestoreFields(enrollment),
    }, caller.token);
    res.status(201).json({ ok: true, enrollment: { id, ...enrollment } });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "Unable to save enrollment" });
  }
});

export default router;