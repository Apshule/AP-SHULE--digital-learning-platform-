import type { AuthEnv, AuthUser } from "./backend-types";
import { handleEducationFileRoute } from "./education-files";
import { handleEducationPlatformRoute } from "./education-platform";
import { inNeonTransaction } from "./neon-db";

type MaybeUser = AuthUser | null | undefined;
type Row = Record<string, unknown>;
type Capability = { capability: string; scope: string; sector: string };

const EDUCATION_TYPES = new Set([
  "learner", "student", "class", "subject", "academic_mark", "marks", "attendance",
  "admission", "id_card", "communication", "teacher_assignment", "grading",
  "payment", "reconciliation", "statement", "fee", "report", "school", "institution",
]);
const RECORD_TYPES: Record<string, Set<string>> = {
  education: EDUCATION_TYPES,
  clinic: new Set([
    "patient", "appointment", "visit", "prescription", "service", "branch", "pharmacy_inventory",
    "product_scan", "billing", "payment", "insurance_claim", "report_template", "access_audit",
    "communication", "clinic_patients", "clinic_appointments", "clinic_visits", "clinic_prescriptions",
    "clinic_services", "clinic_branches", "clinic_pharmacy_inventory", "clinic_product_scans",
    "clinic_billing", "clinic_payments", "clinic_insurance_claims", "clinic_report_templates",
    "clinic_access_audit", "clinic_communications",
  ]),
  farm: new Set([
    "farm", "animal_type", "worker", "camera", "animal_movement", "daily_summary", "attendance",
    "egg_collection", "inventory", "feed_consumption", "produce", "sale", "expense", "report_template",
    "lost_animal", "farm_worker", "feed", "farm_workers", "farm_animal_types", "farm_cameras",
    "farm_animal_movements", "farm_daily_summaries", "farm_worker_attendance", "farm_egg_collections",
    "farm_inventory", "farm_feed_consumption", "farm_produce", "farm_sales", "farm_expenses",
    "farm_report_templates", "farm_lost_animals",
  ]),
  mfi: new Set([
    "borrower", "customer", "collateral", "collateral_type", "collateral_score", "collateral_document",
    "branch", "verification", "decision", "valuer", "legal_officer", "receipt", "loan_product",
    "loan", "repayment_schedule", "payment", "loan_approval", "loan_document", "loan_audit",
    "installment_application", "overdue_log", "credit_note", "restructure", "writeoff", "late_fee_config",
    "refund_request", "report", "mfi_customers", "mfi_collateral", "mfi_branches", "microfinance_loans",
    "mfi_loan_repayment_schedule", "mfi_loan_payments", "mfi_loan_approvals", "mfi_loan_documents",
    "mfi_loan_audit", "mfi_loan_installment_applications", "mfi_loan_overdue_log", "mfi_credit_notes",
    "mfi_loan_restructures", "mfi_loan_writeoffs", "mfi_credit_note_refund_requests",
  ]),
};
const CLINIC_WORKFLOW_RECORD_TYPES = new Set([
  "patient", "appointment", "visit", "prescription", "pharmacy_inventory", "product_scan",
  "billing", "payment", "insurance_claim", "clinic_patients", "clinic_appointments",
  "clinic_visits", "clinic_prescriptions", "clinic_pharmacy_inventory", "clinic_product_scans",
  "clinic_billing", "clinic_payments", "clinic_insurance_claims",
]);
const LEGACY_COLLECTIONS: Record<string, Record<string, string[]>> = {
  education: {
    learner: ["students", "learners", "school_students"], student: ["students", "learners", "school_students"],
    class: ["school_classes", "classes"], subject: ["school_subjects", "subjects"],
    attendance: ["liveAttendance", "attendanceEvents", "attendance"],
    academic_mark: ["school_marks"], marks: ["school_marks"],
    report: ["school_report_cards"], admission: ["admissions", "school_admissions"],
    teacher_assignment: ["school_teacher_assignments"], id_card: ["id_cards"],
    communication: ["notifications"], fee: ["school_fees"], payment: ["payments"],
    reconciliation: ["bursar_reconciliations"], statement: ["bursar_statements"],
    school: ["schools"], institution: ["institutions"],
  },
  clinic: {
    patient: ["clinic_patients"], appointment: ["clinic_appointments"], visit: ["clinic_visits"],
    prescription: ["clinic_prescriptions"], service: ["clinic_services"], branch: ["clinic_branches"],
    pharmacy_inventory: ["clinic_pharmacy_inventory"], product_scan: ["clinic_product_scans"],
    billing: ["clinic_billing"], payment: ["clinic_payments"], insurance_claim: ["clinic_insurance_claims"],
    report_template: ["clinic_report_templates"], access_audit: ["clinic_access_audit"],
    communication: ["clinic_communications"],
  },
  farm: {
    farm: ["farms"], animal_type: ["farm_animal_types"], worker: ["farm_workers"],
    camera: ["farm_cameras"], animal_movement: ["farm_animal_movements"],
    daily_summary: ["farm_daily_summaries"], attendance: ["farm_worker_attendance"],
    egg_collection: ["farm_egg_collections"], inventory: ["farm_inventory"],
    feed: ["farm_feed_consumption"], feed_consumption: ["farm_feed_consumption"],
    produce: ["farm_produce"], sale: ["farm_sales"], expense: ["farm_expenses"],
    report_template: ["farm_report_templates"], lost_animal: ["farm_lost_animals"],
  },
  mfi: {
    borrower: ["mfi_customers"], customer: ["mfi_customers"], collateral: ["mfi_collateral"],
    collateral_type: ["mfi_collateral_types"], collateral_score: ["mfi_collateral_scoring"],
    collateral_document: ["mfi_collateral_documents"], branch: ["mfi_branches"],
    verification: ["mfi_collateral_verification"], decision: ["mfi_collateral_decisions"],
    valuer: ["mfi_valuers"], legal_officer: ["mfi_legal_officers"], receipt: ["mfi_receipts"],
    loan_product: ["mfi_loan_products"], loan: ["microfinance_loans"],
    repayment_schedule: ["mfi_loan_repayment_schedule"], payment: ["mfi_loan_payments"],
    loan_approval: ["mfi_loan_approvals"], loan_document: ["mfi_loan_documents"],
    loan_audit: ["mfi_loan_audit"], installment_application: ["mfi_loan_installment_applications"],
    overdue_log: ["mfi_loan_overdue_log"], credit_note: ["mfi_credit_notes"],
    restructure: ["mfi_loan_restructures"], writeoff: ["mfi_loan_writeoffs"],
    late_fee_config: ["mfi_late_fee_config"], refund_request: ["mfi_credit_note_refund_requests"],
    report: ["mfi_loan_audit", "mfi_loan_overdue_log"],
  },
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const clean = (v: unknown, max = 200) => String(v ?? "").trim().slice(0, max);
const stamp = () => new Date().toISOString();
const makeId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;

function role(user: AuthUser): string {
  const value = clean(user.role, 80).toLowerCase().replace(/[ -]+/g, "_");
  return value === "super_admin" ? "superadmin" : value;
}
function effectiveRole(user: AuthUser, sector: string): string {
  const r = role(user);
  if (sector !== "education") return r;
  if (["school", "school_admin", "head_teacher"].includes(r)) return "headteacher";
  if (r === "teacher_staff" || r === "teacher_independent") return "teacher";
  if (r === "accountant") return "bursar";
  if (r === "individual") return "student";
  return r;
}
function tenant(user: AuthUser): { institutionId: string | null; schoolId: string | null } {
  return { institutionId: user.institutionId || null, schoolId: user.schoolId || null };
}
function tenantWhere(user: AuthUser, alias = "", sector = "", firstParameter = 1): { sql: string; args: string[] } {
  if (role(user) === "superadmin") return { sql: "TRUE", args: [] };
  const p = alias ? `${alias}.` : "";
  const t = tenant(user);
  if (!t.institutionId && !t.schoolId) {
    return sector === "education" ? { sql: "TRUE", args: [] } : { sql: "FALSE", args: [] };
  }
  if (t.schoolId) return {
    sql: `(${p}school_id = $${firstParameter} OR (${p}school_id IS NULL AND ${p}institution_id = $${firstParameter + 1}))`,
    args: [t.schoolId, t.institutionId || ""],
  };
  return { sql: `${p}institution_id = $${firstParameter}`, args: [t.institutionId!] };
}
async function capabilities(env: AuthEnv, user: AuthUser, sector: string): Promise<Capability[]> {
  if (role(user) === "superadmin") return [{ capability: "*", scope: "tenant", sector: "*" }];
  const r = effectiveRole(user, sector);
  if (!env.PG) throw new Error("PostgreSQL persistence is unavailable");
  const result = await env.PG.query<Capability>(
    "SELECT capability, scope, sector FROM role_capabilities WHERE lower(role)=$1 AND (sector=$2 OR sector='*')",
    [r, sector],
  );
  return result.rows;
}
function can(caps: Capability[], capability: string): boolean {
  if (caps.some((c) => c.capability === "*" || c.capability === capability)) return true;
  if (!capability.endsWith(".read")) return false;
  const readScope = capability.slice(0, -".read".length);
  return caps.some((c) => c.capability === `${readScope}.manage`);
}
export async function allowed(env: AuthEnv, user: AuthUser, sector: string, capability: string): Promise<boolean> {
  const caps = await capabilities(env, user, sector);
  return can(caps, capability);
}
async function audit(env: AuthEnv, user: AuthUser, action: string, resourceType: string, resourceId: string, metadata: unknown = {}) {
  const t = tenant(user);
  if (!env.PG) throw new Error("PostgreSQL persistence is unavailable");
  await env.PG.query(
    "INSERT INTO audit (id,institution_id,school_id,actor_id,action,resource_type,resource_id,metadata_json,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [makeId("audit"), t.institutionId, t.schoolId, user.uid, action, resourceType, resourceId, JSON.stringify(metadata), stamp()],
  );
}
async function body(request: Request): Promise<Row> {
  try { const value = await request.json(); return value && typeof value === "object" ? value as Row : {}; } catch { return {}; }
}
function tenantInput(input: Row, user: AuthUser) {
  // Tenant ownership always comes from the authenticated principal, never the browser.
  return { institutionId: user.institutionId || null, schoolId: user.schoolId || null };
}
function decodeFirestore(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const v = value as Row;
  if ("fields" in v) return decodeFirestore(v.fields);
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  if ("referenceValue" in v) return v.referenceValue;
  if ("bytesValue" in v) return v.bytesValue;
  if ("arrayValue" in v) return ((v.arrayValue as Row)?.values as unknown[] || []).map(decodeFirestore);
  if ("mapValue" in v) return decodeFirestore((v.mapValue as Row)?.fields || {});
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decodeFirestore(x)]));
}
function safeLegacy(row: Row) {
  return { id: row.document_path, data: decodeFirestore(JSON.parse(String(row.data_json || "{}"))), createdAt: row.create_time, updatedAt: row.update_time };
}
function legacyInTenant(record: Row, user: AuthUser, sector: string): boolean {
  if (role(user) === "superadmin") return true;
  const data = record.data && typeof record.data === "object" ? record.data as Row : {};
  const institution = clean(data.institutionId || data.institution_id, 160);
  const school = clean(data.schoolId || data.school_id, 160);
  const farm = clean(data.farmId || data.farm_id, 160);
  const clinic = clean(data.clinicId || data.clinic_id || data.institutionId, 160);
  const mfi = clean(data.mfiId || data.mfi_id || data.institutionId, 160);
  const t = tenant(user);
  if (sector === "education" && !t.institutionId && !t.schoolId) return true;
  if (t.schoolId) return school === t.schoolId || (!school && Boolean(t.institutionId && institution === t.institutionId));
  return Boolean((t.institutionId && institution === t.institutionId)
    || (t.institutionId && farm === t.institutionId)
    || (t.institutionId && clinic === t.institutionId)
    || (t.institutionId && mfi === t.institutionId));
}
function isSelfRole(user: AuthUser, sector: string) {
  const r = role(user);
  return (sector === "clinic" && r === "patient") || (sector === "mfi" && r === "borrower") ||
    (sector === "farm" && r === "farm_worker") ||
    (sector === "education" && ["student", "learner"].includes(effectiveRole(user, sector)));
}

