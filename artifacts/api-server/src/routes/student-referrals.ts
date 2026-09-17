import { Router, type Request, type Response } from "express";
import { verifyFirebaseCaller } from "../lib/firebase-auth";
import { getFirebaseAdminToken } from "../lib/firebase-admin-token";

const router = Router();
const project = process.env["FIREBASE_PROJECT_ID"] ?? "apshule-app";
const firestoreBase =
  `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
const STUDENT_CASH_REWARD_UGX = 500;
const STUDENT_SIGNUP_FEE_UGX = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const defaultProductionUrl = "https://paymentsapi1.yo.co.ug/ybs/task.php";
const defaultSandboxUrl = "https://sandbox.yo.co.ug/services/yopaymentsdev/task.php";

type FirestoreValue = Record<string, unknown>;
type FirestoreDocument = { name?: string; fields?: Record<string, FirestoreValue> };

function now(): string {
  return new Date().toISOString();
}

function xmlEscape(value: unknown): string {
  return String(value ?? "").replace(/[<>&'"]/g, (character) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", "\"": "&quot;",
  }[character] ?? character));
}

function xmlField(xml: string, name: string): string {
  return xml.match(new RegExp(`<${name}[^>]*>([^<]*)`, "i"))?.[1] ?? "";
}

function hasYoCredentials(): boolean {
  return Boolean(process.env["YO_API_USERNAME"] && process.env["YO_API_PASSWORD"]);
}

function publicBaseUrl(): string {
  return (process.env["PUBLIC_API_URL"] ?? "https://appshule.com").replace(/\/$/, "");
}

function configuredSettings(saved: Record<string, unknown> = {}) {
  const mode = String(saved.mode ?? process.env["YO_API_MODE"] ?? "sandbox") === "production" ? "production" : "sandbox";
  return {
    url: mode === "production"
      ? String(saved.productionUrl ?? process.env["YO_API_PRODUCTION_URL"] ?? defaultProductionUrl)
      : String(saved.sandboxUrl ?? process.env["YO_API_SANDBOX_URL"] ?? defaultSandboxUrl),
  };
}

async function yoDeposit(
  phone: string,
  externalRef: string,
  settings: ReturnType<typeof configuredSettings>,
): Promise<string> {
  if (!hasYoCredentials()) throw new Error("Yo API credentials are not configured");
  const body = `<AutoCreate><Request><APIUsername>${xmlEscape(process.env["YO_API_USERNAME"])}</APIUsername><APIpassword>${xmlEscape(process.env["YO_API_PASSWORD"])}</APIpassword><Method>acdepositfunds</Method><NonBlocking>TRUE</NonBlocking><Amount>${STUDENT_SIGNUP_FEE_UGX.toFixed(2)}</Amount><Account>${xmlEscape(phone)}</Account><Narrative>APSHULE referral registration</Narrative><ExternalReference>${xmlEscape(externalRef)}</ExternalReference><InstantNotificationUrl>${xmlEscape(`${publicBaseUrl()}/api/webhooks/yo/ipn`)}</InstantNotificationUrl><FailureNotificationUrl>${xmlEscape(`${publicBaseUrl()}/api/webhooks/yo/failure`)}</FailureNotificationUrl></Request></AutoCreate>`;
  const response = await fetch(settings.url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${process.env["YO_API_USERNAME"]}:${process.env["YO_API_PASSWORD"]}`).toString("base64")}`,
      "Content-Type": "application/xml",
    },
    body,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Yo API rejected the request (${response.status})`);
  return text;
}

function normalizePhone(value: unknown): string {
  const raw = String(value ?? "").replace(/[\s()-]/g, "");
  if (/^07\d{8}$/.test(raw)) return `+256${raw.slice(1)}`;
  if (/^2567\d{8}$/.test(raw)) return `+${raw}`;
  if (/^\+2567\d{8}$/.test(raw)) return raw;
  return "";
}

function firestoreValue(value: unknown): FirestoreValue {
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number" && Number.isInteger(value)) return { integerValue: String(value) };
  if (typeof value === "number") return { doubleValue: value };
  return { stringValue: String(value ?? "") };
}

function firestoreFields(data: Record<string, unknown>) {
  return {
    fields: Object.fromEntries(
      Object.entries(data).map(([key, value]) => [key, firestoreValue(value)]),
    ),
  };
}

function fieldValue(value: FirestoreValue | undefined): unknown {
  if (!value) return undefined;
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("timestampValue" in value) return value.timestampValue;
  return undefined;
}

function documentData(document?: FirestoreDocument): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(document?.fields ?? {}).map(([key, value]) => [key, fieldValue(value)]),
  );
}

