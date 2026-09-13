import crypto from "node:crypto";
import { logger } from "./logger";

function loadPushSecret(): string | null {
  const secret = process.env["PUSH_SECRET"];
  if (secret && secret.length >= 32) {
    return secret;
  }

  if (secret) {
    logger.warn(
      "PUSH_SECRET env var is set but shorter than 32 characters — " +
        "treating as absent. Set PUSH_SECRET to a 32-char random string.",
    );
  } else {
    logger.warn(
      "PUSH_SECRET env var not set — POST /api/push-events is UNPROTECTED. " +
        "Set PUSH_SECRET (32+ random chars) in both the API server and the " +
        "push-watch script environment to restrict who can trigger notifications.",
    );
  }

  return null;
}

/** Null means no secret is configured; the route skips the auth check. */
export const pushSecret: string | null = loadPushSecret();

/**
 * Returns true when the request should be allowed.
 * - If no secret is configured on the server, all callers are allowed (with a logged warning).
 * - If a secret is configured, callers must supply it via
 *     Authorization: Bearer <secret>  or  X-Push-Secret: <secret>
 */
export function isAuthorized(
  authHeader: string | undefined,
  xHeader: string | undefined,
  log?: (msg: string) => void,
): boolean {
  if (pushSecret === null) {
    if (log) {
      log("PUSH_SECRET not configured — skipping auth check for push endpoint.");
    }
    return true;
  }

  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
  const candidate = bearer ?? xHeader;
  if (!candidate) return false;

  try {
    const a = Buffer.from(candidate, "utf8");
    const b = Buffer.from(pushSecret, "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