function legacyCollections(sector: string, type: string): string[] {
  const direct = LEGACY_COLLECTIONS[sector]?.[type];
  if (direct) return direct;
  const suffix = type.replace(/s$/, "");
  return LEGACY_COLLECTIONS[sector]?.[suffix] || [];
}

function legacyOwner(record: Row, uid: string): boolean {
  return legacyOwnerUid(record) === uid;
}
function legacyOwnerUid(record: Row): string {
  const data = record.data && typeof record.data === "object" ? record.data as Row : {};
  return clean(data.uid || data.userId || data.user_id || data.ownerUid || data.owner_uid || data.ownerId
    || data.studentUid || data.student_uid || data.studentId || data.student_id
    || data.patientUid || data.patientId || data.borrowerUid || data.borrowerId || data.workerUid, 160);
}

function recordFields(record: Row): Row {
  const data = record.data && typeof record.data === "object" ? record.data as Row : {};
  return { ...data, ...record };
}

function educationRecordType(record: Row): string {
  const fields = recordFields(record);
  return clean(
    fields.type || fields.recordType || fields.admissionType || fields.admission_type ||
      fields.sourceType || fields.source_type,
    80,
  ).toLowerCase();
}
function isVocationalEducationRecord(record: Row): boolean {
  const fields = recordFields(record);
  return [fields.type, fields.recordType, fields.admissionType, fields.admission_type, fields.sourceType, fields.source_type]
    .some((value) => clean(value, 80).toLowerCase() === "vocational");
}

function educationStudentIdentity(record: Row, user: AuthUser): boolean {
  record = recordFields(record);
  const ids = [
    record.id, record.uid, record.userId, record.user_id, record.ownerUid, record.owner_uid,
    record.studentUid, record.student_uid, record.studentId, record.student_id,
    record.learnerUid, record.learner_uid, record.learnerId, record.learner_id,
  ].map((value) => clean(value, 160));
  if (user.uid && ids.includes(user.uid)) return true;
  const email = clean(user.email, 200).toLowerCase();
  if (!email) return false;
  return Boolean(email) && [record.email, record.studentEmail, record.student_email, record.learnerEmail, record.learner_email]
    .some((value) => clean(value, 200).toLowerCase() === email);
}

function teacherName(record: Row): string {
  const fields = recordFields(record);
  return clean(fields.className || fields.class_name || fields.class, 100).toLowerCase();
}
function teacherClassLabel(record: Row): string {
  const fields = recordFields(record);
  return teacherName(fields) || clean(fields.name, 100).toLowerCase();
}
function teacherSubject(record: Row): string {
  const fields = recordFields(record);
  return clean(fields.subject || fields.subjectName || fields.subject_name || fields.name, 120).toLowerCase();
}
function teacherAssignmentMatchesUser(record: Row, user: AuthUser): boolean {
  const fields = recordFields(record);
  const uid = clean(fields.teacherUid || fields.teacher_uid || fields.teacherId || fields.teacher_id, 160);
  const email = clean(fields.teacherEmail || fields.teacher_email, 200).toLowerCase();
  return uid === user.uid || Boolean(email && email === clean(user.email, 200).toLowerCase());
}
async function teacherAssignmentsForUser(env: AuthEnv, user: AuthUser): Promise<Row[]> {
  const records = (await readRecords(env, user, "education", "teacher_assignment", false))
    .filter((record) => teacherAssignmentMatchesUser(record, user));
  if (tenant(user).schoolId || tenant(user).institutionId) return records;
  return records.filter((record) => Boolean(clean(record.schoolId || record.school_id, 160) || clean(record.institutionId || record.institution_id, 160)));
}
function sameEducationScope(record: Row, anchor: Row): boolean {
  const recordData = recordFields(record);
  const anchorData = recordFields(anchor);
  const anchorSchoolId = clean(anchorData.schoolId || anchorData.school_id, 160);
  const recordSchoolId = clean(recordData.schoolId || recordData.school_id, 160);
  const anchorInstitutionId = clean(anchorData.institutionId || anchorData.institution_id, 160);
  const recordInstitutionId = clean(recordData.institutionId || recordData.institution_id, 160);
  if (anchorSchoolId) {
    return recordSchoolId === anchorSchoolId ||
      (!recordSchoolId && Boolean(anchorInstitutionId && recordInstitutionId === anchorInstitutionId));
  }
  return Boolean(anchorInstitutionId && !recordSchoolId && recordInstitutionId === anchorInstitutionId);
}

function teacherRecordMatchesAssignments(
  record: Row,
  type: string,
  assignments: Row[],
  requireScopedAssignment = false,
): boolean {
  const className = type === "class" ? teacherClassLabel(record) : teacherName(record);
  const subject = teacherSubject(record);
  if (type === "teacher_assignment") return true;
  return assignments.some((assignment) => {
    if (requireScopedAssignment && !sameEducationScope(record, assignment)) return false;
    if (type === "learner" || type === "student" || type === "class" || type === "attendance") {
      return Boolean(className && teacherName(assignment) === className);
    }
    if (type === "subject") return Boolean(subject && teacherSubject(assignment) === subject);
    if (type === "marks") {
      return Boolean(className && subject && teacherName(assignment) === className &&
        teacherSubject(assignment) === subject);
    }
    return false;
  });
}
function studentRecordMatchesProfile(record: Row, profile: Row, user: AuthUser): boolean {
  if (educationStudentIdentity(record, user)) return true;
  record = recordFields(record);
  profile = recordFields(profile);
  const profileIds = [
    profile.id, profile.studentNumber, profile.student_number, profile.admissionNumber,
    profile.admission_number, profile.studentId, profile.student_id,
  ].map((value) => clean(value, 300)).filter(Boolean);
  const finalId = clean(profile.id, 300).split("/").pop() || "";
  if (finalId) profileIds.push(finalId);
  const recordIds = [
    record.learnerId, record.learner_id, record.studentId, record.student_id,
    record.learnerNumber, record.studentNumber, record.student_number,
  ].map((value) => clean(value, 300)).filter(Boolean);
  return recordIds.some((id) => profileIds.includes(id));
}

function studentRecordMatchesOwnProfile(record: Row, profile: Row, user: AuthUser): boolean {
  if (educationStudentIdentity(record, user)) return true;
  const profileData = recordFields(profile);
  const profileHasScope = Boolean(
    clean(profileData.schoolId || profileData.school_id, 160) ||
    clean(profileData.institutionId || profileData.institution_id, 160),
  );
  return profileHasScope && sameEducationScope(record, profile) &&
    studentRecordMatchesProfile(record, profile, user);
}

export async function readRecords(
  env: AuthEnv,
  user: AuthUser,
  sector: string,
  type: string,
  ownOnlyOverride?: boolean,
): Promise<Row[]> {
  const scope = tenantWhere(user, "", sector);
  if (!env.PG) throw new Error("PostgreSQL persistence is unavailable");
  const result = await env.PG.query<Row>(
    `SELECT id,record_json,record_type,created_at,updated_at,owner_uid,is_deleted,school_id,institution_id FROM sector_records WHERE sector=$1 AND record_type=$2 AND ${tenantWhere(user, "", sector, 3).sql} ORDER BY updated_at DESC LIMIT 500`,
    [sector, type, ...scope.args],
  );
  const ownOnly = ownOnlyOverride ?? isSelfRole(user, sector);
  const hiddenIds = new Set(result.rows.filter((row) => Number(row.is_deleted) === 1).map((row) => clean(row.id, 300)));
  const activeRows = result.rows.filter((row) => Number(row.is_deleted) !== 1);
  const records: Row[] = activeRows
    .filter((row) => !ownOnly || clean(row.owner_uid, 160) === user.uid || (
      sector === "education" && ["student", "learner"].includes(effectiveRole(user, sector)) &&
      educationStudentIdentity(JSON.parse(String(row.record_json || "{}")) as Row, user)
    ))
    .map((row) => {
      const data = JSON.parse(String(row.record_json || "{}")) as Row;
      return {
        id: row.id,
        ...data,
        recordType: row.record_type,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        schoolId: row.school_id ?? data.schoolId ?? data.school_id ?? null,
        institutionId: row.institution_id ?? data.institutionId ?? data.institution_id ?? null,
      };
    })
    .filter((record) => !(sector === "education" && ["admission", "marks"].includes(type) &&
      isVocationalEducationRecord(record)));
  if (sector === "education" && (type === "admission" || type === "marks")) {
    const table = type === "admission" ? "school_admissions" : "marks";
    const sharedScope = tenantWhere(user, "", "education", 1);
    const shared = await env.PG.query<Row>(
      `SELECT id,record_json,created_at,updated_at,school_id,institution_id,is_deleted
       FROM ${table} WHERE ${sharedScope.sql} ORDER BY updated_at DESC LIMIT 500`,
      sharedScope.args,
    );
    for (const row of shared.rows) {
      const id = clean(row.id, 300);
      if (Number(row.is_deleted) === 1) {
        hiddenIds.add(id);
        continue;
      }
      if (hiddenIds.has(id) || records.some((entry) => clean(entry.id, 300) === id)) continue;
      let data: Row = {};
      try { data = JSON.parse(String(row.record_json || "{}")) as Row; } catch { continue; }
      if (ownOnly && !educationStudentIdentity(data, user)) continue;
      records.push({
        ...data, id, recordType: type, createdAt: row.created_at, updatedAt: row.updated_at,
        schoolId: row.school_id ?? data.schoolId ?? data.school_id ?? null,
        institutionId: row.institution_id ?? data.institutionId ?? data.institution_id ?? null,
      });
      hiddenIds.add(id);
    }
  }
  const collections = legacyCollections(sector, type);
  if (collections.length) {
    const legacy = await env.PG.query<Row>(
      `SELECT document_path,data_json,create_time,update_time FROM firestore_documents WHERE collection_path IN (${collections.map((_, index) => `$${index + 1}`).join(",")}) LIMIT 500`,
      collections,
    );
    for (const row of legacy.rows) {
      let record: Row;
      try { record = safeLegacy(row); } catch { continue; }
      const legacyId = clean(record.id, 300);
      if (sector === "education" && ["admission", "marks"].includes(type)) {
        const collection = legacyId.split("/")[0];
        if (isVocationalEducationRecord(record)) continue;
        // Generic admissions rows are ambiguous without an explicit school discriminator.
        if (type === "admission" && collection === "admissions" && educationRecordType(record) !== "school") continue;
      }
      if (hiddenIds.has(legacyId) || records.some((entry) => clean(entry.id, 300) === legacyId)) continue;
      const studentOwnsLegacy = sector === "education" && ["student", "learner"].includes(effectiveRole(user, sector)) &&
        record.data && typeof record.data === "object" && educationStudentIdentity(record.data as Row, user);
      if (!legacyInTenant(record, user, sector) || ownOnly && !legacyOwner(record, user.uid) && !studentOwnsLegacy) continue;
      records.push({ ...record, recordType: type });
    }
  }
  return records;
}