async function firestoreRequest(path: string, init: RequestInit = {}, callerToken?: string) {
  const adminToken = await getFirebaseAdminToken();
  const token = adminToken ?? callerToken;
  if (!token) throw new Error("Firebase service account is not configured");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Content-Type", "application/json");
  const response = await fetch(`${firestoreBase}${path}`, { ...init, headers });
  if (!response.ok) throw new Error(`Firestore request failed (${response.status})`);
  return response.status === 204 ? null : response.json();
}

async function getUser(uid: string, callerToken?: string): Promise<Record<string, unknown> | null> {
  try {
    const document = await firestoreRequest(`/users/${encodeURIComponent(uid)}`, {}, callerToken) as FirestoreDocument;
    return documentData(document);
  } catch {
    return null;
  }
}

async function findReferrer(referralCode: string): Promise<{
  id: string;
  data: Record<string, unknown>;
  rewardChoice?: "cash" | "day";
} | null> {
  const fields: Array<{ path: string; rewardChoice?: "cash" | "day" }> = [
    { path: "referralCashCode", rewardChoice: "cash" },
    { path: "referralDayCode", rewardChoice: "day" },
    { path: "referralCode" },
  ];
  for (const field of fields) {
    const rows = await firestoreRequest(":runQuery", {
      method: "POST",
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "users" }],
          where: { fieldFilter: { field: { fieldPath: field.path }, op: "EQUAL", value: firestoreValue(referralCode) } },
          limit: 1,
        },
      }),
    }) as Array<{ document?: FirestoreDocument }>;
    const document = rows.find((row) => row.document?.name)?.document;
    if (!document?.name) continue;
    const id = document.name.split("/documents/users/")[1] ?? "";
    if (id) return { id, data: documentData(document), rewardChoice: field.rewardChoice };
  }
  return null;
}

async function findPayment(externalRef: string): Promise<{ path: string; data: Record<string, unknown> } | null> {
  const rows = await firestoreRequest(":runQuery", {
    method: "POST",
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "studentReferralPayments" }],
        where: { fieldFilter: { field: { fieldPath: "externalRef" }, op: "EQUAL", value: firestoreValue(externalRef) } },
        limit: 1,
      },
    }),
  }) as Array<{ document?: FirestoreDocument }>;
  const document = rows.find((row) => row.document?.name)?.document;
  if (!document?.name) return null;
  return { path: document.name.split("/documents/")[1] ?? "", data: documentData(document) };
}

function validReward(value: unknown): "cash" | "day" {
  return String(value ?? "").toLowerCase() === "cash" ? "cash" : "day";
}

async function grantStudentReward(
  referredUserId: string,
  referralCode: string,
  rewardChoice: "cash" | "day",
) {
  const newUser = await getUser(referredUserId);
  if (!newUser || !["individual", "student"].includes(String(newUser.role ?? ""))) {
    throw new Error("Only student accounts can redeem student referrals");
  }
  if (newUser.referralRewardClaimedAt) {
    return { duplicate: true, rewardType: newUser.referralRewardType ?? rewardChoice };
  }
  const referrer = await findReferrer(referralCode);
  if (!referrer || referrer.id === referredUserId || !["individual", "student"].includes(String(referrer.data.role ?? ""))) {
    throw new Error("That referral link is invalid");
  }
  const selectedReward = referrer.rewardChoice ?? rewardChoice;

  const claimedAt = now();
  const rewardId = `referral_${referrer.id}_${referredUserId}`;
  const patch: Record<string, unknown> = {
    referredBy: referrer.id, referralRewardClaimedAt: claimedAt, referralRewardType: selectedReward,
    registrationStatus: "active", status: "active",
  };
  const reward = selectedReward === "cash"
    ? { amount: STUDENT_CASH_REWARD_UGX, status: "pending" }
    : { amount: 0, status: "granted" };
  if (selectedReward === "cash") {
    patch.referralCashBalance = Number(referrer.data.referralCashBalance ?? 0) + STUDENT_CASH_REWARD_UGX;
  } else {
    const existingUntil = Date.parse(String(referrer.data.premiumAccessUntil ?? ""));
    const base = Number.isFinite(existingUntil) && existingUntil > Date.now() ? existingUntil : Date.now();
    patch.premiumAccessUntil = new Date(base + DAY_MS).toISOString();
    patch.subscriptionTier = "premium";
    patch.aiRequestsLimit = 500;
  }

  await firestoreRequest(`/studentReferralRewards/${encodeURIComponent(rewardId)}`, {
    method: "PATCH",
    body: JSON.stringify(firestoreFields({
      referrerId: referrer.id, referredUserId, referredUserName: newUser.name ?? referredUserId,
      rewardType: rewardChoice, amount: reward.amount, currency: "UGX", status: reward.status, createdAt: claimedAt,
    })),
  });
  await firestoreRequest(`/users/${encodeURIComponent(referredUserId)}`, {
    method: "PATCH", body: JSON.stringify(firestoreFields(patch)),
  });
  await firestoreRequest(`/users/${encodeURIComponent(referrer.id)}`, {
    method: "PATCH",
    body: JSON.stringify(firestoreFields({
      referralCount: Number(referrer.data.referralCount ?? 0) + 1,
      ...(selectedReward === "cash" ? { referralCashBalance: patch.referralCashBalance } : {
        premiumAccessUntil: patch.premiumAccessUntil, subscriptionTier: "premium", aiRequestsLimit: 500,
      }),
    })),
  });
  return {
    duplicate: false, rewardType: selectedReward, amount: reward.amount,
    premiumAccessUntil: patch.premiumAccessUntil ?? null,
    message: selectedReward === "cash"
      ? "UGX 500 referral reward added to the referrer's cash balance."
      : "24 hours of premium access added to the referrer's account.",
  };
}

