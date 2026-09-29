import type { AuthEnv, AuthUser, AuthenticationResult } from "./backend-types";

const SESSION_PREFIX = "auth:session:v2:";
const SESSION_TTL = 60 * 60 * 24 * 14;
const RESET_CODE_TTL_MS = 10 * 60 * 1000;
const RESET_REQUEST_COOLDOWN_MS = 60 * 1000;
const RESET_TICKET_TTL_MS = 10 * 60 * 1000;
const RESET_CHALLENGE_MAX_FAILURES = 3;
const RESET_CHALLENGE_LOCK_MS = 15 * 60 * 1000;
const PBKDF2_ITERATIONS = 100_000;
const RATE_LIMIT_TTL = 60 * 15;
const RATE_LIMIT_MAX = 8;
const LOGIN_OTP_TTL_MS = 10 * 60 * 1000;
const LOGIN_OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const LOGIN_OTP_MAX_FAILURES = 3;
const LOGIN_OTP_LOCK_MS = 15 * 60 * 1000;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function text(value: unknown, max = 500): string {
  return String(value ?? "").trim().slice(0, max);
}

async function input(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomToken(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return encode(value);
}

function randomSixDigitCode(): string {
  const range = 900_000;
  const rejectionLimit = Math.floor(0x1_0000_0000 / range) * range;
  const sample = new Uint32Array(1);
  do {
    crypto.getRandomValues(sample);
  } while (sample[0] >= rejectionLimit);
  return String(100_000 + (sample[0] % range));
}

async function digest(value: string): Promise<string> {
  const result = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return encode(result);
}

async function checkRateLimit(env: AuthEnv, request: Request, label: string, identity: string): Promise<boolean> {
  if (!env.SESSIONS) return false;
  const address = request.headers.get("cf-connecting-ip") ?? "unknown";
  const key = `auth:rate:v2:${label}:${await digest(`${address}:${identity}`)}`;
  const current = Number(await env.SESSIONS.get(key, "text") || "0");
  if (current >= RATE_LIMIT_MAX) return false;
  await env.SESSIONS.put(key, String(current + 1), { expirationTtl: RATE_LIMIT_TTL });
  return true;
}

async function derive(password: string, salt: Uint8Array, iterations = PBKDF2_ITERATIONS): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const saltBuffer = new Uint8Array(salt.length);
  saltBuffer.set(salt);
  return crypto.subtle.deriveBits({ name: "PBKDF2", salt: saltBuffer.buffer as ArrayBuffer, iterations, hash: "SHA-256" }, key, 256);
}

async function passwordHash(password: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const digest = new Uint8Array(await derive(password, salt));
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${encode(salt)}$${encode(digest)}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, iterationText, saltText, digestText] = stored.split("$");
  if (algorithm !== "pbkdf2-sha256" || !iterationText || !saltText || !digestText) return false;
  const iterations = Number(iterationText);
  if (!Number.isSafeInteger(iterations) || iterations < 100_000 || iterations > 100_000) return false;
  const actual = new Uint8Array(await derive(password, decode(saltText), iterations));
  const expected = decode(digestText);
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) difference |= actual[index] ^ expected[index];
  return difference === 0;
}

