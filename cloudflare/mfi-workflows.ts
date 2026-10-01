import type { AuthEnv, AuthUser } from "./backend-types";
import type { NeonClient } from "./neon-db";
import { inNeonTransaction } from "./neon-db";

type Row = Record<string, unknown>;
type MfiRole = "mfi_admin" | "loan_officer" | "loan_manager" | "loan_director" | "borrower" | "superadmin";
const ROLES = new Set<MfiRole>(["mfi_admin", "loan_officer", "loan_manager", "loan_director", "borrower", "superadmin"]);
const staff = new Set(["mfi_admin", "loan_officer", "loan_manager", "superadmin"]);
const LEGACY_COLLECTIONS: Record<string, string[]> = {
  borrower: ["mfi_customers"],
  loan_product: ["mfi_loan_products"],
  loan: ["microfinance_loans"],
  repayment_schedule: ["mfi_loan_repayment_schedule"],
  payment: ["mfi_loan_payments"],
  loan_approval: ["mfi_loan_approvals"],
  report: ["mfi_loan_audit", "mfi_loan_overdue_log"],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const text = (v: unknown, n = 240) => String(v ?? "").replace(/\0/g, "").trim().slice(0, n);
const roleOf = (u: AuthUser) => {
  const value = text(u.role, 80).toLowerCase().replace(/[ -]+/g, "_");
  return (value === "super_admin" ? "superadmin" : value) as MfiRole;
};
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
const tenant = (u: AuthUser) => text(u.institutionId, 160);
const own = (u: AuthUser, row: Row) => [row.ownerUid, row.borrowerUid, row.customerUid, row.userId, row.uid].some((v) => text(v, 160) === u.uid);

class MfiPersistenceUnavailable extends Error {}

function pg(env: AuthEnv): NeonClient {
  if (!env.PG) throw new MfiPersistenceUnavailable("PostgreSQL persistence is unavailable");
  return env.PG;
}

async function query<T extends Row = Row>(env: AuthEnv, sql: string, values: unknown[] = []) {
  try {
    return await pg(env).query<T>(sql, values);
  } catch (error) {
    if (error instanceof MfiPersistenceUnavailable) throw error;
    throw new MfiPersistenceUnavailable("PostgreSQL persistence is unavailable");
  }
}

async function transaction<T>(env: AuthEnv, operation: () => Promise<T>): Promise<T> {
  try {
    return await inNeonTransaction(pg(env), operation);
  } catch {
    throw new MfiPersistenceUnavailable("PostgreSQL persistence is unavailable");
  }
}

function can(capabilities: string[], capability: string): boolean {
  if (capabilities.includes("*") || capabilities.includes(capability)) return true;
  if (!capability.endsWith(".read")) return false;
  return capabilities.includes(`${capability.slice(0, -".read".length)}.manage`);
}

async function allowed(env: AuthEnv, user: AuthUser, capability: string): Promise<boolean> {
  if (roleOf(user) === "superadmin") return true;
  const result = await query<{ capability: string }>(
    env,
    "SELECT capability FROM role_capabilities WHERE lower(role)=$1 AND (sector=$2 OR sector='*')",
    [roleOf(user), "mfi"],
  );
  return can(result.rows.map((row) => row.capability), capability);
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
  return Object.fromEntries(Object.entries(v).map(([key, item]) => [key, decodeFirestore(item)]));
}

function legacyOwnerUid(record: Row): string {
  const data = record.data && typeof record.data === "object" ? record.data as Row : {};
  return text(data.uid || data.userId || data.user_id || data.ownerUid || data.owner_uid || data.ownerId
    || data.studentUid || data.student_uid || data.studentId || data.student_id
    || data.patientUid || data.patientId || data.borrowerUid || data.borrowerId || data.workerUid, 160);
}

function legacyInTenant(record: Row, user: AuthUser): boolean {
  if (roleOf(user) === "superadmin") return true;
  const data = record.data && typeof record.data === "object" ? record.data as Row : {};
  const institution = text(data.institutionId || data.institution_id, 160);
  const school = text(data.schoolId || data.school_id, 160);
  const farm = text(data.farmId || data.farm_id, 160);
  const clinic = text(data.clinicId || data.clinic_id || data.institutionId, 160);
  const mfi = text(data.mfiId || data.mfi_id || data.institutionId, 160);
  if (user.schoolId) return school === user.schoolId || (!school && Boolean(tenant(user) && institution === tenant(user)));
  return Boolean(tenant(user) && [institution, farm, clinic, mfi].includes(tenant(user)));
}

async function input(request: Request): Promise<Row | null> {
  try { const value = await request.json(); return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null; } catch { return null; }
}
async function records(env: AuthEnv, user: AuthUser, type: string, lock = false): Promise<Row[]> {
  const role = roleOf(user);
  const values: unknown[] = ["mfi", type];
  const filters = ["sector=$1", "record_type=$2"];
  if (role !== "superadmin") {
    const schoolId = text(user.schoolId, 160);
    if (schoolId) {
      values.push(schoolId, tenant(user));
      filters.push(`(school_id=$${values.length - 1} OR (school_id IS NULL AND institution_id=$${values.length}))`);
    } else {
      values.push(tenant(user));
      filters.push(`institution_id=$${values.length}`);
    }
  }
  const ownOnly = role === "borrower";
  const sectorRows = await query<Row>(
    env,
    `SELECT id,record_json,record_type,created_at,updated_at,owner_uid,is_deleted,school_id,institution_id
     FROM sector_records WHERE ${filters.join(" AND ")}
     ORDER BY updated_at DESC NULLS LAST LIMIT 500${lock ? " FOR SHARE" : ""}`,
    values,
  );
  const hiddenIds = new Set(sectorRows.rows.filter((row) => row.is_deleted === true || Number(row.is_deleted) === 1)
    .map((row) => text(row.id, 300)));
  const records: Row[] = sectorRows.rows
    .filter((row) => (row.is_deleted !== true && Number(row.is_deleted) !== 1)
      && (!ownOnly || text(row.owner_uid, 160) === user.uid))
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
    });

  const collections = LEGACY_COLLECTIONS[type] || LEGACY_COLLECTIONS[type.replace(/s$/, "")] || [];
  if (collections.length) {
    const legacyRows = await query<Row>(
      env,
      `SELECT document_path,data_json,create_time,update_time FROM firestore_documents
       WHERE collection_path IN (${collections.map((_, index) => `$${index + 1}`).join(",")}) LIMIT 500`,
      collections,
    );
    for (const row of legacyRows.rows) {
      let record: Row;
      try {
        record = {
          id: row.document_path,
          data: decodeFirestore(JSON.parse(String(row.data_json || "{}"))),
          createdAt: row.create_time,
          updatedAt: row.update_time,
        };
      } catch {
        continue;
      }
      const legacyId = text(record.id, 300);
      if (hiddenIds.has(legacyId) || records.some((entry) => text(entry.id, 300) === legacyId)) continue;
      if (!legacyInTenant(record, user) || ownOnly && legacyOwnerUid(record) !== user.uid) continue;
      records.push({ ...record, recordType: type });
    }
  }
  return records;
}
function money(value: unknown): number {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount) : 0;
}

