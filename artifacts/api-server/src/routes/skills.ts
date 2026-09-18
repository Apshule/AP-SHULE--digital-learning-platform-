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
  category: string;
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
  verificationStatus: "unverified" | "pending_topup" | "verified";
  ownerId: string;
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
        category: cleanText(row.category, 80) || "General skills",
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
    verificationStatus:
      data.verificationStatus === "verified" || data.verificationStatus === "pending_topup"
        ? data.verificationStatus
        : status === "active"
          ? "verified"
          : "unverified",
    ownerId: cleanText(data.ownerId, 120),
    courses: cleanCourses(data.courses),
    rating: Math.max(0, Math.min(5, Number(data.rating) || 0)),
    reviewCount: Math.max(0, Math.floor(Number(data.reviewCount) || 0)),
    createdAt: cleanText(data.createdAt, 80),
    updatedAt: cleanText(data.updatedAt, 80),
  };
}

function publicProvider(provider: Provider): Omit<Provider, "ownerId"> {
  const { ownerId: _ownerId, ...safeProvider } = provider;
  return safeProvider;
}

function providerManifestLogo(provider: Provider): { src: string; type: string } {
  const rawLogo = provider.logoUrl.trim();
  const src = !rawLogo
    ? "/icons/icon-192.png"
    : /^https?:\/\//i.test(rawLogo) || rawLogo.startsWith("/")
      ? rawLogo
      : `/skills/${rawLogo.replace(/^\.?\//, "")}`;
  const extension = src.match(/\.([a-z0-9]+)(?:[?#].*)?$/i)?.[1]?.toLowerCase();
  const type = extension === "jpg" || extension === "jpeg"
    ? "image/jpeg"
    : extension === "webp"
      ? "image/webp"
      : extension === "svg"
        ? "image/svg+xml"
        : "image/png";
  return { src, type };
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

async function requireSignedIn(req: Request, res: Response): Promise<FirebaseCaller | null> {
  const caller = await verifyFirebaseCaller(req.headers.authorization);
  if (!("uid" in caller)) {
    res.status(caller.status).json({ ok: false, error: caller.reason });
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

function firestoreUpdateMask(fields: string[]): string {
  return fields
    .map((field) => `updateMask.fieldPaths=${encodeURIComponent(field)}`)
    .join("&");
}

async function readProvider(
  providerId: string,
  callerToken: string,
): Promise<Record<string, unknown>> {
  const document = await firestoreRequest(
    `/providers/${encodeURIComponent(providerId)}`,
    {},
    callerToken,
  ) as FirestoreDocument;
  return documentData(document);
}

async function writeEnrollment(
  caller: FirebaseCaller,
  providerId: string,
  referralCode: string,
  courseId: string,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const provider = providerView(providerId, await readProvider(providerId, caller.token));
  const course = provider.courses.find((item) => item.id === courseId);
  if (
    provider.status !== "active" ||
    provider.referralCode !== referralCode ||
    !course
  ) {
    throw new Error("That provider course link is no longer active");
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
    courseCategory: course.category,
    amountUgx: course.feeUgx,
    status: "pending",
    createdAt,
    ...extra,
  };
  await firestoreRequest(
    `/skills_enrollments/${encodeURIComponent(id)}`,
    { method: "PATCH", body: firestoreFields(enrollment) },
    caller.token,
  );
  return { id, ...enrollment };
}

async function readProviders(callerToken: string): Promise<Provider[]> {
  const response = await firestoreRequest("/providers?pageSize=500", {}, callerToken) as {
    documents?: FirestoreDocument[];
  };
  return (response.documents ?? [])
    .map((document) => providerView(documentId(document), documentData(document)))
    .filter((provider) => provider.id);
}

router.get("/skills/providers", async (_req, res) => {
  try {
    const providers = await readProviders("");
    res.json({
      ok: true,
      providers: providers
        .filter((provider) => provider.status === "active")
        .map(publicProvider),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : "Unable to load public providers",
    });
  }
});

router.get("/skills/providers/:providerId/manifest.json", async (req, res) => {
  const providerId = cleanText(req.params.providerId, 120);
  if (!providerId) {
    res.status(400).json({ ok: false, error: "Provider ID is required" });
    return;
  }
  try {
    const provider = providerView(providerId, await readProvider(providerId, ""));
    const logo = providerManifestLogo(provider);
    const startUrl = cleanText(req.query.startUrl, 200) === "/obote"
      ? "/obote"
      : "/skills/provider-register.html";
    res.setHeader("Cache-Control", "no-store");
    res.json({
      name: `${provider.name || "Provider"} | APSHULE Skills`,
      short_name: (provider.name || "Provider").slice(0, 24),
      id: startUrl,
      start_url: startUrl,
      scope: "/",
      display: "standalone",
      orientation: "any",
      theme_color: "#54284d",
      background_color: "#f4ede2",
      lang: "en",
      categories: ["education", "business"],
      icons: [
        { ...logo, sizes: "any", purpose: "any" },
        { ...logo, sizes: "any", purpose: "maskable" },
      ],
    });
  } catch (error) {
    res.status(404).json({
      ok: false,
      error: error instanceof Error ? error.message : "Provider manifest is not available",
    });
  }
});

router.get("/skills/providers/mine", async (req, res) => {
  const caller = await requireSignedIn(req, res);
  if (!caller) return;
  try {
    const providers = await readProviders(caller.token);
    res.json({
      ok: true,
      providers: providers
        .filter((provider) => provider.ownerId === caller.uid)
        .map(publicProvider),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : "Unable to load your provider profile",
    });
  }
});

router.get("/skills/providers/:providerId", async (req, res) => {
  const providerId = cleanText(req.params.providerId, 120);
  if (!providerId) {
    res.status(400).json({ ok: false, error: "Provider ID is required" });
    return;
  }
  try {
    const provider = providerView(providerId, await readProvider(providerId, ""));
    if (provider.status !== "active") {
      res.status(404).json({ ok: false, error: "Provider profile is not available" });
      return;
    }
    res.json({ ok: true, provider: publicProvider(provider) });
  } catch (error) {
    res.status(404).json({
      ok: false,
      error: error instanceof Error ? error.message : "Provider profile is not available",
    });
  }
});

router.post("/skills/providers/register", async (req, res) => {
  const caller = await requireSignedIn(req, res);
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
      verificationStatus: "unverified",
      ownerId: caller.uid,
      topupStatus: "not_paid",
      topupAmountUgx: 20_000,
      courses: cleanCourses(req.body?.courses),
      rating: 0,
      reviewCount: 0,
      createdAt: now,
      updatedAt: now,
      createdBy: caller.uid,
    };
    await firestoreRequest(
      `/providers/${encodeURIComponent(id)}`,
      { method: "PATCH", body: firestoreFields(provider) },
      caller.token,
    );
    res.status(201).json({
      ok: true,
      provider: providerView(id, provider),
      topupAmountUgx: 20_000,
      verificationStatus: "unverified",
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : "Unable to register provider",
    });
  }
});

router.post("/skills/provider/topup", async (req, res) => {
  const caller = await requireSignedIn(req, res);
  if (!caller) return;
  const providerId = cleanText(req.body?.providerId, 120);
  if (!providerId) {
    res.status(400).json({ ok: false, error: "Provider ID is required" });
    return;
  }

  try {
    const provider = await readProvider(providerId, caller.token);
    if (provider.ownerId !== caller.uid) {
      res.status(403).json({ ok: false, error: "You can only top up your own provider profile" });
      return;
    }
    const now = new Date().toISOString();
    const topupReference = `SKILL-TOPUP-${randomUUID().replace(/-/g, "").slice(0, 14).toUpperCase()}`;
    await firestoreRequest(
      `/providers/${encodeURIComponent(providerId)}?${firestoreUpdateMask([
        "verificationStatus",
        "topupStatus",
        "topupAmountUgx",
        "topupReference",
        "topupConfirmedAt",
        "updatedAt",
      ])}`,
      {
        method: "PATCH",
        body: firestoreFields({
          verificationStatus: "pending_topup",
          topupStatus: "simulated_confirmed",
          topupAmountUgx: 20_000,
          topupReference,
          topupConfirmedAt: now,
          updatedAt: now,
        }),
      },
      caller.token,
    );
    res.json({
      ok: true,
      providerId,
      verificationStatus: "pending_topup",
      topupStatus: "simulated_confirmed",
      amountUgx: 20_000,
      topupReference,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : "Unable to confirm provider top-up",
    });
  }
});

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
    const provider = await readProvider(providerId, caller.token);
    const canApprove =
      provider.verificationStatus === undefined ||
      provider.verificationStatus === "verified" ||
      provider.verificationStatus === "pending_topup";
    if (
      status === "active" &&
      !canApprove
    ) {
      res.status(409).json({
        ok: false,
        error: "Provider top-up verification must be confirmed before approval",
      });
      return;
    }
    const updatedAt = new Date().toISOString();
    const updateMask = ["status", "updatedAt", "reviewedAt", "reviewedBy"];
    const updateFields: Record<string, unknown> = {
      status,
      updatedAt,
      reviewedAt: updatedAt,
      reviewedBy: caller.uid,
    };
    if (status === "active" && provider.verificationStatus === "pending_topup") {
      updateMask.push("verificationStatus");
      updateFields.verificationStatus = "verified";
    }
    await firestoreRequest(
      `/providers/${encodeURIComponent(providerId)}?${firestoreUpdateMask(updateMask)}`,
      {
        method: "PATCH",
        body: firestoreFields(updateFields),
      },
      caller.token,
    );
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
  const caller = await requireSignedIn(req, res);
  if (!caller) return;
  const providerId = cleanText(req.body?.providerId, 120);
  const referralCode = cleanText(req.body?.referralCode, 120);
  const courseId = cleanText(req.body?.courseId, 80);
  if (!providerId || !referralCode || !courseId) {
    res.status(400).json({ ok: false, error: "Provider, referral code, and course are required" });
    return;
  }

  try {
    const enrollment = await writeEnrollment(caller, providerId, referralCode, courseId);
    res.status(201).json({ ok: true, enrollment });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "Unable to save enrollment" });
  }
});

