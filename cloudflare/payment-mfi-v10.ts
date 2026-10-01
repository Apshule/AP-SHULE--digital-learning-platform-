import type { AuthEnv, AuthUser } from "./backend-types";
import type { NeonClient } from "./neon-db";
import { inNeonTransaction } from "./neon-db";

type Row = Record<string, unknown>;
type QueryResult<T> = { rows: T[]; rowCount?: number | null };
type PaymentEnv = AuthEnv & { YO_API_PUBLIC_KEY?: string };
type MfiRole = "mfi_admin" | "loan_officer" | "loan_manager" | "loan_director" | "borrower" | "superadmin";
const MFI_ROLES = new Set<MfiRole>(["mfi_admin", "loan_officer", "loan_manager", "loan_director", "borrower", "superadmin"]);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const clean = (value: unknown, max = 240) => String(value ?? "").replace(/\0/g, "").trim().slice(0, max);
const now = () => new Date().toISOString();
const makeId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
const roleOf = (user: AuthUser): MfiRole => {
  const value = clean(user.role, 80).toLowerCase().replace(/[ -]+/g, "_");
  return (value === "super_admin" ? "superadmin" : value) as MfiRole;
};
const tenantOf = (user: AuthUser) => clean(user.institutionId, 160);
const safeFailure = () => json({ ok: false, error: "PostgreSQL persistence is unavailable" }, 503);

class PersistenceError extends Error {}

function db(env: PaymentEnv): NeonClient {
  if (!env.PG) throw new PersistenceError("PostgreSQL persistence is unavailable");
  return env.PG;
}

async function query<T extends Row = Row>(env: PaymentEnv, sql: string, values: unknown[] = []): Promise<QueryResult<T>> {
  try {
    return await db(env).query<T>(sql, values) as QueryResult<T>;
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    throw new PersistenceError("PostgreSQL persistence is unavailable");
  }
}

async function transaction<T>(env: PaymentEnv, action: () => Promise<T>): Promise<T> {
  try {
    return await inNeonTransaction(db(env), action);
  } catch (error) {
    if (error instanceof PersistenceError || error instanceof Error &&
        ["LOAN_TERMS_INVALID", "RECORD_COLLISION", "RECORD_SCOPE_CHANGED"].includes(error.message)) throw error;
    throw new PersistenceError("PostgreSQL persistence is unavailable");
  }
}

function money(value: unknown): number {
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : 0;
}

function cents(value: unknown): number | null {
  const source = String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(source)) return null;
  const [whole, fraction = ""] = source.split(".");
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