/** Compatibility normalization for both Step 1 aggregate and Step 2 component schedules. */
export function normalizeInstallment(row: Row): Row {
  const principalDue = money(row.principalDue);
  const interestDue = money(row.interestDue);
  const lateFeeDue = money(row.lateFeeDue ?? row.lateFeeApplied);
  const explicit = ["principalPaid", "interestPaid", "lateFeePaid"].some((key) => row[key] !== undefined);
  const aggregate = money(row.paidAmount);
  const principalPaid = Math.min(principalDue, money(row.principalPaid ?? (explicit ? 0 : row.paidPrincipal)));
  const interestPaid = Math.min(interestDue, money(row.interestPaid ?? (!explicit ? Math.max(0, aggregate - principalPaid - money(row.lateFeePaid)) : 0)));
  const lateFeePaid = Math.min(lateFeeDue, money(row.lateFeePaid));
  return {
    ...row, principalDue, interestDue, lateFeeDue, principalPaid, interestPaid, lateFeePaid,
    principalBalance: Math.max(0, principalDue - principalPaid),
    interestBalance: Math.max(0, interestDue - interestPaid),
    lateFeeBalance: Math.max(0, lateFeeDue - lateFeePaid),
  };
}

export function allocateManualRepayment(amountValue: unknown, rows: Row[]) {
  let remaining = money(amountValue);
  const updatedSchedule = rows.map(normalizeInstallment).sort((a, b) => Number(a.installmentNumber || 0) - Number(b.installmentNumber || 0));
  const applications: Row[] = [];
  for (const row of updatedSchedule) {
    const late = Math.min(remaining, money(row.lateFeeBalance)); remaining -= late;
    const interest = Math.min(remaining, money(row.interestBalance)); remaining -= interest;
    const principal = Math.min(remaining, money(row.principalBalance)); remaining -= principal;
    const next: Row = { ...row, lateFeePaid: money(row.lateFeePaid) + late, interestPaid: money(row.interestPaid) + interest, principalPaid: money(row.principalPaid) + principal };
    next.lateFeeBalance = Math.max(0, money(row.lateFeeBalance) - late);
    next.interestBalance = Math.max(0, money(row.interestBalance) - interest);
    next.principalBalance = Math.max(0, money(row.principalBalance) - principal);
    next.paidAmount = money(row.paidAmount) + late + interest + principal;
    next.paidPrincipal = next.principalPaid;
    next.status = money(next.lateFeeBalance) + money(next.interestBalance) + money(next.principalBalance) === 0 ? "paid" : "partially_paid";
    updatedSchedule[updatedSchedule.indexOf(row)] = next;
    if (late + interest + principal) applications.push({ installmentId: row.id, amount: late + interest + principal, amountToLateFee: late, amountToInterest: interest, amountToPrincipal: principal });
    if (remaining <= 0) break;
  }
  return { applications, updatedSchedule, overpayment: remaining, remainingLoanBalance: updatedSchedule.reduce((n, r) => n + money(r.principalBalance) + money(r.interestBalance) + money(r.lateFeeBalance), 0) };
}

