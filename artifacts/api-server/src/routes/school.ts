import { Router } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { logger } from "../lib/logger";
import { getFirebaseAdminToken } from "../lib/firebase-admin-token";

const router = Router();

const FIREBASE_PROJECT_ID = process.env["FIREBASE_PROJECT_ID"] ?? "apshule-app";

const JWKS = createRemoteJWKSet(
  new URL(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
  ),
);

/**
 * Verifies the caller's Firebase ID token and confirms they are a school account.
 * Returns { uid, schoolId } on success, or null on failure.
 */
async function verifySchoolCaller(
  authHeader: string | undefined,
): Promise<{ uid: string; role: string; schoolId: string; institutionId?: string } | null> {
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
  if (!token) return null;

  let uid: string;
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
      audience: FIREBASE_PROJECT_ID,
    });
    uid = (payload["user_id"] as string) ?? "";
    if (!uid) return null;
  } catch {
    return null;
  }

  try {
    const url =
      `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}` +
      `/databases/(default)/documents/users/${uid}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) return null;
    const docData = (await resp.json()) as {
      fields?: {
        role?: { stringValue?: string };
        schoolId?: { stringValue?: string };
        institutionId?: { stringValue?: string };
      };
    };
    const role = docData.fields?.role?.stringValue;
    if (!["school", "school_admin", "headteacher", "bursar"].includes(String(role))) return null;
    const schoolId = docData.fields?.schoolId?.stringValue ?? docData.fields?.institutionId?.stringValue;
    if (!schoolId) return null;
    return { uid, role: String(role), schoolId, institutionId: docData.fields?.institutionId?.stringValue };
  } catch {
    return null;
  }
}

type FirestoreField = {
  stringValue?: string;
  integerValue?: string;
  doubleValue?: number;
  booleanValue?: boolean;
  timestampValue?: string;
  referenceValue?: string;
  arrayValue?: { values?: FirestoreField[] };
  mapValue?: { fields?: Record<string, FirestoreField> };
};

function firestoreValue(field: FirestoreField | undefined): unknown {
  if (!field) return undefined;
  if (field.stringValue !== undefined) return field.stringValue;
  if (field.integerValue !== undefined) return Number(field.integerValue);
  if (field.doubleValue !== undefined) return field.doubleValue;
  if (field.booleanValue !== undefined) return field.booleanValue;
  if (field.timestampValue !== undefined) return field.timestampValue;
  if (field.referenceValue !== undefined) return field.referenceValue;
  if (field.arrayValue) return (field.arrayValue.values ?? []).map(firestoreValue);
  if (field.mapValue) {
    return Object.fromEntries(
      Object.entries(field.mapValue.fields ?? {}).map(([key, value]) => [key, firestoreValue(value)]),
    );
  }
  return null;
}

type FirestoreDocument = {
  name?: string;
  fields?: Record<string, FirestoreField>;
};

function documentId(document: FirestoreDocument): string {
  return String(document.name?.split("/").pop() ?? "");
}

function documentData(document: FirestoreDocument): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(document.fields ?? {}).map(([key, value]) => [key, firestoreValue(value)]),
  );
}

function safeRecord(data: Record<string, unknown>, id: string): Record<string, unknown> {
  const blocked = /password|secret|token|credential|privatekey|apiKey/i;
  return {
    id,
    ...Object.fromEntries(
      Object.entries(data).filter(([key, value]) => !blocked.test(key) && typeof value !== "function"),
    ),
  };
}

function belongsToSchool(data: Record<string, unknown>, schoolIds: Set<string>): boolean {
  return ["schoolId", "institutionId", "school", "schoolRef", "institution", "institutionRef"].some((key) => {
    const value = data[key];
    return typeof value === "string" && schoolIds.has(value);
  });
}

async function firestoreGet(
  path: string,
  token: string,
): Promise<FirestoreDocument | null> {
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) return null;
  return (await response.json()) as FirestoreDocument;
}

async function firestoreList(
  collection: string,
  token: string,
): Promise<FirestoreDocument[]> {
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}` +
      `/databases/(default)/documents/${collection}?pageSize=500`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) return [];
  const payload = (await response.json()) as { documents?: FirestoreDocument[] };
  return payload.documents ?? [];
}