function cookie(token: string, maxAge: number): string {
  return `aps_session=${encodeURIComponent(token)}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function requestToken(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  if (/^Bearer\s+/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, "").trim();
  const match = (request.headers.get("cookie") ?? "").match(/(?:^|;\s*)aps_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

async function getUser(env: AuthEnv, uid: string): Promise<AuthUser | null> {
  const result = await env.DB.prepare(
    "SELECT uid,email,display_name,role,school_id,institution_id,session_version,active,disabled FROM users WHERE uid = ? LIMIT 1",
  ).bind(uid).all<Record<string, unknown>>();
  const row = result.results[0];
  if (!row || Number(row.disabled) === 1 || Number(row.active ?? 1) === 0) return null;
  return {
    uid: text(row.uid, 200), email: text(row.email, 320), displayName: text(row.display_name, 200),
    role: text(row.role, 80), schoolId: row.school_id ? text(row.school_id, 200) : null,
    institutionId: row.institution_id ? text(row.institution_id, 200) : null,
    sessionVersion: Number(row.session_version ?? 1),
  };
}

export async function authenticate(req: Request, env: AuthEnv): Promise<AuthenticationResult> {
  if (!env.SESSIONS) return { authenticated: false, reason: "unavailable", status: 503 };
  const token = requestToken(req);
  if (!token) return { authenticated: false, reason: "missing", status: 401 };
  const raw = await env.SESSIONS.get(`${SESSION_PREFIX}${await digest(token)}`, "text");
  if (typeof raw !== "string") return { authenticated: false, reason: "expired", status: 401 };
  try {
    const session = JSON.parse(raw) as { uid?: string; sessionVersion?: number };
    if (!session.uid) return { authenticated: false, reason: "invalid", status: 401 };
    const user = await getUser(env, session.uid);
    if (!user) return { authenticated: false, reason: "disabled", status: 401 };
    if (user.sessionVersion !== Number(session.sessionVersion)) return { authenticated: false, reason: "invalid", status: 401 };
    return { authenticated: true, user, sessionToken: token };
  } catch {
    return { authenticated: false, reason: "invalid", status: 401 };
  }
}

async function sendResetCodeEmail(env: AuthEnv, email: string, code: string): Promise<void> {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) throw new Error("Password reset email sender is not configured");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL,
      to: [email],
      subject: "Your APSHULE password reset code",
      text: `Your APSHULE password reset code is ${code}.\n\nThis code expires in 10 minutes. If you did not request this code, you can ignore this email.`,
      html: `<!doctype html>
<html lang="en"><body style="margin:0;background:#f4f7fa;color:#182b3a;font-family:Arial,sans-serif">
  <main style="max-width:520px;margin:32px auto;padding:32px;background:#ffffff;border:1px solid #dce5ec;border-radius:16px">
    <p style="margin:0 0 12px;color:#536b7d;font-size:13px;font-weight:700;letter-spacing:.12em;text-transform:uppercase">APSHULE account recovery</p>
    <h1 style="margin:0 0 16px;font-size:24px">Your password reset code</h1>
    <p style="margin:0 0 18px;color:#536b7d;line-height:1.6">Enter this code on the password reset page:</p>
    <p style="margin:0 0 18px;padding:18px 12px;border-radius:12px;background:#f0f5f9;text-align:center">
      <strong style="font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:36px;letter-spacing:.28em">${code}</strong>
    </p>
    <p style="margin:0;color:#536b7d;line-height:1.6"><strong>This code expires in 10 minutes.</strong> If you did not request it, you can ignore this email.</p>
  </main>
</body></html>`,
    }),
  });
  if (!response.ok) throw new Error(`Password reset email delivery failed (${response.status})`);
}

async function sendLoginOtpEmail(env: AuthEnv, email: string, code: string): Promise<void> {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) throw new Error("Email sender is not configured");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL,
      to: [email],
      subject: "Your APSHULE sign-in code",
      text: `Your APSHULE sign-in code is ${code}.\n\nThis code expires in 10 minutes. If you did not request it, you can ignore this email.`,
      html: `<p>Your APSHULE sign-in code is <strong>${code}</strong>.</p><p>This code expires in 10 minutes. If you did not request it, you can ignore this email.</p>`,
    }),
  });
  if (!response.ok) throw new Error(`Login code delivery failed (${response.status})`);
}

async function createSession(env: AuthEnv, user: AuthUser): Promise<Response> {
  const token = randomToken();
  await env.SESSIONS!.put(`${SESSION_PREFIX}${await digest(token)}`, JSON.stringify({ uid: user.uid, sessionVersion: user.sessionVersion }), { expirationTtl: SESSION_TTL });
  return json({ ok: true, user }, 200, { "set-cookie": cookie(token, SESSION_TTL) });
}

export async function handleAuthRoute(req: Request, env: AuthEnv): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  if (!path.startsWith("/api/auth/")) return null;
  const allowedMethod = path === "/api/auth/session" ? ["GET", "POST"].includes(req.method) : req.method === "POST";
  if (!allowedMethod) return json({ ok: false, error: "method not allowed" }, 405);
  if (!env.SESSIONS) return json({ ok: false, error: "SESSIONS KV is not configured" }, 503);

  if (path === "/api/auth/login") {
    return json({ ok: false, error: "Password login is disabled. Request an email sign-in code." }, 410);
  }

  if (path === "/api/auth/request-login-otp") {
    const email = text((await input(req)).email, 320).toLowerCase();
    const message = "If that email belongs to an active account, a 6-digit sign-in code will be sent. It expires in 10 minutes; wait 60 seconds before requesting another.";
    if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) {
      return json({ ok: false, error: "Email sign-in is not configured" }, 503);
    }
    if (!email || !await checkRateLimit(env, req, "login-otp-request", email)) return json({ ok: true, message });
    const row = (await env.DB.prepare(
      "SELECT uid,email FROM users WHERE lower(email)=? AND active=1 AND disabled=0 LIMIT 1",
    ).bind(email).all<{ uid: string; email: string }>()).results[0];
    if (!row) return json({ ok: true, message });
    const now = Date.now();
    await env.DB.prepare("DELETE FROM login_otp_challenges WHERE expires_at_ms<=? OR (locked_until_ms>0 AND locked_until_ms<=?)")
      .bind(now, now).run();
    const code = randomSixDigitCode();
    const codeHash = await passwordHash(`${row.uid}:${code}`);
    const saved = await env.DB.prepare(
      `INSERT INTO login_otp_challenges (uid,code_hash,expires_at_ms,requested_at_ms,failed_attempts,locked_until_ms,consumed_at_ms)
       VALUES (?,?,?,?,0,0,NULL)
       ON CONFLICT(uid) DO UPDATE SET code_hash=excluded.code_hash,expires_at_ms=excluded.expires_at_ms,
         requested_at_ms=excluded.requested_at_ms,failed_attempts=0,locked_until_ms=0,consumed_at_ms=NULL
       WHERE login_otp_challenges.locked_until_ms<=?
         AND login_otp_challenges.requested_at_ms<=?
         AND login_otp_challenges.consumed_at_ms IS NULL
       RETURNING uid`,
    ).bind(row.uid, codeHash, now + LOGIN_OTP_TTL_MS, now, now, now - LOGIN_OTP_RESEND_COOLDOWN_MS)
      .all<{ uid: string }>();
    if (!saved.results.length) return json({ ok: true, message });
    try {
      await sendLoginOtpEmail(env, row.email, code);
    } catch {
      await env.DB.prepare("DELETE FROM login_otp_challenges WHERE uid=? AND code_hash=?").bind(row.uid, codeHash).run();
    }
    return json({ ok: true, message });
  }

  if (path === "/api/auth/verify-login-otp") {
    const body = await input(req);
    const email = text(body.email, 320).toLowerCase();
    const code = text(body.code, 12);
    const invalid = () => json({ ok: false, error: "The sign-in code is invalid or expired. Request a new code and try again." }, 400);
    if (!email || !/^\d{6}$/.test(code) || !await checkRateLimit(env, req, "login-otp-verify", email)) return invalid();
    const row = (await env.DB.prepare("SELECT uid FROM users WHERE lower(email)=? AND active=1 AND disabled=0 LIMIT 1")
      .bind(email).all<{ uid: string }>()).results[0];
    if (!row) return invalid();
    const now = Date.now();
    const challenge = (await env.DB.prepare(
      "SELECT code_hash,expires_at_ms,failed_attempts,locked_until_ms FROM login_otp_challenges WHERE uid=? AND consumed_at_ms IS NULL LIMIT 1",
    ).bind(row.uid).all<{ code_hash: string; expires_at_ms: number; failed_attempts: number; locked_until_ms: number }>()).results[0];
    if (!challenge || Number(challenge.expires_at_ms) <= now || Number(challenge.locked_until_ms) > now ||
      !await verifyPassword(`${row.uid}:${code}`, challenge.code_hash)) {
      if (challenge && Number(challenge.expires_at_ms) > now && Number(challenge.locked_until_ms) <= now) {
        await env.DB.prepare(
          "UPDATE login_otp_challenges SET failed_attempts=failed_attempts+1,locked_until_ms=CASE WHEN failed_attempts+1>=? THEN ? ELSE locked_until_ms END WHERE uid=? AND consumed_at_ms IS NULL AND failed_attempts<? RETURNING failed_attempts",
        ).bind(LOGIN_OTP_MAX_FAILURES, now + LOGIN_OTP_LOCK_MS, row.uid, LOGIN_OTP_MAX_FAILURES).all<{ failed_attempts: number }>();
      }
      return invalid();
    }
    const consumed = await env.DB.prepare(
      "UPDATE login_otp_challenges SET consumed_at_ms=? WHERE uid=? AND code_hash=? AND consumed_at_ms IS NULL AND expires_at_ms>? AND locked_until_ms<=? RETURNING uid",
    ).bind(now, row.uid, challenge.code_hash, now, now).all<{ uid: string }>();
    if (!consumed.results.length) return invalid();
    const user = await getUser(env, row.uid);
    if (!user) return invalid();
    await env.DB.prepare("DELETE FROM login_otp_challenges WHERE uid=?").bind(row.uid).run();
    if (!user.role) {
      return json({ ok: false, error: "Your account does not have an assigned workspace role. Contact an administrator." }, 403);
    }
    return createSession(env, user);
  }

  if (path === "/api/auth/logout") {
    const token = requestToken(req);
    if (token) await env.SESSIONS.delete(`${SESSION_PREFIX}${await digest(token)}`);
    return json({ ok: true }, 200, { "set-cookie": cookie("", 0) });
  }

  if (path === "/api/auth/session") {
    const auth = await authenticate(req, env);
    if (auth.authenticated === true) return json({ ok: true, user: auth.user });
    return json({ ok: false, authenticated: false }, auth.status);
  }

  if (path === "/api/auth/request-password-reset") {
    if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) return json({ ok: false, error: "Password reset email sender is not configured" }, 503);
    const email = text((await input(req)).email, 320).toLowerCase();
    const message = "If that email belongs to an active account, a 6-digit reset code will be sent. It expires in 10 minutes; wait 60 seconds before requesting another.";
    if (!email || !await checkRateLimit(env, req, "reset", email)) {
      return json({ ok: true, message });
    }
    const result = await env.DB.prepare(
      "SELECT uid,email FROM users WHERE lower(email) = ? AND disabled = 0 AND active = 1 LIMIT 1",
    ).bind(email).all<{ uid: string; email: string }>();
    const user = result.results[0];
    if (user) {
      const uid = text(user.uid, 200);
      const now = Date.now();
      await env.DB.batch([
        env.DB.prepare("DELETE FROM password_reset_codes WHERE expires_at_ms <= ?").bind(now),
        env.DB.prepare("DELETE FROM password_reset_tickets WHERE expires_at_ms <= ?").bind(now),
        env.DB.prepare(
          `DELETE FROM password_reset_challenge_locks
           WHERE (locked_until_ms > 0 AND locked_until_ms <= ?)
              OR (locked_until_ms = 0 AND window_started_at_ms <= ?)`,
        ).bind(now, now - RESET_CHALLENGE_LOCK_MS),
        env.DB.prepare("DELETE FROM password_reset_request_cooldowns WHERE requested_at_ms < ?").bind(now - 24 * 60 * 60 * 1000),
      ]);
      const challengeLock = await env.DB.prepare(
        "SELECT locked_until_ms FROM password_reset_challenge_locks WHERE uid=? AND locked_until_ms>? LIMIT 1",
      ).bind(uid, now).all<{ locked_until_ms: number }>();
      if (challengeLock.results.length) return json({ ok: true, message });
      const cooldown = await env.DB.prepare(
        `INSERT INTO password_reset_request_cooldowns (uid,requested_at_ms) VALUES (?,?)
         ON CONFLICT(uid) DO UPDATE SET requested_at_ms=excluded.requested_at_ms
         WHERE password_reset_request_cooldowns.requested_at_ms <= ?
         RETURNING uid`,
      ).bind(uid, now, now - RESET_REQUEST_COOLDOWN_MS).all<{ uid: string }>();
      if (!cooldown.results.length) return json({ ok: true, message });

      const code = randomSixDigitCode();
      const codeHash = await passwordHash(`${uid}:${code}`);
      const createdAt = new Date().toISOString();
      const expiresAt = now + RESET_CODE_TTL_MS;
      await env.DB.batch([
        env.DB.prepare("DELETE FROM password_reset_codes WHERE uid=?").bind(uid),
        env.DB.prepare("DELETE FROM password_reset_tickets WHERE uid=?").bind(uid),
        env.DB.prepare(
          "INSERT INTO password_reset_codes (uid,code_hash,expires_at_ms,created_at) VALUES (?,?,?,?)",
        ).bind(uid, codeHash, expiresAt, createdAt),
      ]);
      try {
        await sendResetCodeEmail(env, user.email, code);
      } catch {
        await env.DB.prepare("DELETE FROM password_reset_codes WHERE uid=? AND code_hash=?")
          .bind(uid, codeHash).run();
        return json({ ok: false, error: "Password reset email could not be delivered" }, 502);
      }
    }
    return json({ ok: true, message });
  }

  if (path === "/api/auth/verify-password-reset-code") {
    const body = await input(req);
    const email = text(body.email, 320).toLowerCase();
    const code = text(body.code, 12);
    const invalid = () => json({ ok: false, error: "The code is invalid or expired. Request a new code and try again." }, 400);
    if (!email || !/^\d{6}$/.test(code) || !await checkRateLimit(env, req, "reset-verify", email)) return invalid();

    const userResult = await env.DB.prepare(
      "SELECT uid FROM users WHERE lower(email)=? AND active=1 AND disabled=0 LIMIT 1",
    ).bind(email).all<{ uid: string }>();
    const uid = text(userResult.results[0]?.uid, 200);
    if (!uid) return invalid();

    const now = Date.now();
    const challengeLock = await env.DB.prepare(
      "SELECT locked_until_ms FROM password_reset_challenge_locks WHERE uid=? AND locked_until_ms>? LIMIT 1",
    ).bind(uid, now).all<{ locked_until_ms: number }>();
    if (challengeLock.results.length) return invalid();
    const codeResult = await env.DB.prepare(
      "SELECT code_hash FROM password_reset_codes WHERE uid=? AND expires_at_ms>? AND claim_id IS NULL LIMIT 1",
    ).bind(uid, now).all<{ code_hash: string }>();
    const codeHash = codeResult.results[0]?.code_hash;
    if (!codeHash || !await verifyPassword(`${uid}:${code}`, String(codeHash))) {
      if (codeHash) {
        const cutoff = now - RESET_CHALLENGE_LOCK_MS;
        const attempts = await env.DB.prepare(
          `INSERT INTO password_reset_challenge_locks
             (uid,failed_attempts,window_started_at_ms,locked_until_ms,updated_at)
           VALUES (?,1,?,0,?)
           ON CONFLICT(uid) DO UPDATE SET
             failed_attempts=CASE WHEN password_reset_challenge_locks.window_started_at_ms<=? THEN 1
                                  ELSE password_reset_challenge_locks.failed_attempts+1 END,
             window_started_at_ms=CASE WHEN password_reset_challenge_locks.window_started_at_ms<=?
                                       THEN excluded.window_started_at_ms
                                       ELSE password_reset_challenge_locks.window_started_at_ms END,
             locked_until_ms=CASE WHEN password_reset_challenge_locks.window_started_at_ms<=? THEN 0
                                  WHEN password_reset_challenge_locks.failed_attempts+1>=? THEN ?
                                  ELSE password_reset_challenge_locks.locked_until_ms END,
             updated_at=excluded.updated_at
           WHERE password_reset_challenge_locks.locked_until_ms<=?
             AND EXISTS (
               SELECT 1 FROM password_reset_codes
               WHERE uid=? AND code_hash=? AND expires_at_ms>? AND claim_id IS NULL
             )
           RETURNING failed_attempts,locked_until_ms`,
        ).bind(
          uid,
          now,
          new Date(now).toISOString(),
          cutoff,
          cutoff,
          cutoff,
          RESET_CHALLENGE_MAX_FAILURES,
          now + RESET_CHALLENGE_LOCK_MS,
          now,
          uid,
          codeHash,
          now,
        ).all<{ failed_attempts: number; locked_until_ms: number }>();
        if (Number(attempts.results[0]?.failed_attempts ?? 0) >= RESET_CHALLENGE_MAX_FAILURES) {
          await env.DB.prepare(
            "DELETE FROM password_reset_codes WHERE uid=? AND code_hash=? AND claim_id IS NULL",
          ).bind(uid, codeHash).run();
        }
      }
      return invalid();
    }

    const resetTicket = randomToken();
    const ticketHash = await digest(resetTicket);
    const verifiedAt = Date.now();
    const ticketExpiry = verifiedAt + RESET_TICKET_TTL_MS;
    const createdAt = new Date().toISOString();
    const claimId = randomToken(16);
    const results = await env.DB.batch([
      env.DB.prepare(
        "UPDATE password_reset_codes SET claim_id=? WHERE uid=? AND code_hash=? AND expires_at_ms>? AND claim_id IS NULL RETURNING uid",
      ).bind(claimId, uid, codeHash, verifiedAt),
      env.DB.prepare(
        `INSERT INTO password_reset_tickets (ticket_hash,uid,expires_at_ms,created_at,claim_id)
         SELECT ?,uid,?,?,NULL FROM password_reset_codes
         WHERE uid=? AND code_hash=? AND claim_id=?
         RETURNING ticket_hash`,
      ).bind(ticketHash, ticketExpiry, createdAt, uid, codeHash, claimId),
      env.DB.prepare(
        "DELETE FROM password_reset_codes WHERE uid=? AND code_hash=? AND claim_id=? RETURNING uid",
      ).bind(uid, codeHash, claimId),
      env.DB.prepare(
        `DELETE FROM password_reset_challenge_locks WHERE uid=?
         AND EXISTS (SELECT 1 FROM password_reset_tickets WHERE ticket_hash=? AND uid=? AND claim_id IS NULL)`,
      ).bind(uid, ticketHash, uid),
    ]);
    if (!results[1]?.results?.length || !results[2]?.results?.length) return invalid();
    return json({ ok: true, resetTicket });
  }

  if (path === "/api/auth/complete-password-reset") {
    const body = await input(req);
    const ticket = text(body.ticket, 200);
    const password = String(body.password ?? "").slice(0, 1000);
    if (!ticket || password.length < 12) return json({ ok: false, error: "A valid reset session and password of at least 12 characters are required" }, 400);
    const ticketHash = await digest(ticket);
    const currentTime = Date.now();
    const ticketResult = await env.DB.prepare(
      "SELECT uid FROM password_reset_tickets WHERE ticket_hash=? AND claim_id IS NULL AND expires_at_ms>? LIMIT 1",
    ).bind(ticketHash, currentTime).all<{ uid: string }>();
    const uid = text(ticketResult.results[0]?.uid, 200);
    if (!uid) return json({ ok: false, error: "Reset verification has expired. Request a new code." }, 400);
    const hash = await passwordHash(password);
    const claimId = randomToken(16);
    const claimTime = Date.now();
    const results = await env.DB.batch([
      env.DB.prepare(
        "UPDATE password_reset_tickets SET claim_id=? WHERE ticket_hash=? AND uid=? AND claim_id IS NULL AND expires_at_ms>? RETURNING uid",
      ).bind(claimId, ticketHash, uid, claimTime),
      env.DB.prepare(
        `UPDATE users
         SET password_hash_v2=?,password_salt_v2=NULL,hash_algorithm='PBKDF2-SHA256',
             requires_password_reset=0,session_version=session_version+1
         WHERE uid=? AND active=1 AND disabled=0
            AND EXISTS (SELECT 1 FROM password_reset_tickets WHERE ticket_hash=? AND claim_id=?)
         RETURNING uid`,
      ).bind(hash, uid, ticketHash, claimId),
      env.DB.prepare("DELETE FROM password_reset_codes WHERE uid=?").bind(uid),
      env.DB.prepare("DELETE FROM password_reset_tickets WHERE uid=?").bind(uid),
    ]);
    if (!results[1]?.results?.length) return json({ ok: false, error: "Reset token is invalid or expired" }, 400);
    return json({ ok: true, message: "Password updated successfully" });
  }

  return null;
}