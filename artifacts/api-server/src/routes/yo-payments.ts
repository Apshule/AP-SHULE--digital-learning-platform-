import { Router, type Request, type Response } from "express";
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { verifyFirebaseAdmin, verifyFirebaseCaller } from "../lib/firebase-auth";
import { getFirebaseAdminToken } from "../lib/firebase-admin-token";
import { settleStudentReferralPayment, settleTeacherRegistrationPayment } from "./student-referrals";

const router = Router();
const project = process.env["FIREBASE_PROJECT_ID"] ?? "apshule-app";
const firestoreBase = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
const defaultProductionUrl = "https://paymentsapi1.yo.co.ug/ybs/task.php";
const defaultSandboxUrl = "https://sandbox.yo.co.ug/services/yopaymentsdev/task.php";
const now = () => new Date().toISOString();
const publicBaseUrl = () => (process.env["PUBLIC_API_URL"] ?? "https://appshule.com").replace(/\/$/, "");

type FirestoreDocument = { name?: string; fields?: Record<string, unknown> };
type FirestoreValue = Record<string, unknown>;

function xmlEscape(value: unknown): string {
  return String(value ?? "").replace(/[<>&'"]/g, (character) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    "\"": "&quot;",
  }[character] ?? character));
}

function xmlField(xml: string, name: string): string {
  return xml.match(new RegExp(`<${name}[^>]*>([^<]*)`, "i"))?.[1] ?? "";
}

function normalizedPhone(value: unknown): string {
  const raw = String(value ?? "").replace(/[\s()-]/g, "");
  if (/^07\d{8}$/.test(raw)) return `+256${raw.slice(1)}`;
  if (/^2567\d{8}$/.test(raw)) return `+${raw}`;
  if (/^\+2567\d{8}$/.test(raw)) return raw;
  return "";
}

function firestoreValue(value: unknown): FirestoreValue {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return { doubleValue: value };
  if (typeof value === "object" && !Array.isArray(value)) {
    return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, firestoreValue(item)])) } };
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(firestoreValue) } };
  return { stringValue: String(value) };
}

function firestoreFields(data: Record<string, unknown>) {
  return { fields: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, firestoreValue(value)])) };
}

function firestoreFieldValue(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const item = value as Record<string, unknown>;
  if ("stringValue" in item) return item.stringValue;
  if ("integerValue" in item) return Number(item.integerValue);
  if ("doubleValue" in item) return item.doubleValue;
  if ("booleanValue" in item) return item.booleanValue;
  if ("timestampValue" in item) return item.timestampValue;
  if ("nullValue" in item) return null;
  if ("mapValue" in item) {
    const fields = (item.mapValue as { fields?: Record<string, unknown> }).fields ?? {};
    return Object.fromEntries(Object.entries(fields).map(([key, nested]) => [key, firestoreFieldValue(nested)]));
  }
  if ("arrayValue" in item) return ((item.arrayValue as { values?: unknown[] }).values ?? []).map(firestoreFieldValue);
  return item;
}

function firestoreDocumentData(document?: FirestoreDocument): Record<string, unknown> {
  return Object.fromEntries(Object.entries(document?.fields ?? {}).map(([key, value]) => [key, firestoreFieldValue(value)]));
}

async function firestoreRequest(path: string, init: RequestInit = {}, callerToken?: string) {
  const adminToken = await getFirebaseAdminToken();
  if (!adminToken && !callerToken) throw new Error("Firebase service-account secret is not configured");
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Authorization", `Bearer ${adminToken ?? callerToken}`);
  const response = await fetch(`${firestoreBase}${path}`, { ...init, headers });
  if (!response.ok) throw new Error(`Firestore request failed (${response.status})`);
  return response.status === 204 ? null : response.json();
}

async function firestoreGet(collectionId: string, documentId: string, callerToken?: string): Promise<Record<string, unknown> | null> {
  try {
    const document = await firestoreRequest(`/${collectionId}/${encodeURIComponent(documentId)}`, {}, callerToken) as FirestoreDocument;
    return firestoreDocumentData(document);
  } catch (error) {
    if (String(error).includes("(404)")) return null;
    throw error;
  }
}

async function firestoreQuery(collectionId: string, fieldPath: string, fieldValue: string): Promise<Array<{ document?: FirestoreDocument }>> {
  const adminToken = await getFirebaseAdminToken();
  if (!adminToken) throw new Error("Firebase service-account secret is not configured");
  const response = await fetch(`${firestoreBase}:runQuery`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId }],
        where: { fieldFilter: { field: { fieldPath }, op: "EQUAL", value: firestoreValue(fieldValue) } },
      },
    }),
  });
  if (!response.ok) throw new Error(`Firestore query failed (${response.status})`);
  return await response.json() as Array<{ document?: FirestoreDocument }>;
}

/** Reports deliberately use the service account, then apply all filters server-side. */
async function firestoreList(collectionId: string): Promise<Array<{ document?: FirestoreDocument }>> {
  const adminToken = await getFirebaseAdminToken();
  if (!adminToken) throw new Error("Firebase service-account secret is not configured");
  const response = await fetch(`${firestoreBase}:runQuery`, {
    method: "POST", headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId }] } }),
  });
  if (!response.ok) throw new Error(`Firestore query failed (${response.status})`);
  return await response.json() as Array<{ document?: FirestoreDocument }>;
}

function documentRows(rows: Array<{ document?: FirestoreDocument }>): Array<Record<string, unknown> & { id: string }> {
  return rows.filter((row) => row.document?.name).map((row) => ({
    id: row.document?.name?.split("/").pop() ?? "", ...firestoreDocumentData(row.document),
  }));
}

function admin(req: Request, res: Response) {
  return verifyFirebaseAdmin(req.headers.authorization).then((result) => {
    if (!result.ok) {
      res.status(result.status).json({ ok: false, error: result.reason });
      return null;
    }
    return result.uid;
  });
}

async function caller(req: Request, res: Response) {
  const result = await verifyFirebaseCaller(req.headers.authorization);
  if ("ok" in result) {
    res.status(result.status).json({ ok: false, error: result.reason });
    return null;
  }
  return result;
}

async function savedPaymentSettings(callerToken?: string): Promise<Record<string, unknown>> {
  return await firestoreGet("payment_settings", "global", callerToken).catch(() => null) ?? {};
}

function configuredSettings(saved: Record<string, unknown> = {}) {
  const mode = String(saved.mode ?? process.env["YO_API_MODE"] ?? "sandbox") === "production" ? "production" : "sandbox";
  return {
    mode,
    productionUrl: String(saved.productionUrl ?? process.env["YO_API_PRODUCTION_URL"] ?? defaultProductionUrl),
    sandboxUrl: String(saved.sandboxUrl ?? process.env["YO_API_SANDBOX_URL"] ?? defaultSandboxUrl),
    serviceFeePercentage: Number(saved.serviceFeePercentage ?? process.env["YO_SERVICE_FEE_PERCENTAGE"] ?? 5),
    serviceFeeFixed: Number(saved.serviceFeeFixed ?? 0),
    autoDisburse: saved.autoDisburse !== false,
  };
}

function activeYoUrl(settings: ReturnType<typeof configuredSettings>): string {
  return settings.mode === "production" ? settings.productionUrl : settings.sandboxUrl;
}

function hasYoCredentials(): boolean {
  return Boolean(process.env["YO_API_USERNAME"] && process.env["YO_API_PASSWORD"]);
}

function authorizedToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
}

router.get("/payments/config/status", async (req, res) => {
  const uid = await admin(req, res);
  if (!uid) return;
  const settings = configuredSettings(await savedPaymentSettings(authorizedToken(req)));
  res.json({
    ok: true,
    configured: Boolean(hasYoCredentials() && process.env["YO_API_PUBLIC_KEY"]),
    mode: settings.mode,
    serviceFeePercentage: settings.serviceFeePercentage,
    productionUrl: settings.productionUrl,
    sandboxUrl: settings.sandboxUrl,
    ipnUrl: `${publicBaseUrl()}/api/webhooks/yo/ipn`,
    failureUrl: `${publicBaseUrl()}/api/webhooks/yo/failure`,
  });
});

router.post("/payments/config", async (req, res) => {
  const uid = await admin(req, res);
  if (!uid) return;
  const mode = String(req.body?.mode ?? "sandbox");
  const serviceFeePercentage = Number(req.body?.serviceFeePercentage ?? 5);
  if (!["sandbox", "production"].includes(mode) || !Number.isFinite(serviceFeePercentage) || serviceFeePercentage < 0 || serviceFeePercentage > 100) {
    res.status(400).json({ ok: false, error: "Mode and service fee percentage are invalid" });
    return;
  }
  const data = { settingsId: "global", mode, serviceFeePercentage, updatedBy: uid, updatedAt: now() };
  try {
    await firestoreRequest("/payment_settings/global", { method: "PATCH", body: JSON.stringify(firestoreFields(data)) }, authorizedToken(req));
    res.json({ ok: true, mode, serviceFeePercentage });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "Unable to save payment settings" });
  }
});

