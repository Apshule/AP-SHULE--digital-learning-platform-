import { createRemoteJWKSet, jwtVerify } from "jose";
import { getFirebaseAdminToken } from "./firebase-admin-token";

const FIREBASE_PROJECT_ID = process.env["FIREBASE_PROJECT_ID"] ?? "apshule-app";

const JWKS = createRemoteJWKSet(
  new URL(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
  ),
);

type FirebaseAdminResult =
  | { ok: true; uid: string }
  | { ok: false; status: 401 | 403; reason: string };

export const DEFAULT_FREE_AI_LIMIT = 10;
export const PREMIUM_AI_LIMIT = 500;

type FirebaseProfileField = {
  stringValue?: string;
  booleanValue?: boolean;
  integerValue?: string;
  doubleValue?: number;
};

export type FirebaseCaller = {
  uid: string;
  role: string;
  token: string;
  isPremium: boolean;
  subscriptionTier: "free" | "premium";
  aiRequestsLimit: number;
};

function profileIsPremium(
  fields: Record<string, FirebaseProfileField> | undefined,
  role: string,
): boolean {
  if (role.trim().toLowerCase() === "superadmin") return true;
  const explicitPremium = ["isPremium", "premium", "premiumUser"].some(
    (key) => fields?.[key]?.booleanValue === true,
  );
  const plan = String(
    fields?.subscriptionTier?.stringValue ??
    fields?.subscriptionPlan?.stringValue ??
      fields?.plan?.stringValue ??
      fields?.membershipPlan?.stringValue ??
      "",
  ).toLowerCase();
  return explicitPremium || /premium|pro|paid/.test(plan);
}

function profileEntitlements(
  fields: Record<string, FirebaseProfileField> | undefined,
  role: string,
): {
  isPremium: boolean;
  subscriptionTier: "free" | "premium";
  aiRequestsLimit: number;
} {
  const isPremium = profileIsPremium(fields, role);
  const storedLimit = Number(
    fields?.aiRequestsLimit?.integerValue ??
      fields?.aiRequestsLimit?.doubleValue ??
      Number.NaN,
  );
  const maximum = isPremium ? PREMIUM_AI_LIMIT : DEFAULT_FREE_AI_LIMIT;
  const aiRequestsLimit =
    Number.isInteger(storedLimit) && storedLimit > 0
      ? Math.min(storedLimit, maximum)
      : maximum;
  return {
    isPremium,
    subscriptionTier: isPremium ? "premium" : "free",
    aiRequestsLimit,
  };
}

async function ensureProfileDefaults(
  uid: string,
  callerToken: string,
  fields: Record<string, FirebaseProfileField> | undefined,
): Promise<void> {
  const missing: Record<string, Record<string, string>> = {};
  if (!fields?.subscriptionTier) missing.subscriptionTier = { stringValue: "free" };
  if (!fields?.aiRequestsLimit) missing.aiRequestsLimit = { integerValue: String(DEFAULT_FREE_AI_LIMIT) };
  if (!Object.keys(missing).length) return;

  const adminToken = await getFirebaseAdminToken();
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}` +
      `/databases/(default)/documents/users/${encodeURIComponent(uid)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${adminToken ?? callerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fields: missing }),
    },
  );
  if (!response.ok) {
    // Entitlement defaults are also applied in memory; a transient profile
    // backfill failure must not prevent authentication.
    return;
  }
}

/** Verifies an ID token and reads the caller's Firestore role. */
export async function verifyFirebaseCaller(
  authHeader: string | undefined,
): Promise<FirebaseCaller | { ok: false; status: 401 | 403; reason: string }> {
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
  if (!token) return { ok: false, status: 401, reason: "Missing Authorization header" };
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
      audience: FIREBASE_PROJECT_ID,
    });
    const uid = String(payload["user_id"] ?? payload.sub ?? "");
    if (!uid) throw new Error("No uid");
    const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${uid}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return { ok: false, status: 403, reason: "Could not read user role" };
    const document = (await response.json()) as {
      fields?: Record<string, FirebaseProfileField>;
    };
    const role = document.fields?.role?.stringValue ?? "individual";
    const entitlements = profileEntitlements(document.fields, role);
    void ensureProfileDefaults(uid, token, document.fields);
    return { uid, role, token, ...entitlements };
  } catch {
    return { ok: false, status: 401, reason: "Invalid or expired Firebase token" };
  }
}

/**
 * Verifies a Firebase ID token and confirms the caller is a superadmin.
 *
 * Returns { ok: true, uid } for a valid superadmin token.
 * Returns { ok: false, status: 401 } when the token is missing or invalid.
 * Returns { ok: false, status: 403 } when the token is valid but the user is not superadmin.
 */
export async function verifyFirebaseAdmin(
  authHeader: string | undefined,
): Promise<FirebaseAdminResult> {
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
  if (!token) {
    return { ok: false, status: 401, reason: "Missing Authorization header" };
  }

  let uid: string;
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
      audience: FIREBASE_PROJECT_ID,
    });
    uid = payload["user_id"] as string;
    if (!uid) throw new Error("No user_id claim");
  } catch {
    return { ok: false, status: 401, reason: "Invalid or expired Firebase token" };
  }

  // Check Firestore for the user's role using the caller's own token
  // (relies on Firestore security rules allowing users to read their own document).
  try {
    const firestoreUrl =
      `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}` +
      `/databases/(default)/documents/users/${uid}`;
    const resp = await fetch(firestoreUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      return { ok: false, status: 403, reason: "Could not read user document from Firestore" };
    }
    const doc = (await resp.json()) as {
      fields?: { role?: { stringValue?: string } };
    };
    const role = doc.fields?.role?.stringValue;
    if (role !== "superadmin") {
      return { ok: false, status: 403, reason: "User is not a superadmin" };
    }
  } catch {
    return { ok: false, status: 403, reason: "Firestore role check failed" };
  }

  return { ok: true, uid };
}