function educationLevel(data: Record<string, unknown>): "primary" | "secondary" | "unknown" {
  const value = String(
    data.educationLevel ?? data.schoolLevel ?? data.level ?? data.classLevel ??
    data.className ?? data.class ?? data.section ?? "",
  ).toLowerCase();
  if (/(secondary|o[- ]?level|a[- ]?level|^s[1-6]\b|^f[1-6]\b)/i.test(value)) return "secondary";
  if (/(primary|nursery|^p[1-7]\b|^baby\b|^top\b|^middle\b)/i.test(value)) return "primary";
  return "unknown";
}

function learnerRecord(data: Record<string, unknown>, id: string) {
  return safeRecord({
    name: data.name ?? data.displayName ?? "",
    admissionNumber: data.admissionNumber ?? data.admissionNo ?? data.studentNumber ?? "",
    className: data.className ?? data.class ?? data.classLevel ?? data.level ?? "",
    stream: data.stream ?? data.section ?? "",
    status: data.status ?? "active",
    gender: data.gender ?? "",
    educationLevel: educationLevel(data),
  }, id);
}

function financialRecord(data: Record<string, unknown>, id: string) {
  return safeRecord({
    reference: data.reference ?? data.paymentReference ?? "",
    billReference: data.billReference ?? data.billId ?? id,
    clientName: data.clientName ?? data.studentName ?? data.payerName ?? "",
    amountPaid: Number(data.amountPaid ?? data.paidAmount ?? data.amount ?? 0),
    totalAmount: Number(data.totalAmount ?? data.billTotal ?? data.amount ?? 0),
    balanceRemaining: Number(data.balanceRemaining ?? data.balanceAmount ?? Math.max(
      0,
      Number(data.totalAmount ?? data.billTotal ?? data.amount ?? 0) -
      Number(data.amountPaid ?? data.paidAmount ?? 0),
    )),
    status: data.status ?? data.paymentStatus ?? "unpaid",
    paymentDate: data.paymentDate ?? data.createdAt ?? "",
    dueDate: data.dueDate ?? "",
  }, id);
}

