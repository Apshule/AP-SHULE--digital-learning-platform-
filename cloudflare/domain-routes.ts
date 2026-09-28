import type { AuthEnv, AuthUser } from "./backend-types";

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
  return clean(user.role, 80).toLowerCase();
}
function effectiveRole(user: AuthUser, sector: string): string {
  const r = role(user);
  return sector === "education" && (r === "school" || r === "school_admin") ? "headteacher" : r;
}
function tenant(user: AuthUser): { institutionId: string | null; schoolId: string | null } {
  return { institutionId: user.institutionId || null, schoolId: user.schoolId || null };
}
function tenantWhere(user: AuthUser, alias = ""): { sql: string; args: string[] } {
  if (role(user) === "superadmin") return { sql: "1=1", args: [] };
  const p = alias ? `${alias}.` : "";
  const t = tenant(user);
  if (!t.institutionId && !t.schoolId) return { sql: "1=0", args: [] };
  if (t.schoolId) return { sql: `(${p}school_id = ? OR (${p}school_id IS NULL AND ${p}institution_id = ?))`, args: [t.schoolId, t.institutionId || ""] };
  return { sql: `${p}institution_id = ?`, args: [t.institutionId!] };
}
async function capabilities(env: AuthEnv, user: AuthUser, sector: string): Promise<Capability[]> {
  if (role(user) === "superadmin") return [{ capability: "*", scope: "tenant", sector: "*" }];
  const r = effectiveRole(user, sector);
  const result = await env.DB.prepare(
    "SELECT capability, scope, sector FROM role_capabilities WHERE lower(role)=? AND (sector=? OR sector='*')",
  ).bind(r, sector).all<Capability>();
  return result.results;
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
  await env.DB.prepare(
    "INSERT INTO audit (id,institution_id,school_id,actor_id,action,resource_type,resource_id,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).bind(makeId("audit"), t.institutionId, t.schoolId, user.uid, action, resourceType, resourceId, JSON.stringify(metadata), stamp()).run();
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
function legacyInTenant(record: Row, user: AuthUser): boolean {
  if (role(user) === "superadmin") return true;
  const data = record.data && typeof record.data === "object" ? record.data as Row : {};
  const institution = clean(data.institutionId || data.institution_id, 160);
  const school = clean(data.schoolId || data.school_id, 160);
  const farm = clean(data.farmId || data.farm_id, 160);
  const clinic = clean(data.clinicId || data.clinic_id || data.institutionId, 160);
  const mfi = clean(data.mfiId || data.mfi_id || data.institutionId, 160);
  const t = tenant(user);
  if (t.schoolId) return school === t.schoolId || (!school && Boolean(t.institutionId && institution === t.institutionId));
  return Boolean((t.institutionId && institution === t.institutionId)
    || (t.institutionId && farm === t.institutionId)
    || (t.institutionId && clinic === t.institutionId)
    || (t.institutionId && mfi === t.institutionId));
}
function isSelfRole(user: AuthUser, sector: string) {
  const r = role(user);
  return (sector === "clinic" && r === "patient") || (sector === "mfi" && r === "borrower") ||
    (sector === "farm" && r === "farm_worker");
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
    || data.patientUid || data.patientId || data.borrowerUid || data.borrowerId || data.workerUid, 160);
}

export async function readRecords(env: AuthEnv, user: AuthUser, sector: string, type: string): Promise<Row[]> {
  const scope = tenantWhere(user);
  const result = await env.DB.prepare(`SELECT id,record_json,record_type,created_at,updated_at,owner_uid,is_deleted FROM sector_records WHERE sector=? AND record_type=? AND ${scope.sql} ORDER BY updated_at DESC LIMIT 500`)
    .bind(sector, type, ...scope.args).all<Row>();
  const ownOnly = isSelfRole(user, sector);
  const hiddenIds = new Set(result.results.filter((row) => Number(row.is_deleted) === 1).map((row) => clean(row.id, 300)));
  const activeRows = result.results.filter((row) => Number(row.is_deleted) !== 1);
  const records: Row[] = activeRows
    .filter((row) => !ownOnly || clean(row.owner_uid, 160) === user.uid)
    .map((row) => ({
      id: row.id,
      ...JSON.parse(String(row.record_json || "{}")),
      recordType: row.record_type,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  const collections = legacyCollections(sector, type);
  if (collections.length) {
    const legacy = await env.DB.prepare(
      `SELECT document_path,data_json,create_time,update_time FROM firestore_documents WHERE collection_path IN (${collections.map(() => "?").join(",")}) LIMIT 500`,
    ).bind(...collections).all<Row>();
    for (const row of legacy.results) {
      let record: Row;
      try { record = safeLegacy(row); } catch { continue; }
      const legacyId = clean(record.id, 300);
      if (hiddenIds.has(legacyId) || activeRows.some((entry) => clean(entry.id, 300) === legacyId)) continue;
      if (!legacyInTenant(record, user) || ownOnly && !legacyOwner(record, user.uid)) continue;
      records.push({ ...record, recordType: type });
    }
  }
  return records;
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
  if (role(user) !== "superadmin" && !tenant(user).institutionId && !tenant(user).schoolId) {
    return json({ ok: false, error: "Tenant scope is required" }, 403);
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
  const t = tenant(user);
  const scope = tenantWhere(user);
  if (method === "GET") {
    let records = await readRecords(env, user, sector, type);
    if (recordId) records = records.filter((record) => clean(record.id, 300) === recordId || clean(record.id, 300).endsWith(`/${recordId}`));
    return json({ ok: true, records });
  }
  const id = recordId || clean(input.id, 160) || makeId(type);
  if (method === "DELETE" && !recordId) return json({ ok: false, error: "Record ID is required" }, 400);
  const priorResult = await env.DB.prepare(`SELECT id,record_json,owner_uid,is_deleted FROM sector_records WHERE id=? AND sector=? AND ${scope.sql} LIMIT 1`)
    .bind(id, sector, ...scope.args).all<Row>();
  const prior = priorResult.results[0] && Number(priorResult.results[0].is_deleted) !== 1 ? priorResult.results[0] : null;
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
    if (prior) {
      await env.DB.prepare(`UPDATE sector_records SET is_deleted=1,record_json=?,updated_at=? WHERE id=? AND sector=? AND ${scope.sql}${own ? " AND owner_uid=?" : ""}`)
        .bind(tombstone, timestamp, id, sector, ...scope.args, ...(own ? [user.uid] : [])).run();
    } else {
      const collision = await env.DB.prepare("SELECT id FROM sector_records WHERE id=? LIMIT 1").bind(id).all<Row>();
      if (collision.results[0]) return json({ ok: false, error: "Record is outside this tenant" }, 404);
      await env.DB.prepare("INSERT INTO sector_records (id,sector,institution_id,school_id,owner_uid,record_type,record_json,created_by,is_deleted,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,1,?,?)")
        .bind(id, sector, t.institutionId, t.schoolId, own ? user.uid : legacyOwnerUid(legacyRecord!), type, tombstone, user.uid, timestamp, timestamp).run();
    }
    await audit(env, user, "delete", `${sector}_record`, id);
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
    const targetScope = await env.DB.prepare("SELECT uid FROM users WHERE uid=? AND active=1 AND disabled=0 AND ((school_id=? AND ?<>'') OR (institution_id=? AND ?<>'')) LIMIT 1")
      .bind(clean(requestedOwner, 160), t.schoolId || "", t.schoolId || "", t.institutionId || "", t.institutionId || "").all<Row>();
    if (!targetScope.results[0]) return json({ ok: false, error: "Owner is outside this tenant" }, 400);
    ownerUid = clean(requestedOwner, 160);
  }
  const payload = { ...(method === "PATCH" ? previous : {}), ...fields, id, recordType: type, schoolId: t.schoolId, institutionId: t.institutionId };
  const timestamp = stamp();
  if ((method === "PATCH" || method === "PUT") && prior) {
    await env.DB.prepare(`UPDATE sector_records SET record_json=?,owner_uid=?,updated_at=? WHERE id=? AND sector=? AND ${scope.sql}${own ? " AND owner_uid=?" : ""}`)
      .bind(JSON.stringify(payload), ownerUid, timestamp, id, sector, ...scope.args, ...(own ? [user.uid] : [])).run();
  } else {
    const collision = await env.DB.prepare("SELECT id FROM sector_records WHERE id=? LIMIT 1").bind(id).all<Row>();
    if (collision.results[0]) return json({ ok: false, error: "Record ID is unavailable" }, 409);
    await env.DB.prepare("INSERT INTO sector_records (id,sector,institution_id,school_id,owner_uid,record_type,record_json,created_by,is_deleted,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,0,?,?)")
      .bind(id, sector, t.institutionId, t.schoolId, ownerUid, type, JSON.stringify(payload), user.uid, timestamp, timestamp).run();
  }
  await audit(env, user, method === "POST" ? "create" : "update", `${sector}_record`, id);
  return json({ ok: true, record: { ...payload, id } }, method === "POST" ? 201 : 200);
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
    const scope = tenantWhere(user);
    const rows = await env.DB.prepare(`SELECT id,institution_id,school_id,payer_id,amount,currency,status,provider,provider_reference,created_at,updated_at FROM payments WHERE ${scope.sql} ORDER BY created_at DESC LIMIT 500`)
      .bind(...scope.args).all<Row>();
    return json({ ok: true, payments: rows.results });
  }
  if (request.method !== "POST" || !can(caps, "payments.manage")) return json({ ok: false, error: "Forbidden" }, request.method === "POST" ? 403 : 405);
  const input = await body(request);
  const amount = Number(input.amount);
  const key = clean(input.idempotencyKey || request.headers.get("idempotency-key"), 200);
  if (!Number.isSafeInteger(amount) || amount <= 0 || !key) return json({ ok: false, error: "A positive integer amount and idempotency key are required" }, 400);
  const prior = await env.DB.prepare("SELECT id,status FROM payments WHERE idempotency_key=? LIMIT 1").bind(key).all<Row>();
  if (prior.results[0]) return json({ ok: true, payment: prior.results[0], idempotent: true });
  const t = tenant(user);
  const paymentId = makeId("payment");
  const ts = stamp();
  await env.DB.prepare("INSERT INTO payments (id,institution_id,school_id,payer_id,amount,currency,status,provider,provider_reference,idempotency_key,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(paymentId, t.institutionId, t.schoolId, user.uid, amount, clean(input.currency, 8) || "UGX", "pending", null, null, key, JSON.stringify(input.metadata || {}), ts, ts).run();
  await audit(env, user, "payment.create", "payment", paymentId);
  return json({ ok: true, payment: { id: paymentId, amount, currency: clean(input.currency, 8) || "UGX", status: "pending", manual: true }, message: "Payment recorded as pending; no payment gateway is configured." }, 201);
}

async function education(request: Request, env: AuthEnv, user: AuthUser, pathname: string) {
  const caps = await capabilities(env, user, "education");
  if (!tenant(user).institutionId && !tenant(user).schoolId && role(user) !== "superadmin") return json({ ok: false, error: "Tenant scope is required" }, 403);
  if (pathname === "/api/school/education-workspace" && request.method === "GET") {
    const currentRole = effectiveRole(user, "education");
    const isSuperadmin = role(user) === "superadmin";
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
      const scope = tenantWhere(user);
      const paymentsResult = await env.DB.prepare(`SELECT id,institution_id,school_id,payer_id,amount,currency,status,provider,provider_reference,created_at,updated_at FROM payments WHERE ${scope.sql} ORDER BY created_at DESC LIMIT 500`)
        .bind(...scope.args).all<Row>();
      result.finance = {
        fees: await readRecords(env, user, "education", "fee"),
        payments: paymentsResult.results,
        reconciliations: await readRecords(env, user, "education", "reconciliation"),
        statements: await readRecords(env, user, "education", "statement"),
      };
    }
    return json(result);
  }
  if (pathname === "/api/school/bursar/payments") return educationPayments(request, env, user);
  const match = educationRoute(pathname);
  if (!match) return json({ ok: false, error: "Unknown Education route" }, 404);
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
  "superadmin", "secretary", "headteacher", "bursar", "teacher", "school", "school_admin",
  "clinic_admin", "doctor", "nurse", "receptionist", "pharmacist", "patient",
  "farm_admin", "farm_director", "farm_manager", "farm_worker",
  "mfi_admin", "loan_officer", "loan_manager", "loan_director", "borrower",
]);
async function adminRoute(request: Request, env: AuthEnv, user: AuthUser, pathname: string) {
  if (role(user) !== "superadmin") return json({ ok: false, error: "Superadmin access required" }, 403);
  if (pathname === "/api/admin/roles" && request.method === "GET") {
    const rows = await env.DB.prepare("SELECT role,sector,capability,scope FROM role_capabilities ORDER BY role,sector,capability").all<Capability & { role: string }>();
    return json({ ok: true, roles: rows.results });
  }
  const uid = pathname.match(/^\/api\/admin\/users\/([^/]+)$/)?.[1] || "";
  if (pathname === "/api/admin/users" && request.method === "GET") {
    const rows = await env.DB.prepare("SELECT uid,email,display_name,role,school_id,institution_id,active,session_version FROM users ORDER BY email").all<Row>();
    return json({ ok: true, users: rows.results.map(publicUser) });
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
    await env.DB.prepare("INSERT INTO users (uid,email,display_name,role,school_id,institution_id,active,session_version,requires_password_reset) VALUES (?,?,?,?,?,?,?,?,1)")
      .bind(newUid, email, clean(input.displayName, 160), assignedRole, schoolId || null, institutionId || null, 1, 1).run();
    await audit(env, user, "admin.user.create", "user", newUid, { email });
    return json({ ok: true, user: { uid: newUid, email, requiresPasswordReset: true } }, 201);
  }
  if (uid && request.method === "PATCH") {
    const input = await body(request);
    const sets: string[] = []; const args: unknown[] = [];
    if (input.role !== undefined) {
      const nextRole = clean(input.role, 80).toLowerCase();
      if (!ALLOWED_ROLES.has(nextRole)) return json({ ok: false, error: "Unsupported role" }, 400);
      sets.push("role=?"); args.push(nextRole);
    }
    if (input.schoolId !== undefined) { sets.push("school_id=?"); args.push(clean(input.schoolId, 160) || null); }
    if (input.institutionId !== undefined) { sets.push("institution_id=?"); args.push(clean(input.institutionId, 160) || null); }
    if (input.active !== undefined) { sets.push("active=?"); args.push(input.active ? 1 : 0); }
    if (!sets.length) return json({ ok: false, error: "No allowed changes" }, 400);
    sets.push("session_version=session_version+1"); args.push(uid);
    await env.DB.prepare(`UPDATE users SET ${sets.join(",")} WHERE uid=?`).bind(...args).run();
    await audit(env, user, "admin.user.update", "user", uid, { changed: sets.map((x) => x.split("=")[0]) });
    return json({ ok: true, uid, sessionVersionRevoked: true });
  }
  if (pathname === "/api/admin/audit" && request.method === "GET") {
    const rows = await env.DB.prepare("SELECT id,institution_id,school_id,actor_id,action,resource_type,resource_id,metadata_json,created_at FROM audit ORDER BY created_at DESC LIMIT 500").all<Row>();
    return json({ ok: true, audit: rows.results.map((row) => ({
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
  if (!(await allowed(env, user, "payments", read ? "payments.read" : "payments.create"))) return json({ ok: false, error: "Payment capability required" }, 403);
  const t = tenant(user);
  const scope = tenantWhere(user);
  const id = pathname.match(/^\/api\/payments\/([^/]+)$/)?.[1] || "";
  if (read) {
    const rows = await env.DB.prepare(`SELECT id,institution_id,school_id,payer_id,amount,currency,status,provider,provider_reference,idempotency_key,metadata_json,created_at,updated_at FROM payments WHERE ${scope.sql}${id ? " AND id=?" : ""} ORDER BY created_at DESC LIMIT 500`)
      .bind(...scope.args, ...(id ? [id] : [])).all<Row>();
    return json({ ok: true, payments: rows.results.map((r) => ({ ...r, metadata: r.metadata_json ? JSON.parse(String(r.metadata_json)) : null })) });
  }
  const input = await body(request);
  const key = clean(input.idempotencyKey || request.headers.get("idempotency-key"), 200);
  if (!key) return json({ ok: false, error: "Idempotency-Key is required" }, 400);
  const amount = Number(input.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0) return json({ ok: false, error: "Amount must be a positive integer" }, 400);
  const prior = await env.DB.prepare(`SELECT id,status FROM payments WHERE idempotency_key=? AND ${scope.sql} LIMIT 1`).bind(key, ...scope.args).all<Row>();
  if (prior.results[0]) return json({ ok: true, payment: prior.results[0], idempotent: true }, 200);
  const collision = await env.DB.prepare("SELECT id FROM payments WHERE idempotency_key=? LIMIT 1").bind(key).all<Row>();
  if (collision.results[0]) return json({ ok: false, error: "Idempotency key is already used" }, 409);
  const paymentId = makeId("payment"); const ts = stamp();
  await env.DB.prepare("INSERT INTO payments (id,institution_id,school_id,payer_id,amount,currency,status,provider,provider_reference,idempotency_key,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(paymentId, t.institutionId, t.schoolId, user.uid, amount, clean(input.currency, 8) || "UGX", "pending", null, null, key, JSON.stringify(input.metadata || {}), ts, ts).run();
  await audit(env, user, "payment.create", "payment", paymentId);
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
  if (url.pathname.startsWith("/api/admin/")) return adminRoute(request, env, user, url.pathname);
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