async function yoCall(method: string, params: Record<string, string>, settings: ReturnType<typeof configuredSettings>) {
  if (!hasYoCredentials()) throw new Error("Yo API credentials are not configured");
  const body = `<AutoCreate><Request><APIUsername>${xmlEscape(process.env["YO_API_USERNAME"])}</APIUsername><APIpassword>${xmlEscape(process.env["YO_API_PASSWORD"])}</APIpassword><Method>${xmlEscape(method)}</Method><NonBlocking>TRUE</NonBlocking>${Object.entries(params).map(([key, value]) => `<${key}>${xmlEscape(value)}</${key}>`).join("")}</Request></AutoCreate>`;
  const response = await fetch(activeYoUrl(settings), {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${process.env["YO_API_USERNAME"]}:${process.env["YO_API_PASSWORD"]}`).toString("base64")}`, "Content-Type": "application/xml" },
    body,
  });
  const responseText = await response.text();
  if (!response.ok) throw new Error(`Yo API rejected the request (${response.status})`);
  return responseText;
}

router.post("/payments/config/test", async (req, res) => {
  if (!await admin(req, res)) return;
  const settings = configuredSettings({ mode: req.body?.mode });
  if (!hasYoCredentials()) {
    res.status(503).json({ ok: false, error: "Yo API credentials are not configured in server secrets" });
    return;
  }
  try {
    const response = await yoCall("acgetbalance", {}, settings);
    res.json({ ok: true, status: xmlField(response, "Status") || xmlField(response, "status") || "response received" });
  } catch {
    res.status(502).json({ ok: false, error: "Yo API connection test failed" });
  }
});

router.post("/payments/student/referral-withdraw", async (req, res) => {
  const user = await caller(req, res);
  if (!user) return;
  if (!["individual", "student"].includes(user.role)) {
    res.status(403).json({ ok: false, error: "Only student accounts can withdraw referral earnings" });
    return;
  }
  const profile = await firestoreGet("users", user.uid, user.token);
  const amount = Math.round(Number(profile?.referralCashBalance ?? 0));
  const account = normalizedPhone(req.body?.phone ?? profile?.phone);
  const paymentMethod = String(req.body?.paymentMethod ?? "").trim();
  if (amount < 500) {
    res.status(400).json({ ok: false, error: "You need at least UGX 500 in referral earnings to withdraw." });
    return;
  }
  if (!account || !["MTN", "Airtel"].includes(paymentMethod)) {
    res.status(400).json({ ok: false, error: "Enter a valid MTN/Airtel number and choose the network." });
    return;
  }
  if (!hasYoCredentials()) {
    res.status(503).json({ ok: false, error: "Automatic referral withdrawals are not available until Yo is configured on the server." });
    return;
  }

  const lockPath = `/studentReferralPayoutLocks/${encodeURIComponent(user.uid)}`;
  try {
    await firestoreRequest(lockPath, {
      method: "PATCH",
      body: JSON.stringify({
        currentDocument: { exists: false },
        ...firestoreFields({ studentId: user.uid, createdAt: now() }),
      }),
    });
  } catch {
    res.status(409).json({ ok: false, error: "Another referral withdrawal is already being prepared." });
    return;
  }

  const withdrawalId = `SRW-${new Date().getUTCFullYear()}-${createHash("sha256").update(`${user.uid}:${Date.now()}`).digest("hex").slice(0, 16).toUpperCase()}`;
  const externalRef = `SRWD-${withdrawalId}`;
  let debited = false;
  try {
    await firestoreRequest(`/users/${encodeURIComponent(user.uid)}`, {
      method: "PATCH",
      body: JSON.stringify(firestoreFields({
        referralCashBalance: 0,
        referralCashLastWithdrawalId: withdrawalId,
        referralCashLastWithdrawalAt: now(),
      })),
    });
    debited = true;
    await firestoreRequest(`/studentReferralWithdrawals/${encodeURIComponent(withdrawalId)}`, {
      method: "PATCH",
      body: JSON.stringify(firestoreFields({
        withdrawalId, studentId: user.uid, amount, currency: "UGX",
        beneficiaryAccount: account, paymentMethod, externalRef,
        status: "processing", automatic: true, approvalRequired: false,
        createdAt: now(), updatedAt: now(),
      })),
    });
    await firestoreRequest(`/payment_disbursements/${encodeURIComponent(withdrawalId)}`, {
      method: "PATCH",
      body: JSON.stringify(firestoreFields({
        disbursementId: withdrawalId, externalRef, studentReferralWithdrawalId: withdrawalId,
        studentId: user.uid, amount, netAmount: amount, fee: 0,
        beneficiaryType: "mobile_money", beneficiaryAccount: account,
        beneficiaryAccountName: profile?.name ?? user.uid, status: "processing",
        attempts: 0, maxAttempts: 3, createdAt: now(), updatedAt: now(),
      })),
    });
    const settings = configuredSettings(await savedPaymentSettings(user.token));
    const response = await yoCall("acwithdrawfunds", {
      Amount: amount.toFixed(2), CurrencyCode: "UGX", BeneficiaryAccount: account,
      BeneficiaryEmail: "", Narrative: `Student referral earnings ${withdrawalId}`,
      ExternalReference: withdrawalId, InstantNotificationUrl: `${publicBaseUrl()}/api/webhooks/yo/disbursement`,
    }, settings);
    const yoTransactionId = xmlField(response, "TransactionReference") || xmlField(response, "reference") || "";
    await firestoreRequest(`/studentReferralWithdrawals/${encodeURIComponent(withdrawalId)}`, {
      method: "PATCH", body: JSON.stringify(firestoreFields({ yoTransactionId, updatedAt: now() })),
    });
    await firestoreRequest(`/payment_disbursements/${encodeURIComponent(withdrawalId)}`, {
      method: "PATCH", body: JSON.stringify(firestoreFields({ yoTransactionId, requestSentAt: now(), updatedAt: now() })),
    });
    res.status(201).json({ ok: true, withdrawalId, status: "processing", amount });
  } catch (error) {
    if (debited) {
      await firestoreRequest(`/users/${encodeURIComponent(user.uid)}`, {
        method: "PATCH",
        body: JSON.stringify(firestoreFields({ referralCashBalance: amount })),
      }).catch(() => undefined);
    }
    await firestoreRequest(`/studentReferralWithdrawals/${encodeURIComponent(withdrawalId)}`, {
      method: "PATCH",
      body: JSON.stringify(firestoreFields({ status: "failed", failureReason: error instanceof Error ? error.message : "Payout request failed", updatedAt: now() })),
    }).catch(() => undefined);
    res.status(502).json({ ok: false, error: "The payout provider rejected the withdrawal; your referral balance was released." });
  } finally {
    await firestoreRequest(lockPath, { method: "DELETE" }).catch(() => undefined);
  }
});

router.post("/payments/beneficiaries/verify", async (req, res) => {
  if (!await admin(req, res)) return;
  const account = String(req.body?.account ?? "").trim();
  if (!/^\+?[0-9]{8,15}$/.test(account)) {
    res.status(400).json({ ok: false, error: "Valid account is required" });
    return;
  }
  try {
    const response = await yoCall("acverifyaccountvalidity", { Account: account }, configuredSettings());
    res.json({ ok: true, valid: /success|valid/i.test(response), status: xmlField(response, "Status") || "response received" });
  } catch {
    res.status(502).json({ ok: false, error: "Beneficiary verification failed" });
  }
});

const attempts = new Map<string, number[]>();

async function authoritativeBalance(sector: string, reference: string, callerToken: string) {
  const normalized = sector.toLowerCase();
  const collections = normalized.includes("clinic") ? ["clinic_billing"] : normalized.includes("mfi") ? ["microfinance_loans", "mfi_loans"] : ["school_fees", "school_bills"];
  for (const collectionName of collections) {
    const current = await firestoreGet(collectionName, reference, callerToken);
    if (!current) continue;
    const total = Number(current.totalAmount ?? current.loanAmount ?? current.amount ?? 0);
    const paid = Number(current.paidAmount ?? current.amountPaid ?? 0);
    return { collectionName, total, paid, balance: Math.max(0, total - paid) };
  }
  return null;
}

