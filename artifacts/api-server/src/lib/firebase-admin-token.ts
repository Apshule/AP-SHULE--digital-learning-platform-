import { importPKCS8, SignJWT } from "jose";
import { logger } from "./logger";

let _cachedAccessToken: { token: string; expiresAt: number } | null = null;

/**
 * Returns a short-lived OAuth2 access token from the Firebase service-account
 * private key stored in FIREBASE_SERVICE_ACCOUNT_JSON.
 *
 * Scopes: firebase.messaging + cloud-platform + firebase (covers FCM V1, Admin API,
 * Identity Toolkit user management, and Firestore writes).
 */
export async function getFirebaseAdminToken(): Promise<string | null> {
  const raw = process.env["FIREBASE_SERVICE_ACCOUNT_JSON"];
  if (!raw) return null;

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

    const assertion = await new SignJWT({
      scope: [
        "https://www.googleapis.com/auth/firebase.messaging",
        "https://www.googleapis.com/auth/cloud-platform",
        "https://www.googleapis.com/auth/firebase",
      ].join(" "),
    })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(clientEmail)
      .setSubject(clientEmail)
      .setAudience("https://oauth2.googleapis.com/token")
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(privateKey);

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
