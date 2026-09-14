import { createRemoteJWKSet, jwtVerify } from "jose";

const FIREBASE_PROJECT_ID = process.env["FIREBASE_PROJECT_ID"] ?? "apshule-app";

const JWKS = createRemoteJWKSet(
  new URL(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
  ),
);

type FirebaseAdminResult =
  | { ok: true; uid: string }
  | { ok: false; status: 401 | 403; reason: string };

export type FirebaseCaller = { uid: string; role: string; token: string };

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
    const document = (await response.json()) as { fields?: { role?: { stringValue?: string } } };
    return { uid, role: document.fields?.role?.stringValue ?? "individual", token };
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