router.post("/payments/initiate", async (req, res) => {
  const user = await caller(req, res);
  if (!user) return;
  const body = req.body ?? {};
  const amountPaid = Number(body.amountPaid ?? body.amount);
  const totalAmount = Number(body.totalAmount ?? body.billTotal ?? amountPaid);
  const alreadyPaid = Number(body.alreadyPaid ?? body.existingPaid ?? Math.max(0, totalAmount - Number(body.balance ?? totalAmount)));
  const balanceRemaining = Math.max(0, totalAmount - alreadyPaid);
  const paymentMethod = String(body.paymentMethod ?? body.method ?? "");
  const clientPhone = String(body.clientPhone ?? body.phone ?? "").trim();
  const institutionId = String(body.institutionId ?? "").trim();
  const sector = String(body.sector ?? "").trim();
  const billReference = String(body.billReference ?? "").trim();
  if (!hasYoCredentials()) {
    res.status(503).json({ ok: false, error: "Yo API credentials are not configured in server secrets" });
    return;
  }
  if (!Number.isFinite(amountPaid) || amountPaid <= 0 || !Number.isFinite(totalAmount) || totalAmount <= 0 || !["MTN", "Airtel"].includes(paymentMethod) || !/^\+?[0-9]{8,15}$/.test(clientPhone) || !institutionId || !sector || !billReference) {
    res.status(400).json({ ok: false, error: "Positive amount, outstanding balance, supported payment method, phone, institutionId, sector and billReference are required" });
    return;
  }
  if (await lockedMonth(now().slice(0, 7))) {
    res.status(423).json({ ok: false, error: "Payment month is locked; new edits are not permitted" });
    return;
  }
  const stored = await authoritativeBalance(sector, billReference, user.token).catch(() => null);
  const resolvedTotal = stored?.total || totalAmount;
  const resolvedPaid = stored ? stored.paid : alreadyPaid;
  const resolvedBalance = Math.max(0, resolvedTotal - resolvedPaid);
  const recent = (attempts.get(user.uid) ?? []).filter((timestamp) => timestamp > Date.now() - 3_600_000);
  if (recent.length >= 5) {
    res.status(429).json({ ok: false, error: "Payment attempt limit exceeded; try again later" });
    return;
  }
  recent.push(Date.now());
  attempts.set(user.uid, recent);
  const settings = configuredSettings(await savedPaymentSettings(user.token));
  const fee = Math.round((amountPaid * settings.serviceFeePercentage / 100 + settings.serviceFeeFixed) * 100) / 100;
  const grossAmount = amountPaid + fee;
  const paymentType = amountPaid > resolvedBalance ? "Overpayment" : amountPaid === resolvedBalance ? "Full Payment" : "Partial Payment";
  const reference = `PAY-${new Date().getUTCFullYear()}-${createHash("sha256").update(`${user.uid}:${Date.now()}`).digest("hex").slice(0, 12).toUpperCase()}`;
  const transaction: Record<string, unknown> = {
    reference,
    clientId: user.uid,
    clientName: String(body.clientName ?? "Client"),
    clientPhone,
    institutionId,
    sector,
    billReference,
    totalAmount: resolvedTotal,
    amountPaid,
    balanceRemaining: Math.max(0, resolvedBalance - amountPaid),
    fee,
    netAmount: Math.max(0, amountPaid - fee),
    paymentType,
    paymentMethod,
    status: "pending",
    createdAt: now(),
    createdBy: user.uid,
    amountSource: stored ? "server_bill_record" : "validated_request",
  };
  transaction.receiptNumber = `RCP-${new Date().getUTCFullYear()}-${reference}`;
  transaction.receiptHash = receiptHash(transaction);
  try {
    const document = await firestoreRequest("/payment_transactions", { method: "POST", body: JSON.stringify(firestoreFields(transaction)) }, user.token) as FirestoreDocument;
    const transactionId = document.name?.split("/documents/")[1] ?? "";
    void yoCall("acdepositfunds", {
      Amount: grossAmount.toFixed(2),
      Account: clientPhone,
      Narrative: `${billReference} payment`,
      ExternalReference: reference,
      InstantNotificationUrl: `${publicBaseUrl()}/api/webhooks/yo/ipn`,
      FailureNotificationUrl: `${publicBaseUrl()}/api/webhooks/yo/failure`,
    }, settings).then(async (providerResponse) => {
      if (transactionId) await firestoreRequest(`/${transactionId}`, { method: "PATCH", body: JSON.stringify(firestoreFields({ yoWebhookData: { initialResponse: providerResponse.slice(0, 10000) }, updatedAt: now() })) }, user.token).catch(() => undefined);
    }).catch(async (error) => {
      if (transactionId) await firestoreRequest(`/${transactionId}`, { method: "PATCH", body: JSON.stringify(firestoreFields({ status: "failed", failureReason: error instanceof Error ? error.message : "Yo API request failed", updatedAt: now() })) }, user.token).catch(() => undefined);
    });
    res.status(201).json({ ok: true, transactionId, reference, amountPaid, fee, grossAmount, status: "pending" });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "Payment could not be created" });
  }
});

function isActiveTeacherWithdrawal(status: unknown): boolean {
  return ["processing", "pending_provider_configuration", "pending", "submitted"].includes(String(status ?? ""));
}

async function releaseTeacherEarnings(earningIds: string[], extra: Record<string, unknown> = {}) {
  await Promise.all(earningIds.map((id) => firestoreRequest(`/teacherEarnings/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(firestoreFields({ payoutStatus: null, withdrawalId: null, ...extra })),
  })));
}

async function completeTeacherEarnings(earningIds: string[], withdrawalId: string, successful: boolean) {
  if (successful) {
    await Promise.all(earningIds.map((id) => firestoreRequest(`/teacherEarnings/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(firestoreFields({ paid: true, payoutStatus: "paid", paidAt: now(), withdrawalId })),
    })));
  } else {
    await releaseTeacherEarnings(earningIds, { payoutError: "The payout provider did not confirm this withdrawal." });
  }
}