async function sharedEducationRecord(
  request: Request,
  env: AuthEnv,
  user: AuthUser,
  type: "admission" | "marks",
  recordId: string,
  input: Row,
  capability: string,
): Promise<Response | null> {
  if (!(await allowed(env, user, "education", capability))) return json({ ok: false, error: "Forbidden" }, 403);
  const table = type === "admission" ? "school_admissions" : "marks";
  const t = tenant(user);
  const scope = tenantWhere(user, "", "education", 2);
  const id = recordId || clean(input.id, 160) || makeId(type);
  if (!env.PG) return json({ ok: false, error: "PostgreSQL persistence is unavailable" }, 503);
  const scoped = `id=$1 AND ${scope.sql}`;
  const existingResult = await env.PG.query<Row>(
    `SELECT id,record_json,school_id,institution_id,is_deleted,created_at,updated_at
     FROM ${table} WHERE ${scoped} LIMIT 1`,
    [id, ...scope.args],
  );
  const existing = existingResult.rows[0];
  const active = existing && Number(existing.is_deleted) !== 1 ? existing : null;
  if (request.method === "GET") return null;
  if (request.method === "POST" && active) return json({ ok: false, error: "Record already exists" }, 409);
  if (["PATCH", "PUT", "DELETE"].includes(request.method) && !active) {
    return json({ ok: false, error: "Record not found in this school" }, 404);
  }
  if (request.method === "DELETE") {
    await inNeonTransaction(env.PG, async () => {
      await env.PG!.query(
        `UPDATE ${table} SET is_deleted=1,updated_at=$1 WHERE id=$2 AND ${tenantWhere(user, "", "education", 3).sql} AND is_deleted=0`,
        [stamp(), id, ...tenantWhere(user, "", "education", 3).args],
      );
      await audit(env, user, "delete", `education_${type}`, id);
    });
    return json({ ok: true, deleted: true });
  }
  const previous = active ? (() => {
    try { return JSON.parse(String(active.record_json || "{}")) as Row; } catch { return {}; }
  })() : {};
  const recordTenant = role(user) === "superadmin" && active
    ? {
      schoolId: clean(active.school_id, 160) || clean(previous.schoolId || previous.school_id, 160) || null,
      institutionId: clean(active.institution_id, 160) || clean(previous.institutionId || previous.institution_id, 160) || null,
    }
    : t;
  const { id: _id, type: _type, recordType: _recordType, schoolId: _schoolId, institutionId: _institutionId,
    ...fields } = input;
  const payload = { ...(request.method === "PATCH" ? previous : {}), ...fields, id, recordType: type,
    schoolId: recordTenant.schoolId, institutionId: recordTenant.institutionId };
  const timestamp = stamp();
  const columns = type === "admission"
    ? "(id,student_id,full_name,phone,email,education_level,previous_experience,institution_id,school_id,status,record_json,created_by,is_deleted,created_at,updated_at)"
    : "(id,admission_id,provider_id,student_id,course_id,course_title,theory,practical,total,grade,passed,entered_by,institution_id,school_id,learner_id,class_name,subject,score,term,maximum_score,remarks,record_json,is_deleted,created_at,updated_at)";
  const values = type === "admission"
    ? [id, clean(fields.studentId || fields.student_id, 160), clean(fields.fullName || fields.full_name, 160),
      clean(fields.phone, 80), clean(fields.email, 160), clean(fields.educationLevel || fields.education_level, 120),
      clean(fields.previousExperience || fields.previous_experience, 240), t.institutionId, t.schoolId,
      clean(fields.status, 80) || "submitted", JSON.stringify(payload), user.uid, 0, timestamp, timestamp]
    : [id, clean(fields.admissionId || fields.admission_id, 160), "", clean(fields.studentId || fields.student_id, 160),
      clean(fields.courseId || fields.course_id, 120), clean(fields.courseTitle || fields.course_title, 160),
      Number(fields.theory || 0), Number(fields.practical || 0), Number(fields.total ?? fields.score ?? 0), clean(fields.grade, 40),
      fields.passed ? 1 : 0, user.uid, t.institutionId, t.schoolId, clean(fields.learnerId || fields.learner_id, 160),
      clean(fields.className || fields.class_name, 120), clean(fields.subject, 120), Number(fields.score ?? 0),
      clean(fields.term, 80), Number(fields.maximumScore ?? fields.maximum_score ?? 0), clean(fields.remarks, 500),
      JSON.stringify(payload), 0, timestamp, timestamp];
  try {
    await inNeonTransaction(env.PG, async () => {
      if (active) {
        const updateScope = tenantWhere(user, "", "education", 6);
        await env.PG!.query(
          `UPDATE ${table} SET record_json=$1,school_id=$2,institution_id=$3,updated_at=$4 WHERE id=$5 AND ${updateScope.sql} AND is_deleted=0`,
          [JSON.stringify(payload), recordTenant.schoolId, recordTenant.institutionId, timestamp, id, ...updateScope.args],
        );
      } else {
        const inserted = await env.PG!.query<Row>(
          `INSERT INTO ${table} ${columns} VALUES (${values.map((_, index) => `$${index + 1}`).join(",")} ) ON CONFLICT (id) DO NOTHING RETURNING id`,
          values,
        );
        if (!inserted.rows.length) throw new Error("DOMAIN_RECORD_COLLISION");
      }
      await audit(env, user, request.method === "POST" ? "create" : "update", `education_${type}`, id);
    });
  } catch (error) {
    if (error instanceof Error && error.message === "DOMAIN_RECORD_COLLISION") return json({ ok: false, error: "Record ID is unavailable" }, 409);
    throw error;
  }
  return json({ ok: true, record: payload }, request.method === "POST" ? 201 : 200);
}

