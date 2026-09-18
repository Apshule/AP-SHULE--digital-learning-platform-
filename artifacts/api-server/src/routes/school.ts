import { Router } from "express";
import { createHash } from "node:crypto";
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
    `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${path.replace(/^\/+/, "")}`,
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

async function firestoreCollectionIds(token: string): Promise<string[]> {
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}` +
      `/databases/(default)/documents:listCollectionIds`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ pageSize: 300 }),
    },
  );
  if (!response.ok) return [];
  const payload = (await response.json()) as { collectionIds?: string[] };
  return payload.collectionIds ?? [];
}

function firestoreEncodedValue(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(firestoreEncodedValue) } };
  if (typeof value === "object") {
    return {
      mapValue: {
        fields: Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, firestoreEncodedValue(item)]),
        ),
      },
    };
  }
  return { stringValue: String(value) };
}

async function firestoreWrite(
  path: string,
  token: string,
  data: Record<string, unknown>,
  method: "PATCH" | "POST" = "PATCH",
): Promise<FirestoreDocument | null> {
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${path.replace(/^\/+/, "")}`,
    {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: Object.fromEntries(
          Object.entries(data).map(([key, value]) => [key, firestoreEncodedValue(value)]),
        ),
      }),
    },
  );
  if (!response.ok) throw new Error(`Firestore write failed (${response.status})`);
  return (await response.json()) as FirestoreDocument;
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

function academicText(data: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  return "";
}