router.post("/payments/teacher/withdraw", async (req, res) => {
  const user = await caller(req, res);
  if (!user) return;
  const teacher = await firestoreGet("users", user.uid, user.token);
  if (!teacher || teacher.role !== "teacher") {
    res.status(403).json({ ok: false, error: "Only teacher accounts can withdraw teacher earnings" });
    return;
  }
  const amount = Math.round(Number(req.body?.amount ?? 0));
  const beneficiaryType = String(req.body?.beneficiaryType ?? "").toLowerCase();
  const accountName = String(req.body?.accountName ?? "").trim();
  const account = String(req.body?.account ?? "").trim();
  const bankIdentifier = String(req.body?.bankIdentifier ?? "").trim();
  const mobile = beneficiaryType === "mobile_money";
  const accountValid = mobile ? /^\+?[0-9]{8,15}$/.test(account) : /^[A-Za-z0-9 .\/-]{4,34}$/.test(account);
  if (!Number.isSafeInteger(amount) || amount < 1000 || !["mobile_money", "bank"].includes(beneficiaryType) || !accountName || !accountValid || (beneficiaryType === "bank" && !bankIdentifier)) {
    res.status(400).json({ ok: false, error: "Enter a valid withdrawal amount and payout account details" });
    return;
  }
  const savedProfile = (teacher.teacherPayoutProfile && typeof teacher.teacherPayoutProfile === "object"
    ? teacher.teacherPayoutProfile : {}) as Record<string, unknown>;
  const profileMatches = savedProfile.status === "verified"
    && String(savedProfile.beneficiaryType ?? "") === beneficiaryType
    && String(savedProfile.accountName ?? "") === accountName
    && String(savedProfile.account ?? "") === account
    && String(savedProfile.bankIdentifier ?? "") === bankIdentifier;
  if (!profileMatches) {
    await firestoreRequest(`/users/${encodeURIComponent(user.uid)}`, {
      method: "PATCH",
      body: JSON.stringify(firestoreFields({
        teacherPayoutProfile: {
          beneficiaryType, accountName, account, bankIdentifier,
          status: "pending_validation", submittedAt: now(), updatedAt: now(),
        },
        payoutProfileUpdatedAt: now(),
      })),
    });
    res.status(202).json({
      ok: true, status: "pending_validation", approvalRequired: true,
      message: "Payout details submitted. An admin must validate them once before automatic withdrawals can start.",
    });
    return;
  }
  const lockPath = `/teacherPayoutLocks/${encodeURIComponent(user.uid)}`;
  try {
    await firestoreRequest(lockPath, {
      method: "PATCH",
      body: JSON.stringify({
        currentDocument: { exists: false },
        ...firestoreFields({ teacherId: user.uid, createdAt: now() }),
      }),
    });
  } catch {
    res.status(409).json({ ok: false, error: "Another withdrawal is already being prepared. Please wait." });
    return;
  }

  let reservedIds: string[] = [];
  try {
    const existingWithdrawals = documentRows(await firestoreQuery("teacherWithdrawals", "teacherId", user.uid));
    if (existingWithdrawals.some((item) => isActiveTeacherWithdrawal(item.status))) {
      res.status(409).json({ ok: false, error: "A previous withdrawal is still being processed." });
      return;
    }
    const earningRows = documentRows(await firestoreQuery("teacherEarnings", "teacherId", user.uid));
    const available = earningRows.filter((item) => item.paid !== true && item.payoutStatus !== "reserved" && item.payoutStatus !== "paid");
    const availableAmount = available.reduce((sum, item) => sum + Number(item.amount ?? 0), 0);
    if (amount > availableAmount || amount <= 0) {
      res.status(400).json({ ok: false, error: `The requested amount exceeds your available balance of UGX ${availableAmount.toLocaleString()}` });
      return;
    }
    if (!hasYoCredentials()) {
      res.status(503).json({ ok: false, error: "Automatic withdrawals are not available until the Yo provider is configured on the server. Your earnings were not changed." });
      return;
    }
    // Earnings are immutable units. Full-balance withdrawals always work; a
    // partial withdrawal must match whole earning records to avoid splitting
    // one view or referral across two payouts.
    const selected: Array<Record<string, unknown> & { id: string }> = [];
    let selectedAmount = 0;
    for (const earning of available) {
      if (selectedAmount + Number(earning.amount ?? 0) > amount) continue;
      selected.push(earning);
      selectedAmount += Number(earning.amount ?? 0);
      if (selectedAmount === amount) break;
    }
    if (selectedAmount !== amount) {
      res.status(400).json({ ok: false, error: "Choose the full available balance or an amount matching complete earning records." });
      return;
    }
    reservedIds = selected.map((item) => item.id);
    const withdrawalId = `TWD-${new Date().getUTCFullYear()}-${createHash("sha256").update(`${user.uid}:${Date.now()}`).digest("hex").slice(0, 16).toUpperCase()}`;
    const profile = { ...savedProfile, beneficiaryType, accountName, account, bankIdentifier, status: "verified", updatedAt: now() };
    await Promise.all(selected.map((item) => firestoreRequest(`/teacherEarnings/${encodeURIComponent(item.id)}`, {
      method: "PATCH",
      body: JSON.stringify(firestoreFields({ payoutStatus: "reserved", withdrawalId, reservedAt: now() })),
    })));
    const settings = configuredSettings(await savedPaymentSettings());
    const configured = true;
    const status = "processing";
    const withdrawal = {
      withdrawalId, teacherId: user.uid, teacherName: teacher.name ?? user.uid,
      amount, currency: "UGX", beneficiaryType, accountName, account, bankIdentifier,
      earningIds: reservedIds, status, createdAt: now(), updatedAt: now(),
      automatic: true, approvalRequired: false,
      blockedReason: configured ? null : "Yo API credentials are not configured on the server",
    };
    await firestoreRequest(`/teacherWithdrawals/${encodeURIComponent(withdrawalId)}`, {
      method: "PATCH", body: JSON.stringify(firestoreFields(withdrawal)),
    });
    await firestoreRequest(`/users/${encodeURIComponent(user.uid)}`, {
      method: "PATCH",
      body: JSON.stringify(firestoreFields({ teacherPayoutProfile: profile, pendingEarnings: Math.max(0, availableAmount - amount), payoutProfileUpdatedAt: now() })),
    });
    const disbursementId = `TDISC-${withdrawalId}`;
    await firestoreRequest(`/payment_disbursements/${encodeURIComponent(disbursementId)}`, {
      method: "PATCH",
      body: JSON.stringify(firestoreFields({
        disbursementId, teacherWithdrawalId: withdrawalId, teacherId: user.uid,
        externalRef: disbursementId, reference: withdrawalId, amount, netAmount: amount,
        fee: 0, beneficiaryType, beneficiaryAccount: account, beneficiaryAccountName: accountName,
        bankIdentifier, status, attempts: 0, maxAttempts: 3, createdAt: now(), updatedAt: now(),
        blockedReason: configured ? null : "Yo API credentials are not configured on the server",
      })),
    });
    if (configured) {
      const method = beneficiaryType === "bank" ? "acwithdrawfundstobank" : "acwithdrawfunds";
      try {
        const response = await yoCall(method, {
          Amount: amount.toFixed(2), CurrencyCode: "UGX", BeneficiaryAccount: account,
          BeneficiaryEmail: "", Narrative: `Teacher earnings withdrawal ${withdrawalId}`,
          ExternalReference: disbursementId, InstantNotificationUrl: `${publicBaseUrl()}/api/webhooks/yo/disbursement`,
          BankAccountName: accountName, BankAccountNumber: beneficiaryType === "bank" ? account : "",
          BankAccountIdentifier: bankIdentifier, TransferTransactionType: "EFT",
        }, settings);
        const yoTransactionId = xmlField(response, "TransactionReference") || xmlField(response, "reference") || "";
        await firestoreRequest(`/teacherWithdrawals/${encodeURIComponent(withdrawalId)}`, { method: "PATCH", body: JSON.stringify(firestoreFields({ status: "processing", yoTransactionId, updatedAt: now() })) });
        await firestoreRequest(`/payment_disbursements/${encodeURIComponent(disbursementId)}`, { method: "PATCH", body: JSON.stringify(firestoreFields({ status: "processing", yoTransactionId, requestSentAt: now(), updatedAt: now() })) });
      } catch (error) {
        await completeTeacherEarnings(reservedIds, withdrawalId, false);
        await firestoreRequest(`/teacherWithdrawals/${encodeURIComponent(withdrawalId)}`, { method: "PATCH", body: JSON.stringify(firestoreFields({ status: "failed", failureReason: error instanceof Error ? error.message : "Payout request failed", updatedAt: now() })) });
        await firestoreRequest(`/payment_disbursements/${encodeURIComponent(disbursementId)}`, { method: "PATCH", body: JSON.stringify(firestoreFields({ status: "failed", failureReason: error instanceof Error ? error.message : "Payout request failed", updatedAt: now() })) });
        res.status(502).json({ ok: false, error: "The payout provider rejected the withdrawal; your earnings were released." });
        return;
      }
    }
    res.status(201).json({ ok: true, withdrawalId, status });
  } catch (error) {
    if (reservedIds.length) await releaseTeacherEarnings(reservedIds).catch(() => undefined);
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "Withdrawal could not be created" });
  } finally {
    await firestoreRequest(lockPath, { method: "DELETE" }).catch(() => undefined);
  }
});

function webhookSignature(req: Request, raw: string): string {
  const header = req.headers["x-yo-signature"] ?? req.headers["yo-signature"];
  if (header) return String(header);
  if (raw.includes("=")) return new URLSearchParams(raw).get("signature") ?? "";
  return String(req.body?.signature ?? xmlField(raw, "Signature") ?? "");
}

function signatureCandidates(raw: string, body: Record<string, unknown>): string[] {
  const withoutSignature = raw.replace(/(^|&)signature=[^&]*(&|$)/i, "$1").replace(/^&|&$/g, "");
  const orderedKeys = ["date_time", "amount", "narrative", "network_ref", "external_ref", "msisdn", "payer_names", "payer_email"];
  return [
    withoutSignature,
    orderedKeys.map((key) => String(body[key] ?? "")).join(""),
    orderedKeys.map((key) => `${key}=${String(body[key] ?? "")}`).join("&"),
  ].filter(Boolean);
}

function validSignature(req: Request, raw: string): boolean {
  const key = process.env["YO_API_PUBLIC_KEY"];
  const signature = webhookSignature(req, raw);
  if (!key || !signature) return false;
  try {
    const publicKey = createPublicKey(key);
    return signatureCandidates(raw, req.body as Record<string, unknown>).some((candidate) => verifySignature("RSA-SHA1", Buffer.from(candidate), publicKey, Buffer.from(signature, "base64")));
  } catch {
    return false;
  }
}

async function logWebhook(data: Record<string, unknown>, callerToken?: string): Promise<string | null> {
  try {
    const document = await firestoreRequest("/yo_webhook_logs", { method: "POST", body: JSON.stringify(firestoreFields(data)) }, callerToken) as FirestoreDocument;
    return document.name?.split("/documents/")[1] ?? null;
  } catch {
    return null;
  }
}

async function queueNotification(transaction: Record<string, unknown>, recipientType: string, recipientId: unknown, message: string, extra: Record<string, unknown> = {}) {
  await firestoreRequest("/payment_notifications", { method: "POST", body: JSON.stringify(firestoreFields({
    transactionId: transaction.transactionId ?? transaction.reference, recipientType, recipientId, message,
    channels: ["in_app", "sms", "email"], deliveryStatus: "queued", status: "pending",
    smsEmailQueued: true, createdAt: now(), ...extra,
  })) });
}

async function institutionBeneficiary(institutionId: string): Promise<Record<string, unknown> | null> {
  const rows = await firestoreQuery("institution_beneficiaries", "institutionId", institutionId);
  const candidates = rows.map((row) => firestoreDocumentData(row.document)).filter((item) =>
    item.isActive === true && String(item.status ?? "active").toLowerCase() === "active");
  const item = candidates[0];
  if (!item) return null;
  return {
    ...item,
    type: item.type ?? item.beneficiaryType,
    account: item.account ?? item.beneficiaryAccount,
    email: item.email ?? item.contactEmail,
    phone: item.phone ?? item.contactPhone,
    accountName: item.accountName ?? item.bankAccountName,
    accountNumber: item.accountNumber ?? item.bankAccountNumber ?? item.beneficiaryAccount,
    bankIdentifier: item.bankIdentifier ?? item.apiBankIdentifier,
  };
}