function numberValue(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

async function bursarRecords(
  schoolIds: Set<string>,
  adminToken: string,
) {
  const [paymentDocuments, feeDocuments, billDocuments] = await Promise.all([
    firestoreList("payment_transactions", adminToken),
    firestoreList("school_fees", adminToken),
    firestoreList("school_bills", adminToken),
  ]);
  const scopedPayments = paymentDocuments
    .map((item) => ({ id: documentId(item), data: documentData(item) }))
    .filter(({ data }) => belongsToSchool(data, schoolIds))
    .map(({ id, data }) => financialRecord(data, id));
  const scopedFees = [...feeDocuments, ...billDocuments]
    .map((item) => ({ id: documentId(item), data: documentData(item) }))
    .filter(({ data }) => belongsToSchool(data, schoolIds))
    .map(({ id, data }) => financialRecord(data, id));
  const accountsByReference = new Map(scopedFees.map((row) => [String(row.billReference ?? row.id), row]));
  const accounts = [...accountsByReference.values()];
  const totalDue = accounts.reduce((sum, row) => sum + numberValue(row.totalAmount), 0);
  const totalPaid = accounts.reduce((sum, row) => sum + numberValue(row.amountPaid), 0);
  const paymentTotal = scopedPayments.reduce((sum, row) => sum + numberValue(row.amountPaid), 0);
  return {
    summary: {
      accountCount: accounts.length,
      totalDue,
      totalPaid,
      outstandingBalance: Math.max(0, totalDue - totalPaid),
      paymentCount: scopedPayments.length,
      paymentTotal,
      pendingPayments: scopedPayments.filter((row) => ["pending", "processing"].includes(String(row.status).toLowerCase())).length,
    },
    accounts: accounts.slice(0, 500),
    payments: scopedPayments.slice(0, 500),
  };
}

/**
 * GET /api/school/education-workspace
 *
 * Read-only Education workspace bootstrap. The server verifies the Firebase
 * school role, resolves the linked school/institution, and returns only
 * records belonging to that school. Legacy school documents are sanitized so
 * loginPassword and other credentials never leave the server.
 */
router.get("/school/education-workspace", async (req, res) => {
  const caller = await verifySchoolCaller(req.headers["authorization"]);
  if (!caller) {
    res.status(401).json({ ok: false, error: "Unauthorized — school account required" });
    return;
  }

  const adminToken = await getFirebaseAdminToken();
  if (!adminToken) {
    res.status(503).json({ ok: false, error: "Education records are temporarily unavailable" });
    return;
  }

  try {
    const [directSchool, allSchools, allUsers, classes, subjects] = await Promise.all([
      firestoreGet(`schools/${encodeURIComponent(caller.schoolId)}`, adminToken),
      firestoreList("schools", adminToken),
      firestoreList("users", adminToken),
      firestoreList("school_classes", adminToken),
      firestoreList("school_subjects", adminToken),
    ]);
    const schoolDocument = directSchool ?? allSchools.find((item) => {
      const data = documentData(item);
      return item.name?.endsWith(`/${caller.schoolId}`) ||
        data.institutionId === caller.schoolId ||
        data.schoolId === caller.schoolId;
    });
    if (!schoolDocument) {
      res.status(404).json({ ok: false, error: "No authorized school profile was found" });
      return;
    }

    const school = documentData(schoolDocument);
    const resolvedSchoolId = documentId(schoolDocument) || caller.schoolId;
    const schoolIds = new Set([caller.schoolId, resolvedSchoolId]);
    for (const value of [caller.institutionId, school.institutionId, school.schoolId]) {
      if (typeof value === "string" && value) schoolIds.add(value);
    }
    const attendanceDocuments = await Promise.all(
      [...schoolIds].map((id) => firestoreList(`attendanceEvents/${encodeURIComponent(id)}/records`, adminToken)),
    );
    const attendance = [...new Map(
      attendanceDocuments.flat().map((item) => [item.name ?? documentId(item), item]),
    ).values()];

    const linkedUsers = allUsers
      .map((item) => ({ id: documentId(item), data: documentData(item) }))
      .filter(({ data }) => belongsToSchool(data, schoolIds));
    const learners = linkedUsers
      .filter(({ data }) => ["individual", "student"].includes(String(data.role ?? "").toLowerCase()))
      .map(({ id, data }) => learnerRecord(data, id));
    const staff = linkedUsers
      .filter(({ data }) => ["school", "school_admin", "headteacher", "teacher"].includes(String(data.role ?? "").toLowerCase()))
      .map(({ id, data }) => safeRecord({
        name: data.name ?? data.displayName ?? "",
        role: data.role ?? "",
        subjects: data.subjectsTaught ?? data.subjects ?? "",
      }, id));
    const scopedClasses = classes
      .map((item) => ({ id: documentId(item), data: documentData(item) }))
      .filter(({ data }) => belongsToSchool(data, schoolIds))
      .map(({ id, data }) => safeRecord(data, id));
    const scopedSubjects = subjects
      .map((item) => ({ id: documentId(item), data: documentData(item) }))
      .filter(({ data }) => belongsToSchool(data, schoolIds))
      .map(({ id, data }) => safeRecord(data, id));

    const levels = new Set<string>();
    const schoolLevel = educationLevel(school);
    if (schoolLevel !== "unknown") levels.add(schoolLevel);
    for (const row of [...learners, ...scopedClasses]) {
      const level = educationLevel(row);
      if (level !== "unknown") levels.add(level);
    }
    const account = levels.size > 1 ? "both" : levels.has("secondary") ? "secondary" : "primary";
    const safeSchool = safeRecord({
      name: school.name ?? school.schoolName ?? "Authorized school",
      contact: school.contact ?? school.phone ?? "",
      location: school.location ?? school.address ?? "",
      logo: school.logo ?? "",
      educationLevel: school.educationLevel ?? school.schoolLevel ?? school.level ?? account,
      status: school.status ?? "active",
    }, resolvedSchoolId);

    const bursar = caller.role === "bursar" ? await bursarRecords(schoolIds, adminToken) : null;
    res.json({
      ok: true,
      live: true,
      account: caller.role === "bursar" ? "primary" : account,
      workspace: caller.role === "bursar" ? "bursar" : "education",
      role: caller.role,
      school: safeSchool,
      learners,
      staff,
      classes: scopedClasses,
      subjects: scopedSubjects,
      attendance: attendance.map((item) => safeRecord(documentData(item), documentId(item))),
      reports: [],
      marks: [],
      bursar,
    });
  } catch (err) {
    logger.warn({ err, schoolId: caller.schoolId }, "Education workspace read failed");
    res.status(502).json({ ok: false, error: "Unable to load authorized school records" });
  }
});

/**
 * POST /api/school/create-student
 * Authorization: Bearer <school admin Firebase ID token>
 * Body: { name: string, email: string, password: string }
 *
 * Creates a Firebase Auth user and a Firestore user doc linked to the caller's school.
 * Uses the service-account token so the school admin's own session is unaffected.
 */
router.post("/school/create-student", async (req, res) => {
  const caller = await verifySchoolCaller(req.headers["authorization"]);
  if (!caller) {
    res.status(401).json({ ok: false, error: "Unauthorized — school account required" });
    return;
  }

  const { name, email, password } = req.body as {
    name?: string;
    email?: string;
    password?: string;
  };

  if (!name || !email || !password) {
    res.status(400).json({ ok: false, error: "name, email and password are required" });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ ok: false, error: "Password must be at least 6 characters" });
    return;
  }

  const adminToken = await getFirebaseAdminToken();
  if (!adminToken) {
    res.status(500).json({ ok: false, error: "Service account not configured" });
    return;
  }

  // Create Firebase Auth user via Identity Toolkit Admin API (does not change server session)
  let newUid: string;
  try {
    const authResp = await fetch(
      `https://identitytoolkit.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/accounts`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          email,
          password,
          displayName: name,
          emailVerified: false,
        }),
      },
    );
    const authData = (await authResp.json()) as {
      localId?: string;
      error?: { message?: string };
    };
    if (!authResp.ok || !authData.localId) {
      const msg = authData.error?.message ?? "Firebase Auth user creation failed";
      res.status(400).json({ ok: false, error: msg });
      return;
    }
    newUid = authData.localId;
  } catch (err) {
    logger.warn({ err }, "Firebase Auth create-student failed");
    res.status(500).json({ ok: false, error: "Failed to create user account" });
    return;
  }

  // Write Firestore user document linked to the school
  try {
    const firestoreUrl =
      `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}` +
      `/databases/(default)/documents/users/${newUid}`;
    await fetch(firestoreUrl, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        fields: {
          uid: { stringValue: newUid },
          name: { stringValue: name },
          email: { stringValue: email },
          role: { stringValue: "individual" },
          schoolId: { stringValue: caller.schoolId },
          mustChangePassword: { booleanValue: true },
          subscriptionTier: { stringValue: "free" },
          aiRequestsLimit: { integerValue: "10" },
          createdAt: { stringValue: new Date().toISOString() },
          loginCount: { integerValue: "0" },
        },
      }),
    });
  } catch (err) {
    logger.warn({ err, newUid }, "Firestore user doc write failed after Auth creation");
  }

  logger.info({ newUid, schoolId: caller.schoolId, email }, "School created student account");
  res.json({ ok: true, uid: newUid });
});

export default router;