export function preview(principal: number, rate: number, term: number, type: string, processing = 0, insurance = 0) {
  const p = money(principal), t = Math.max(1, Math.floor(term)), r = Math.max(0, Number(rate) || 0) / 100;
  const processingFee = p * Math.max(0, processing) / 100;
  const insuranceFee = p * Math.max(0, insurance) / 100;
  if (type.toLowerCase() === "flat") {
    const totalInterest = p * r * t;
    const totalRepayment = p + totalInterest + insuranceFee;
    return {
      principal: p, termMonths: t, totalInterest: Math.round(totalInterest),
      totalFees: Math.round(insuranceFee), processingFee: Math.round(processingFee),
      insuranceFee: Math.round(insuranceFee), totalRepayment: Math.round(totalRepayment),
      installment: Math.round(totalRepayment / t),
    };
  }
  const installment = r
    ? p * r * Math.pow(1 + r, t) / (Math.pow(1 + r, t) - 1)
    : p / t;
  let balance = p;
  let totalInterest = 0;
  for (let index = 0; index < t; index += 1) {
    const interest = balance * r;
    totalInterest += interest;
    balance = Math.max(0, balance - (installment - interest));
  }
  return {
    principal: p, termMonths: t, totalInterest: Math.round(totalInterest),
    totalFees: Math.round(insuranceFee), processingFee: Math.round(processingFee),
    insuranceFee: Math.round(insuranceFee),
    totalRepayment: Math.round(p + totalInterest + insuranceFee),
    installment: Math.round(installment),
  };
}

async function save(env: AuthEnv, user: AuthUser, type: string, value: Row, ownerUid: string | null = null) {
  const ts = new Date().toISOString();
  const record = { ...value, id: id(type), recordType: type, institutionId: tenant(user), updatedAt: ts };
  await query(env, `INSERT INTO sector_records
    (id,sector,institution_id,school_id,owner_uid,record_type,record_json,created_by,is_deleted,created_at,updated_at)
    VALUES ($1,'mfi',$2,NULL,$3,$4,$5,$6,0,$7,$7)`,
  [record.id, tenant(user), ownerUid, type, JSON.stringify(record), user.uid, ts]);
  return record;
}