async function domainRecords(
  request: Request,
  env: AuthEnv,
  user: AuthUser,
  match: RegExpMatchArray,
  forcedType = "",
  capabilityOverride?: { read: string; write: string },
) {
  const sector = match[1];
  const recordId = match[2] || "";
  const method = request.method;
  const input = method === "GET" ? {} : await body(request);
  const type = clean(forcedType || input.recordType || input.type || new URL(request.url).searchParams.get("type"), 80).toLowerCase();
  if (!RECORD_TYPES[sector] || !type || !RECORD_TYPES[sector].has(type)) return json({ ok: false, error: "Unsupported record type" }, 400);
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) return json({ ok: false, error: "Method not allowed" }, 405);
  if (sector === "clinic" && CLINIC_WORKFLOW_RECORD_TYPES.has(type)) {
    return json({ ok: false, error: "Use the Clinic workflow endpoints for operational records" }, 410);
  }
  if (sector === "farm" && ["feed", "feed_consumption"].includes(type) && method !== "GET") {
    return json({ ok: false, error: "Use the atomic Farm feed workflow for feed records" }, 405);
  }
  if (sector === "farm" && type === "produce" && method !== "GET") {
    return json({ ok: false, error: "Use the validated Farm produce workflow" }, 405);
  }
  const noTenantScope = !tenant(user).institutionId && !tenant(user).schoolId;
  if (role(user) !== "superadmin" && noTenantScope && (sector !== "education" || method !== "GET")) {
    return json({
      ok: false,
      error: sector === "education"
        ? "Ask a superadmin to assign a school scope before editing records."
        : "Tenant scope is required",
    }, 403);
  }
  const own = isSelfRole(user, sector);
  if (sector === "mfi" && type === "report" && method !== "GET") return json({ ok: false, error: "MFI reports are read-only" }, 405);
  let readCapability = capabilityOverride?.read || "records.read";
  let writeCapability = capabilityOverride?.write || "records.manage";
  if (own && sector === "clinic") {
    readCapability = "records.own.read";
    writeCapability = type === "appointment" ? "appointments.create" : "";
  } else if (own && sector === "mfi") {
    readCapability = "records.own.read";
    writeCapability = type === "loan" ? "loans.create" : "";
  } else if (own && sector === "farm") {
    readCapability = "records.own.read";
    writeCapability = "records.own.manage";
  } else if (own && sector === "education") {
    readCapability = "records.own.read";
    writeCapability = "";
  } else if (sector === "clinic" && role(user) === "receptionist") {
    readCapability = type === "patient" ? "patients.read" : "appointments.manage";
    writeCapability = type === "appointment" ? "appointments.manage" : "";
  } else if (sector === "clinic" && role(user) === "pharmacist" && type === "pharmacy_inventory") {
    readCapability = "pharmacy.manage";
    writeCapability = "pharmacy.manage";
  } else if (sector === "mfi" && type === "loan_approval") {
    readCapability = "loans.approve";
    writeCapability = "loans.approve";
  } else if (sector === "mfi" && type === "loan" && ["loan_officer", "borrower"].includes(role(user))) {
    writeCapability = "loans.create";
  } else if (sector === "mfi" && type === "report") {
    readCapability = "records.read";
    writeCapability = "";
  }
  const capability = method === "GET" ? readCapability : writeCapability;
  if (!capability || !(await allowed(env, user, sector, capability))) return json({ ok: false, error: "Forbidden" }, 403);
  const teacher = sector === "education" && effectiveRole(user, "education") === "teacher";
  const assignments = teacher ? await teacherAssignmentsForUser(env, user) : [];
  const requireScopedAssignments = teacher && noTenantScope && role(user) !== "superadmin";
  if (teacher && method !== "GET" && !await teacherMayWrite(env, user, type, input, assignments)) {
    return json({ ok: false, error: "This action is limited to your assigned classes and subjects" }, 403);
  }
  if (sector === "education" && (type === "admission" || type === "marks") && method !== "GET") {
    return sharedEducationRecord(request, env, user, type, recordId, input, capability);
  }
  const t = tenant(user);
  const scope = tenantWhere(user, "", sector, 3);
  if (method === "GET") {
    let records = await readRecords(env, user, sector, type);
    if (teacher) {
      records = type === "teacher_assignment"
        ? assignments
        : records.filter((record) => teacherRecordMatchesAssignments(record, type, assignments, requireScopedAssignments));
    }
    if (recordId) records = records.filter((record) => clean(record.id, 300) === recordId || clean(record.id, 300).endsWith(`/${recordId}`));
    return json({ ok: true, records });
  }
  const id = recordId || clean(input.id, 160) || makeId(type);
  if (method === "DELETE" && !recordId) return json({ ok: false, error: "Record ID is required" }, 400);
  if (!env.PG) return json({ ok: false, error: "PostgreSQL persistence is unavailable" }, 503);
  const priorResult = await env.PG.query<Row>(
    `SELECT id,record_json,owner_uid,is_deleted FROM sector_records WHERE id=$1 AND sector=$2 AND ${scope.sql} LIMIT 1`,
    [id, sector, ...scope.args],
  );
  const prior = priorResult.rows[0] && Number(priorResult.rows[0].is_deleted) !== 1 ? priorResult.rows[0] : null;
  let legacyRecord: Row | null = null;
  if (!prior && (method === "PATCH" || method === "PUT" || method === "DELETE" || method === "POST" && Boolean(input.id))) {
    const legacy = await readRecords(env, user, sector, type);
    legacyRecord = legacy.find((record) => clean(record.id, 300) === id || clean(record.id, 300).endsWith(`/${id}`)) || null;
  }
  if (prior && method === "POST" && sector === "farm" && ["feed", "feed_consumption", "attendance"].includes(type)) {
    return json({ ok: true, idempotent: true, record: { id, ...JSON.parse(String(prior.record_json || "{}")) } });
  }
  if ((prior || legacyRecord) && method === "POST") return json({ ok: false, error: "Record already exists" }, 409);
  if ((method === "PATCH" || method === "PUT" || method === "DELETE") && !prior && !legacyRecord) {
    return json({ ok: false, error: "Record not found in this tenant" }, 404);
  }
  if (method === "DELETE") {
    const timestamp = stamp();
    const tombstone = JSON.stringify({ id, recordType: type, schoolId: t.schoolId, institutionId: t.institutionId, deleted: true });
    try {
      await inNeonTransaction(env.PG, async () => {
        if (prior) {
          const deleteScope = tenantWhere(user, "", sector, 5);
          await env.PG!.query(
            `UPDATE sector_records SET is_deleted=1,record_json=$1,updated_at=$2 WHERE id=$3 AND sector=$4 AND ${deleteScope.sql}${own ? ` AND owner_uid=$${5 + deleteScope.args.length}` : ""}`,
            [tombstone, timestamp, id, sector, ...deleteScope.args, ...(own ? [user.uid] : [])],
          );
        } else {
          const inserted = await env.PG!.query<Row>(
            "INSERT INTO sector_records (id,sector,institution_id,school_id,owner_uid,record_type,record_json,created_by,is_deleted,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10) ON CONFLICT (id) DO NOTHING RETURNING id",
            [id, sector, t.institutionId, t.schoolId, own ? user.uid : legacyOwnerUid(legacyRecord!), type, tombstone, user.uid, timestamp, timestamp],
          );
          if (!inserted.rows.length) throw new Error("DOMAIN_RECORD_OUTSIDE_TENANT");
        }
        await audit(env, user, "delete", `${sector}_record`, id);
      });
    } catch (error) {
      if (error instanceof Error && error.message === "DOMAIN_RECORD_OUTSIDE_TENANT") return json({ ok: false, error: "Record is outside this tenant" }, 404);
      throw error;
    }
    return json({ ok: true, deleted: true });
  }
  const previous = prior
    ? JSON.parse(String(prior.record_json || "{}")) as Row
    : legacyRecord?.data && typeof legacyRecord.data === "object"
      ? { ...(legacyRecord.data as Row), id, recordType: type }
      : {};
  const { schoolId: _schoolId, institutionId: _institutionId, ownerUid: requestedOwner, owner_uid: _ownerUid,
    id: _requestedId, recordType: _recordType, type: _type, ...fields } = input;
  let ownerUid = own ? user.uid : clean(prior?.owner_uid, 160) || (legacyRecord ? legacyOwnerUid(legacyRecord) : "") || null;
  if (!own && requestedOwner) {
    const targetScope = await env.PG.query<Row>(
      "SELECT uid FROM users WHERE uid=$1 AND active=TRUE AND disabled=FALSE AND ((school_id=$2 AND $3<>'') OR (institution_id=$4 AND $5<>'')) LIMIT 1",
      [clean(requestedOwner, 160), t.schoolId || "", t.schoolId || "", t.institutionId || "", t.institutionId || ""],
    );
    if (!targetScope.rows[0]) return json({ ok: false, error: "Owner is outside this tenant" }, 400);
    ownerUid = clean(requestedOwner, 160);
  }
  const payload = { ...(method === "PATCH" ? previous : {}), ...fields, id, recordType: type, schoolId: t.schoolId, institutionId: t.institutionId };
  const timestamp = stamp();
  try {
    await inNeonTransaction(env.PG, async () => {
      if ((method === "PATCH" || method === "PUT") && prior) {
        const updateScope = tenantWhere(user, "", sector, 6);
        await env.PG!.query(
          `UPDATE sector_records SET record_json=$1,owner_uid=$2,updated_at=$3 WHERE id=$4 AND sector=$5 AND ${updateScope.sql}${own ? ` AND owner_uid=$${6 + updateScope.args.length}` : ""}`,
          [JSON.stringify(payload), ownerUid, timestamp, id, sector, ...updateScope.args, ...(own ? [user.uid] : [])],
        );
      } else {
        const inserted = await env.PG!.query<Row>(
          "INSERT INTO sector_records (id,sector,institution_id,school_id,owner_uid,record_type,record_json,created_by,is_deleted,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10) ON CONFLICT (id) DO NOTHING RETURNING id",
          [id, sector, t.institutionId, t.schoolId, ownerUid, type, JSON.stringify(payload), user.uid, timestamp, timestamp],
        );
        if (!inserted.rows.length) throw new Error("DOMAIN_RECORD_COLLISION");
      }
      await audit(env, user, method === "POST" ? "create" : "update", `${sector}_record`, id);
    });
  } catch (error) {
    if (error instanceof Error && error.message === "DOMAIN_RECORD_COLLISION") return json({ ok: false, error: "Record ID is unavailable" }, 409);
    throw error;
  }
  return json({ ok: true, record: { ...payload, id } }, method === "POST" ? 201 : 200);
}

async function teacherMayWrite(
  env: AuthEnv,
  user: AuthUser,
  type: string,
  input: Row,
  assignments: Row[],
): Promise<boolean> {
  if (!["marks", "attendance"].includes(type) || !assignments.length || input.id) return false;
  const learnerId = clean(input.learnerId || input.studentId, 300);
  if (!learnerId) return false;
  const learners = await readRecords(env, user, "education", "learner", false);
  const learner = learners.find((record) => {
    const fields = recordFields(record);
    return clean(record.id, 300) === learnerId ||
      clean(fields.studentNumber || fields.student_number || fields.studentId || fields.student_id, 300) === learnerId;
  });
  if (!learner) return false;
  const learnerFields = recordFields(learner);
  const className = teacherName({ className: learnerFields.className || learnerFields.class_name || learnerFields.class });
  const requestedClass = clean(input.className || input.class_name, 100).toLowerCase();
  if (!className || requestedClass && requestedClass !== className) return false;
  const subject = clean(input.subject, 120).toLowerCase();
  return assignments.some((assignment) => teacherName(assignment) === className &&
    (type === "attendance" || Boolean(subject && teacherSubject(assignment) === subject)));
}

function educationRoute(pathname: string): { type: string; recordId: string } | null {
  const routes: Array<[RegExp, string]> = [
    [/^\/api\/school\/(?:learners|students)(?:\/([^/]+))?$/, "learner"],
    [/^\/api\/school\/classes(?:\/([^/]+))?$/, "class"],
    [/^\/api\/school\/subjects(?:\/([^/]+))?$/, "subject"],
    [/^\/api\/school\/attendance(?:\/([^/]+))?$/, "attendance"],
    [/^\/api\/school\/admissions(?:\/([^/]+))?$/, "admission"],
    [/^\/api\/school\/academic\/marks(?:\/([^/]+))?$/, "marks"],
    [/^\/api\/school\/academic\/grading(?:\/([^/]+))?$/, "grading"],
    [/^\/api\/school\/teachers\/assignments(?:\/([^/]+))?$/, "teacher_assignment"],
    [/^\/api\/school\/id-cards(?:\/([^/]+))?$/, "id_card"],
    [/^\/api\/school\/communications(?:\/([^/]+))?$/, "communication"],
    [/^\/api\/school\/bursar\/fees(?:\/([^/]+))?$/, "fee"],
    [/^\/api\/school\/bursar\/statements(?:\/([^/]+))?$/, "statement"],
    [/^\/api\/school\/bursar\/reconciliation(?:\/([^/]+))?$/, "reconciliation"],
  ];
  for (const [pattern, type] of routes) {
    const match = pathname.match(pattern);
    if (match) return { type, recordId: match[1] || "" };
  }
  return null;
}