router.post("/skills/admissions/payment", async (req, res) => {
  const caller = await requireSignedIn(req, res);
  if (!caller) return;
  const amountUgx = Math.floor(Number(req.body?.amountUgx));
  if (amountUgx !== 20_000) {
    res.status(400).json({ ok: false, error: "The vocational admission fee is UGX 20,000" });
    return;
  }

  try {
    const paymentId = `admission_payment_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const createdAt = new Date().toISOString();
    const paymentReference = `SKILL-ADMISSION-${randomUUID().replace(/-/g, "").slice(0, 14).toUpperCase()}`;
    await firestoreRequest(
      `/skills_admission_payments/${encodeURIComponent(paymentId)}`,
      {
        method: "PATCH",
        body: firestoreFields({
          studentId: caller.uid,
          amountUgx,
          status: "confirmed",
          paymentReference,
          createdAt,
        }),
      },
      caller.token,
    );
    res.status(201).json({ ok: true, paymentReference, amountUgx, status: "confirmed" });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : "Unable to confirm admission payment",
    });
  }
});

router.post("/skills/admissions", async (req, res) => {
  const caller = await requireSignedIn(req, res);
  if (!caller) return;
  const providerId = cleanText(req.body?.providerId, 120);
  const referralCode = cleanText(req.body?.referralCode, 120);
  const courseId = cleanText(req.body?.courseId, 80);
  const fullName = cleanText(req.body?.fullName, 160);
  const phone = cleanText(req.body?.phone, 80);
  const email = cleanText(req.body?.email, 160);
  const educationLevel = cleanText(req.body?.educationLevel, 80);
  const previousExperience = cleanText(req.body?.previousExperience, 1200);
  const paymentReference = cleanText(req.body?.paymentReference, 120);
  if (
    !providerId ||
    !referralCode ||
    !courseId ||
    !fullName ||
    !phone ||
    !email ||
    !educationLevel ||
    !paymentReference
  ) {
    res.status(400).json({
      ok: false,
      error: "Complete the admission form and confirm the UGX 20,000 fee",
    });
    return;
  }

  try {
    const paymentQuery = await firestoreRequest(
      "/skills_admission_payments?pageSize=1000",
      {},
      caller.token,
    ) as { documents?: FirestoreDocument[] };
    const payment = (paymentQuery.documents ?? [])
      .map((document) => documentData(document))
      .find((item) => item.paymentReference === paymentReference);
    if (!payment || payment.studentId !== caller.uid || payment.status !== "confirmed") {
      res.status(400).json({
        ok: false,
        error: "Confirm the admission fee before submitting your application",
      });
      return;
    }

    const enrollment = await writeEnrollment(
      caller,
      providerId,
      referralCode,
      courseId,
      {
        fullName,
        phone,
        email,
        educationLevel,
        previousExperience,
        admissionFeeUgx: 20_000,
        admissionPaymentReference: paymentReference,
        admissionPaymentStatus: "confirmed",
        applicationType: "vocational_admission",
      },
    );
    res.status(201).json({ ok: true, enrollment });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : "Unable to submit vocational admission",
    });
  }
});

export default router;