async function createDisbursement(transaction: Record<string, unknown>, transactionId: string, amount: number) {
  const reference = String(transaction.reference ?? transactionId);
  const id = `DISC-${reference}`;
  const existing = await firestoreGet("payment_disbursements", id);
  if (existing && ["completed", "pending", "processing"].includes(String(existing.status))) return existing;
  const beneficiary = await institutionBeneficiary(String(transaction.institutionId ?? ""));
  const settings = configuredSettings(await savedPaymentSettings());
  const fee = Number(transaction.fee ?? Math.round(amount * settings.serviceFeePercentage) / 100);
  const netAmount = Math.max(0, amount - fee);
  const base = {
    disbursementId: id, transactionId, externalRef: id, reference, institutionId: transaction.institutionId,
    beneficiaryId: beneficiary?.beneficiaryId ?? beneficiary?.id ?? null,
    beneficiaryType: beneficiary?.type ?? null, beneficiaryAccount: beneficiary?.account ?? beneficiary?.accountNumber ?? null,
    amount, fee, netAmount, status: beneficiary ? "pending" : "pending", attempts: 0,
    maxAttempts: 3, retryDelaysSeconds: [30, 120, 600], createdAt: now(), updatedAt: now(),
    blockedReason: beneficiary ? null : "No active beneficiary",
  };
  await firestoreRequest(`/payment_disbursements/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(firestoreFields(base)) });
  await firestoreRequest("/payment_audit_log", { method: "POST", body: JSON.stringify(firestoreFields({
    action: beneficiary ? "disbursement_queued" : "disbursement_blocked", actorId: "system",
    transactionId, details: { externalRef: id, amount, netAmount, beneficiaryId: base.beneficiaryId }, timestamp: now(),
  })) });
  if (!beneficiary) {
    await queueNotification(transaction, "SuperAdmin", "superadmin", "Disbursement blocked — no active beneficiary");
    return base;
  }
  if (!settings.autoDisburse || !hasYoCredentials()) return base;
  try {
    const type = String(beneficiary.type ?? "").toLowerCase();
    const method = type.includes("bank") ? "acwithdrawfundstobank" : type.includes("mobile") || type.includes("momo") ? "acwithdrawfunds" : "acinternaltransfer";
    const response = await yoCall(method, {
      Amount: netAmount.toFixed(2), CurrencyCode: "UGX", BeneficiaryAccount: String(beneficiary.account ?? beneficiary.accountNumber ?? ""),
      BeneficiaryEmail: String(beneficiary.email ?? ""), Narrative: `Payment disbursement ${reference}`, ExternalReference: id,
      BankAccountName: String(beneficiary.accountName ?? ""), BankAccountNumber: String(beneficiary.accountNumber ?? ""),
      BankAccountIdentifier: String(beneficiary.bankIdentifier ?? beneficiary.bankCode ?? ""),
      TransferTransactionType: String(beneficiary.transferType ?? "EFT"),
    }, settings);
    const yoTransactionId = xmlField(response, "TransactionReference") || xmlField(response, "reference") || "";
    await firestoreRequest(`/payment_disbursements/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(firestoreFields({ status: "processing", yoTransactionId, requestSentAt: now(), updatedAt: now() })) });
  } catch (error) {
    await firestoreRequest(`/payment_disbursements/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(firestoreFields({
      status: "failed", attempts: 1, nextRetryAt: new Date(Date.now() + 30000).toISOString(),
      retryDelaySeconds: 30, failureReason: error instanceof Error ? error.message : "Disbursement request failed", updatedAt: now(),
    })) });
  }
  return base;
}

async function updateBalance(transaction: Record<string, unknown>, amount: number) {
  const sector = String(transaction.sector ?? "").toLowerCase();
  const collectionNames = sector.includes("clinic") ? ["clinic_billing"] : sector.includes("mfi") ? ["microfinance_loans", "mfi_loans"] : ["school_fees", "school_bills"];
  const reference = String(transaction.billReference ?? "");
  for (const collectionName of collectionNames) {
    const current = await firestoreGet(collectionName, reference);
    if (!current) continue;
    const paid = Number(current.paidAmount ?? current.amountPaid ?? 0) + amount;
    const total = Number(current.totalAmount ?? current.loanAmount ?? current.amount ?? transaction.totalAmount ?? 0);
    const overpayment = Math.max(0, paid - total);
    const balance = Math.max(0, total - paid);
    const status = balance === 0 ? "paid" : paid > 0 ? "partial" : "unpaid";
    const scheduleKey = collectionName.includes("microfinance") || collectionName.includes("mfi") ? (Array.isArray(current.repaymentSchedule) ? "repaymentSchedule" : Array.isArray(current.installments) ? "installments" : null) : null;
    const schedule = scheduleKey ? [...(current[scheduleKey] as unknown[])] as Array<Record<string, unknown>> : null;
    if (schedule) {
      let remainingPayment = amount;
      for (const installment of schedule) {
        if (remainingPayment <= 0) break;
        const due = Number(installment.amountDue ?? installment.amount ?? installment.totalAmount ?? 0);
        const installmentPaid = Number(installment.amountPaid ?? installment.paidAmount ?? 0);
        const applied = Math.min(remainingPayment, Math.max(0, due - installmentPaid));
        if (applied <= 0) continue;
        const nextPaid = installmentPaid + applied;
        installment.amountPaid = nextPaid;
        installment.paidAmount = nextPaid;
        installment.status = nextPaid >= due ? "paid" : "partially_paid";
        installment.lastPaymentAmount = applied;
        installment.lastPaymentDate = now();
        remainingPayment -= applied;
      }
    }
    await firestoreRequest(`/${collectionName}/${encodeURIComponent(reference)}`, { method: "PATCH", body: JSON.stringify(firestoreFields({
      paidAmount: paid, amountPaid: paid, balanceAmount: balance, balanceRemaining: balance,
      paymentStatus: status === "paid" ? "Paid" : status === "partial" ? "Partially Paid" : "Unpaid",
      repaymentStatus: status === "paid" ? "Fully Repaid" : status === "partial" ? "Partially Paid" : "On Track",
      status, lastPaymentDate: now(), lastPaymentAmount: amount, updatedAt: now(),
      ...(schedule ? { [scheduleKey as string]: schedule } : {}),
    })) });
    const balanceId = `${String(transaction.clientId ?? "client")}-${String(transaction.institutionId ?? "institution")}-${reference}`.replace(/[^A-Za-z0-9_-]/g, "_");
    await firestoreRequest(`/sector_balances/${encodeURIComponent(balanceId)}`, { method: "PATCH", body: JSON.stringify(firestoreFields({
      balanceId, clientId: transaction.clientId, institutionId: transaction.institutionId, sector: transaction.sector,
      referenceType: collectionName === "school_fees" ? "school_fees" : collectionName === "clinic_billing" ? "clinic_bill" : "microfinance_loan",
      referenceId: reference, totalAmount: total, amountPaid: paid, balanceRemaining: balance,
      status: overpayment > 0 ? "overpaid" : balance === 0 ? "paid" : paid > 0 ? "partially_paid" : "unpaid",
      dueDate: current.dueDate ?? current.due_date ?? null, lastPaymentDate: now(), lastPaymentAmount: amount, updatedAt: now(),
    })) });
    if (overpayment > 0) {
      const creditId = `CN-${String(transaction.reference ?? reference)}`;
      await firestoreRequest(`/credit_notes/${encodeURIComponent(creditId)}`, { method: "PATCH", body: JSON.stringify(firestoreFields({
        creditNoteId: creditId, clientId: transaction.clientId, clientName: transaction.clientName ?? "Client",
        institutionId: transaction.institutionId, sector: transaction.sector, originalBillReference: reference,
        creditAmount: overpayment, usedAmount: 0, balanceRemaining: overpayment, status: "active",
        expiryDate: new Date(Date.now() + 365 * 86400000).toISOString(), createdAt: now(), updatedAt: now(), createdBy: "system",
      })) });
    }
    return { collectionName, balance, overpayment, status };
  }
  return null;
}

async function processWebhook(req: Request, res: Response, failed: boolean) {
  const raw = String((req as Request & { rawBody?: string }).rawBody ?? "");
  const body = (req.body ?? {}) as Record<string, unknown>;
  const networkRef = String(body.network_ref ?? xmlField(raw, "network_ref") ?? "");
  const msisdn = String(body.msisdn ?? xmlField(raw, "msisdn") ?? "");
  const externalRef = String(body.external_ref ?? body.ExternalReference ?? xmlField(raw, "external_ref") ?? xmlField(raw, "ExternalReference") ?? "");
  const verified = validSignature(req, raw);
  const logId = await logWebhook({ logId: `yo-${Date.now()}`, webhookType: failed ? "Failure" : "IPN", payload: body, signature: webhookSignature(req, raw), isVerified: verified, processed: false, networkRef, msisdn, receivedAt: now() });
  if (!verified) {
    res.status(401).json({ ok: false, error: "Invalid webhook signature" });
    return;
  }
  try {
    if (!externalRef) {
      res.status(200).json({ ok: true, processed: false });
      return;
    }
    const referralRegistration = await settleStudentReferralPayment(externalRef, failed, body)
      || await settleTeacherRegistrationPayment(externalRef, failed, body);
    if (referralRegistration) {
      if (logId) {
        await firestoreRequest(`/yo_webhook_logs/${encodeURIComponent(logId)}`, {
          method: "PATCH",
          body: JSON.stringify(firestoreFields({ processed: true, processedAt: now() })),
        });
      }
      res.status(200).json({ ok: true, processed: true, referralRegistration: true });
      return;
    }
    if (networkRef && msisdn && (await firestoreQuery("yo_webhook_logs", "networkRef", networkRef)).some((row) => String(firestoreDocumentData(row.document).msisdn ?? "") === msisdn && firestoreDocumentData(row.document).isVerified === true && firestoreDocumentData(row.document).processed === true)) {
      res.status(200).json({ ok: true, duplicate: true });
      return;
    }
    const matches = await firestoreQuery("payment_transactions", "reference", externalRef);
    const match = matches.find((row) => row.document?.name);
    if (!match?.document?.name) {
      res.status(200).json({ ok: true, processed: false });
      return;
    }
    const transactionPath = match.document.name.split("/documents/")[1];
    const transaction = firestoreDocumentData(match.document);
    const transactionMonth = String(transaction.paymentDate ?? transaction.createdAt ?? "").slice(0, 7);
    if (transactionMonth && await lockedMonth(transactionMonth)) {
      res.status(423).json({ ok: false, error: "Payment month is locked; transaction cannot be edited" });
      return;
    }
    if (!failed && transaction.status === "completed") {
      res.status(200).json({ ok: true, duplicate: true });
      return;
    }
    // The callback confirms the transaction; it never gets to redefine the
    // amount that was authorized and stored during initiation.
    const amount = Number(transaction.amountPaid ?? 0);
    const updated = {
      status: failed ? "failed" : "completed",
      yoTransactionId: String(body.reference ?? body.transaction_id ?? ""),
      yoNetworkRef: networkRef,
      yoMsisdn: msisdn,
      yoWebhookData: body,
      paymentDate: now(),
      updatedAt: now(),
    };
    await firestoreRequest(`/${transactionPath}`, { method: "PATCH", body: JSON.stringify(firestoreFields(updated)) });
    if (!failed) {
      const balanceUpdate = await updateBalance(transaction, amount);
      const transactionId = transactionPath.split("/").pop() ?? "";
      await createDisbursement(transaction, transactionId, amount);
      await queueNotification({ ...transaction, transactionId }, "Client", transaction.clientId, `Payment confirmed. Balance: UGX ${Number(balanceUpdate?.balance ?? transaction.balanceRemaining ?? 0).toLocaleString()}`);
      await queueNotification({ ...transaction, transactionId }, "Institution", transaction.institutionId, `Payment of UGX ${amount.toLocaleString()} received`);
      await queueNotification({ ...transaction, transactionId }, "SuperAdmin", "superadmin", `Payment: UGX ${amount.toLocaleString()} received`);
      if (Number(balanceUpdate?.overpayment ?? 0) > 0) {
        const message = `You overpaid UGX ${Number(balanceUpdate?.overpayment).toLocaleString()}. Credit note issued.`;
        await queueNotification({ ...transaction, transactionId }, "Client", transaction.clientId, message);
        await queueNotification({ ...transaction, transactionId }, "Institution", transaction.institutionId, "Overpayment received");
        await queueNotification({ ...transaction, transactionId }, "SuperAdmin", "superadmin", `Client overpaid UGX ${Number(balanceUpdate?.overpayment).toLocaleString()}`);
      }
    } else {
      await queueNotification({ ...transaction, transactionId: transactionPath.split("/").pop() }, "Client", transaction.clientId, "Payment failed. Try again or contact support.");
    }
    await firestoreRequest("/payment_audit_log", { method: "POST", body: JSON.stringify(firestoreFields({ action: failed ? "failed" : "ipn_received", actorId: "yo-webhook", transactionId: transactionPath.split("/").pop(), details: { externalRef, networkRef, amount }, timestamp: now() })) });
    if (logId) await firestoreRequest(`/yo_webhook_logs/${encodeURIComponent(logId)}`, { method: "PATCH", body: JSON.stringify(firestoreFields({ processed: true, processedAt: now() })) });
    res.status(200).json({ ok: true, processed: true });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "Webhook persistence failed" });
  }
}

router.post("/webhooks/yo/ipn", (req, res) => void processWebhook(req, res, false));
router.post("/webhooks/yo/failure", (req, res) => void processWebhook(req, res, true));

router.post("/webhooks/yo/disbursement", async (req, res) => {
  const raw = String((req as Request & { rawBody?: string }).rawBody ?? "");
  if (!validSignature(req, raw)) {
    res.status(401).json({ ok: false, error: "Invalid webhook signature" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const externalRef = String(body.external_ref ?? body.ExternalReference ?? xmlField(raw, "external_ref") ?? "");
  if (!externalRef) {
    res.status(400).json({ ok: false, error: "external_ref is required" });
    return;
  }
  try {
    const rows = await firestoreQuery("payment_disbursements", "externalRef", externalRef);
    const document = rows.find((row) => row.document?.name);
    if (!document?.document?.name) {
      res.status(404).json({ ok: false, error: "Disbursement not found" });
      return;
    }
    const path = document.document.name.split("/documents/")[1];
    const current = firestoreDocumentData(document.document);
    const successful = /success|complete|processed/i.test(String(body.status ?? body.Status ?? xmlField(raw, "Status")));
    const update: Record<string, unknown> = {
      status: successful ? "completed" : "failed",
      yoTransactionId: String(body.reference ?? body.transaction_id ?? body.network_ref ?? ""),
      webhookData: body, updatedAt: now(),
    };
    if (successful) update.disbursedAt = now();
    else {
      const attempts = Number(current.attempts ?? 0) + 1;
      update.attempts = attempts;
      update.retryDelaySeconds = attempts === 1 ? 30 : attempts === 2 ? 120 : 600;
      update.nextRetryAt = attempts < 3 ? new Date(Date.now() + Number(update.retryDelaySeconds) * 1000).toISOString() : null;
      update.status = attempts >= 3 ? "needs_manual_review" : "failed";
      update.retryExhausted = attempts >= 3;
    }
    await firestoreRequest(`/${path}`, { method: "PATCH", body: JSON.stringify(firestoreFields(update)) });
    if (current.teacherWithdrawalId && current.teacherId) {
      const withdrawalId = String(current.teacherWithdrawalId);
      const earningIds = Array.isArray(current.earningIds) ? current.earningIds.map(String) : [];
      await completeTeacherEarnings(earningIds, withdrawalId, successful);
      await firestoreRequest(`/teacherWithdrawals/${encodeURIComponent(withdrawalId)}`, {
        method: "PATCH",
        body: JSON.stringify(firestoreFields({
          status: successful ? "completed" : "failed",
          disbursedAt: successful ? now() : null,
          failureReason: successful ? null : "The payout provider did not confirm this withdrawal.",
          updatedAt: now(),
        })),
      });
    }
    if (current.studentReferralWithdrawalId && current.studentId) {
      const withdrawalId = String(current.studentReferralWithdrawalId);
      const studentId = String(current.studentId);
      if (!successful && current.cashRestored !== true) {
        const student = await firestoreGet("users", studentId);
        await firestoreRequest(`/users/${encodeURIComponent(studentId)}`, {
          method: "PATCH",
          body: JSON.stringify(firestoreFields({
            referralCashBalance: Number(student?.referralCashBalance ?? 0) + Number(current.amount ?? 0),
          })),
        });
        await firestoreRequest(`/${path}`, {
          method: "PATCH",
          body: JSON.stringify(firestoreFields({ cashRestored: true })),
        });
      }
      await firestoreRequest(`/studentReferralWithdrawals/${encodeURIComponent(withdrawalId)}`, {
        method: "PATCH",
        body: JSON.stringify(firestoreFields({
          status: successful ? "completed" : "failed",
          disbursedAt: successful ? now() : null,
          cashRestored: !successful,
          failureReason: successful ? null : "The payout provider did not confirm this withdrawal.",
          updatedAt: now(),
        })),
      });
    }
    await firestoreRequest("/payment_audit_log", { method: "POST", body: JSON.stringify(firestoreFields({ action: `disbursement_${update.status}`, actorId: "yo-webhook", disbursementId: path.split("/").pop(), details: update, timestamp: now() })) });
    if (current.teacherWithdrawalId && current.teacherId) {
      await queueNotification({ transactionId: current.teacherWithdrawalId, reference: externalRef }, "Teacher", current.teacherId, successful ? `UGX ${Number(current.netAmount ?? 0).toLocaleString()} withdrawal completed` : "Your withdrawal failed and the earnings were released.");
    } else if (current.studentReferralWithdrawalId && current.studentId) {
      await queueNotification({ transactionId: current.studentReferralWithdrawalId, reference: externalRef }, "Student", current.studentId, successful ? `UGX ${Number(current.netAmount ?? 0).toLocaleString()} referral withdrawal completed` : "Your referral withdrawal failed and the balance was returned.");
    } else {
      const institutionId = current.institutionId;
      await queueNotification({ transactionId: current.transactionId, reference: externalRef }, "Institution", institutionId, successful ? `Funds of UGX ${Number(current.netAmount ?? 0).toLocaleString()} disbursed` : `Disbursement failed. Retry ${Number(update.attempts ?? 0)}/3`);
      await queueNotification({ transactionId: current.transactionId, reference: externalRef }, "SuperAdmin", "superadmin", successful ? "Disbursement completed" : `Disbursement failed. Retry ${Number(update.attempts ?? 0)}/3`);
    }
    res.json({ ok: true, status: update.status });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "Disbursement webhook failed" });
  }
});

router.post("/payments/credits/apply", async (req, res) => {
  const user = await caller(req, res);
  if (!user) return;
  const creditNoteId = String(req.body?.creditNoteId ?? "");
  const balanceId = String(req.body?.balanceId ?? "");
  const requested = Number(req.body?.amount ?? 0);
  const credit = await firestoreGet("credit_notes", creditNoteId, user.token);
  if (!credit || credit.clientId !== user.uid || credit.status !== "active" || Number(credit.balanceRemaining) <= 0) {
    res.status(404).json({ ok: false, error: "Credit note not found or not owned by caller" });
    return;
  }
  const balance = balanceId ? await firestoreGet("sector_balances", balanceId, user.token) : null;
  if (balanceId && (!balance || balance.clientId !== user.uid || Number(balance.balanceRemaining ?? 0) <= 0)) {
    res.status(404).json({ ok: false, error: "Balance not found or not owned by caller" });
    return;
  }
  const amount = Math.min(
    Number.isFinite(requested) && requested > 0 ? requested : Number(credit.balanceRemaining),
    Number(credit.balanceRemaining),
    balance ? Number(balance.balanceRemaining ?? 0) : Number(credit.balanceRemaining),
  );
  const remaining = Number(credit.balanceRemaining) - amount;
  await firestoreRequest(`/credit_notes/${encodeURIComponent(creditNoteId)}`, { method: "PATCH", body: JSON.stringify(firestoreFields({ usedAmount: Number(credit.usedAmount ?? 0) + amount, balanceRemaining: remaining, status: remaining === 0 ? "used" : "active", updatedAt: now() })) }, user.token);
  let targetBalanceRemaining: number | null = null;
  if (balance) {
    targetBalanceRemaining = Math.max(0, Number(balance.balanceRemaining ?? 0) - amount);
    await firestoreRequest(`/sector_balances/${encodeURIComponent(balanceId)}`, { method: "PATCH", body: JSON.stringify(firestoreFields({
      amountPaid: Number(balance.amountPaid ?? 0) + amount,
      balanceRemaining: targetBalanceRemaining,
      status: targetBalanceRemaining === 0 ? "paid" : "partially_paid",
      lastPaymentAmount: amount,
      lastPaymentDate: now(),
      updatedAt: now(),
    })) }, user.token);
    await queueNotification({ transactionId: balanceId }, "Client", user.uid, `Your credit note of UGX ${amount.toLocaleString()} was applied to ${String(balance.referenceId ?? balanceId)}`);
  }
  res.json({ ok: true, appliedAmount: amount, balanceRemaining: remaining, targetBalanceRemaining });
});

router.get("/payments/summary", async (req, res) => {
  const user = await caller(req, res);
  if (!user) return;
  try {
    const [balanceRows, creditRows, transactionRows] = await Promise.all([
      firestoreQuery("sector_balances", "clientId", user.uid),
      firestoreQuery("credit_notes", "clientId", user.uid),
      firestoreQuery("payment_transactions", "clientId", user.uid),
    ]);
    const withIds = (rows: Array<{ document?: FirestoreDocument }>): Array<Record<string, unknown> & { id: string }> => rows.map((row) => {
      const document = firestoreDocumentData(row.document);
      const id = row.document?.name?.split("/").pop() ?? "";
      return { id, ...document };
    });
    const balances = withIds(balanceRows);
    const credits = withIds(creditRows).filter((item) => item.status === "active" && Number(item.balanceRemaining ?? 0) > 0);
    const history = withIds(transactionRows).sort((left, right) => String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? ""))).slice(0, 100);
    res.json({
      ok: true,
      balances,
      credits,
      history,
      totalOutstanding: balances.reduce((sum, item) => sum + Number(item.balanceRemaining ?? 0), 0),
      totalCredits: credits.reduce((sum, item) => sum + Number(item.balanceRemaining ?? 0), 0),
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "Unable to load payment summary" });
  }
});

function reminderTypeFor(daysUntilDue: number): string | null {
  if (daysUntilDue === 7) return "due_soon";
  if (daysUntilDue === 0) return "due_today";
  if (daysUntilDue === -1) return "overdue_1day";
  if (daysUntilDue === -7) return "overdue_7days";
  if (daysUntilDue === -30) return "overdue_30days";
  return null;
}

function reminderMessage(type: string, balance: Record<string, unknown>): string {
  const amount = Number(balance.balanceRemaining ?? 0).toLocaleString();
  const reference = String(balance.referenceId ?? balance.balanceId ?? "bill");
  const institution = String(balance.institutionName ?? balance.institutionId ?? "your institution");
  if (type === "due_soon") return `Reminder: your ${reference} balance of UGX ${amount} is due in 7 days.`;
  if (type === "due_today") return `Due today: your ${reference} balance of UGX ${amount} is due today.`;
  if (type === "overdue_1day") return `Payment overdue: UGX ${amount} remains due on ${reference}.`;
  if (type === "overdue_7days") return `7-day overdue notice: UGX ${amount} remains due. Please contact ${institution}.`;
  return `30-day overdue notice: UGX ${amount} remains due. Please contact ${institution}.`;
}

router.post("/payments/reminders/run", async (req, res) => {
  const uid = await admin(req, res);
  if (!uid) return;
  try {
    const balances = [
      ...(await firestoreQuery("sector_balances", "status", "unpaid")),
      ...(await firestoreQuery("sector_balances", "status", "partially_paid")),
    ].map((row) => firestoreDocumentData(row.document));
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    let queued = 0;
    for (const balance of balances) {
      const due = Date.parse(String(balance.dueDate ?? ""));
      if (!Number.isFinite(due)) continue;
      const dueDay = new Date(due);
      dueDay.setUTCHours(0, 0, 0, 0);
      const daysUntilDue = Math.round((dueDay.getTime() - today.getTime()) / 86400000);
      const type = reminderTypeFor(daysUntilDue);
      if (!type) continue;
      const balanceId = String(balance.balanceId ?? balance.referenceId ?? "");
      const reminderId = `REM-${balanceId}-${type}-${today.toISOString().slice(0, 10)}`.replace(/[^A-Za-z0-9_-]/g, "_");
      if (await firestoreGet("payment_reminders", reminderId)) continue;
      const message = reminderMessage(type, balance);
      await firestoreRequest(`/payment_reminders/${encodeURIComponent(reminderId)}`, { method: "PATCH", body: JSON.stringify(firestoreFields({
        reminderId, balanceId, clientId: balance.clientId, institutionId: balance.institutionId, reminderType: type,
        channel: "in_app", message, scheduledAt: now(), sentAt: null, status: "pending", createdAt: now(),
      })) });
      await queueNotification({ transactionId: balanceId }, "Client", balance.clientId, message, { reminderId, reminderType: type, channels: ["in_app", "sms"], deliveryStatus: "queued" });
      queued += 1;
    }
    await firestoreRequest("/payment_audit_log", { method: "POST", body: JSON.stringify(firestoreFields({ action: "payment_reminder_sweep", actorId: uid, details: { queued }, timestamp: now() })) });
    res.json({ ok: true, queued });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "Unable to run payment reminders" });
  }
});

router.get("/payments/disbursements", async (req, res) => {
  if (!await admin(req, res)) return;
  try {
    const rows = await firestoreQuery("payment_disbursements", "status", String(req.query.status ?? "pending"));
    res.json({ ok: true, disbursements: rows.map((row) => firestoreDocumentData(row.document)) });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "Unable to load disbursements" });
  }
});

router.post("/payments/disbursements/:id/retry", async (req, res) => {
  const uid = await admin(req, res);
  if (!uid) return;
  const id = String(req.params.id);
  const current = await firestoreGet("payment_disbursements", id);
  if (!current) {
    res.status(404).json({ ok: false, error: "Disbursement not found" });
    return;
  }
  const attempts = Number(current.attempts ?? 0);
  if (attempts >= 3) {
    res.status(409).json({ ok: false, error: "Automatic retry limit exhausted; manual review required" });
    return;
  }
  await firestoreRequest(`/payment_disbursements/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(firestoreFields({
    status: "pending", retryRequestedBy: uid, retryRequestedAt: now(), nextRetryAt: now(), updatedAt: now(),
  })) });
  res.json({ ok: true, status: "pending", attempts, maxAttempts: 3 });
});