function educationCapabilitiesFor(type: string, user: AuthUser): { read: string; write: string } {
  const currentRole = effectiveRole(user, "education");
  if (["student", "learner"].includes(currentRole)) return { read: "records.own.read", write: "" };
  if (currentRole === "teacher" && ["learner", "student", "class", "subject", "teacher_assignment"].includes(type)) {
    return { read: "teacher_assignments.read", write: "" };
  }
  if (["learner", "student"].includes(type)) {
    return { read: "students.read", write: currentRole === "headteacher" ? "students.secondary.manage" : "students.manage" };
  }
  if (["marks", "academic_mark", "grading"].includes(type)) return { read: "marks.manage", write: type === "grading" ? "grading.manage" : "marks.manage" };
  if (type === "teacher_assignment") return { read: "teacher_assignments.manage", write: "teacher_assignments.manage" };
  if (type === "class") return { read: "students.read", write: currentRole === "secretary" ? "students.manage" : "classes.manage" };
  if (type === "subject") return { read: "students.read", write: currentRole === "secretary" ? "students.manage" : "subjects.manage" };
  if (type === "attendance") return { read: "attendance.manage", write: "attendance.manage" };
  if (type === "admission") return { read: "admissions.manage", write: "admissions.manage" };
  if (type === "id_card") return { read: "students.read", write: "id_cards.manage" };
  if (type === "communication") return { read: "communications.manage", write: "communications.manage" };
  if (type === "fee") return { read: "fees.manage", write: "fees.manage" };
  if (type === "payment") return { read: "payments.manage", write: "payments.manage" };
  if (type === "reconciliation") return { read: "reconciliation.manage", write: "reconciliation.manage" };
  if (type === "statement") return { read: "statements.read", write: "statements.manage" };
  if (type === "report") {
    const reportCapability = currentRole === "secretary" ? "reports.primary.read" : "reports.secondary.read";
    return { read: reportCapability, write: "" };
  }
  return { read: "students.read", write: "students.manage" };
}

async function educationPayments(request: Request, env: AuthEnv, user: AuthUser) {
  const caps = await capabilities(env, user, "education");
  if (request.method === "GET") {
    if (!can(caps, "payments.manage")) return json({ ok: false, error: "Forbidden" }, 403);
    const scope = tenantWhere(user, "", "education");
    if (!env.PG) return json({ ok: false, error: "PostgreSQL persistence is unavailable" }, 503);
    const rows = await env.PG.query<Row>(
      `SELECT id,institution_id,school_id,payer_id,amount,currency,status,provider,provider_reference,created_at,updated_at FROM payments WHERE ${scope.sql} ORDER BY created_at DESC LIMIT 500`,
      scope.args,
    );
    return json({ ok: true, payments: rows.rows });
  }
  if (request.method !== "POST" || !can(caps, "payments.manage")) return json({ ok: false, error: "Forbidden" }, request.method === "POST" ? 403 : 405);
  const input = await body(request);
  const amount = Number(input.amount);
  const key = clean(input.idempotencyKey || request.headers.get("idempotency-key"), 200);
  if (!Number.isSafeInteger(amount) || amount <= 0 || !key) return json({ ok: false, error: "A positive integer amount and idempotency key are required" }, 400);
  if (!env.PG) return json({ ok: false, error: "PostgreSQL persistence is unavailable" }, 503);
  const t = tenant(user);
  const paymentId = makeId("payment");
  const ts = stamp();
  const scope = tenantWhere(user, "", "education", 2);
  const prior = await env.PG.query<Row>(
    `SELECT id,status FROM payments WHERE idempotency_key=$1 AND ${scope.sql} LIMIT 1`,
    [key, ...scope.args],
  );
  if (prior.rows[0]) return json({ ok: true, payment: prior.rows[0], idempotent: true });
  const collision = await env.PG.query<Row>("SELECT id FROM payments WHERE idempotency_key=$1 LIMIT 1", [key]);
  if (collision.rows[0]) return json({ ok: false, error: "Idempotency key is already used" }, 409);
  const insert = await inNeonTransaction(env.PG, async () => {
    const result = await env.PG!.query<Row>(
      "INSERT INTO payments (id,institution_id,school_id,payer_id,amount,currency,status,provider,provider_reference,idempotency_key,metadata_json,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id,status",
      [paymentId, t.institutionId, t.schoolId, user.uid, amount, clean(input.currency, 8) || "UGX", "pending", null, null, key, JSON.stringify(input.metadata || {}), ts, ts],
    );
    if (result.rows[0]) await audit(env, user, "payment.create", "payment", paymentId);
    return result.rows[0] || null;
  });
  if (!insert) {
    const existing = await env.PG.query<Row>(
      `SELECT id,status FROM payments WHERE idempotency_key=$1 AND ${scope.sql} LIMIT 1`,
      [key, ...scope.args],
    );
    if (existing.rows[0]) return json({ ok: true, payment: existing.rows[0], idempotent: true });
    return json({ ok: false, error: "Idempotency key is already used" }, 409);
  }
  return json({ ok: true, payment: { id: paymentId, amount, currency: clean(input.currency, 8) || "UGX", status: "pending", manual: true }, message: "Payment recorded as pending; no payment gateway is configured." }, 201);
}

async function educationLessons(env: AuthEnv, user: AuthUser, write = false): Promise<Row[]> {
  const r = effectiveRole(user, "education");
  let scopedUser = user;
  if ((r === "student" || r === "learner") && !user.schoolId && !user.institutionId) {
    const own = await readRecords(env, user, "education", "learner", false);
    const matches = own.filter((x) => educationStudentIdentity(x, user));
    const scopes = matches.map((x) => ({ schoolId: clean(x.schoolId || x.school_id, 160) || null, institutionId: clean(x.institutionId || x.institution_id, 160) || null }));
    if (scopes.length !== 1 || (!scopes[0].schoolId && !scopes[0].institutionId)) return [];
    scopedUser = { ...user, schoolId: scopes[0].schoolId, institutionId: scopes[0].institutionId };
  }
  if (r !== "student" && r !== "learner" && r !== "parent" && role(user) !== "superadmin" &&
      !tenant(user).schoolId && !tenant(user).institutionId) return [];
  const scope = tenantWhere(scopedUser, "", "education");
  if (!env.PG) throw new Error("PostgreSQL persistence is unavailable");
  let rows: Row[] = [];
  rows = (await env.PG.query<Row>(
    `SELECT * FROM education_lessons WHERE ${scope.sql} ORDER BY updated_at DESC LIMIT 500`,
    scope.args,
  )).rows;
  const files = await env.PG.query<Row>(
    `SELECT lesson_id,id,filename,content_type,size_bytes FROM education_files WHERE lesson_id IN (${rows.map((_, index) => `$${index + 1}`).join(",") || "NULL"}) ORDER BY created_at`,
    rows.map((x) => x.id),
  );
  const filesByLesson = new Map<string, Row[]>();
  for (const file of files.rows) {
    const list = filesByLesson.get(clean(file.lesson_id)) || [];
    list.push({ id: file.id, filename: file.filename, fileName: file.filename, contentType: file.content_type, sizeBytes: file.size_bytes });
    filesByLesson.set(clean(file.lesson_id), list);
  }
  rows = rows.map((lesson) => ({ ...lesson, files: filesByLesson.get(clean(lesson.id)) || [] }));
  if (role(user) === "superadmin") return rows;
  if (write && r === "teacher") return rows.filter((x) => clean(x.owner_uid) === user.uid);
  if (r === "teacher") return rows.filter((x) => clean(x.owner_uid) === user.uid);
  if (["secretary", "headteacher", "bursar"].includes(r)) return rows;
  if (r === "student" || r === "learner") {
    const learners = await readRecords(env, user, "education", "learner", false);
    const own = learners.find((x) => educationStudentIdentity(x, user));
    const cls = own ? teacherName(recordFields(own)) : "";
    return cls ? rows.filter((x) => Number(x.published) === 1 && clean(x.class_name).toLowerCase() === cls) : [];
  }
  if (r === "parent") {
    const links = await env.PG.query<Row>(
      "SELECT p.learner_id,p.institution_id,p.school_id,s.record_json FROM parent_links p " +
      "JOIN sector_records s ON s.id=p.learner_id AND s.sector='education' AND s.record_type IN ('learner','student') " +
      "WHERE p.parent_uid=$1 AND p.active=1 AND s.institution_id IS NOT DISTINCT FROM p.institution_id AND s.school_id IS NOT DISTINCT FROM p.school_id",
      [user.uid],
    );
    const visible = new Set<string>();
    for (const link of links.rows) {
      let data: Row;
      try { data = JSON.parse(String(link.record_json || "{}")) as Row; } catch { continue; }
      const className = clean(data.className || data.class_name).toLowerCase();
      for (const lesson of rows) {
        if (Number(lesson.published) === 1 &&
            clean(lesson.institution_id) === clean(link.institution_id) &&
            clean(lesson.school_id) === clean(link.school_id) &&
            clean(lesson.class_name).toLowerCase() === className) visible.add(clean(lesson.id));
      }
    }
    return rows.filter((x) => visible.has(clean(x.id)));
  }
  return [];
}

async function educationLessonRoute(request: Request, env: AuthEnv, user: AuthUser) {
  const input = await body(request);
  if (request.method === "GET") {
    const current = effectiveRole(user, "education");
    if (!(await allowed(env, user, "education", "lessons.read")) &&
        !(await allowed(env, user, "education", "lessons.manage"))) return json({ ok: false, error: "Forbidden" }, 403);
    return json({ ok: true, lessons: await educationLessons(env, user) });
  }
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  const current = effectiveRole(user, "education");
  if (!["teacher", "secretary", "headteacher"].includes(current) || !(await allowed(env, user, "education", "lessons.manage"))) {
    return json({ ok: false, error: "Forbidden" }, 403);
  }
  const title = clean(input.title, 200), className = clean(input.className || input.class_name, 120);
  const subject = clean(input.subject, 120), description = clean(input.description, 2000), youtubeUrl = clean(input.youtubeUrl || input.youtube_url, 500);
  if (!title || !className || !subject) return json({ ok: false, error: "Title, className, and subject are required" }, 400);
  let parsed: URL | null = null;
  if (youtubeUrl) {
    try { parsed = new URL(youtubeUrl); } catch { return json({ ok: false, error: "A valid YouTube URL is required" }, 400); }
    if (parsed.protocol !== "https:" || !["youtube.com", "www.youtube.com", "youtu.be", "www.youtu.be"].includes(parsed.hostname.toLowerCase()) ||
        (!parsed.pathname.startsWith("/watch") && !parsed.hostname.includes("youtu.be"))) return json({ ok: false, error: "Only HTTPS YouTube URLs are accepted" }, 400);
  }
  const assignments = current === "teacher" ? await teacherAssignmentsForUser(env, user) : [];
  if (current === "teacher" && !assignments.some((x) => teacherName(x) === className.toLowerCase() && teacherSubject(x) === subject.toLowerCase())) {
    return json({ ok: false, error: "This lesson is limited to your assigned class and subject" }, 403);
  }
  const t = tenant(user), id = makeId("lesson"), ts = stamp();
  try {
    if (!env.PG) return json({ ok: false, error: "PostgreSQL persistence is unavailable" }, 503);
    await inNeonTransaction(env.PG, async () => {
      await env.PG!.query(
        "INSERT INTO education_lessons(id,institution_id,school_id,owner_uid,title,description,class_name,subject,youtube_url,published,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
        [id, t.institutionId, t.schoolId, user.uid, title, description, className, subject, parsed?.toString() || "", 1, ts, ts],
      );
      await audit(env, user, "create", "education_lesson", id);
    });
  } catch { return json({ ok: false, error: "Lesson could not be saved" }, 500); }
  return json({ ok: true, lesson: { id, institutionId: t.institutionId, schoolId: t.schoolId, ownerUid: user.uid, title, description, className, subject, youtubeUrl: parsed?.toString() || "", published: 1 } }, 201);
}