function fields(raw: string, contentType: string): Row {
  const type = contentType.toLowerCase();
  if (type.includes("application/json")) {
    try {
      const value = JSON.parse(raw);
      return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
    } catch { return {}; }
  }
  if (type.includes("application/x-www-form-urlencoded") || (!type.includes("xml") && raw.includes("="))) {
    const result: Row = {};
    new URLSearchParams(raw).forEach((value, key) => { result[key] = value; });
    return result;
  }
  const result: Row = {};
  for (const name of ["external_ref", "ExternalReference", "amount", "network_ref", "reference", "transaction_id", "status", "signature"]) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = raw.match(new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)<\\/${escaped}\\s*>`, "i"));
    if (match) result[name] = match[1].trim();
  }
  return result;
}

function callbackSignature(request: Request, raw: string, body: Row): { signature: string; signedBody: string } {
  const header = request.headers.get("x-yo-signature") || request.headers.get("yo-signature");
  if (header) return { signature: header.trim(), signedBody: raw };
  const signature = clean(body.signature || new URLSearchParams(raw).get("signature"), 2048);
  // When the provider carries the signature as a form field, that field is the
  // envelope, not signed content. All remaining body bytes are retained exactly.
  const signedBody = raw.replace(/(^|&)signature=[^&]*(?=&|$)/i, (_match, prefix: string) => prefix === "&" ? "" : "")
    .replace(/^&|&$/g, "");
  return { signature, signedBody };
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value.replace(/\s/g, ""));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch { return null; }
}

function derLength(length: number): number[] {
  if (length < 128) return [length];
  if (length < 256) return [0x81, length];
  return [0x82, (length >> 8) & 0xff, length & 0xff];
}

async function verifyYoSignature(env: PaymentEnv, signature: string, signedBody: string): Promise<boolean> {
  const pem = clean(env.YO_API_PUBLIC_KEY, 16_000);
  const bytes = decodeBase64(signature);
  if (!pem || !bytes) return false;
  try {
    const pkcs1 = pem.includes("-----BEGIN RSA PUBLIC KEY-----");
    const base64 = pem.replace(/-----BEGIN (?:RSA )?PUBLIC KEY-----|-----END (?:RSA )?PUBLIC KEY-----|\s/g, "");
    const keyBytes = decodeBase64(base64);
    if (!keyBytes) return false;
    const spkiBytes = pkcs1
      ? (() => {
        const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
        const bitString = [0x03, ...derLength(keyBytes.length + 1), 0x00, ...keyBytes];
        const content = [...algorithm, ...bitString];
        return new Uint8Array([0x30, ...derLength(content.length), ...content]);
      })()
      : keyBytes;
    const key = await crypto.subtle.importKey(
      "spki", spkiBytes.buffer.slice(spkiBytes.byteOffset, spkiBytes.byteOffset + spkiBytes.byteLength) as ArrayBuffer,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-1" }, false, ["verify"],
    );
    return await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5", key,
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      new TextEncoder().encode(signedBody),
    );
  } catch { return false; }
}

async function processIpn(request: Request, env: PaymentEnv): Promise<Response> {
  if (request.method !== "POST") return json({ ok: false, error: "Only POST is supported" }, 405);
  if (!env.PG) return safeFailure();
  const raw = await request.text();
  const body = fields(raw, request.headers.get("content-type") || "");
  const { signature, signedBody } = callbackSignature(request, raw, body);
  if (!await verifyYoSignature(env, signature, signedBody)) {
    return json({ ok: false, error: "Invalid webhook signature" }, 401);
  }

  const reference = clean(body.external_ref || body.ExternalReference, 240);
  const amountCents = cents(body.amount);
  if (!reference || amountCents === null) {
    return json({ ok: false, error: "A valid payment reference and amount are required" }, 400);
  }
  const networkRef = clean(body.network_ref, 240);
  const eventKey = networkRef
    ? `yo-network:${networkRef}`
    : `yo-body:${await sha256(signedBody)}`;
  const timestamp = now();
  try {
    const result = await transaction(env, async () => {
      await query(env, "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`yo-ipn:${eventKey}`]);
      const seen = await query<Row>(env, "SELECT event_key,payment_id,result_json FROM yo_ipn_events WHERE event_key=$1 FOR UPDATE", [eventKey]);
      if (seen.rows[0]) {
        let previous: Row = {};
        try { previous = JSON.parse(String(seen.rows[0].result_json || "{}")) as Row; } catch { /* stored response is optional */ }
        return { kind: "duplicate" as const, response: previous };
      }
      const match = await query<Row>(env,
        `SELECT id,amount,status,provider,provider_reference,institution_id,payer_id
         FROM payments WHERE provider_reference=$1
           AND regexp_replace(lower(COALESCE(provider,'')),'[^a-z]','','g')='yo'
         ORDER BY created_at DESC FOR UPDATE`,
        [reference],
      );
      const payment = match.rows[0];
      if (match.rows.length !== 1 || !payment) {
        const response = { ok: true, processed: false };
        await query(env,
          `INSERT INTO yo_ipn_events (event_key,provider_reference,network_reference,payment_id,status,result_json,received_at)
           VALUES ($1,$2,$3,NULL,$4,$5,$6)`,
          [eventKey, reference, networkRef || null, match.rows.length ? "ambiguous" : "unmatched", JSON.stringify(response), timestamp],
        );
        return { kind: "unmatched" as const, response };
      }
      const expected = cents(Number(payment.amount).toFixed(2));
      if (expected === null || expected !== amountCents) {
        const response = { ok: false, error: "Callback amount does not match the pending payment" };
        await query(env,
          `INSERT INTO yo_ipn_events (event_key,provider_reference,network_reference,payment_id,status,result_json,received_at)
           VALUES ($1,$2,$3,$4,'amount_mismatch',$5,$6)`,
          [eventKey, reference, networkRef || null, payment.id, JSON.stringify(response), timestamp],
        );
        return { kind: "amount_mismatch" as const, response };
      }
      if (String(payment.status).toLowerCase() !== "pending") {
        const response = { ok: false, error: "Payment is no longer pending" };
        await query(env,
          `INSERT INTO yo_ipn_events (event_key,provider_reference,network_reference,payment_id,status,result_json,received_at)
           VALUES ($1,$2,$3,$4,'not_pending',$5,$6)`,
          [eventKey, reference, networkRef || null, payment.id, JSON.stringify(response), timestamp],
        );
        return { kind: "not_pending" as const, response };
      }
      const settlement = await query<Row>(env,
        "UPDATE payments SET status='completed',updated_at=$1 WHERE id=$2 AND status='pending' RETURNING id",
        [timestamp, payment.id],
      );
      if (!settlement.rows.length) throw new Error("PAYMENT_SETTLEMENT_RACE");
      const response = { ok: true, processed: true, paymentId: String(payment.id) };
      await query(env,
        `INSERT INTO yo_ipn_events (event_key,provider_reference,network_reference,payment_id,status,result_json,received_at)
         VALUES ($1,$2,$3,$4,'settled',$5,$6)`,
        [eventKey, reference, networkRef || null, payment.id, JSON.stringify(response), timestamp],
      );
      return { kind: "settled" as const, response };
    });
    if (result.kind === "amount_mismatch") return json(result.response, 400);
    if (result.kind === "not_pending") return json(result.response, 409);
    return json(result.response);
  } catch (error) {
    if (error instanceof PersistenceError) return safeFailure();
    return json({ ok: false, error: "Payment callback could not be processed" }, 500);
  }
}

async function sha256(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hasCapability(env: PaymentEnv, user: AuthUser, capability: string): Promise<boolean> {
  if (roleOf(user) === "superadmin") return true;
  const result = await query<{ capability: string }>(env,
    "SELECT capability FROM role_capabilities WHERE lower(role)=$1 AND (sector='mfi' OR sector='*')",
    [roleOf(user)],
  );
  const grants = result.rows.map((row) => row.capability);
  return grants.includes("*") || grants.includes(capability) || grants.includes("records.manage");
}

async function parseJson(request: Request): Promise<Row | null> {
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
  } catch { return null; }
}

export function normalizeMfiInstallmentV10(row: Row): Row {
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

export function allocateMfiRepaymentV10(amount: number, schedule: Row[]) {
  let remaining = amount;
  const updated = schedule.map(normalizeMfiInstallmentV10)
    .sort((a, b) => Number(a.installmentNumber || 0) - Number(b.installmentNumber || 0));
  const applications: Row[] = [];
  for (const row of updated) {
    const late = Math.min(remaining, money(row.lateFeeBalance)); remaining -= late;
    const interest = Math.min(remaining, money(row.interestBalance)); remaining -= interest;
    const principal = Math.min(remaining, money(row.principalBalance)); remaining -= principal;
    const next: Row = {
      ...row,
      lateFeePaid: money(row.lateFeePaid) + late,
      interestPaid: money(row.interestPaid) + interest,
      principalPaid: money(row.principalPaid) + principal,
      paidAmount: money(row.paidAmount) + late + interest + principal,
      paidPrincipal: money(row.principalPaid) + principal,
      updatedAt: now(),
    };
    next.lateFeeBalance = Math.max(0, money(row.lateFeeBalance) - late);
    next.interestBalance = Math.max(0, money(row.interestBalance) - interest);
    next.principalBalance = Math.max(0, money(row.principalBalance) - principal);
    next.status = money(next.lateFeeBalance) + money(next.interestBalance) + money(next.principalBalance) === 0 ? "paid" : "partially_paid";
    Object.assign(row, next);
    if (late + interest + principal > 0) applications.push({
      installmentId: clean(row.id, 300), amount: late + interest + principal,
      amountToLateFee: late, amountToInterest: interest, amountToPrincipal: principal,
    });
    if (remaining === 0) break;
  }
  return {
    updated, applications, overpayment: remaining,
    balance: updated.reduce((sum, row) => sum + money(row.principalBalance) + money(row.interestBalance) + money(row.lateFeeBalance), 0),
  };
}

function recordData(row: Row): Row {
  try {
    const parsed = JSON.parse(String(row.record_json || "{}")) as Row;
    return { ...parsed, id: row.id, institutionId: row.institution_id, ownerUid: row.owner_uid, recordType: row.record_type };
  } catch { return {}; }
}

function recordScope(user: AuthUser, type: string, firstParameter = 1): { sql: string; args: unknown[] } {
  if (roleOf(user) === "superadmin") return {
    sql: `sector='mfi' AND record_type=$${firstParameter} AND is_deleted=0`,
    args: [type],
  };
  return {
    sql: `sector='mfi' AND record_type=$${firstParameter} AND institution_id=$${firstParameter + 1} AND is_deleted=0`,
    args: [type, tenantOf(user)],
  };
}

async function records(env: PaymentEnv, user: AuthUser, type: string, lock = false): Promise<Row[]> {
  const scope = recordScope(user, type);
  const found = await query<Row>(env,
    `SELECT id,record_json,record_type,institution_id,owner_uid,created_at,updated_at,is_deleted
     FROM sector_records WHERE ${scope.sql} ORDER BY created_at, id${lock ? " FOR UPDATE" : ""}`,
    scope.args,
  );
  return found.rows.map(recordData);
}

async function findLoan(env: PaymentEnv, user: AuthUser, loanId: string, lock = false): Promise<Row | null> {
  const scope = recordScope(user, "loan", 2);
  const result = await query<Row>(env,
    `SELECT id,record_json,record_type,institution_id,owner_uid,created_at,updated_at,is_deleted
     FROM sector_records WHERE id=$1 AND ${scope.sql}${lock ? " FOR UPDATE" : ""} LIMIT 1`,
    [loanId, ...scope.args],
  );
  const loan = result.rows[0] ? recordData(result.rows[0]) : null;
  if (!loan || roleOf(user) !== "borrower") return loan;
  return [loan.ownerUid, loan.borrowerUid, loan.customerUid, loan.userId].some((v) => clean(v, 160) === user.uid) ? loan : null;
}

async function saveRecord(env: PaymentEnv, user: AuthUser, type: string, data: Row, ownerUid: string | null = null): Promise<Row> {
  const timestamp = now();
  const id = clean(data.id, 300) || makeId(type);
  const record = { ...data, id, recordType: type, institutionId: tenantOf(user), updatedAt: timestamp };
  const inserted = await query<Row>(env,
    `INSERT INTO sector_records (id,sector,institution_id,school_id,owner_uid,record_type,record_json,created_by,is_deleted,created_at,updated_at)
     VALUES ($1,'mfi',$2,NULL,$3,$4,$5,$6,0,$7,$7) ON CONFLICT (id) DO NOTHING RETURNING id`,
    [id, tenantOf(user), ownerUid, type, JSON.stringify(record), user.uid, timestamp],
  );
  if (!inserted.rows.length) throw new Error("RECORD_COLLISION");
  return record;
}

async function updateRecord(env: PaymentEnv, user: AuthUser, record: Row, type: string, data: Row): Promise<Row> {
  const timestamp = now();
  const next = { ...data, id: record.id, recordType: type, institutionId: tenantOf(user), updatedAt: timestamp };
  const changed = await query<Row>(env,
    `UPDATE sector_records SET record_json=$1,updated_at=$2
     WHERE id=$3 AND sector='mfi' AND record_type=$4 AND is_deleted=0
       AND ($5::boolean OR institution_id=$6) RETURNING id`,
    [JSON.stringify(next), timestamp, record.id, type, roleOf(user) === "superadmin", tenantOf(user)],
  );
  if (!changed.rows.length) throw new Error("RECORD_SCOPE_CHANGED");
  return next;
}

function validDate(value: unknown): Date | null {
  const date = new Date(String(value ?? ""));
  return Number.isFinite(date.getTime()) ? date : null;
}

function datePlusMonths(from: Date, months: number): string {
  const day = from.getUTCDate();
  const result = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result.toISOString().slice(0, 10);
}

function datePlusDays(from: Date, days: number): string {
  const result = new Date(from);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

function normalizedTypeName(value: unknown): string {
  return clean(value, 100).toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
}

function collateralScore(collateral: Row, customer: Row, type: Row | undefined): Row {
  const name = normalizedTypeName(type?.name || collateral.typeName);
  const assetTypeScore = Math.max(0, Math.min(25, Number(type?.baseScore) || 0));
  const proof = clean(collateral.ownershipProofType).toLowerCase();
  const ownershipProofScore = proof === "title deed" || proof === "logbook" ? 25
    : proof === "bank statement" ? 20 : proof === "sales agreement" ? 15 : 0;
  const reference = Number(customer.requestedLoanAmount || customer.totalRequestedLoan || 0)
    || Number(customer.monthlyIncome || 0) * 12;
  const value = Number(collateral.estimatedValueUgx) || 0;
  const marketValueScore = !value ? 0 : !reference ? 10 : value >= reference * 1.5 ? 20
    : value >= reference ? 15 : value >= reference * 0.5 ? 10 : 0;
  const location = clean(collateral.location).toLowerCase();
  const central = ["kampala", "wakiso", "entebbe"].some((item) => location.includes(item));
  const regional = ["mbarara", "gulu", "mbale", "jinja", "fort portal", "masaka", "arua", "lira", "hoima", "kabale", "soroti"]
    .some((item) => location.includes(item));
  const locationScore = central ? 15 : regional ? 10 : location ? 5 : 0;
  const liquidityScore = name.includes("land") || name.includes("property") || name.includes("bank") ? 15
    : name.includes("vehicle") ? 12 : name.includes("business") ? 8
      : name.includes("guarantor") ? 5 : name.includes("household") ? 3 : 0;
  const totalScore = Math.max(0, Math.min(100, assetTypeScore + ownershipProofScore + marketValueScore + locationScore + liquidityScore));
  const grade = totalScore >= 80 ? "Excellent" : totalScore >= 60 ? "Good" : totalScore >= 40 ? "Fair" : "Weak";
  const recommendation = totalScore >= 60 ? "Approve" : totalScore >= 40 ? "Request Top-up" : "Reject";
  return { assetTypeScore, ownershipProofScore, marketValueScore, locationScore, liquidityScore, totalScore, grade, recommendation };
}

function buildSchedule(loan: Row, loanId: string): Row[] {
  const principal = money(loan.approvedAmount ?? loan.disbursedAmount ?? loan.requestedAmount);
  const term = Math.floor(Number(loan.approvedTermMonths ?? loan.requestedTermMonths));
  const rate = Number(loan.approvedInterestRate ?? loan.interestRate ?? 0);
  const type = clean(loan.approvedInterestType ?? loan.interestType ?? "Flat").toLowerCase();
  if (!principal || !Number.isSafeInteger(term) || term < 1 || term > 240 || !Number.isFinite(rate) || rate < 0 ||
      !["flat", "reducing balance"].includes(type)) throw new Error("LOAN_TERMS_INVALID");
  const start = validDate(loan.disbursementDate ?? loan.disbursedAt ?? loan.approvedAt) || new Date();
  const monthlyRate = rate / 100;
  const totalFlatInterest = type === "flat" ? Math.round(principal * monthlyRate * term) : 0;
  const scheduledPayment = type === "flat"
    ? (principal + totalFlatInterest) / term
    : monthlyRate
      ? principal * monthlyRate * Math.pow(1 + monthlyRate, term) / (Math.pow(1 + monthlyRate, term) - 1)
      : principal / term;
  const frequency = clean(loan.repaymentFrequency).toLowerCase();
  const cycleDays = frequency === "weekly" ? 7 : frequency === "bi-weekly" || frequency === "biweekly" ? 14 : 0;
  const graceDays = Math.max(0, Math.min(365, money(loan.approvedGracePeriodDays ?? loan.gracePeriodDays)));
  const schedule: Row[] = [];
  let balance = principal;
  let flatInterestAssigned = 0;
  for (let index = 1; index <= term; index += 1) {
    const interest = type === "flat"
      ? index === term ? totalFlatInterest - flatInterestAssigned : Math.round(totalFlatInterest / term)
      : Math.round(balance * monthlyRate);
    if (type === "flat") flatInterestAssigned += interest;
    const installmentPrincipal = index === term
      ? balance
      : Math.min(balance, Math.max(0, Math.round(scheduledPayment) - interest));
    balance = Math.max(0, balance - installmentPrincipal);
    const cycleDate = cycleDays ? datePlusDays(start, graceDays + cycleDays * index) : datePlusMonths(start, index);
    const dueDate = !cycleDays && graceDays ? datePlusDays(new Date(cycleDate), graceDays) : cycleDate;
    schedule.push({
      id: makeId("installment"), loanId, institutionId: loan.institutionId,
      installmentNumber: index, dueDate,
      principalDue: installmentPrincipal, interestDue: interest, lateFeeDue: 0, feesDue: 0,
      totalDue: installmentPrincipal + interest, balanceAfterDue: balance,
      principalPaid: 0, interestPaid: 0, lateFeePaid: 0, paidAmount: 0, paidPrincipal: 0,
      status: "pending", createdAt: now(), updatedAt: now(),
    });
  }
  return schedule;
}

async function makeSchedule(env: PaymentEnv, user: AuthUser, loanId: string): Promise<Row[] | null> {
  const loan = await findLoan(env, user, loanId, true);
  if (!loan || !["approved", "disbursed", "repaying"].includes(clean(loan.status).toLowerCase())) return null;
  const existing = (await records(env, user, "repayment_schedule", true)).filter((row) => clean(row.loanId, 300) === loanId);
  if (existing.length) return existing.sort((a, b) => Number(a.installmentNumber) - Number(b.installmentNumber));
  const schedule = buildSchedule(loan, loanId);
  for (const installment of schedule) await saveRecord(env, user, "repayment_schedule", installment, clean(loan.ownerUid || loan.borrowerUid, 160) || null);
  const total = schedule.reduce((sum, row) => sum + money(row.totalDue), 0);
  await updateRecord(env, user, loan, "loan", {
    ...loan, totalExpectedRepayment: total, balanceRemaining: total,
    nextPaymentDueDate: schedule[0]?.dueDate || null, nextPaymentAmount: schedule[0]?.totalDue || 0,
    expectedPaybackDate: schedule[schedule.length - 1]?.dueDate || null,
  });
  return schedule;
}

async function routeMfi(request: Request, env: PaymentEnv, user: AuthUser): Promise<Response> {
  const path = new URL(request.url).pathname;
  const role = roleOf(user);
  if (!MFI_ROLES.has(role)) return json({ ok: false, error: "MFI access required" }, 403);
  if (!tenantOf(user)) return json({ ok: false, error: "Select an MFI tenant before continuing" }, 403);
  if (!env.PG) return safeFailure();
  const collateralPath = /^\/api\/mfi\/(?:collateral\/score|collateral-scoring|collateral\/scoring)$/.test(path);
  const loanMatch = path.match(/^\/api\/mfi\/loans\/([^/]+)\/(schedule|disburse|disbursement|overdue|late-fee|repayment|repayments)$/);
  const overdueSweep = path === "/api/mfi/loans/overdue";
  if (!collateralPath && !loanMatch && !overdueSweep) return json({ ok: false, error: "Unknown MFI payment route" }, 404);
  if (!["POST"].includes(request.method)) return json({ ok: false, error: "Only POST is supported" }, 405);
  const capability = collateralPath ? "collateral.score.manage"
    : overdueSweep || loanMatch?.[2] === "overdue" ? "loans.overdue.manage"
      : loanMatch?.[2] === "schedule" ? "loans.schedule.manage"
        : loanMatch?.[2] === "repayment" || loanMatch?.[2] === "repayments"
          ? role === "borrower" ? "repayments.create" : "repayments.manage"
          : loanMatch?.[2] === "late-fee" ? "loans.late_fees.manage" : "loans.disburse";
  try {
    if (!await hasCapability(env, user, capability)) return json({ ok: false, error: "This role is not authorized for this MFI operation" }, 403);
    const input = await parseJson(request);
    if (!input) return json({ ok: false, error: "Valid JSON request body is required" }, 400);

    if (collateralPath) {
      const collateralId = clean(input.collateralId || input.id, 300);
      if (!collateralId) return json({ ok: false, error: "Collateral ID is required" }, 400);
      const score = await transaction(env, async () => {
        const collateral = await query<Row>(env,
          `SELECT id,record_json,owner_uid FROM sector_records
           WHERE id=$1 AND sector='mfi' AND record_type='collateral' AND is_deleted=0
             AND ($2::boolean OR institution_id=$3) LIMIT 1 FOR UPDATE`,
          [collateralId, role === "superadmin", tenantOf(user)],
        );
        if (!collateral.rows[0]) return null;
        const data = recordData({ ...collateral.rows[0], record_type: "collateral", institution_id: tenantOf(user) });
        const customerId = clean(data.customerId || data.borrowerId, 300);
        const customerRecords = await records(env, user, "borrower", true);
        const customer = customerRecords.find((item) => item.id === customerId || clean(item.uid || item.userId, 160) === customerId) || {};
        const typeRecords = await records(env, user, "collateral_type", true);
        const type = typeRecords.find((item) => clean(item.id, 300) === clean(data.typeId, 300));
        const computed = collateralScore(data, customer, type);
        const record = await saveRecord(env, user, "collateral_score", {
          collateralId, borrowerId: customerId || null, ...computed,
          managerComments: "", scoredBy: user.uid, scoredAt: now(), status: "pending",
        }, clean(collateral.rows[0].owner_uid, 160) || null);
        const updated = { ...data, score: computed, scoringId: record.id, scoredAt: now() };
        await query(env, "UPDATE sector_records SET record_json=$1,updated_at=$2 WHERE id=$3 AND sector='mfi' AND record_type='collateral'",
          [JSON.stringify(updated), now(), collateralId]);
        return record;
      });
      if (!score) return json({ ok: false, error: "Collateral not found in this MFI tenant" }, 404);
      return json({ ok: true, score }, 201);
    }

    if (overdueSweep || loanMatch?.[2] === "overdue") {
      const today = clean(input.asOfDate, 10) || now().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return json({ ok: false, error: "asOfDate must be a valid YYYY-MM-DD date" }, 400);
      const output = await transaction(env, async () => {
        const configRecords = await records(env, user, "late_fee_config", true);
        const grace = Math.max(0, Math.min(365, money(configRecords[0]?.gracePeriodDays ?? 3)));
        const installments = await records(env, user, "repayment_schedule", true);
        const requestedLoanId = loanMatch ? decodeURIComponent(loanMatch[1]) : "";
        const overdue = installments.filter((row) => {
          const normalized = normalizeMfiInstallmentV10(row);
          const openBalance = money(normalized.principalBalance) + money(normalized.interestBalance) + money(normalized.lateFeeBalance);
          return (!requestedLoanId || clean(row.loanId, 300) === requestedLoanId) && row.status !== "paid"
            && openBalance > 0 && String(row.dueDate || "") < today
            && Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${String(row.dueDate).slice(0, 10)}T00:00:00Z`)) / 86400000) > grace;
        });
        const loans = new Map((await records(env, user, "loan", true)).map((row) => [String(row.id), row]));
        const results: Row[] = [];
        for (const schedule of overdue) {
          const loanId = clean(schedule.loanId, 300);
          const loan = loans.get(loanId);
          if (!loan) continue;
          const daysOverdue = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${String(schedule.dueDate).slice(0, 10)}T00:00:00Z`)) / 86400000);
          const balance = money(normalizeMfiInstallmentV10(schedule).principalBalance)
            + money(normalizeMfiInstallmentV10(schedule).interestBalance) + money(normalizeMfiInstallmentV10(schedule).lateFeeBalance);
          const next = await updateRecord(env, user, schedule, "repayment_schedule", { ...schedule, status: "overdue", daysOverdue });
          const prior = (await records(env, user, "overdue_log")).some((row) => row.installmentId === schedule.id && row.currentStatus === "open");
          if (!prior) await saveRecord(env, user, "overdue_log", {
            loanId, installmentId: schedule.id, customerId: loan.customerId || loan.borrowerUid || null,
            daysOverdue, amountOverdue: balance, lateFeeApplied: 0,
            escalationLevel: daysOverdue >= 30 ? 3 : daysOverdue >= 7 ? 2 : 1,
            currentStatus: "open", createdAt: now(), updatedAt: now(),
          }, clean(loan.ownerUid || loan.borrowerUid, 160) || null);
          results.push({ installmentId: next.id, loanId, daysOverdue, amountOverdue: balance });
        }
        for (const loanId of new Set(results.map((row) => clean(row.loanId, 300)))) {
          const loan = loans.get(loanId);
          if (loan && clean(loan.status).toLowerCase() !== "overdue") {
            loans.set(loanId, await updateRecord(env, user, loan, "loan", { ...loan, status: "overdue" }));
          }
        }
        return results;
      });
      return json({ ok: true, asOfDate: today, overdue: output });
    }

    const loanId = decodeURIComponent(loanMatch![1]);
    const action = loanMatch![2];
    if (action === "schedule") {
      const result = await transaction(env, () => makeSchedule(env, user, loanId));
      return result ? json({ ok: true, schedule: result }) : json({ ok: false, error: "Approved loan not found in this tenant" }, 404);
    }

    if (action === "disburse" || action === "disbursement") {
      const reference = clean(input.disbursementReference || input.reference, 160);
      const method = clean(input.disbursementMethod || input.method, 40);
      if (!reference || !["Cash", "MTN", "Airtel", "Bank"].includes(method)) {
        return json({ ok: false, error: "Disbursement method and reference are required" }, 400);
      }
      const result = await transaction(env, async () => {
        const loan = await findLoan(env, user, loanId, true);
        if (!loan || clean(loan.status).toLowerCase() !== "approved") return null;
        const updated = await updateRecord(env, user, loan, "loan", {
          ...loan, status: "disbursed", disbursementMethod: method, disbursementReference: reference,
          disbursedBy: user.uid, disbursementDate: now().slice(0, 10), disbursedAt: now(),
        });
        const schedule = await makeSchedule(env, user, loanId);
        return { loan: updated, schedule };
      });
      return result ? json({ ok: true, ...result }, 200) : json({ ok: false, error: "Approved loan not found or already disbursed" }, 409);
    }

    if (action === "late-fee") {
      const result = await transaction(env, async () => {
        const loan = await findLoan(env, user, loanId, true);
        if (!loan) return null;
        const configRows = await records(env, user, "late_fee_config", true);
        const config = configRows[0];
        if (!config) return { error: "Late-fee configuration is not set for this MFI" as const };
        const schedule = (await records(env, user, "repayment_schedule", true))
          .filter((row) => clean(row.loanId, 300) === loanId)
          .sort((a, b) => Number(a.installmentNumber) - Number(b.installmentNumber));
        const applied: Row[] = [];
        let totalFeesApplied = 0;
        for (const row of schedule) {
          const normalized = normalizeMfiInstallmentV10(row);
          const due = String(row.dueDate || "").slice(0, 10);
          const today = now().slice(0, 10);
          const days = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86400000);
          const grace = Math.max(0, Math.min(365, money(config.gracePeriodDays ?? 3)));
          if (row.status === "paid" || !Number.isFinite(days) || days <= grace || row.lateFeeAppliedAt) continue;
          const base = money(normalized.principalBalance) + money(normalized.interestBalance);
          const fixed = clean(config.lateFeeType).toLowerCase() === "fixed";
          const computed = fixed ? money(config.lateFeeAmount) : Math.round(base * Math.max(0, Number(config.lateFeePercentage) || 0) / 100);
          const cap = money(config.maxLateFeeCap);
          const fee = cap ? Math.min(computed, cap) : computed;
          if (!fee) continue;
          const next = {
            ...row, lateFeeDue: money(normalized.lateFeeDue) + fee, lateFeeApplied: fee,
            totalDue: money(row.totalDue) + fee,
            lateFeeAppliedAt: now(), status: "overdue", updatedAt: now(),
          };
          await updateRecord(env, user, row, "repayment_schedule", next);
          applied.push({ installmentId: row.id, lateFeeApplied: fee });
          totalFeesApplied += fee;
        }
        if (totalFeesApplied > 0) {
          await updateRecord(env, user, loan, "loan", {
            ...loan,
            totalExpectedRepayment: money(loan.totalExpectedRepayment) + totalFeesApplied,
            balanceRemaining: money(loan.balanceRemaining) + totalFeesApplied,
            status: "overdue",
          });
        }
        return { applied, totalFeesApplied };
      });
      if (!result) return json({ ok: false, error: "Loan not found in this tenant" }, 404);
      if ("error" in result) return json({ ok: false, error: result.error }, 409);
      return json({ ok: true, ...result });
    }

    const amount = money(input.amount);
    const idempotencyKey = clean(request.headers.get("idempotency-key") || input.idempotencyKey, 160);
    if (!amount || !idempotencyKey) return json({ ok: false, error: "Positive integer amount and idempotency key are required" }, 400);
    const outcome = await transaction(env, async () => {
      await query<Row>(env,
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`mfi-repayment:${tenantOf(user)}:${idempotencyKey}`],
      );
      const previous = await query<Row>(env,
        "SELECT result_json FROM mfi_v10_operation_keys WHERE institution_id=$1 AND operation_key=$2 FOR UPDATE",
        [tenantOf(user), idempotencyKey],
      );
      if (previous.rows[0]) {
        try { return { duplicate: true, result: JSON.parse(String(previous.rows[0].result_json)) as Row }; }
        catch { return { duplicate: true, result: { ok: true, duplicate: true } }; }
      }
      const loan = await findLoan(env, user, loanId, true);
      if (!loan || !["disbursed", "repaying", "overdue"].includes(clean(loan.status).toLowerCase())) return { error: "loan_missing" as const };
      const schedules = (await records(env, user, "repayment_schedule", true))
        .filter((row) => clean(row.loanId, 300) === loanId);
      if (!schedules.length) return { error: "schedule_missing" as const };
      const allocation = allocateMfiRepaymentV10(amount, schedules);
      const payment = await saveRecord(env, user, "payment", {
        loanId, borrowerUid: clean(loan.ownerUid || loan.borrowerUid, 160),
        amount, currency: clean(input.currency, 8) || "UGX", paymentMethod: clean(input.paymentMethod, 40) || "manual",
        reference: clean(input.reference, 160) || null, idempotencyKey, recordedBy: user.uid,
        applications: allocation.applications, overpayment: allocation.overpayment,
        status: "completed", paidAt: now(),
      }, clean(loan.ownerUid || loan.borrowerUid, 160) || null);
      for (const updated of allocation.updated) {
        if (allocation.applications.some((item) => item.installmentId === updated.id)) {
          await updateRecord(env, user, schedules.find((row) => row.id === updated.id)!, "repayment_schedule", updated);
        }
      }
      const paidSoFar = money(loan.totalPaidSoFar) + amount - allocation.overpayment;
      const hasOverdue = allocation.updated.some((row) => row.status !== "paid"
        && String(row.dueDate || "") < now().slice(0, 10));
      const status = allocation.balance === 0 ? "fully_repaid" : hasOverdue ? "overdue" : "repaying";
      const nextSchedule = allocation.updated.find((row) => row.status !== "paid");
      const updatedLoan = await updateRecord(env, user, loan, "loan", {
        ...loan, totalPaidSoFar: paidSoFar, balanceRemaining: allocation.balance,
        status, actualPaybackDate: status === "fully_repaid" ? now().slice(0, 10) : loan.actualPaybackDate || null,
        nextPaymentDueDate: nextSchedule?.dueDate || null, nextPaymentAmount: nextSchedule
          ? money(nextSchedule.principalBalance) + money(nextSchedule.interestBalance) + money(nextSchedule.lateFeeBalance) : 0,
      });
      const response = { ok: true, payment, loan: updatedLoan, applications: allocation.applications, overpayment: allocation.overpayment };
      await query(env,
        `INSERT INTO mfi_v10_operation_keys (institution_id,operation_key,resource_id,result_json,created_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [tenantOf(user), idempotencyKey, payment.id, JSON.stringify(response), now()],
      );
      return { duplicate: false, result: response };
    });
    if ("error" in outcome) return json({ ok: false, error: outcome.error === "loan_missing" ? "Repayable loan not found in this tenant" : "Loan repayment schedule is missing" }, outcome.error === "loan_missing" ? 404 : 409);
    return json(outcome.result, outcome.duplicate ? 200 : 201);
  } catch (error) {
    if (error instanceof PersistenceError) return safeFailure();
    if (error instanceof Error && error.message === "LOAN_TERMS_INVALID") return json({ ok: false, error: "Loan terms are incomplete or invalid" }, 400);
    if (error instanceof Error && error.message === "RECORD_COLLISION") return json({ ok: false, error: "Record already exists" }, 409);
    return json({ ok: false, error: "MFI operation could not be completed" }, 500);
  }
}

/**
 * Standalone priority-1 callback and MFI workflow handler. It performs no
 * Firebase, D1, or R2 access; all durable reads and writes use Neon.
 */
export async function handlePaymentMfiV10Route(
  request: Request,
  env: AuthEnv,
  user: AuthUser | null,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const paymentEnv = env as PaymentEnv;
  if (path === "/api/payments/ipn" || path === "/api/webhooks/yo/ipn") return processIpn(request, paymentEnv);
  if (!path.startsWith("/api/mfi/")) return null;
  const claimedMfiRoute = /^\/api\/mfi\/(?:collateral\/(?:score|scoring)|collateral-scoring|loans\/(?:overdue|[^/]+\/(?:schedule|disburse|disbursement|overdue|late-fee|repayment|repayments)))$/.test(path);
  if (!claimedMfiRoute) return null;
  if (!user) return json({ ok: false, error: "Authentication required" }, 401);
  try {
    return await routeMfi(request, paymentEnv, user);
  } catch (error) {
    if (error instanceof PersistenceError) return safeFailure();
    return json({ ok: false, error: "MFI operation could not be completed" }, 500);
  }
}