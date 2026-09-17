import { Router, type Request, type Response } from "express";
import { verifyFirebaseCaller } from "../lib/firebase-auth";
import { getFirebaseAdminToken } from "../lib/firebase-admin-token";

const router = Router();
const project = process.env["FIREBASE_PROJECT_ID"] ?? "apshule-app";
const firestoreBase =
  `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
const STUDENT_CASH_REWARD_UGX = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

type FirestoreValue = Record<string, unknown>;
type FirestoreDocument = { name?: string; fields?: Record<string, FirestoreValue> };

function now(): string {
  return new Date().toISOString();
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

async function findReferrer(referralCode: string): Promise<{ id: string; data: Record<string, unknown> } | null> {
  const rows = await firestoreRequest(":runQuery", {
    method: "POST",
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "users" }],
        where: { fieldFilter: { field: { fieldPath: "referralCode" }, op: "EQUAL", value: firestoreValue(referralCode) } },
        limit: 1,
      },
    }),
  }) as Array<{ document?: FirestoreDocument }>;
  const document = rows.find((row) => row.document?.name)?.document;
  if (!document?.name) return null;
  const id = document.name.split("/documents/users/")[1] ?? "";
  return id ? { id, data: documentData(document) } : null;
}

function validReward(value: unknown): "cash" | "day" {
  return String(value ?? "").toLowerCase() === "cash" ? "cash" : "day";
}

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
        body: JSON.stringify(firestoreFields({ referredBy: referrer.id, referralRewardClaimedAt: claimedAt, referralRewardType: "teacher_cash" })),
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

    const reward = rewardChoice === "cash"
      ? { amount: STUDENT_CASH_REWARD_UGX, status: "pending" }
      : { amount: 0, status: "granted" };
    const patch: Record<string, unknown> = {
      referredBy: referrer.id, referralRewardClaimedAt: claimedAt, referralRewardType: rewardChoice,
    };
    if (rewardChoice === "cash") {
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
        referrerId: referrer.id, referredUserId: caller.uid, referredUserName: newUser.name ?? caller.uid,
        rewardType: rewardChoice, amount: reward.amount, currency: "UGX", status: reward.status, createdAt: claimedAt,
      })),
    });
    await firestoreRequest(`/users/${encodeURIComponent(caller.uid)}`, {
      method: "PATCH", body: JSON.stringify(firestoreFields(patch)),
    });
    await firestoreRequest(`/users/${encodeURIComponent(referrer.id)}`, {
      method: "PATCH",
      body: JSON.stringify(firestoreFields({
        referralCount: Number(referrer.data.referralCount ?? 0) + 1,
        ...(rewardChoice === "cash" ? { referralCashBalance: patch.referralCashBalance } : {
          premiumAccessUntil: patch.premiumAccessUntil, subscriptionTier: "premium", aiRequestsLimit: 500,
        }),
      })),
    });

    res.status(201).json({
      ok: true, rewardType: rewardChoice, amount: reward.amount,
      premiumAccessUntil: patch.premiumAccessUntil ?? null,
      message: rewardChoice === "cash"
        ? "UGX 500 referral reward added to the referrer's cash balance."
        : "24 hours of premium access added to the referrer's account.",
    });
  } catch (error) {
    res.status(503).json({ ok: false, error: error instanceof Error ? error.message : "Referral reward could not be applied" });
  }
});

export default router;