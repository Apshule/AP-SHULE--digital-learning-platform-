import { Router } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { logger } from "../lib/logger";
import { getFirebaseAdminToken } from "../lib/firebase-admin-token";

const router = Router();

const FIREBASE_PROJECT_ID = process.env["FIREBASE_PROJECT_ID"] ?? "apshule-app";

const JWKS = createRemoteJWKSet(
  new URL(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
  ),
);

/**
 * Verifies the caller's Firebase ID token and confirms they are a school account.
 * Returns { uid, schoolId } on success, or null on failure.
 */
async function verifySchoolCaller(
  authHeader: string | undefined,
): Promise<{ uid: string; schoolId: string } | null> {
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
  if (!token) return null;

  let uid: string;
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
      audience: FIREBASE_PROJECT_ID,
    });
    uid = (payload["user_id"] as string) ?? "";
    if (!uid) return null;
  } catch {
    return null;
  }

  try {
    const url =
      `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}` +
      `/databases/(default)/documents/users/${uid}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) return null;
    const docData = (await resp.json()) as {
      fields?: {
        role?: { stringValue?: string };
        schoolId?: { stringValue?: string };
      };
    };
    const role = docData.fields?.role?.stringValue;
    const schoolId = docData.fields?.schoolId?.stringValue;
    if (role !== "school" || !schoolId) return null;
    return { uid, schoolId };
  } catch {
    return null;
  }
}

/**
 * POST /api/school/create-student
 * Authorization: Bearer <school admin Firebase ID token>
 * Body: { name: string, email: string, password: string }
 *
 * Creates a Firebase Auth user and a Firestore user doc linked to the caller's school.
 * Uses the service-account token so the school admin's own session is unaffected.
 */
router.post("/school/create-student", async (req, res) => {
  const caller = await verifySchoolCaller(req.headers["authorization"]);
  if (!caller) {
    res.status(401).json({ ok: false, error: "Unauthorized — school account required" });
    return;
  }

  const { name, email, password } = req.body as {
    name?: string;
    email?: string;
    password?: string;
  };

  if (!name || !email || !password) {
    res.status(400).json({ ok: false, error: "name, email and password are required" });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ ok: false, error: "Password must be at least 6 characters" });
    return;
  }

  const adminToken = await getFirebaseAdminToken();
  if (!adminToken) {
    res.status(500).json({ ok: false, error: "Service account not configured" });
    return;
  }

  // Create Firebase Auth user via Identity Toolkit Admin API (does not change server session)
  let newUid: string;
  try {
    const authResp = await fetch(
      `https://identitytoolkit.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/accounts`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          email,
          password,
          displayName: name,
          emailVerified: false,
        }),
      },
    );
    const authData = (await authResp.json()) as {
      localId?: string;
      error?: { message?: string };
    };
    if (!authResp.ok || !authData.localId) {
      const msg = authData.error?.message ?? "Firebase Auth user creation failed";
      res.status(400).json({ ok: false, error: msg });
      return;
    }
    newUid = authData.localId;
  } catch (err) {
    logger.warn({ err }, "Firebase Auth create-student failed");
    res.status(500).json({ ok: false, error: "Failed to create user account" });
    return;
  }

  // Write Firestore user document linked to the school
  try {
    const firestoreUrl =
      `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}` +
      `/databases/(default)/documents/users/${newUid}`;
    await fetch(firestoreUrl, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        fields: {
          uid: { stringValue: newUid },
          name: { stringValue: name },
          email: { stringValue: email },
          role: { stringValue: "individual" },
          schoolId: { stringValue: caller.schoolId },
          mustChangePassword: { booleanValue: true },
          createdAt: { stringValue: new Date().toISOString() },
          loginCount: { integerValue: "0" },
        },
      }),
    });
  } catch (err) {
    logger.warn({ err, newUid }, "Firestore user doc write failed after Auth creation");
  }

  logger.info({ newUid, schoolId: caller.schoolId, email }, "School created student account");
  res.json({ ok: true, uid: newUid });
});

export default router;