router.post("/payments/disbursements/:id/manual-review", async (req, res) => {
  const uid = await admin(req, res);
  if (!uid) return;
  const id = String(req.params.id);
  await firestoreRequest(`/payment_disbursements/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(firestoreFields({ status: "needs_manual_review", manualReviewBy: uid, manualReviewAt: now(), updatedAt: now() })) });
  res.json({ ok: true, status: "needs_manual_review" });
});

// Step 3 reporting and reconciliation APIs. These endpoints intentionally keep
// the provider credentials in this module and never include them in responses.
async function audit(action: string, actorId: string, details: Record<string, unknown> = {}) {
  await firestoreRequest("/payment_audit_log", {
    method: "POST", body: JSON.stringify(firestoreFields({ action, actorId, details, timestamp: now() })),
  }).catch(() => undefined);
}

function inPeriod(item: Record<string, unknown>, from?: string, to?: string) {
  const date = Date.parse(String(item.paymentDate ?? item.createdAt ?? item.disbursedAt ?? ""));
  return (!from || date >= Date.parse(from)) && (!to || date <= Date.parse(to));
}

async function lockedMonth(value: string): Promise<boolean> {
  const archive = await firestoreGet("payment_monthly_archives", value);
  return archive?.locked === true || archive?.status === "locked";
}

async function institutionFor(user: { uid: string; role: string; token: string }) {
  if (user.role === "superadmin") return null;
  const profile = await firestoreGet("users", user.uid, user.token).catch(() => null);
  return String(profile?.institutionId ?? profile?.schoolId ?? "");
}

router.get("/payments/reports", async (req, res) => {
  const uid = await admin(req, res);
  if (!uid) return;
  try {
    const all = documentRows(await firestoreList("payment_transactions"));
    const rows = all.filter((item) => inPeriod(item, String(req.query.from ?? ""), String(req.query.to ?? "")))
      .filter((item) => !req.query.sector || item.sector === req.query.sector)
      .filter((item) => !req.query.status || item.status === req.query.status)
      .filter((item) => !req.query.institutionId || item.institutionId === req.query.institutionId);
    const total = rows.reduce((sum, item) => sum + Number(item.amountPaid ?? item.amount ?? 0), 0);
    const fees = rows.reduce((sum, item) => sum + Number(item.fee ?? 0), 0);
    const report = { generatedAt: now(), reportType: String(req.query.type ?? "transactions"), rows,
      summary: { transactionCount: rows.length, totalAmount: total, fees, netAmount: total - fees } };
    const cacheId = `${report.reportType}-${createHash("sha256").update(JSON.stringify(req.query)).digest("hex").slice(0, 16)}`;
    await firestoreRequest(`/payment_reports_cache/${encodeURIComponent(cacheId)}`, {
      method: "PATCH", body: JSON.stringify(firestoreFields({ ...report, cacheId })),
    });
    await audit("payment_report_generated", uid, { reportType: report.reportType, count: rows.length });
    res.json({ ok: true, ...report, cacheId });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "Unable to generate payment report" });
  }
});

router.get("/payments/inbox", async (req, res) => {
  const user = await caller(req, res);
  if (!user) return;
  const institutionId = await institutionFor(user);
  if (user.role !== "superadmin" && !institutionId) {
    res.status(403).json({ ok: false, error: "Institution scope is required" }); return;
  }
  try {
    const rows = documentRows(await firestoreList("payment_transactions"))
      .filter((item) => user.role === "superadmin" || item.institutionId === institutionId)
      .filter((item) => inPeriod(item, String(req.query.from ?? ""), String(req.query.to ?? "")))
      .sort((a, b) => String(b.paymentDate ?? b.createdAt).localeCompare(String(a.paymentDate ?? a.createdAt)));
    res.json({ ok: true, institutionId, transactions: rows, totalAmount: rows.reduce((s, x) => s + Number(x.amountPaid ?? 0), 0) });
  } catch (error) { res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "Unable to load payment inbox" }); }
});

router.get("/payments/statements/:institutionId", async (req, res) => {
  const user = await caller(req, res);
  if (!user) return;
  const institutionId = String(req.params.institutionId);
  const ownedInstitution = await institutionFor(user);
  if (user.role !== "superadmin" && ownedInstitution !== institutionId) {
    res.status(403).json({ ok: false, error: "Institution access denied" }); return;
  }
  try {
    const rows = documentRows(await firestoreList("payment_transactions")).filter((x) => x.institutionId === institutionId)
      .filter((x) => inPeriod(x, String(req.query.from ?? ""), String(req.query.to ?? "")));
    const received = rows.reduce((s, x) => s + Number(x.amountPaid ?? 0), 0);
    const fees = rows.reduce((s, x) => s + Number(x.fee ?? 0), 0);
    res.json({ ok: true, statementNumber: `STM-${new Date().getUTCFullYear()}-${institutionId}-${Date.now()}`,
      institutionId, transactions: rows, summary: { totalReceived: received, totalFees: fees, netDisbursed: received - fees,
        pending: rows.filter((x) => x.status === "pending").length } });
  } catch (error) { res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "Unable to generate statement" }); }
});

function receiptHash(transaction: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify({
    reference: transaction.reference, amountPaid: transaction.amountPaid, institutionId: transaction.institutionId,
    paymentDate: transaction.paymentDate ?? transaction.createdAt,
  })).digest("hex");
}

router.get("/payments/receipts/:id/verify", async (req, res) => {
  try {
    const transaction = await firestoreGet("payment_transactions", String(req.params.id));
    if (!transaction) { res.status(404).json({ ok: false, error: "Receipt not found" }); return; }
    const expected = receiptHash(transaction);
    const supplied = String(req.query.hash ?? transaction.receiptHash ?? "");
    res.json({ ok: true, authentic: supplied === expected, receiptNumber: transaction.receiptNumber ?? `RCP-${transaction.reference}`,
      hash: expected, details: { reference: transaction.reference, amountPaid: transaction.amountPaid,
        paymentDate: transaction.paymentDate, institutionId: transaction.institutionId, status: transaction.status } });
  } catch (error) { res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "Unable to verify receipt" }); }
});

router.post("/payments/reconciliation", async (req, res) => {
  const uid = await admin(req, res);
  if (!uid) return;
  const from = String(req.body?.from ?? req.body?.startDate ?? "");
  const to = String(req.body?.to ?? req.body?.endDate ?? "");
  if (!from || !to || !Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to))) {
    res.status(400).json({ ok: false, error: "Valid from and to dates are required" }); return;
  }
  try {
    const local = documentRows(await firestoreList("payment_transactions")).filter((x) => inPeriod(x, from, to));
    let provider: Array<Record<string, unknown>> = [];
    let sandbox = false;
    if (hasYoCredentials()) {
      const xml = await yoCall("acgetministatement", { FromDate: from, ToDate: to }, configuredSettings());
      const refs = [...xml.matchAll(/<(?:ExternalReference|external_ref|TransactionReference|reference)>([^<]+)</gi)];
      provider = refs.map((m) => ({ externalRef: m[1], yoTransactionId: m[1] }));
    } else sandbox = true;
    const byRef = new Map(local.map((x) => [String(x.yoTransactionId ?? x.externalRef ?? x.reference), x]));
    const mismatches: Array<Record<string, unknown>> = [];
    let matched = 0;
    for (const remote of provider) {
      const localItem = byRef.get(String(remote.yoTransactionId ?? remote.externalRef));
      if (localItem) { matched++; byRef.delete(String(remote.yoTransactionId ?? remote.externalRef)); }
      else mismatches.push({ issueType: "missing_in_appshule", yo: remote });
    }
    for (const localItem of byRef.values()) mismatches.push({ issueType: "missing_in_yo", appshule: localItem });
    const reconciliationId = `RECON-${Date.now()}`;
    const result = { reconciliationId, from, to, sandbox, matched, mismatches, providerCount: provider.length, localCount: local.length, createdAt: now(), status: "open", createdBy: uid };
    await firestoreRequest(`/payment_reconciliations/${reconciliationId}`, { method: "PATCH", body: JSON.stringify(firestoreFields(result)) });
    await audit("reconciliation_run", uid, { reconciliationId, from, to, sandbox, mismatchCount: mismatches.length });
    res.json({ ok: true, ...result });
  } catch (error) { res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "Reconciliation failed" }); }
});

router.post("/payments/reconciliation/:id/resolve", async (req, res) => {
  const uid = await admin(req, res);
  if (!uid) return;
  const id = String(req.params.id);
  const action = String(req.body?.action ?? "resolved");
  const current = await firestoreGet("payment_reconciliations", id);
  if (!current) { res.status(404).json({ ok: false, error: "Reconciliation not found" }); return; }
  await firestoreRequest(`/payment_reconciliations/${id}`, { method: "PATCH", body: JSON.stringify(firestoreFields({ status: "resolved", resolutionAction: action, resolvedBy: uid, resolvedAt: now() })) });
  await audit("reconciliation_mismatch_resolved", uid, { reconciliationId: id, action });
  res.json({ ok: true, status: "resolved", action });
});

router.post("/payments/reconciliation/daily", async (req, res) => {
  const uid = await admin(req, res); if (!uid) return;
  const date = String(req.body?.date ?? now().slice(0, 10));
  const record = { reconciliationDate: date, date, cashInHand: Number(req.body?.cashInHand ?? 0), mobileMoney: Number(req.body?.mobileMoney ?? 0),
    bank: Number(req.body?.bank ?? 0), insuranceClaimsPending: Number(req.body?.insuranceClaimsPending ?? 0), variances: req.body?.variances ?? {}, createdBy: uid, createdAt: now() };
  await firestoreRequest(`/payment_daily_reconciliations/${date}`, { method: "PATCH", body: JSON.stringify(firestoreFields(record)) });
  await audit("daily_reconciliation_created", uid, { date }); res.json({ ok: true, ...record });
});

router.post("/payments/reconciliation/month-end/lock", async (req, res) => {
  const uid = await admin(req, res); if (!uid) return;
  const month = String(req.body?.month ?? "");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) { res.status(400).json({ ok: false, error: "month must be YYYY-MM" }); return; }
  if (await lockedMonth(month)) { res.status(409).json({ ok: false, error: "Payment month is already locked" }); return; }
  const rows = documentRows(await firestoreList("payment_transactions")).filter((x) => String(x.paymentDate ?? x.createdAt).startsWith(month));
  const archive = { month: Number(month.slice(5)), monthLabel: month, year: Number(month.slice(0, 4)), monthNumber: Number(month.slice(5)), locked: true, status: "locked", lockedAt: now(), lockedBy: uid,
    transactionCount: rows.length, totalAmount: rows.reduce((s, x) => s + Number(x.amountPaid ?? 0), 0), totalFees: rows.reduce((s, x) => s + Number(x.fee ?? 0), 0) };
  await firestoreRequest(`/payment_monthly_archives/${month}`, { method: "PATCH", body: JSON.stringify(firestoreFields(archive)) });
  await audit("payment_month_locked", uid, { month, transactionCount: rows.length });
  res.json({ ok: true, archive });
});

export default router;