function academicNumber(data: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = Number(data[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function academicRecord(data: Record<string, unknown>, id: string, kind: "marks" | "reports") {
  return safeRecord({
    learnerId: academicText(data, ["learnerId", "studentId", "studentNumber", "admissionNumber", "userId"]),
    learnerName: academicText(data, ["learnerName", "studentName", "student", "name", "displayName"]),
    className: academicText(data, ["className", "class", "classLevel", "level", "stream"]),
    subject: academicText(data, ["subjectName", "subject", "course", "paper"]),
    term: academicText(data, ["term", "termName", "academicTerm", "semester"]),
    curriculum: academicText(data, ["curriculum", "curriculumType", "assessmentType"]),
    score: academicNumber(data, ["score", "marks", "mark", "percentage", "totalScore"]),
    average: academicNumber(data, ["average", "averageScore", "mean"]),
    grade: academicText(data, ["grade", "division", "achievementLevel", "level"]),
    remark: academicText(data, ["remark", "remarks", "comment", "teacherRemark"]),
    status: academicText(data, ["status", "approvalStatus", "reportStatus"]) || "recorded",
    recordType: kind,
  }, id);
}

function academicCollectionNames(collectionIds: string[], kind: "marks" | "reports"): string[] {
  const knownNames = kind === "marks"
    ? ["school_marks", "marks", "student_marks", "academic_marks", "assessments"]
    : ["school_report_cards", "report_cards", "academic_reports", "academic_report_cards", "learner_reports"];
  const names = new Set([...collectionIds, ...knownNames]);
  return [...names].filter((name) => {
    const normalized = name.toLowerCase();
    const matches = kind === "marks"
      ? /(mark|score|assessment|result)/.test(normalized)
      : /(report|result)/.test(normalized);
    return matches && !/(lesson|compliance|curriculum_links|template)/.test(normalized);
  });
}

async function loadAcademicRecords(
  collectionIds: string[],
  schoolIds: Set<string>,
  token: string,
  kind: "marks" | "reports",
) {
  const documents = await Promise.all(
    academicCollectionNames(collectionIds, kind).map((collection) => firestoreList(collection, token)),
  );
  return [...new Map(
    documents.flat()
      .filter((item) => belongsToSchool(documentData(item), schoolIds))
      .map((item) => [item.name ?? documentId(item), item]),
  ).values()].slice(0, 500).map((item) => academicRecord(documentData(item), documentId(item), kind));
}

function numberValue(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function monthArchiveId(institutionId: string, month: string): string {
  return `${institutionId}-${month}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

async function bursarMonthLocked(institutionId: string, month: string, adminToken: string): Promise<boolean> {
  const scopedArchive = await firestoreGet(
    `payment_monthly_archives/${encodeURIComponent(monthArchiveId(institutionId, month))}`,
    adminToken,
  );
  const archive = scopedArchive ? documentData(scopedArchive) : {};
  return archive.locked === true || archive.status === "locked";
}

function transactionDate(data: Record<string, unknown>): number {
  return Date.parse(String(data.paymentDate ?? data.createdAt ?? ""));
}

function transactionMonth(data: Record<string, unknown>): string {
  const date = new Date(transactionDate(data));
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 7) : "";
}

function validDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validMonth(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function transactionInPeriod(data: Record<string, unknown>, from?: string, to?: string): boolean {
  const date = transactionDate(data);
  if (!Number.isFinite(date)) return false;
  const fromDate = from ? Date.parse(`${from}T00:00:00.000Z`) : Number.NEGATIVE_INFINITY;
  const toDate = to ? Date.parse(`${to}T23:59:59.999Z`) : Number.POSITIVE_INFINITY;
  return date >= fromDate && date <= toDate;
}

function bursarReceiptHash(data: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify({
    reference: data.reference,
    amountPaid: data.amountPaid,
    institutionId: data.institutionId,
    paymentDate: data.paymentDate ?? data.createdAt,
  })).digest("hex");
}

function bursarReceipt(data: Record<string, unknown>, id: string, institutionId: string) {
  const receiptHash = bursarReceiptHash({ ...data, institutionId });
  return {
    receiptId: `RCP-${id}`,
    transactionId: id,
    reference: String(data.reference ?? ""),
    billReference: String(data.billReference ?? ""),
    clientName: String(data.clientName ?? data.studentName ?? data.payerName ?? ""),
    amountPaid: numberValue(data.amountPaid ?? data.paidAmount ?? data.amount),
    paymentMethod: String(data.paymentMethod ?? ""),
    paymentDate: String(data.paymentDate ?? data.createdAt ?? ""),
    institutionId,
    status: String(data.status ?? ""),
    receiptHash,
    verification: `sha256:${receiptHash}`,
  };
}

async function bursarStatement(
  schoolIds: Set<string>,
  institutionId: string,
  from: string,
  to: string,
  adminToken: string,
) {
  const documents = await firestoreList("payment_transactions", adminToken);
  const payments = documents
    .map((item) => ({ id: documentId(item), data: documentData(item) }))
    .filter(({ data }) => belongsToSchool(data, schoolIds) && transactionInPeriod(data, from, to))
    .map(({ id, data }) => ({
      id,
      reference: String(data.reference ?? ""),
      billReference: String(data.billReference ?? ""),
      clientName: String(data.clientName ?? data.studentName ?? data.payerName ?? ""),
      amountPaid: numberValue(data.amountPaid ?? data.paidAmount ?? data.amount),
      paymentMethod: String(data.paymentMethod ?? ""),
      paymentDate: String(data.paymentDate ?? data.createdAt ?? ""),
      status: String(data.status ?? ""),
      receiptHash: bursarReceiptHash({ ...data, institutionId }),
    }))
    .sort((a, b) => Date.parse(b.paymentDate) - Date.parse(a.paymentDate));
  const totalAmount = payments.reduce((sum, payment) => sum + payment.amountPaid, 0);
  const byMethod = payments.reduce<Record<string, number>>((totals, payment) => {
    const method = payment.paymentMethod || "unspecified";
    totals[method] = (totals[method] ?? 0) + payment.amountPaid;
    return totals;
  }, {});
  const months = [...new Set(payments.map((payment) => transactionMonth(payment)).filter(Boolean))];
  const lockedMonths = await Promise.all(months.map(async (month) => ({
    month,
    locked: await bursarMonthLocked(institutionId, month, adminToken),
  })));
  return {
    institutionId,
    from,
    to,
    paymentCount: payments.length,
    totalAmount,
    byMethod,
    lockedMonths,
    payments: payments.slice(0, 500),
  };
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

async function findBursarBill(
  billReference: string,
  schoolIds: Set<string>,
  adminToken: string,
): Promise<{ collection: string; id: string; data: Record<string, unknown> } | null> {
  for (const collection of ["school_fees", "school_bills"]) {
    const document = await firestoreGet(`${collection}/${encodeURIComponent(billReference)}`, adminToken);
    if (!document) continue;
    const data = documentData(document);
    if (!belongsToSchool(data, schoolIds)) return null;
    return { collection, id: documentId(document) || billReference, data };
  }
  return null;
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
    const [directSchool, allSchools, allUsers, classes, subjects, collectionIds] = await Promise.all([
      firestoreGet(`schools/${encodeURIComponent(caller.schoolId)}`, adminToken),
      firestoreList("schools", adminToken),
      firestoreList("users", adminToken),
      firestoreList("school_classes", adminToken),
      firestoreList("school_subjects", adminToken),
      firestoreCollectionIds(adminToken),
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
    const [reports, marks] = await Promise.all([
      loadAcademicRecords(collectionIds, schoolIds, adminToken, "reports"),
      loadAcademicRecords(collectionIds, schoolIds, adminToken, "marks"),
    ]);
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
      reports,
      marks,
      bursar,
    });
  } catch (err) {
    logger.warn({ err, schoolId: caller.schoolId }, "Education workspace read failed");
    res.status(502).json({ ok: false, error: "Unable to load authorized school records" });
  }
});

router.post("/school/bursar/payments", async (req, res) => {
  const caller = await verifySchoolCaller(req.headers["authorization"]);
  if (!caller) {
    res.status(401).json({ ok: false, error: "Unauthorized — school account required" });
    return;
  }
  if (caller.role !== "bursar") {
    res.status(403).json({ ok: false, error: "Bursar role required" });
    return;
  }

  const adminToken = await getFirebaseAdminToken();
  if (!adminToken) {
    res.status(503).json({ ok: false, error: "Bursar records are temporarily unavailable" });
    return;
  }

  const body = req.body as {
    billReference?: string;
    amountPaid?: number | string;
    paymentMethod?: string;
    reference?: string;
    clientName?: string;
    clientPhone?: string;
    notes?: string;
  };
  const billReference = String(body.billReference ?? "").trim();
  const amountPaid = Number(body.amountPaid);
  const paymentMethod = String(body.paymentMethod ?? "").trim().toLowerCase();
  const reference = String(body.reference ?? `BUR-${Date.now()}-${caller.uid.slice(0, 8)}`).trim();
  if (
    !billReference ||
    !Number.isFinite(amountPaid) ||
    amountPaid <= 0 ||
    !["cash", "mobile_money", "bank_transfer", "cheque"].includes(paymentMethod) ||
    !/^[A-Za-z0-9/_-]{3,80}$/.test(reference)
  ) {
    res.status(400).json({
      ok: false,
      error: "billReference, positive amountPaid, valid paymentMethod and reference are required",
    });
    return;
  }

  try {
    const schoolIds = new Set([caller.schoolId, caller.institutionId].filter(Boolean) as string[]);
    const institutionId = caller.institutionId ?? caller.schoolId;
    const currentMonth = new Date().toISOString().slice(0, 7);
    if (await bursarMonthLocked(institutionId, currentMonth, adminToken)) {
      res.status(409).json({ ok: false, error: `The ${currentMonth} statement is locked; payment edits are no longer allowed` });
      return;
    }
    const bill = await findBursarBill(billReference, schoolIds, adminToken);
    if (!bill) {
      res.status(404).json({ ok: false, error: "Authorized fee account was not found" });
      return;
    }

    const existingPayments = await firestoreList("payment_transactions", adminToken);
    const duplicate = existingPayments.some((item) => {
      const data = documentData(item);
      return String(data.reference ?? "") === reference && belongsToSchool(data, schoolIds);
    });
    if (duplicate) {
      res.status(409).json({ ok: false, error: "A payment with this reference already exists" });
      return;
    }

    const totalAmount = numberValue(bill.data.totalAmount ?? bill.data.billTotal ?? bill.data.amount);
    const paidAmount = numberValue(bill.data.paidAmount ?? bill.data.amountPaid);
    const outstanding = Math.max(0, totalAmount - paidAmount);
    if (!totalAmount || amountPaid > outstanding) {
      res.status(409).json({
        ok: false,
        error: outstanding ? `Payment exceeds the outstanding balance of UGX ${outstanding.toLocaleString("en-UG")}` : "This fee account has no outstanding balance",
      });
      return;
    }

    const nextPaid = paidAmount + amountPaid;
    const nextBalance = Math.max(0, totalAmount - nextPaid);
    const status = nextBalance === 0 ? "paid" : "partial";
    const createdAt = new Date().toISOString();
    const payment: Record<string, unknown> = {
      reference,
      billReference,
      clientName: String(body.clientName ?? bill.data.clientName ?? bill.data.studentName ?? "").trim(),
      clientPhone: String(body.clientPhone ?? "").trim(),
      institutionId: caller.institutionId ?? caller.schoolId,
      schoolId: caller.schoolId,
      totalAmount,
      amountPaid,
      balanceRemaining: nextBalance,
      fee: 0,
      netAmount: amountPaid,
      paymentType: amountPaid === outstanding ? "Full Payment" : "Partial Payment",
      paymentMethod,
      notes: String(body.notes ?? "").trim(),
      status: "pending",
      paymentDate: createdAt,
      createdAt,
      createdBy: caller.uid,
      source: "bursar_manual",
    };
    payment.receiptHash = bursarReceiptHash(payment);

    const transaction = await firestoreWrite("payment_transactions", adminToken, payment, "POST");
    const transactionId = documentId(transaction ?? {});
    try {
      await firestoreWrite(`${bill.collection}/${encodeURIComponent(bill.id)}`, adminToken, {
        paidAmount: nextPaid,
        amountPaid: nextPaid,
        balanceAmount: nextBalance,
        balanceRemaining: nextBalance,
        paymentStatus: status === "paid" ? "Paid" : "Partially Paid",
        status,
        lastPaymentAmount: amountPaid,
        lastPaymentDate: createdAt,
        updatedAt: createdAt,
      });
      await firestoreWrite(`/payment_transactions/${encodeURIComponent(transactionId)}`, adminToken, {
        status: "completed",
        completedAt: createdAt,
      });
    } catch (error) {
      if (transactionId) {
        await firestoreWrite(`/payment_transactions/${encodeURIComponent(transactionId)}`, adminToken, {
          status: "failed",
          failureReason: "Fee account update failed",
          updatedAt: new Date().toISOString(),
        }).catch(() => undefined);
      }
      throw error;
    }

    await firestoreWrite("payment_audit_log", adminToken, {
      action: "bursar_manual_payment_recorded",
      actorId: caller.uid,
      institutionId: caller.institutionId ?? caller.schoolId,
      details: { reference, billReference, amountPaid, paymentMethod },
      timestamp: createdAt,
    }, "POST").catch(() => undefined);

    res.status(201).json({
      ok: true,
      payment: { id: transactionId, ...payment, status: "completed", completedAt: createdAt },
      receipt: bursarReceipt(payment, transactionId, institutionId),
      balanceRemaining: nextBalance,
    });
  } catch (err) {
    logger.warn({ err, schoolId: caller.schoolId }, "Bursar manual payment failed");
    res.status(502).json({ ok: false, error: "Unable to record the bursar payment" });
  }
});

router.post("/school/bursar/reconciliation", async (req, res) => {
  const caller = await verifySchoolCaller(req.headers["authorization"]);
  if (!caller) {
    res.status(401).json({ ok: false, error: "Unauthorized — school account required" });
    return;
  }
  if (caller.role !== "bursar") {
    res.status(403).json({ ok: false, error: "Bursar role required" });
    return;
  }
  const adminToken = await getFirebaseAdminToken();
  if (!adminToken) {
    res.status(503).json({ ok: false, error: "Bursar records are temporarily unavailable" });
    return;
  }
  const body = req.body as Record<string, unknown>;
  const date = String(body.date ?? new Date().toISOString().slice(0, 10));
  const amounts = ["cashInHand", "mobileMoney", "bank", "insuranceClaimsPending"];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || amounts.some((key) => !Number.isFinite(Number(body[key] ?? 0)) || Number(body[key] ?? 0) < 0)) {
    res.status(400).json({ ok: false, error: "date and non-negative reconciliation amounts are required" });
    return;
  }
  try {
    const institutionId = caller.institutionId ?? caller.schoolId;
    const month = date.slice(0, 7);
    if (await bursarMonthLocked(institutionId, month, adminToken)) {
      res.status(409).json({ ok: false, error: `The ${month} statement is locked; reconciliation edits are no longer allowed` });
      return;
    }
    const id = `${caller.schoolId}-${date}`.replace(/[^A-Za-z0-9_-]/g, "_");
    const record = {
      reconciliationDate: date,
      date,
      schoolId: caller.schoolId,
      institutionId,
      cashInHand: Number(body.cashInHand ?? 0),
      mobileMoney: Number(body.mobileMoney ?? 0),
      bank: Number(body.bank ?? 0),
      insuranceClaimsPending: Number(body.insuranceClaimsPending ?? 0),
      variances: typeof body.variances === "object" && body.variances ? body.variances : {},
      notes: String(body.notes ?? "").trim(),
      createdBy: caller.uid,
      createdAt: new Date().toISOString(),
    };
    await firestoreWrite(`payment_daily_reconciliations/${encodeURIComponent(id)}`, adminToken, record);
    await firestoreWrite("payment_audit_log", adminToken, {
      action: "bursar_daily_reconciliation_created",
      actorId: caller.uid,
      institutionId: record.institutionId,
      details: { date, id },
      timestamp: record.createdAt,
    }, "POST").catch(() => undefined);
    res.status(201).json({ ok: true, reconciliation: { id, ...record } });
  } catch (err) {
    logger.warn({ err, schoolId: caller.schoolId }, "Bursar reconciliation failed");
    res.status(502).json({ ok: false, error: "Unable to save the daily reconciliation" });
  }
});

router.get("/school/bursar/receipts/:paymentId", async (req, res) => {
  const caller = await verifySchoolCaller(req.headers["authorization"]);
  if (!caller) {
    res.status(401).json({ ok: false, error: "Unauthorized — school account required" });
    return;
  }
  if (caller.role !== "bursar") {
    res.status(403).json({ ok: false, error: "Bursar role required" });
    return;
  }
  const adminToken = await getFirebaseAdminToken();
  if (!adminToken) {
    res.status(503).json({ ok: false, error: "Bursar records are temporarily unavailable" });
    return;
  }

  try {
    const schoolIds = new Set([caller.schoolId, caller.institutionId].filter(Boolean) as string[]);
    const payment = await firestoreGet(
      `payment_transactions/${encodeURIComponent(String(req.params.paymentId))}`,
      adminToken,
    );
    if (!payment) {
      res.status(404).json({ ok: false, error: "Payment transaction was not found" });
      return;
    }
    const data = documentData(payment);
    if (!belongsToSchool(data, schoolIds)) {
      res.status(404).json({ ok: false, error: "Payment transaction was not found" });
      return;
    }
    const status = String(data.status ?? "").toLowerCase();
    if (["failed", "pending", "processing"].includes(status)) {
      res.status(409).json({ ok: false, error: "A receipt is available only after the payment is completed" });
      return;
    }
    const institutionId = caller.institutionId ?? caller.schoolId;
    const receipt = bursarReceipt(data, documentId(payment) || String(req.params.paymentId), institutionId);
    res.json({
      ok: true,
      receipt: {
        ...receipt,
        verified: !data.receiptHash || data.receiptHash === receipt.receiptHash,
      },
    });
  } catch (err) {
    logger.warn({ err, schoolId: caller.schoolId }, "Bursar receipt retrieval failed");
    res.status(502).json({ ok: false, error: "Unable to retrieve the payment receipt" });
  }
});

router.get("/school/bursar/statements", async (req, res) => {
  const caller = await verifySchoolCaller(req.headers["authorization"]);
  if (!caller) {
    res.status(401).json({ ok: false, error: "Unauthorized — school account required" });
    return;
  }
  if (caller.role !== "bursar") {
    res.status(403).json({ ok: false, error: "Bursar role required" });
    return;
  }
  const from = String(req.query.from ?? "");
  const to = String(req.query.to ?? "");
  if (!validDateOnly(from) || !validDateOnly(to) || from > to) {
    res.status(400).json({ ok: false, error: "A valid from and to date are required" });
    return;
  }
  const adminToken = await getFirebaseAdminToken();
  if (!adminToken) {
    res.status(503).json({ ok: false, error: "Bursar records are temporarily unavailable" });
    return;
  }

  try {
    const schoolIds = new Set([caller.schoolId, caller.institutionId].filter(Boolean) as string[]);
    const statement = await bursarStatement(
      schoolIds,
      caller.institutionId ?? caller.schoolId,
      from,
      to,
      adminToken,
    );
    res.json({ ok: true, statement });
  } catch (err) {
    logger.warn({ err, schoolId: caller.schoolId }, "Bursar statement retrieval failed");
    res.status(502).json({ ok: false, error: "Unable to generate the bursar statement" });
  }
});

router.post("/school/bursar/statements/close", async (req, res) => {
  const caller = await verifySchoolCaller(req.headers["authorization"]);
  if (!caller) {
    res.status(401).json({ ok: false, error: "Unauthorized — school account required" });
    return;
  }
  if (caller.role !== "bursar") {
    res.status(403).json({ ok: false, error: "Bursar role required" });
    return;
  }
  const month = String((req.body as Record<string, unknown>).month ?? "");
  if (!validMonth(month)) {
    res.status(400).json({ ok: false, error: "A valid statement month is required" });
    return;
  }
  const adminToken = await getFirebaseAdminToken();
  if (!adminToken) {
    res.status(503).json({ ok: false, error: "Bursar records are temporarily unavailable" });
    return;
  }

  try {
    const institutionId = caller.institutionId ?? caller.schoolId;
    const archiveId = monthArchiveId(institutionId, month);
    const archivePath = `payment_monthly_archives/${encodeURIComponent(archiveId)}`;
    const existing = await firestoreGet(archivePath, adminToken);
    const existingData = existing ? documentData(existing) : {};
    if (existingData.locked === true || existingData.status === "locked") {
      res.json({ ok: true, alreadyLocked: true, statement: { id: archiveId, ...existingData } });
      return;
    }

    const from = `${month}-01`;
    const lastDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0))
      .toISOString().slice(0, 10);
    const schoolIds = new Set([caller.schoolId, caller.institutionId].filter(Boolean) as string[]);
    const statement = await bursarStatement(schoolIds, institutionId, from, lastDay, adminToken);
    const lockedAt = new Date().toISOString();
    const archive = {
      month,
      institutionId,
      schoolId: caller.schoolId,
      from,
      to: lastDay,
      paymentCount: statement.paymentCount,
      totalAmount: statement.totalAmount,
      byMethod: statement.byMethod,
      statementHash: createHash("sha256").update(JSON.stringify({
        institutionId,
        month,
        paymentCount: statement.paymentCount,
        totalAmount: statement.totalAmount,
        byMethod: statement.byMethod,
      })).digest("hex"),
      locked: true,
      status: "locked",
      lockedAt,
      lockedBy: caller.uid,
    };
    await firestoreWrite(archivePath, adminToken, archive);
    await firestoreWrite("payment_audit_log", adminToken, {
      action: "bursar_monthly_statement_locked",
      actorId: caller.uid,
      institutionId,
      details: { month, archiveId, totalAmount: statement.totalAmount, paymentCount: statement.paymentCount },
      timestamp: lockedAt,
    }, "POST").catch(() => undefined);
    res.status(201).json({ ok: true, alreadyLocked: false, statement: { id: archiveId, ...archive } });
  } catch (err) {
    logger.warn({ err, schoolId: caller.schoolId }, "Bursar monthly statement close failed");
    res.status(502).json({ ok: false, error: "Unable to close the monthly statement" });
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