export async function settleStudentReferralPayment(
  externalRef: string,
  failed: boolean,
  webhookData: Record<string, unknown>,
): Promise<boolean> {
  const match = await findPayment(externalRef);
  if (!match) return false;
  if (!failed && match.data.status === "completed") return true;
  if (!failed) {
    await grantStudentReward(
      String(match.data.referredUserId),
      String(match.data.referralCode),
      validReward(match.data.rewardChoice),
    );
  }
  const update = {
    status: failed ? "failed" : "completed",
    webhookData,
    updatedAt: now(),
    ...(failed ? { failureReason: "The signup payment was not confirmed." } : { paidAt: now() }),
  };
  await firestoreRequest(`/${match.path}`, { method: "PATCH", body: JSON.stringify(firestoreFields(update)) });
  return true;
}

router.post("/referrals/registration-payment", async (req: Request, res: Response) => {
  const caller = await verifyFirebaseCaller(req.headers.authorization);
  if (!("uid" in caller)) {
    res.status(caller.status).json({ ok: false, error: caller.reason });
    return;
  }
  const referralCode = String(req.body?.referralCode ?? "").trim().slice(0, 80);
  const rewardChoice = validReward(req.body?.rewardChoice);
  const phone = normalizePhone(req.body?.phone);
  const paymentMethod = String(req.body?.paymentMethod ?? "").trim();
  if (!referralCode || !phone || !["MTN", "Airtel"].includes(paymentMethod)) {
    res.status(400).json({ ok: false, error: "Referral code, valid MTN/Airtel phone number, and payment method are required" });
    return;
  }
  const paymentId = `REFPAY-${caller.uid}`;
  const externalRef = `REFSIGN-${caller.uid}`;
  try {
    const newUser = await getUser(caller.uid, caller.token);
    if (!newUser || !["individual", "student"].includes(String(newUser.role ?? ""))) {
      res.status(403).json({ ok: false, error: "Only student accounts can use referral registration" });
      return;
    }
    const referrer = await findReferrer(referralCode);
    if (!referrer || referrer.id === caller.uid) {
      res.status(404).json({ ok: false, error: "That referral link is invalid" });
      return;
    }
    if (String(referrer.data.role ?? "") === "teacher") {
      res.json({ ok: true, requiresPayment: false, teacherReferral: true });
      return;
    }
    if (!["individual", "student"].includes(String(referrer.data.role ?? ""))) {
      res.status(400).json({ ok: false, error: "This is not a student referral link" });
      return;
    }
    const selectedReward = referrer.rewardChoice ?? rewardChoice;

    const existing = await getUser(caller.uid);
    if (existing?.referralRewardClaimedAt) {
      res.json({ ok: true, status: "completed", duplicate: true });
      return;
    }
    const prior = await firestoreRequest(`/${encodeURIComponent("studentReferralPayments")}/${encodeURIComponent(paymentId)}`).catch(() => null) as FirestoreDocument | null;
    const priorData = documentData(prior ?? undefined);
    if (["pending", "processing"].includes(String(priorData.status ?? ""))) {
      res.status(202).json({ ok: true, status: priorData.status, paymentId, amount: STUDENT_SIGNUP_FEE_UGX });
      return;
    }
    if (priorData.status === "completed") {
      res.json({ ok: true, status: "completed", paymentId });
      return;
    }
    if (!hasYoCredentials()) {
      res.status(503).json({ ok: false, error: "Signup payment is not available until Yo is configured on the server. Your account remains pending payment." });
      return;
    }

    const payment = {
      paymentId, externalRef, referredUserId: caller.uid, referralCode, referrerId: referrer.id,
      rewardChoice: selectedReward, amount: STUDENT_SIGNUP_FEE_UGX, currency: "UGX", phone, paymentMethod,
      status: "pending", createdAt: now(),
    };
    await firestoreRequest(`/${encodeURIComponent("studentReferralPayments")}/${encodeURIComponent(paymentId)}`, {
      method: "PATCH", body: JSON.stringify(firestoreFields(payment)),
    });
    const savedSettingsDocument = await firestoreRequest("/payment_settings/global").catch(() => null) as FirestoreDocument | null;
    const response = await yoDeposit(phone, externalRef, configuredSettings(documentData(savedSettingsDocument ?? undefined)));
    const providerReference = xmlField(response, "TransactionReference") || xmlField(response, "reference");
    await firestoreRequest(`/${encodeURIComponent("studentReferralPayments")}/${encodeURIComponent(paymentId)}`, {
      method: "PATCH",
      body: JSON.stringify(firestoreFields({ status: "processing", providerReference, updatedAt: now() })),
    });
    res.status(202).json({
      ok: true, status: "processing", paymentId, amount: STUDENT_SIGNUP_FEE_UGX,
      message: `Approve the UGX ${STUDENT_SIGNUP_FEE_UGX.toLocaleString()} payment prompt on ${paymentMethod}.`,
    });
  } catch (error) {
    await firestoreRequest(`/${encodeURIComponent("studentReferralPayments")}/${encodeURIComponent(paymentId)}`, {
      method: "PATCH",
      body: JSON.stringify(firestoreFields({
        status: "failed",
        failureReason: error instanceof Error ? error.message : "Signup payment could not be started",
        updatedAt: now(),
      })),
    }).catch(() => undefined);
    res.status(502).json({ ok: false, error: error instanceof Error ? error.message : "Signup payment could not be started" });
  }
});

