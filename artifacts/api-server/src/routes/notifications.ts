import { Router } from "express";
import { createRemoteJWKSet, jwtVerify, importPKCS8, SignJWT } from "jose";
import { logger } from "../lib/logger";

const router = Router();

const FIREBASE_PROJECT_ID = process.env["FIREBASE_PROJECT_ID"] ?? "apshule-app";

// ── Firebase ID-token verification (for authenticating callers) ──────────────
const JWKS = createRemoteJWKSet(
  new URL(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
  ),
);

/** Returns the caller's uid if the Bearer token is a valid Firebase ID token, else null. */
async function verifyIdToken(authHeader: string | undefined): Promise<string | null> {
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
      audience: FIREBASE_PROJECT_ID,
    });
    return (payload["user_id"] as string) ?? null;
  } catch {
    return null;
  }
}

// ── Service-account OAuth2 token (for calling FCM V1) ────────────────────────

/** In-memory cache for the OAuth2 access token (expires in ~1 h). */
let _cachedAccessToken: { token: string; expiresAt: number } | null = null;

/**
 * Obtains a short-lived OAuth2 access token from a Firebase service-account
 * private key stored in FIREBASE_SERVICE_ACCOUNT_JSON.
 *
 * Format of the secret: the full JSON downloaded from
 *   Firebase Console → Project Settings → Service accounts → Generate new private key
 */
async function getAccessToken(): Promise<string | null> {
  const raw = process.env["FIREBASE_SERVICE_ACCOUNT_JSON"];
  if (!raw) return null;

  // Return cached token if still valid (with 60s buffer)
  if (_cachedAccessToken && _cachedAccessToken.expiresAt - 60_000 > Date.now()) {
    return _cachedAccessToken.token;
  }

  let clientEmail: string;
  let privateKeyPem: string;
  try {
    const sa = JSON.parse(raw) as { client_email: string; private_key: string };
    clientEmail = sa.client_email;
    privateKeyPem = sa.private_key;
  } catch {
    logger.error("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON");
    return null;
  }

  try {
    const privateKey = await importPKCS8(privateKeyPem, "RS256");
    const now = Math.floor(Date.now() / 1000);

    // Build a signed JWT assertion for the token exchange
    const assertion = await new SignJWT({
      scope: "https://www.googleapis.com/auth/firebase.messaging",
    })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(clientEmail)
      .setSubject(clientEmail)
      .setAudience("https://oauth2.googleapis.com/token")
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(privateKey);

    // Exchange the JWT for an access token
    const resp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });

    const data = (await resp.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) {
      logger.error({ data }, "OAuth2 token exchange failed");
      return null;
    }

    _cachedAccessToken = {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    };
    return _cachedAccessToken.token;
  } catch (err) {
    logger.error({ err }, "Failed to generate service-account access token");
    return null;
  }
}

// ── Firestore lookup (target user's FCM token) ───────────────────────────────

/**
 * Looks up the target user's FCM token from Firestore using the *caller's* own
 * Firebase ID token — relies on Firestore security rules that allow admins /
 * teachers to read any user document (already the case in this app).
 */
async function fetchFcmToken(targetUserId: string, callerIdToken: string): Promise<string | null> {
  const url =
    `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}` +
    `/databases/(default)/documents/users/${targetUserId}`;
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${callerIdToken}` },
    });
    if (!resp.ok) return null;
    const doc = (await resp.json()) as {
      fields?: { fcmToken?: { stringValue?: string } };
    };
    return doc.fields?.fcmToken?.stringValue ?? null;
  } catch {
    return null;
  }
}

// ── Route ─────────────────────────────────────────────────────────────────────

/**
 * POST /api/notifications/send
 * Header: Authorization: Bearer <Firebase ID token>
 * Body:   { targetUserId: string, title: string, body?: string }
 *
 * 1. Verifies the caller's Firebase ID token.
 * 2. Looks up the target user's FCM token from Firestore (server-side, caller
 *    cannot inject an arbitrary token).
 * 3. Sends an FCM V1 push using a service-account OAuth2 token.
 *
 * Requires env: FIREBASE_SERVICE_ACCOUNT_JSON (full service-account JSON from
 *   Firebase Console → Project Settings → Service accounts → Generate new private key)
 */
router.post("/notifications/send", async (req, res) => {
  const rawAuth = req.headers["authorization"];
  const callerUid = await verifyIdToken(rawAuth);
  if (!callerUid) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }

  const { targetUserId, title, body } = req.body as {
    targetUserId?: string;
    title?: string;
    body?: string;
  };

  if (!targetUserId || !title) {
    res.status(400).json({ ok: false, error: "targetUserId and title are required" });
    return;
  }

  // Check service account is configured
  if (!process.env["FIREBASE_SERVICE_ACCOUNT_JSON"]) {
    logger.warn("FIREBASE_SERVICE_ACCOUNT_JSON not set — skipping push delivery");
    res.json({ ok: false, skipped: "FIREBASE_SERVICE_ACCOUNT_JSON not configured" });
    return;
  }

  // Server-side lookup — caller never supplies the raw FCM device token
  const callerIdToken = rawAuth!.slice(7);
  const fcmToken = await fetchFcmToken(targetUserId, callerIdToken);
  if (!fcmToken) {
    res.json({ ok: false, skipped: "target user has no FCM token registered" });
    return;
  }

  const accessToken = await getAccessToken();
  if (!accessToken) {
    res.status(500).json({ ok: false, error: "Could not obtain FCM access token" });
    return;
  }

  try {
    const fcmUrl = `https://fcm.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/messages:send`;
    const resp = await fetch(fcmUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        message: {
          token: fcmToken,
          notification: { title, body: body ?? "" },
          data: { title, body: body ?? "" },
          android: { priority: "high" },
          apns: { headers: { "apns-priority": "10" } },
          webpush: {
            headers: { Urgency: "high" },
            notification: { title, body: body ?? "", requireInteraction: true },
          },
        },
      }),
    });

    const result = (await resp.json()) as { name?: string; error?: { message?: string } };

    if (!resp.ok) {
      logger.warn({ status: resp.status, result }, "FCM V1 delivery failed");
      res.json({ ok: false, error: result.error?.message ?? "FCM rejected the request" });
      return;
    }

    logger.info({ title, targetUserId }, "FCM V1 push sent");
    res.json({ ok: true });
  } catch (err) {
    logger.warn({ err }, "FCM V1 request error");
    res.status(500).json({ ok: false, error: "Failed to send push notification" });
  }
});

export default router;
