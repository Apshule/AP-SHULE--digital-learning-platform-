import { Router, type Request, type Response } from "express";
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { verifyFirebaseAdmin, verifyFirebaseCaller } from "../lib/firebase-auth";
import { getFirebaseAdminToken } from "../lib/firebase-admin-token";

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
  if (!Number.isFinite(amountPaid) || amountPaid <= 0 || amountPaid > balanceRemaining || !Number.isFinite(totalAmount) || totalAmount <= 0 || !["MTN", "Airtel"].includes(paymentMethod) || !/^\+?[0-9]{8,15}$/.test(clientPhone) || !institutionId || !sector || !billReference) {
    res.status(400).json({ ok: false, error: "Positive amount, outstanding balance, supported payment method, phone, institutionId, sector and billReference are required" });
    return;
  }
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
  const paymentType = amountPaid > balanceRemaining ? "Overpayment" : amountPaid === balanceRemaining ? "Full Payment" : "Partial Payment";
  const reference = `PAY-${new Date().getUTCFullYear()}-${createHash("sha256").update(`${user.uid}:${Date.now()}`).digest("hex").slice(0, 12).toUpperCase()}`;
  const transaction = {
    reference,
    clientId: user.uid,
    clientName: String(body.clientName ?? "Client"),
    clientPhone,
    institutionId,
    sector,
    billReference,
    totalAmount,
    amountPaid,
    balanceRemaining: Math.max(0, balanceRemaining - amountPaid),
    fee,
    netAmount: amountPaid,
    paymentType,
    paymentMethod,
    status: "pending",
    createdAt: now(),
    createdBy: user.uid,
  };
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

async function updateBalance(transaction: Record<string, unknown>, amount: number) {
  const sector = String(transaction.sector ?? "").toLowerCase();
  const collectionNames = sector.includes("clinic") ? ["clinic_billing"] : sector.includes("mfi") ? ["microfinance_loans", "mfi_loans"] : ["school_fees", "school_bills"];
  const reference = String(transaction.billReference ?? "");
  for (const collectionName of collectionNames) {
    const current = await firestoreGet(collectionName, reference);
    if (!current) continue;
    const paid = Number(current.paidAmount ?? current.amountPaid ?? 0) + amount;
    const total = Number(current.totalAmount ?? current.loanAmount ?? current.amount ?? transaction.totalAmount ?? 0);
    const balance = Math.max(0, total - paid);
    await firestoreRequest(`/${collectionName}/${encodeURIComponent(reference)}`, { method: "PATCH", body: JSON.stringify(firestoreFields({ paidAmount: paid, amountPaid: paid, balanceAmount: balance, balanceRemaining: balance, status: balance === 0 ? "paid" : paid > 0 ? "partial" : "unpaid", updatedAt: now() })) });
    return { collectionName, balance };
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
    const amount = Number(body.amount ?? xmlField(raw, "amount") ?? transaction.amountPaid ?? 0);
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
      const settings = configuredSettings(await savedPaymentSettings());
      if (settings.autoDisburse) {
        await firestoreRequest("/payment_disbursements", { method: "POST", body: JSON.stringify(firestoreFields({ transactionId: transactionPath.split("/").pop(), institutionId: transaction.institutionId, beneficiaryAccount: "", amount, fee: transaction.fee ?? 0, netAmount: transaction.netAmount ?? amount, status: "pending", createdAt: now() })) });
      }
      await firestoreRequest("/payment_notifications", { method: "POST", body: JSON.stringify(firestoreFields({ transactionId: transactionPath.split("/").pop(), recipientType: "Client", recipientId: transaction.clientId, notificationType: "In-App", message: `Payment confirmed. Balance: UGX ${Number(balanceUpdate?.balance ?? transaction.balanceRemaining ?? 0).toLocaleString()}`, status: "pending", sentAt: now() })) });
      await firestoreRequest("/payment_notifications", { method: "POST", body: JSON.stringify(firestoreFields({ transactionId: transactionPath.split("/").pop(), recipientType: "Institution", recipientId: transaction.institutionId, notificationType: "In-App", message: "New payment received", status: "pending", sentAt: now() })) });
    } else {
      await firestoreRequest("/payment_notifications", { method: "POST", body: JSON.stringify(firestoreFields({ transactionId: transactionPath.split("/").pop(), recipientType: "Client", recipientId: transaction.clientId, notificationType: "In-App", message: "Payment failed", status: "pending", sentAt: now() })) });
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

export default router;