async function educationParentLinks(request: Request, env: AuthEnv, user: AuthUser, linkId = "") {
  const current = effectiveRole(user, "education");
  if (!(await allowed(env, user, "education", "parent_links.manage")) || !["secretary", "headteacher"].includes(current) && role(user) !== "superadmin") return json({ ok: false, error: "Forbidden" }, 403);
  if (!env.PG) return json({ ok: false, error: "PostgreSQL persistence is unavailable" }, 503);
  if (request.method === "DELETE") {
    if (!linkId) return json({ ok: false, error: "Link ID is required" }, 400);
    const sc = tenantWhere(user, "", "education", 3);
    const result = await inNeonTransaction(env.PG, async () => {
      const update = await env.PG!.query<Row>(
        `UPDATE parent_links SET active=0,revoked_at=$1 WHERE id=$2 AND ${sc.sql} AND active=1 RETURNING id`,
        [stamp(), linkId, ...sc.args],
      );
      await audit(env, user, "revoke", "parent_link", linkId);
      return update.rows.length;
    });
    return json({ ok: true, revoked: true, changed: result });
  }
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  const input = await body(request), parentEmail = clean(input.parentEmail, 240).toLowerCase(), learnerId = clean(input.learnerId, 300), relationship = clean(input.relationship, 80) || "parent";
  if (!parentEmail || !learnerId) return json({ ok: false, error: "parentEmail and learnerId are required" }, 400);
  const sc = tenantWhere(user, "", "education", 2);
  const learner = (await env.PG.query<Row>(
    `SELECT id,institution_id,school_id FROM sector_records WHERE id=$1 AND sector='education' AND record_type IN ('learner','student') AND ${sc.sql} AND is_deleted=0 LIMIT 1`,
    [learnerId, ...sc.args],
  )).rows[0];
  if (!learner) return json({ ok: false, error: "Learner is outside this school" }, 404);
  const parent = (await env.PG.query<Row>("SELECT uid,role,active,disabled FROM users WHERE lower(email)=$1 LIMIT 1", [parentEmail])).rows[0];
  if (!parent || parent.active !== true || parent.disabled === true || clean(parent.role).toLowerCase() !== "parent") return json({ ok: false, error: "An active parent account is required" }, 400);
  const learnerTenant = { institutionId: clean(learner.institution_id, 160) || null, schoolId: clean(learner.school_id, 160) || null };
  const id = makeId("plink");
  try {
    await inNeonTransaction(env.PG, async () => {
      await env.PG!.query(
        "INSERT INTO parent_links(id,institution_id,school_id,parent_uid,learner_id,relationship,active,created_by,created_at) VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8)",
        [id, learnerTenant.institutionId, learnerTenant.schoolId, parent.uid, learnerId, relationship, user.uid, stamp()],
      );
      await audit(env, user, "create", "parent_link", id, { parentUid: parent.uid, learnerId });
    });
  } catch { return json({ ok: false, error: "Parent link already exists or could not be saved" }, 409); }
  return json({ ok: true, link: { id, parentUid: parent.uid, learnerId, relationship, active: true, ...learnerTenant } }, 201);
}

async function education(request: Request, env: AuthEnv, user: AuthUser, pathname: string) {
  const caps = await capabilities(env, user, "education");
  const noTenantScope = !tenant(user).institutionId && !tenant(user).schoolId;
  if (noTenantScope && role(user) !== "superadmin" && request.method !== "GET") {
    return json({ ok: false, error: "Ask a superadmin to assign a school scope before editing records." }, 403);
  }
  if (pathname === "/api/school/lessons") return educationLessonRoute(request, env, user);
  const parentLink = pathname.match(/^\/api\/school\/parent-links(?:\/([^/]+))?$/);
  if (parentLink) return educationParentLinks(request, env, user, parentLink[1] || "");
  if (pathname === "/api/school/education-workspace" && request.method === "GET") {
    const currentRole = effectiveRole(user, "education");
    const isSuperadmin = role(user) === "superadmin";
    const isStudent = ["student", "learner"].includes(currentRole);
    if (isStudent) {
      if (!can(caps, "records.own.read")) return json({ ok: false, error: "Student read access is not enabled" }, 403);
      const profiles = await readRecords(env, user, "education", "learner");
      const student = profiles.length === 1 ? profiles[0] : null;
      const result: Row = {
        ok: true,
        role: currentRole,
        workspace: "student",
        schoolId: user.schoolId,
        institutionId: user.institutionId,
        capabilities: caps.map((item) => item.capability),
        student,
        marks: [],
        attendance: [],
        fees: [],
        statements: [],
        subjects: [],
        lessons: [],
      };
      if (student) {
        const studentFields = recordFields(student);
        for (const type of ["marks", "attendance", "fee", "statement"] as const) {
          const matching = (await readRecords(env, user, "education", type, false))
            .filter((record) => studentRecordMatchesOwnProfile(record, student, user));
          result[type === "fee" ? "fees" : type === "statement" ? "statements" : type] = matching;
        }
        const className = teacherName({ className: studentFields.className || studentFields.class_name || studentFields.class });
        if (className) result.classes = (await readRecords(env, user, "education", "class", false))
          .filter((record) => teacherClassLabel(record) === className && sameEducationScope(record, student));
         result.subjects = (await readRecords(env, user, "education", "subject", false))
           .filter((record) => sameEducationScope(record, student));
         result.lessons = await educationLessons(env, user);
      }
      return json(result);
    }
    const isTeacher = currentRole === "teacher";
    if (isTeacher) {
      const assignments = await teacherAssignmentsForUser(env, user);
      const requireScopedAssignments = noTenantScope && role(user) !== "superadmin";
      const result: Row = {
        ok: true,
        role: currentRole,
        workspace: "teacher",
        schoolId: user.schoolId,
        institutionId: user.institutionId,
        capabilities: caps.map((item) => item.capability),
        teacherAssignments: assignments,
        classes: (await readRecords(env, user, "education", "class", false))
          .filter((record) => teacherRecordMatchesAssignments(record, "class", assignments, requireScopedAssignments)),
        subjects: (await readRecords(env, user, "education", "subject", false))
          .filter((record) => teacherRecordMatchesAssignments(record, "subject", assignments, requireScopedAssignments)),
        students: (await readRecords(env, user, "education", "learner", false))
          .filter((record) => teacherRecordMatchesAssignments(record, "learner", assignments, requireScopedAssignments)),
        attendance: (await readRecords(env, user, "education", "attendance", false))
          .filter((record) => teacherRecordMatchesAssignments(record, "attendance", assignments, requireScopedAssignments)),
        marks: (await readRecords(env, user, "education", "marks", false))
          .filter((record) => teacherRecordMatchesAssignments(record, "marks", assignments, requireScopedAssignments)),
         lessons: (await educationLessons(env, user)).filter((lesson) => assignments.some((a) =>
           teacherName(a) === clean(lesson.class_name).toLowerCase() &&
           teacherSubject(a) === clean(lesson.subject).toLowerCase())),
      };
      return json(result);
    }
    if (currentRole === "parent") {
      if (!can(caps, "lessons.read")) return json({ ok: false, error: "Parent lesson access is not enabled" }, 403);
      const parentScope = tenantWhere(user, "", "education", 2);
      const links = await env.PG!.query<Row>(
        `SELECT learner_id,institution_id,school_id FROM parent_links WHERE parent_uid=$1 AND active=1 AND ${parentScope.sql}`,
        [user.uid, ...parentScope.args],
      );
      const children = [];
      for (const link of links.rows) {
        const learnerRow = (await env.PG!.query<Row>(
          "SELECT id,record_json,institution_id,school_id FROM sector_records WHERE id=$1 AND sector='education' AND record_type IN ('learner','student') AND institution_id IS NOT DISTINCT FROM $2 AND school_id IS NOT DISTINCT FROM $3 AND is_deleted=0 LIMIT 1",
          [link.learner_id, link.institution_id, link.school_id],
        )).rows[0];
        if (!learnerRow) continue;
        let learnerData: Row = {};
        try { learnerData = JSON.parse(String(learnerRow.record_json || "{}")) as Row; } catch { continue; }
        const learner = { ...learnerData, id: learnerRow.id, institutionId: learnerRow.institution_id, schoolId: learnerRow.school_id };
        if (!learner) continue;
        const child: Row = { ...learner, marks: [], attendance: [], fees: [], statements: [] };
        const childViewer = { ...user, uid: clean(learnerData.uid || learnerData.userId || learnerData.studentUid || learnerRow.id),
          email: clean(learnerData.email || learnerData.studentEmail), schoolId: clean(link.school_id) || null, institutionId: clean(link.institution_id) || null, role: "student" };
        for (const type of ["marks", "attendance", "fee", "statement"] as const) child[type === "fee" ? "fees" : type === "statement" ? "statements" : type] =
          (await readRecords(env, childViewer, "education", type, false)).filter((x) => studentRecordMatchesOwnProfile(x, learner, childViewer));
        const learnerFields = recordFields(learner);
        child.lessons = (await educationLessons(env, childViewer)).filter((x) =>
          clean(x.class_name).toLowerCase() === teacherName(recordFields(learner)));
        children.push(child);
      }
      return json({ ok: true, role: "parent", workspace: "parent", schoolId: user.schoolId, institutionId: user.institutionId, capabilities: caps.map((x) => x.capability), children });
    }
    const primary = isSuperadmin || currentRole === "secretary";
    const secondary = isSuperadmin || currentRole === "headteacher";
    const finance = isSuperadmin || currentRole === "bursar";
    const hasStudents = can(caps, "students.read");
    const result: Row = {
      ok: true,
      role: currentRole,
      workspace: finance ? "finance" : primary ? "primary" : secondary ? "secondary" : "education",
      schoolId: user.schoolId,
      institutionId: user.institutionId,
      capabilities: caps.map((item) => item.capability),
    };
    if ((primary || secondary || isSuperadmin) && can(caps, "parent_links.manage")) {
      const linkScope = tenantWhere(user, "p", "education");
      result.parentLinks = (await env.PG!.query<Row>(
        `SELECT p.id,p.institution_id,p.school_id,p.parent_uid,u.email AS parentEmail,p.learner_id,p.relationship,p.active,p.created_at,p.revoked_at FROM parent_links p LEFT JOIN users u ON u.uid=p.parent_uid WHERE ${linkScope.sql} ORDER BY p.created_at DESC LIMIT 500`,
        linkScope.args,
      )).rows;
    }
    if (primary || secondary || isSuperadmin) {
      if (hasStudents) result.students = await readRecords(env, user, "education", "learner");
      result.classes = await readRecords(env, user, "education", "class");
      result.subjects = await readRecords(env, user, "education", "subject");
      result.attendance = await readRecords(env, user, "education", "attendance");
    }
    if (secondary || isSuperadmin) {
      result.marks = await readRecords(env, user, "education", "marks");
      result.grading = await readRecords(env, user, "education", "grading");
      result.teacherAssignments = await readRecords(env, user, "education", "teacher_assignment");
      result.secondaryReports = await readRecords(env, user, "education", "report");
    }
    if (primary || isSuperadmin) {
      result.admissions = await readRecords(env, user, "education", "admission");
      result.primaryReports = await readRecords(env, user, "education", "report");
    }
    if (finance || isSuperadmin) {
      const scope = tenantWhere(user, "", "education");
      const paymentsResult = await env.PG!.query<Row>(
        `SELECT id,institution_id,school_id,payer_id,amount,currency,status,provider,provider_reference,created_at,updated_at FROM payments WHERE ${scope.sql} ORDER BY created_at DESC LIMIT 500`,
        scope.args,
      );
      result.finance = {
        fees: await readRecords(env, user, "education", "fee"),
        payments: paymentsResult.rows,
        reconciliations: await readRecords(env, user, "education", "reconciliation"),
        statements: await readRecords(env, user, "education", "statement"),
      };
    }
    return json(result);
  }
  if (pathname === "/api/school/bursar/payments") return educationPayments(request, env, user);
  const match = educationRoute(pathname);
  if (!match) return json({ ok: false, error: "Unknown Education route" }, 404);
  const currentRole = effectiveRole(user, "education");
  if (["student", "learner"].includes(currentRole) &&
    !["learner", "student", "marks", "attendance", "fee", "statement"].includes(match.type)) {
    return json({ ok: false, error: "Students can only access their own school records" }, 403);
  }
  const capabilitiesForType = educationCapabilitiesFor(match.type, user);
  const fakeMatch = ["", "education", match.recordId] as unknown as RegExpMatchArray;
  return domainRecords(request, env, user, fakeMatch, match.type, capabilitiesForType);
}