router.post("/referrals/redeem", async (req: Request, res: Response) => {
  const caller = await verifyFirebaseCaller(req.headers.authorization);
  if (!("uid" in caller)) {
    res.status(caller.status).json({ ok: false, error: caller.reason });
    return;
  }

  const referralCode = String(req.body?.referralCode ?? "").trim().slice(0, 80);
  const rewardChoice = validReward(req.body?.rewardChoice);
  if (!referralCode) {
    res.status(400).json({ ok: false, error: "A referral code is required" });
    return;
  }

  try {
    const newUser = await getUser(caller.uid, caller.token);
    if (!newUser || !["individual", "student"].includes(String(newUser.role ?? ""))) {
      res.status(403).json({ ok: false, error: "Only student accounts can redeem student referrals" });
      return;
    }
    if (newUser.referredBy || newUser.referralRewardClaimedAt) {
      res.json({ ok: true, duplicate: true, message: "Referral reward was already claimed for this account." });
      return;
    }

    const referrer = await findReferrer(referralCode);
    if (!referrer || referrer.id === caller.uid) {
      res.status(404).json({ ok: false, error: "That referral link is invalid" });
      return;
    }
    const referrerRole = String(referrer.data.role ?? "");
    const claimedAt = now();
    const rewardId = `referral_${referrer.id}_${caller.uid}`;

    if (referrerRole === "teacher") {
      const amount = Math.max(0, Number(referrer.data.referralRewardPerSignup ?? 0));
      await firestoreRequest(`/teacherEarnings/${encodeURIComponent(rewardId)}`, {
        method: "PATCH",
        body: JSON.stringify(firestoreFields({
          source: "teacher_referral", teacherId: referrer.id, referredUserId: caller.uid,
          referredUserName: newUser.name ?? caller.uid, amount, paid: false, earnedAt: claimedAt,
        })),
      });
      await firestoreRequest(`/users/${encodeURIComponent(caller.uid)}`, {
        method: "PATCH",
        body: JSON.stringify(firestoreFields({
          referredBy: referrer.id, referralRewardClaimedAt: claimedAt, referralRewardType: "teacher_cash",
          registrationStatus: "active", status: "active",
        })),
      });
      await firestoreRequest(`/users/${encodeURIComponent(referrer.id)}`, {
        method: "PATCH",
        body: JSON.stringify(firestoreFields({ referralCount: Number(referrer.data.referralCount ?? 0) + 1 })),
      });
      res.status(201).json({ ok: true, rewardType: "teacher_cash", amount, message: "Teacher referral recorded." });
      return;
    }

    if (!["individual", "student"].includes(referrerRole)) {
      res.status(400).json({ ok: false, error: "This link is not a student referral link" });
      return;
    }
    res.status(402).json({
      ok: false,
      error: "Student referrals require the UGX 1,000 registration payment before the reward can be granted.",
    });
    return;

  } catch (error) {
    res.status(503).json({ ok: false, error: error instanceof Error ? error.message : "Referral reward could not be applied" });
  }
});

export default router;