export async function handleMfiWorkflowRoute(request: Request, env: AuthEnv, user: AuthUser | null | undefined): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/mfi/")) return null;
  if (!user) return json({ ok: false, error: "Authentication required" }, 401);
  const role = roleOf(user);
  if (!ROLES.has(role)) return json({ ok: false, error: "MFI access required" }, 403);
  if (!tenant(user)) return json({ ok: false, error: "Select an MFI tenant before continuing" }, 403);
  if (!["GET", "POST"].includes(request.method)) return json({ ok: false, error: "Only GET and POST are supported" }, 405);
  const path = url.pathname.replace(/^\/api\/mfi\/?/, "").split("/").filter(Boolean);
  const head = path[0] || "";
  if (head === "preview" && request.method === "POST") {
    const data = await input(request); if (!data) return json({ ok: false, error: "JSON preview is required" }, 400);
    const principal = Number(data.principal ?? data.amount);
    const term = Number(data.termMonths ?? data.term);
    const rate = Number(data.rate ?? data.interestRate ?? 0);
    const processing = Number(data.processingFee ?? 0);
    const insurance = Number(data.insuranceFee ?? 0);
    const repaymentType = text(data.repaymentType || data.type).toLowerCase();
    if (!Number.isFinite(principal) || principal <= 0 || !Number.isFinite(term) || term <= 0
      || !Number.isFinite(rate) || rate < 0 || !Number.isFinite(processing) || processing < 0
      || !Number.isFinite(insurance) || insurance < 0
      || !["flat", "reducing balance"].includes(repaymentType)) {
      return json({ ok: false, error: "Positive principal and term, nonnegative rates/fees, and Flat or Reducing Balance repayment type are required" }, 400);
    }
    return json({ ok: true, preview: preview(principal, rate, term, repaymentType, processing, insurance) });
  }
  if (head === "repayments" && request.method === "POST") {
    // Allocation is intentionally exposed as a pure helper only. Without a
    // payment idempotency protocol, never claim that a payment changed schedules
    // or balances.
    return json({ ok: false, error: "Manual repayment recording is disabled; use the repayment preview only" }, 410);
  }
  if (head === "reports" && request.method !== "GET") {
    return json({ ok: false, error: "MFI reports are read-only" }, 405);
  }

  const databaseBacked = (head === "workspace" && request.method === "GET")
    || (head === "reports" && request.method === "GET")
    || (["loans", "schedules", "payments"].includes(head) && request.method === "GET")
    || head === "borrowers"
    || (head === "products" && request.method === "GET")
    || head === "applications"
    || head === "approvals";
  if (!databaseBacked) return json({ ok: false, error: "Unknown MFI workflow route" }, 404);
  if (!env.PG) return json({ ok: false, error: "PostgreSQL persistence is unavailable" }, 503);

  try {
    if (head === "workspace" && request.method === "GET") {
      const readCapability = role === "borrower" ? "records.own.read" : "records.read";
      if (!await allowed(env, user, readCapability)) {
        return json({ ok: false, error: "MFI workspace access is not allowed for this role" }, 403);
      }
      const result: Row = { ok: true, role, institutionId: tenant(user) || null, reports: [] };
      result.borrowers = await records(env, user, "borrower");
      result.products = await records(env, user, "loan_product");
      result.loans = await records(env, user, "loan");
      result.schedules = await records(env, user, "repayment_schedule");
      result.repayments = await records(env, user, "repayment");
      return json(result);
    }
    if (head === "reports") {
      if (!await allowed(env, user, "records.read")) {
        return json({ ok: false, error: "MFI report access is not allowed for this role" }, 403);
      }
      return json({ ok: true, reports: await records(env, user, "report") });
    }
    if (["loans", "schedules", "payments"].includes(head) && request.method === "GET") {
      const type = head === "loans" ? "loan" : head === "schedules" ? "repayment_schedule" : "repayment";
      return json({ ok: true, records: await records(env, user, type) });
    }
    if (head === "borrowers") {
      if (request.method === "GET") return json({ ok: true, records: await records(env, user, "borrower") });
      if (!staff.has(role)) return json({ ok: false, error: "Borrower changes require MFI staff" }, 403);
      const data = await input(request); if (!data) return json({ ok: false, error: "JSON borrower record is required" }, 400);
      if (!text(data.fullName || data.name) || !text(data.nextOfKinName) || !text(data.nextOfKinPhone)) return json({ ok: false, error: "Name and next-of-kin details are required" }, 400);
      if (text(data.maritalStatus).toLowerCase() === "married" && (!text(data.spouseName) || !text(data.spousePhone))) return json({ ok: false, error: "Spouse details are required for married borrowers" }, 400);
      const linkedUid = text(data.uid || data.userId, 160);
      const borrowerRecord = {
        ...data, uid: linkedUid || null, userId: linkedUid || null,
        ownerUid: linkedUid || null, borrowerUid: linkedUid || null,
      };
      const borrower = await transaction(env, async () => {
        if (linkedUid) {
          const account = await query<Row>(
            env,
            "SELECT uid FROM users WHERE uid=$1 AND lower(role)='borrower' AND institution_id=$2 AND active=TRUE AND disabled=FALSE LIMIT 1 FOR SHARE",
            [linkedUid, tenant(user)],
          );
          if (!account.rows[0]) return null;
        }
        return save(env, user, "borrower", borrowerRecord, linkedUid || null);
      });
      if (!borrower) return json({ ok: false, error: "Linked borrower account must be active in this MFI tenant" }, 400);
      return json({ ok: true, borrower }, 201);
    }
    if (head === "products" && request.method === "GET") {
      return json({ ok: true, records: await records(env, user, "loan_product") });
    }
    if (head === "applications") {
      if (request.method === "GET") return json({ ok: true, records: await records(env, user, "loan_application") });
      if (!["borrower", "loan_officer", "mfi_admin"].includes(role)) return json({ ok: false, error: "Application creation is restricted" }, 403);
      const data = await input(request); if (!data || money(data.amount) <= 0 || money(data.termMonths) <= 0) return json({ ok: false, error: "Positive amount and term are required" }, 400);
      const requestedBorrower = text(data.borrowerUid || data.customerUid);
      const outcome = await transaction(env, async () => {
        const borrowers = await records(env, user, "borrower", true);
        const borrower = role === "borrower"
          ? borrowers.find((row) => own(user, row))
          : borrowers.find((row) => text(row.id, 300) === requestedBorrower || text(row.uid || row.userId, 160) === requestedBorrower);
        if (!borrower) return "borrower_missing" as const;
        // The authenticated borrower owns every application they submit; the browser
        // cannot substitute another borrower UID.
        const owner = role === "borrower" ? user.uid : text(borrower.uid || borrower.userId || borrower.ownerUid, 160) || null;
        if (!owner) return "owner_missing" as const;
        return {
          application: await save(env, user, "loan_application", {
            ...data, borrowerId: text(borrower.id, 300), borrowerName: text(borrower.fullName || borrower.name, 160),
            borrowerUid: owner, ownerUid: owner, status: "pending",
          }, owner),
        };
      });
      if (outcome === "borrower_missing") return json({ ok: false, error: "Borrower must already exist in this tenant" }, 400);
      if (outcome === "owner_missing") return json({ ok: false, error: "Borrower account ownership is required" }, 400);
      return json({ ok: true, application: outcome.application }, 201);
    }
    if (head === "approvals") {
      if (!await allowed(env, user, "loans.approve")) {
        return json({ ok: false, error: "This role is not authorized for MFI loan approvals" }, 403);
      }
      if (request.method === "GET") {
        return json({ ok: true, records: await records(env, user, "loan_approval") });
      }
      const data = await input(request); if (!data || !text(data.loanId) || !text(data.decision)) return json({ ok: false, error: "Loan, decision, and explicit role are required" }, 400);
      const decision = text(data.decision).toLowerCase();
      if (!["approved", "rejected", "top_up"].includes(decision)) return json({ ok: false, error: "Decision must be approved, rejected, or top_up" }, 400);
      if (["rejected", "top_up"].includes(decision) && !text(data.comment, 1000)) return json({ ok: false, error: "A comment is required for rejection or top-up" }, 400);
      const approval = await transaction(env, async () => {
        const loans = await records(env, user, "loan", true);
        if (!loans.some((loan) => text(loan.id, 300) === text(data.loanId, 300))) return null;
        return save(env, user, "loan_approval", {
          loanId: text(data.loanId), decision, comment: text(data.comment, 1000),
          approvedBy: user.uid, approvedRole: role,
        }, null);
      });
      if (!approval) return json({ ok: false, error: "Loan not found in this tenant" }, 404);
      return json({ ok: true, approval }, 201);
    }
    return json({ ok: false, error: "Unknown MFI workflow route" }, 404);
  } catch (error) {
    if (error instanceof MfiPersistenceUnavailable) {
      return json({ ok: false, error: "PostgreSQL persistence is unavailable" }, 503);
    }
    throw error;
  }
}