function publicUser(row: Row) {
  return {
    uid: row.uid || row.id, email: row.email || "", displayName: row.display_name || row.displayName || "",
    role: row.role || "", schoolId: row.school_id || null, institutionId: row.institution_id || null,
    active: Number(row.active ?? 1) === 1, sessionVersion: Number(row.session_version || 1),
  };
}
const ALLOWED_ROLES = new Set([
  "superadmin", "secretary", "headteacher", "head_teacher", "bursar", "accountant", "teacher", "teacher_staff", "teacher_independent", "student", "learner", "parent", "individual", "school", "school_admin",
  "clinic_admin", "doctor", "nurse", "receptionist", "pharmacist", "patient",
  "farm_admin", "farm_director", "farm_manager", "farm_worker",
  "mfi_admin", "loan_officer", "loan_manager", "loan_director", "borrower",
]);
async function adminRoute(request: Request, env: AuthEnv, user: AuthUser, pathname: string) {
  if (role(user) !== "superadmin") return json({ ok: false, error: "Superadmin access required" }, 403);
  if (!env.PG) return json({ ok: false, error: "PostgreSQL persistence is unavailable" }, 503);
  if (pathname === "/api/admin/roles" && request.method === "GET") {
    const rows = await env.PG.query<Capability & { role: string }>("SELECT role,sector,capability,scope FROM role_capabilities ORDER BY role,sector,capability");
    return json({ ok: true, roles: rows.rows });
  }
  if (pathname === "/api/admin/teacher-applications" && request.method === "GET") {
    const rows = await env.PG.query<Row>(
      `SELECT a.id,a.uid,a.application_type,a.organization_name,a.teaching_details,a.status,a.submitted_at,
              u.email,u.display_name
       FROM teacher_applications a JOIN users u ON u.uid=a.uid
       WHERE a.status='pending'
       ORDER BY a.submitted_at ASC LIMIT 300`,
    );
    return json({ ok: true, applications: rows.rows });
  }
  const teacherApplicationReview = pathname.match(/^\/api\/admin\/teacher-applications\/([^/]+)\/review$/);
  if (teacherApplicationReview && request.method === "POST") {
    let applicationId = "";
    try { applicationId = decodeURIComponent(teacherApplicationReview[1]); } catch {}
    if (!applicationId) return json({ ok: false, error: "A valid teacher application is required" }, 400);
    const application = (await env.PG.query<Row>(
      "SELECT uid,application_type,status FROM teacher_applications WHERE id=$1 LIMIT 1",
      [applicationId],
    )).rows[0];
    if (!application || application.status !== "pending") {
      return json({ ok: false, error: "This teacher application is no longer pending review" }, 409);
    }
    const input = await body(request);
    const decision = clean(input.decision, 20).toLowerCase();
    if (decision !== "approve" && decision !== "reject") {
      return json({ ok: false, error: "Choose approve or reject" }, 400);
    }
    const schoolId = clean(input.schoolId, 160) || "";
    const institutionId = clean(input.institutionId, 160) || "";
    const applicationType = clean(application.application_type, 40);
    if (decision === "approve" && applicationType === "teacher_staff" && !schoolId && !institutionId) {
      return json({ ok: false, error: "Assign a school or institution before approving a school teaching application" }, 400);
    }
    if (decision === "approve" && !["teacher_staff", "teacher_independent"].includes(applicationType)) {
      return json({ ok: false, error: "This application has an unsupported teacher type" }, 409);
    }

    const reviewedAt = stamp();
    const reviewClaim = makeId("review");
    if (decision === "approve") {
      try {
        await inNeonTransaction(env.PG, async () => {
          const claimed = await env.PG!.query<Row>(
            `UPDATE teacher_applications
             SET status='approved',reviewed_at=$1,reviewed_by=$2,review_note=$3,review_claim=$4
             WHERE id=$5 AND status='pending'
               AND EXISTS (SELECT 1 FROM users WHERE users.uid=teacher_applications.uid AND users.disabled=FALSE)
             RETURNING uid`,
            [reviewedAt, user.uid, clean(input.note, 500) || null, reviewClaim, applicationId],
          );
          if (!claimed.rows.length) throw new Error("TEACHER_APPLICATION_REVIEW_CONFLICT");
          const updatedUser = await env.PG!.query<Row>(
            `UPDATE users
             SET role=$1,school_id=$2,institution_id=$3,active=TRUE,session_version=session_version+1
             WHERE uid=$4 AND disabled=FALSE
               AND EXISTS (
                 SELECT 1 FROM teacher_applications
                 WHERE id=$5 AND uid=$6 AND status='approved' AND review_claim=$7
               )
             RETURNING uid`,
            [applicationType, schoolId || null, institutionId || null, application.uid, applicationId, application.uid, reviewClaim],
          );
          if (!updatedUser.rows.length) throw new Error("TEACHER_APPLICATION_REVIEW_CONFLICT");
          await audit(env, user, "admin.teacher_application.approve", "teacher_application", applicationId, {
            uid: application.uid, role: applicationType, schoolId: schoolId || null, institutionId: institutionId || null,
          });
        });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "TEACHER_APPLICATION_REVIEW_CONFLICT") throw error;
        return json({ ok: false, error: "This application could not be approved. Refresh the list and try again." }, 409);
      }
      return json({ ok: true, id: applicationId, status: "approved", sessionVersionRevoked: true });
    }

    try {
      await inNeonTransaction(env.PG, async () => {
        const rejected = await env.PG!.query<Row>(
          `UPDATE teacher_applications
           SET status='rejected',reviewed_at=$1,reviewed_by=$2,review_note=$3,review_claim=$4
           WHERE id=$5 AND status='pending'
           RETURNING uid`,
          [reviewedAt, user.uid, clean(input.note, 500) || null, reviewClaim, applicationId],
        );
        if (!rejected.rows.length) throw new Error("TEACHER_APPLICATION_REVIEW_CONFLICT");
        await audit(env, user, "admin.teacher_application.reject", "teacher_application", applicationId, { uid: application.uid });
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "TEACHER_APPLICATION_REVIEW_CONFLICT") throw error;
      return json({ ok: false, error: "This application is no longer pending review" }, 409);
    }
    return json({ ok: true, id: applicationId, status: "rejected" });
  }
  const uid = pathname.match(/^\/api\/admin\/users\/([^/]+)$/)?.[1] || "";
  if (pathname === "/api/admin/users" && request.method === "GET") {
    const rows = await env.PG.query<Row>("SELECT uid,email,display_name,role,school_id,institution_id,active,session_version FROM users ORDER BY email");
    return json({ ok: true, users: rows.rows.map(publicUser) });
  }
  if (pathname === "/api/admin/users" && request.method === "POST") {
    const input = await body(request);
    const email = clean(input.email, 200).toLowerCase();
    const assignedRole = clean(input.role, 80).toLowerCase();
    if (!email.includes("@") || !ALLOWED_ROLES.has(assignedRole)) return json({ ok: false, error: "A valid email and supported role are required" }, 400);
    const schoolId = clean(input.schoolId, 160) || "";
    const institutionId = clean(input.institutionId, 160) || "";
    if (assignedRole !== "superadmin" && !schoolId && !institutionId) return json({ ok: false, error: "A school or institution scope is required for this role" }, 400);
    const newUid = makeId("user");
    await inNeonTransaction(env.PG, async () => {
      await env.PG!.query(
        "INSERT INTO users (uid,email,display_name,role,school_id,institution_id,active,session_version,requires_password_reset,raw_json,imported_at) VALUES ($1,$2,$3,$4,$5,$6,TRUE,1,TRUE,'{}',$7)",
        [newUid, email, clean(input.displayName, 160), assignedRole, schoolId || null, institutionId || null, stamp()],
      );
      await audit(env, user, "admin.user.create", "user", newUid, { email });
    });
    return json({ ok: true, user: { uid: newUid, email, requiresPasswordReset: true } }, 201);
  }
  if (uid && request.method === "PATCH") {
    const input = await body(request);
    const sets: string[] = []; const args: unknown[] = [];
    if (input.role !== undefined) {
      const nextRole = clean(input.role, 80).toLowerCase();
      if (!ALLOWED_ROLES.has(nextRole)) return json({ ok: false, error: "Unsupported role" }, 400);
      sets.push(`role=$${args.length + 1}`); args.push(nextRole);
    }
    if (input.schoolId !== undefined) { sets.push(`school_id=$${args.length + 1}`); args.push(clean(input.schoolId, 160) || null); }
    if (input.institutionId !== undefined) { sets.push(`institution_id=$${args.length + 1}`); args.push(clean(input.institutionId, 160) || null); }
    if (input.active !== undefined) { sets.push(`active=$${args.length + 1}`); args.push(Boolean(input.active)); }
    if (!sets.length) return json({ ok: false, error: "No allowed changes" }, 400);
    sets.push("session_version=session_version+1"); args.push(uid);
    await inNeonTransaction(env.PG, async () => {
      await env.PG!.query(`UPDATE users SET ${sets.join(",")} WHERE uid=$${args.length}`, args);
      await audit(env, user, "admin.user.update", "user", uid, { changed: sets.map((x) => x.split("=")[0]) });
    });
    return json({ ok: true, uid, sessionVersionRevoked: true });
  }
  if (pathname === "/api/admin/audit" && request.method === "GET") {
    const rows = await env.PG.query<Row>("SELECT id,institution_id,school_id,actor_id,action,resource_type,resource_id,metadata_json,created_at FROM audit ORDER BY created_at DESC LIMIT 500");
    return json({ ok: true, audit: rows.rows.map((row) => ({
      ...row,
      metadata: row.metadata_json ? JSON.parse(String(row.metadata_json)) : null,
      metadata_json: undefined,
    })) });
  }
  return json({ ok: false, error: "Not found" }, 404);
}

async function payments(request: Request, env: AuthEnv, user: AuthUser, pathname: string) {
  if (!["GET", "POST"].includes(request.method)) return json({ ok: false, error: "Method not allowed" }, 405);
  if (pathname === "/api/pay" && request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  if (pathname !== "/api/pay" && pathname !== "/api/payments" && pathname.startsWith("/api/payments/") && request.method !== "GET") {
    return json({ ok: false, error: "Payment status can only be changed by a verified provider callback" }, 405);
  }
  const read = request.method === "GET";
  if (!read && role(user) !== "superadmin" && !tenant(user).institutionId && !tenant(user).schoolId) {
    return json({ ok: false, error: "Ask a superadmin to assign a school scope before creating a payment." }, 403);
  }
  if (!(await allowed(env, user, "payments", read ? "payments.read" : "payments.create"))) return json({ ok: false, error: "Payment capability required" }, 403);
  const t = tenant(user);
  const educationStudent = ["student", "learner"].includes(effectiveRole(user, "education"));
  const scope = tenantWhere(user, "", educationStudent ? "education" : "");
  const id = pathname.match(/^\/api\/payments\/([^/]+)$/)?.[1] || "";
  if (!env.PG) return json({ ok: false, error: "PostgreSQL persistence is unavailable" }, 503);
  if (read) {
    const args: unknown[] = [...scope.args];
    let filters = scope.sql;
    if (educationStudent) {
      args.push(user.uid);
      filters += ` AND payer_id=$${args.length}`;
    }
    if (id) {
      args.push(id);
      filters += ` AND id=$${args.length}`;
    }
    const rows = await env.PG.query<Row>(
      `SELECT id,institution_id,school_id,payer_id,amount,currency,status,provider,provider_reference,idempotency_key,metadata_json,created_at,updated_at FROM payments WHERE ${filters} ORDER BY created_at DESC LIMIT 500`,
      args,
    );
    return json({ ok: true, payments: rows.rows.map((r) => ({ ...r, metadata: r.metadata_json ? JSON.parse(String(r.metadata_json)) : null })) });
  }
  const input = await body(request);
  const key = clean(input.idempotencyKey || request.headers.get("idempotency-key"), 200);
  if (!key) return json({ ok: false, error: "Idempotency-Key is required" }, 400);
  const amount = Number(input.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0) return json({ ok: false, error: "Amount must be a positive integer" }, 400);
  const idempotencyScope = tenantWhere(user, "", educationStudent ? "education" : "", 2);
  const priorArgs: unknown[] = [key, ...idempotencyScope.args];
  let priorScopeSql = idempotencyScope.sql;
  if (educationStudent) {
    priorArgs.push(user.uid);
    priorScopeSql += ` AND payer_id=$${priorArgs.length}`;
  }
  const prior = await env.PG.query<Row>(
    `SELECT id,status FROM payments WHERE idempotency_key=$1 AND ${priorScopeSql} LIMIT 1`,
    priorArgs,
  );
  if (prior.rows[0]) return json({ ok: true, payment: prior.rows[0], idempotent: true }, 200);
  const collision = await env.PG.query<Row>("SELECT id FROM payments WHERE idempotency_key=$1 LIMIT 1", [key]);
  if (collision.rows[0]) return json({ ok: false, error: "Idempotency key is already used" }, 409);
  const paymentId = makeId("payment"); const ts = stamp();
  const inserted = await inNeonTransaction(env.PG, async () => {
    const result = await env.PG!.query<Row>(
      "INSERT INTO payments (id,institution_id,school_id,payer_id,amount,currency,status,provider,provider_reference,idempotency_key,metadata_json,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id",
      [paymentId, t.institutionId, t.schoolId, user.uid, amount, clean(input.currency, 8) || "UGX", "pending", null, null, key, JSON.stringify(input.metadata || {}), ts, ts],
    );
    if (result.rows[0]) await audit(env, user, "payment.create", "payment", paymentId);
    return result.rows.length > 0;
  });
  if (!inserted) {
    const existingArgs: unknown[] = [key, ...idempotencyScope.args];
    let existingScopeSql = idempotencyScope.sql;
    if (educationStudent) {
      existingArgs.push(user.uid);
      existingScopeSql += ` AND payer_id=$${existingArgs.length}`;
    }
    const existing = await env.PG.query<Row>(
      `SELECT id,status FROM payments WHERE idempotency_key=$1 AND ${existingScopeSql} LIMIT 1`,
      existingArgs,
    );
    if (existing.rows[0]) return json({ ok: true, payment: existing.rows[0], idempotent: true }, 200);
    return json({ ok: false, error: "Idempotency key is already used" }, 409);
  }
  return json({ ok: true, payment: { id: paymentId, status: "pending", provider: null, manual: true }, message: "Payment recorded as pending; no payment gateway is configured." }, 201);
}

export async function handleDomainRoute(request: Request, env: AuthEnv, user: AuthUser | null | undefined): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return null;
  const protectedRoute = url.pathname.startsWith("/api/school/") || url.pathname.startsWith("/api/clinic") ||
    url.pathname.startsWith("/api/farm") || url.pathname.startsWith("/api/mfi") ||
    url.pathname.startsWith("/api/admin/") || url.pathname === "/api/pay" || url.pathname.startsWith("/api/payments");
  if (!protectedRoute) return null;
  if (!user) return json({ ok: false, error: "Authentication required" }, 401);
  if (!env.PG) return json({ ok: false, error: "PostgreSQL persistence is unavailable" }, 503);
  if (url.pathname.startsWith("/api/school/platform-") || url.pathname.startsWith("/api/admin/platform")) {
    return handleEducationPlatformRoute(request, env, user, url.pathname);
  }
  if (url.pathname.startsWith("/api/admin/")) return adminRoute(request, env, user, url.pathname);
  if (url.pathname.startsWith("/api/school/lessons/") && url.pathname.includes("/files")) {
    return handleEducationFileRoute(request, env, user, url.pathname);
  }
  if (url.pathname.startsWith("/api/school/")) return education(request, env, user, url.pathname);
  if (url.pathname === "/api/pay" || url.pathname.startsWith("/api/payments")) return payments(request, env, user, url.pathname);
  const match = url.pathname.match(/^\/api\/(clinic|farm|mfi)\/records(?:\/([^/]+))?$/);
  if (match) return domainRecords(request, env, user, match);
  const resourceMatch = url.pathname.match(/^\/api\/(clinic|farm|mfi)\/([a-z-]+)(?:\/([^/]+))?$/);
  if (resourceMatch) {
    const aliases: Record<string, Record<string, string>> = {
      clinic: {
        patients: "patient", appointments: "appointment", visits: "visit", prescriptions: "prescription",
        services: "service", branches: "branch", pharmacy: "pharmacy_inventory", inventory: "pharmacy_inventory",
        "product-scans": "product_scan", billing: "billing", payments: "payment",
        "insurance-claims": "insurance_claim", reports: "report_template", communications: "communication",
      },
      farm: {
        farms: "farm", "animal-types": "animal_type", workers: "worker", cameras: "camera",
        "animal-movements": "animal_movement", summaries: "daily_summary", attendance: "attendance",
        "egg-collections": "egg_collection", inventory: "inventory", feed: "feed", "feed-consumption": "feed_consumption",
        produce: "produce", sales: "sale", expenses: "expense", reports: "report_template", "lost-animals": "lost_animal",
      },
      mfi: {
        borrowers: "borrower", customers: "customer", collateral: "collateral", branches: "branch",
        verifications: "verification", decisions: "decision", "loan-products": "loan_product", loans: "loan",
        repayments: "payment", schedules: "repayment_schedule", payments: "payment",
        approvals: "loan_approval", documents: "loan_document", audit: "loan_audit",
        "overdue-log": "overdue_log", "credit-notes": "credit_note", restructures: "restructure",
        writeoffs: "writeoff", reports: "report",
      },
    };
    const type = aliases[resourceMatch[1]]?.[resourceMatch[2]];
    if (type) {
      const aliasMatch = ["", resourceMatch[1], resourceMatch[3] || ""] as unknown as RegExpMatchArray;
      return domainRecords(request, env, user, aliasMatch, type);
    }
  }
  return null;
}
