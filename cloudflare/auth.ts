import type { AuthEnv, AuthUser, AuthenticationResult } from "./backend-types";
import { inNeonTransaction } from "./neon-db";

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
const SIGNUP_CODE_TTL_MS = 5 * 60 * 1000;
const SIGNUP_RESEND_COOLDOWN_MS = 60 * 1000;
const SIGNUP_MAX_FAILURES = 5;
const SIGNUP_LOCK_MS = 15 * 60 * 1000;
const DUMMY_PASSWORD_HASH = "pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SIGNUP_MESSAGE = "If this email can be registered, a verification code has been sent. It expires in 5 minutes; wait 60 seconds before requesting another.";

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
  try {
    const [algorithm, iterationText, saltText, digestText] = stored.split("$");
    if (algorithm !== "pbkdf2-sha256" || !iterationText || !saltText || !digestText) return false;
    const iterations = Number(iterationText);
    if (!Number.isSafeInteger(iterations) || iterations !== PBKDF2_ITERATIONS) return false;
    const actual = new Uint8Array(await derive(password, decode(saltText), iterations));
    const expected = decode(digestText);
    if (actual.length !== expected.length) return false;
    let difference = 0;
    for (let index = 0; index < actual.length; index += 1) difference |= actual[index] ^ expected[index];
    return difference === 0;
  } catch {
    return false;
  }
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
  if (!env.PG) return null;
  const result = await env.PG.query<Record<string, unknown>>(
    "SELECT uid,email,display_name,role,school_id,institution_id,session_version,active,disabled FROM users WHERE uid = $1 LIMIT 1",
    [uid],
  );
  const row = result.rows[0];
  if (!row || Number(row.disabled) === 1 || Number(row.active ?? 1) === 0) return null;
  const storedRole = text(row.role, 80);
  const normalizedRole = storedRole.trim().toLowerCase().replace(/[ -]+/g, "_");
  return {
    uid: text(row.uid, 200), email: text(row.email, 320), displayName: text(row.display_name, 200),
    role: normalizedRole === "super_admin" ? "superadmin" : storedRole,
    schoolId: row.school_id ? text(row.school_id, 200) : null,
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
    if (!env.PG) return { authenticated: false, reason: "unavailable", status: 503 };
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

async function sendSignupVerificationEmail(env: AuthEnv, email: string, code: string): Promise<void> {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) throw new Error("Email sender is not configured");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL,
      to: [email],
      subject: "Verify your APSHULE account",
      text: `Your APSHULE email verification code is ${code}.\n\nThis code expires in 5 minutes. If you did not request it, you can ignore this email.`,
      html: `<p>Your APSHULE email verification code is <strong>${code}</strong>.</p><p>This code expires in 5 minutes. If you did not request it, you can ignore this email.</p>`,
    }),
  });
  if (!response.ok) throw new Error(`Signup verification email delivery failed (${response.status})`);
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
    if (!env.PG) return json({ ok: false, error: "Authentication database is not available" }, 503);
    const body = await input(req);
    const email = text(body.email, 320).toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";
    const invalid = () => json({ ok: false, error: "Email or password is incorrect, or the account is not ready to sign in." }, 401);
    if (!email || !password || password.length > 1000) return invalid();
    if (!await checkRateLimit(env, req, "password-login", email)) {
      return json({ ok: false, error: "Too many sign-in attempts. Wait a few minutes and try again." }, 429);
    }
    const row = (await env.PG.query<Record<string, unknown>>(
      "SELECT uid,password_hash_v2,email_verified,requires_password_reset,active,disabled,role FROM users WHERE lower(email)=$1 LIMIT 1",
      [email],
    )).rows[0];
    const storedHash = typeof row?.password_hash_v2 === "string" ? row.password_hash_v2 : DUMMY_PASSWORD_HASH;
    const passwordMatches = await verifyPassword(password, storedHash);
    if (!row || !passwordMatches || Number(row.email_verified) !== 1 ||
      Number(row.requires_password_reset) === 1 || Number(row.active ?? 1) !== 1 ||
      Number(row.disabled) === 1 || !text(row.role, 80)) return invalid();
    const user = await getUser(env, text(row.uid, 200));
    if (!user || !user.role) return invalid();
    return createSession(env, user);
  }

  if (path === "/api/auth/request-signup-verification") {
    if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) {
      console.error("[auth] signup verification sender is not configured", {
        apiKeyConfigured: Boolean(env.RESEND_API_KEY),
        fromAddressConfigured: Boolean(env.RESEND_FROM_EMAIL),
      });
      return json({ ok: false, error: "Email verification is not configured" }, 503);
    }
    const body = await input(req);
    const email = text(body.email, 320).toLowerCase();
    const displayName = text(body.displayName, 160);
    const password = typeof body.password === "string" ? body.password : "";
    const accountType = text(body.accountType, 40);
    const organizationName = text(body.organizationName, 180);
    const teachingDetails = text(body.teachingDetails, 1000);
    const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
    const validType = ["student", "teacher_staff", "teacher_independent"].includes(accountType);
    const minPasswordLength = accountType === "student" ? 6 : 12;
    if (!validEmail || !displayName || displayName.length > 160 || password.length < minPasswordLength || password.length > 1000 ||
      !validType || (accountType === "teacher_staff" && !organizationName)) {
      return json({ ok: false, error: `Enter a valid name, email, account type, and password of at least ${minPasswordLength} characters. School teaching applications also need a school or organization name.` }, 400);
    }
    if (!await checkRateLimit(env, req, "signup-request", email)) return json({ ok: true, message: SIGNUP_MESSAGE });
    if (!env.PG) return json({ ok: false, error: "Authentication database is not available" }, 503);
    const existing = await env.PG.query<{ uid: string }>(
      "SELECT uid FROM users WHERE lower(email)=$1 LIMIT 1",
      [email],
    );
    if (existing.rows.length) return json({ ok: true, message: SIGNUP_MESSAGE });

    const now = Date.now();
    await env.PG.query("DELETE FROM signup_challenges WHERE expires_at_ms<=$1", [now]);
    const uid = `signup_${randomToken(20)}`;
    const code = randomSixDigitCode();
    const codeHash = await passwordHash(`${uid}:${code}`);
    const passwordHashValue = await passwordHash(password);
    const saved = await env.PG.query<{ email: string }>(
      `INSERT INTO signup_challenges
         (email,uid,display_name,account_type,organization_name,teaching_details,password_hash,code_hash,
          expires_at_ms,requested_at_ms,failed_attempts,locked_until_ms,consumed_at_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,0,NULL)
       ON CONFLICT(email) DO UPDATE SET uid=excluded.uid,display_name=excluded.display_name,
         account_type=excluded.account_type,organization_name=excluded.organization_name,
         teaching_details=excluded.teaching_details,password_hash=excluded.password_hash,
         code_hash=excluded.code_hash,expires_at_ms=excluded.expires_at_ms,
         requested_at_ms=excluded.requested_at_ms,failed_attempts=0,locked_until_ms=0,consumed_at_ms=NULL
        WHERE signup_challenges.requested_at_ms<=$11
          AND signup_challenges.locked_until_ms<=$12
         AND signup_challenges.consumed_at_ms IS NULL
       RETURNING email`,
      [
        email, uid, displayName, accountType, organizationName || null, teachingDetails || null,
        passwordHashValue, codeHash, now + SIGNUP_CODE_TTL_MS, now, now - SIGNUP_RESEND_COOLDOWN_MS, now,
      ],
    );
    if (!saved.rows.length) return json({ ok: true, message: SIGNUP_MESSAGE });
    try {
      await sendSignupVerificationEmail(env, email, code);
    } catch (error) {
      console.error(
        "[auth] signup verification email delivery failed",
        error instanceof Error ? error.message : "unknown provider failure",
      );
      await env.PG.query("DELETE FROM signup_challenges WHERE email=$1 AND code_hash=$2", [email, codeHash]);
      return json({ ok: false, error: "Verification email could not be delivered. Try again later." }, 502);
    }
    return json({ ok: true, message: SIGNUP_MESSAGE });
  }

  if (path === "/api/auth/verify-signup") {
    const body = await input(req);
    const email = text(body.email, 320).toLowerCase();
    const code = text(body.code, 12);
    const invalid = () => json({ ok: false, error: "The verification code is invalid or expired. Request a new code and try again." }, 400);
    if (!email || !/^\d{6}$/.test(code) || !await checkRateLimit(env, req, "signup-verify", email)) return invalid();
    if (!env.PG) return json({ ok: false, error: "Authentication database is not available" }, 503);
    const now = Date.now();
    const challenge = (await env.PG.query<{ uid: string; code_hash: string; expires_at_ms: number; failed_attempts: number; locked_until_ms: number }>(
      "SELECT uid,code_hash,expires_at_ms,failed_attempts,locked_until_ms FROM signup_challenges WHERE email=$1 AND consumed_at_ms IS NULL LIMIT 1",
      [email],
    )).rows[0];
    if (!challenge || Number(challenge.expires_at_ms) <= now || Number(challenge.locked_until_ms) > now ||
      !await verifyPassword(`${challenge.uid}:${code}`, challenge.code_hash)) {
      if (challenge && Number(challenge.expires_at_ms) > now && Number(challenge.locked_until_ms) <= now) {
        await env.PG.query(
          `UPDATE signup_challenges
           SET failed_attempts=failed_attempts+1,
               locked_until_ms=CASE WHEN failed_attempts+1>=$1 THEN $2 ELSE locked_until_ms END
           WHERE email=$3 AND consumed_at_ms IS NULL AND failed_attempts<$4`,
          [SIGNUP_MAX_FAILURES, now + SIGNUP_LOCK_MS, email, SIGNUP_MAX_FAILURES],
        );
      }
      return invalid();
    }

    const consumedAt = Date.now();
    const verifiedAt = new Date(consumedAt).toISOString();
    const pg = env.PG;
    const createdUser = await inNeonTransaction(pg, async () => {
      await pg.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [email]);
      const consumed = await pg.query<{ uid: string }>(
        `UPDATE signup_challenges SET consumed_at_ms=$1
         WHERE email=$2 AND uid=$3 AND code_hash=$4 AND expires_at_ms>$1 AND locked_until_ms<=$1 AND consumed_at_ms IS NULL
         RETURNING uid`,
        [consumedAt, email, challenge.uid, challenge.code_hash],
      );
      if (!consumed.rows.length) return null;

      const inserted = await pg.query<Record<string, unknown>>(
        `INSERT INTO users
           (uid,email,display_name,role,disabled,email_verified,requires_password_reset,raw_json,created_at,imported_at,
            password_hash_v2,password_salt_v2,hash_algorithm,active,session_version)
         SELECT uid,email,display_name,CASE WHEN account_type='student' THEN 'student' ELSE '' END,
           FALSE,TRUE,FALSE,'{}',$1,$2,password_hash,NULL,'PBKDF2-SHA256',
           account_type='student',1
         FROM signup_challenges
         WHERE email=$3 AND uid=$4 AND consumed_at_ms=$5 AND NOT EXISTS
           (SELECT 1 FROM users WHERE lower(email)=$6)
         RETURNING uid,email,display_name,role,school_id,institution_id,session_version`,
        [verifiedAt, verifiedAt, email, challenge.uid, consumedAt, email],
      );
      const user = inserted.rows[0];
      if (!user) {
        await pg.query(
          "DELETE FROM signup_challenges WHERE email=$1 AND consumed_at_ms=$2",
          [email, consumedAt],
        );
        return null;
      }

      if (text(user.role, 80) !== "student") {
        await pg.query(
          `INSERT INTO teacher_applications
           (id,uid,application_type,organization_name,teaching_details,status,submitted_at)
           SELECT $1,c.uid,c.account_type,c.organization_name,c.teaching_details,'pending',$2
           FROM signup_challenges c JOIN users u ON u.uid=c.uid
           WHERE c.email=$3 AND c.uid=$4 AND c.consumed_at_ms=$5 AND c.account_type<>'student'
           RETURNING id`,
          [`application_${randomToken(16)}`, verifiedAt, email, challenge.uid, consumedAt],
        );
      }
      await pg.query(
        "DELETE FROM signup_challenges WHERE email=$1 AND consumed_at_ms=$2",
        [email, consumedAt],
      );
      return user;
    });
    if (!createdUser) return invalid();
    const accountType = text(createdUser.role, 80);
    if (accountType !== "student") {
      return json({
        ok: true,
        pendingReview: true,
        message: "Your email is verified. Your teacher application is waiting for Super Admin review.",
      });
    }
    const user = await getUser(env, text(createdUser.uid, 200));
    if (!user) return json({ ok: false, error: "The account was created but could not be signed in. Please sign in with your email and password." }, 500);
    return createSession(env, user);
  }

  if (path === "/api/auth/request-login-otp") {
    const email = text((await input(req)).email, 320).toLowerCase();
    const message = "If that email belongs to an active account, a 6-digit sign-in code will be sent. It expires in 10 minutes; wait 60 seconds before requesting another.";
    if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) {
      return json({ ok: false, error: "Email sign-in is not configured" }, 503);
    }
    if (!email || !await checkRateLimit(env, req, "login-otp-request", email)) return json({ ok: true, message });
    if (!env.PG) return json({ ok: false, error: "Authentication database is not available" }, 503);
    const row = (await env.PG.query<{ uid: string; email: string }>(
      "SELECT uid,email FROM users WHERE lower(email)=$1 AND active=TRUE AND disabled=FALSE LIMIT 1",
      [email],
    )).rows[0];
    if (!row) return json({ ok: true, message });
    const now = Date.now();
    await env.PG.query(
      "DELETE FROM login_otp_challenges WHERE expires_at_ms<=$1 OR (locked_until_ms>0 AND locked_until_ms<=$1)",
      [now],
    );
    const code = randomSixDigitCode();
    const codeHash = await passwordHash(`${row.uid}:${code}`);
    const saved = await env.PG.query<{ uid: string }>(
      `INSERT INTO login_otp_challenges (uid,code_hash,expires_at_ms,requested_at_ms,failed_attempts,locked_until_ms,consumed_at_ms)
       VALUES ($1,$2,$3,$4,0,0,NULL)
       ON CONFLICT(uid) DO UPDATE SET code_hash=excluded.code_hash,expires_at_ms=excluded.expires_at_ms,
         requested_at_ms=excluded.requested_at_ms,failed_attempts=0,locked_until_ms=0,consumed_at_ms=NULL
       WHERE login_otp_challenges.locked_until_ms<=$5
          AND login_otp_challenges.requested_at_ms<=$6
         AND login_otp_challenges.consumed_at_ms IS NULL
       RETURNING uid`,
      [row.uid, codeHash, now + LOGIN_OTP_TTL_MS, now, now, now - LOGIN_OTP_RESEND_COOLDOWN_MS],
    );
    if (!saved.rows.length) return json({ ok: true, message });
    try {
      await sendLoginOtpEmail(env, row.email, code);
    } catch {
      await env.PG.query("DELETE FROM login_otp_challenges WHERE uid=$1 AND code_hash=$2", [row.uid, codeHash]);
    }
    return json({ ok: true, message });
  }

  if (path === "/api/auth/verify-login-otp") {
    const body = await input(req);
    const email = text(body.email, 320).toLowerCase();
    const code = text(body.code, 12);
    const invalid = () => json({ ok: false, error: "The sign-in code is invalid or expired. Request a new code and try again." }, 400);
    if (!email || !/^\d{6}$/.test(code) || !await checkRateLimit(env, req, "login-otp-verify", email)) return invalid();
    if (!env.PG) return json({ ok: false, error: "Authentication database is not available" }, 503);
    const row = (await env.PG.query<{ uid: string }>(
      "SELECT uid FROM users WHERE lower(email)=$1 AND active=TRUE AND disabled=FALSE LIMIT 1",
      [email],
    )).rows[0];
    if (!row) return invalid();
    const now = Date.now();
    const challenge = (await env.PG.query<{ code_hash: string; expires_at_ms: number; failed_attempts: number; locked_until_ms: number }>(
      "SELECT code_hash,expires_at_ms,failed_attempts,locked_until_ms FROM login_otp_challenges WHERE uid=$1 AND consumed_at_ms IS NULL LIMIT 1",
      [row.uid],
    )).rows[0];
    if (!challenge || Number(challenge.expires_at_ms) <= now || Number(challenge.locked_until_ms) > now ||
      !await verifyPassword(`${row.uid}:${code}`, challenge.code_hash)) {
      if (challenge && Number(challenge.expires_at_ms) > now && Number(challenge.locked_until_ms) <= now) {
        await env.PG.query<{ failed_attempts: number }>(
          "UPDATE login_otp_challenges SET failed_attempts=failed_attempts+1,locked_until_ms=CASE WHEN failed_attempts+1>=$1 THEN $2 ELSE locked_until_ms END WHERE uid=$3 AND consumed_at_ms IS NULL AND failed_attempts<$4 RETURNING failed_attempts",
          [LOGIN_OTP_MAX_FAILURES, now + LOGIN_OTP_LOCK_MS, row.uid, LOGIN_OTP_MAX_FAILURES],
        );
      }
      return invalid();
    }
    const consumed = await env.PG.query<{ uid: string }>(
      "UPDATE login_otp_challenges SET consumed_at_ms=$1 WHERE uid=$2 AND code_hash=$3 AND consumed_at_ms IS NULL AND expires_at_ms>$1 AND locked_until_ms<=$1 RETURNING uid",
      [now, row.uid, challenge.code_hash],
    );
    if (!consumed.rows.length) return invalid();
    const user = await getUser(env, row.uid);
    if (!user) return invalid();
    await env.PG.query("DELETE FROM login_otp_challenges WHERE uid=$1", [row.uid]);
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
    if (!env.PG) return json({ ok: false, error: "Authentication database is not available" }, 503);
    const pg = env.PG;
    const result = await pg.query<{ uid: string; email: string }>(
      "SELECT uid,email FROM users WHERE lower(email)=$1 AND disabled=FALSE AND active=TRUE LIMIT 1",
      [email],
    );
    const user = result.rows[0];
    if (user) {
      const uid = text(user.uid, 200);
      const now = Date.now();
      await inNeonTransaction(pg, async () => {
        await pg.query("DELETE FROM password_reset_codes WHERE expires_at_ms<=$1", [now]);
        await pg.query("DELETE FROM password_reset_tickets WHERE expires_at_ms<=$1", [now]);
        await pg.query(
          `DELETE FROM password_reset_challenge_locks
           WHERE (locked_until_ms > 0 AND locked_until_ms <= $1)
              OR (locked_until_ms = 0 AND window_started_at_ms <= $2)`,
          [now, now - RESET_CHALLENGE_LOCK_MS],
        );
        await pg.query(
          "DELETE FROM password_reset_request_cooldowns WHERE requested_at_ms<$1",
          [now - 24 * 60 * 60 * 1000],
        );
      });
      const challengeLock = await pg.query<{ locked_until_ms: number }>(
        "SELECT locked_until_ms FROM password_reset_challenge_locks WHERE uid=$1 AND locked_until_ms>$2 LIMIT 1",
        [uid, now],
      );
      if (challengeLock.rows.length) return json({ ok: true, message });
      const cooldown = await pg.query<{ uid: string }>(
        `INSERT INTO password_reset_request_cooldowns (uid,requested_at_ms) VALUES ($1,$2)
         ON CONFLICT(uid) DO UPDATE SET requested_at_ms=excluded.requested_at_ms
         WHERE password_reset_request_cooldowns.requested_at_ms <= $3
         RETURNING uid`,
        [uid, now, now - RESET_REQUEST_COOLDOWN_MS],
      );
      if (!cooldown.rows.length) return json({ ok: true, message });

      const code = randomSixDigitCode();
      const codeHash = await passwordHash(`${uid}:${code}`);
      const createdAt = new Date().toISOString();
      const expiresAt = now + RESET_CODE_TTL_MS;
      await inNeonTransaction(pg, async () => {
        await pg.query("DELETE FROM password_reset_codes WHERE uid=$1", [uid]);
        await pg.query("DELETE FROM password_reset_tickets WHERE uid=$1", [uid]);
        await pg.query(
          "INSERT INTO password_reset_codes (uid,code_hash,expires_at_ms,created_at) VALUES ($1,$2,$3,$4)",
          [uid, codeHash, expiresAt, createdAt],
        );
      });
      try {
        await sendResetCodeEmail(env, user.email, code);
      } catch {
        await pg.query("DELETE FROM password_reset_codes WHERE uid=$1 AND code_hash=$2", [uid, codeHash]);
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
    if (!env.PG) return json({ ok: false, error: "Authentication database is not available" }, 503);
    const pg = env.PG;

    const userResult = await pg.query<{ uid: string }>(
      "SELECT uid FROM users WHERE lower(email)=$1 AND active=TRUE AND disabled=FALSE LIMIT 1",
      [email],
    );
    const uid = text(userResult.rows[0]?.uid, 200);
    if (!uid) return invalid();

    const now = Date.now();
    const challengeLock = await pg.query<{ locked_until_ms: number }>(
      "SELECT locked_until_ms FROM password_reset_challenge_locks WHERE uid=$1 AND locked_until_ms>$2 LIMIT 1",
      [uid, now],
    );
    if (challengeLock.rows.length) return invalid();
    const codeResult = await pg.query<{ code_hash: string }>(
      "SELECT code_hash FROM password_reset_codes WHERE uid=$1 AND expires_at_ms>$2 AND claim_id IS NULL LIMIT 1",
      [uid, now],
    );
    const codeHash = codeResult.rows[0]?.code_hash;
    if (!codeHash || !await verifyPassword(`${uid}:${code}`, String(codeHash))) {
      if (codeHash) {
        const cutoff = now - RESET_CHALLENGE_LOCK_MS;
        const attempts = await pg.query<{ failed_attempts: number; locked_until_ms: number }>(
          `INSERT INTO password_reset_challenge_locks
             (uid,failed_attempts,window_started_at_ms,locked_until_ms,updated_at)
           VALUES ($1,1,$2,0,$3)
           ON CONFLICT(uid) DO UPDATE SET
             failed_attempts=CASE WHEN password_reset_challenge_locks.window_started_at_ms<=$4 THEN 1
                                  ELSE password_reset_challenge_locks.failed_attempts+1 END,
             window_started_at_ms=CASE WHEN password_reset_challenge_locks.window_started_at_ms<=$5
                                       THEN excluded.window_started_at_ms
                                       ELSE password_reset_challenge_locks.window_started_at_ms END,
             locked_until_ms=CASE WHEN password_reset_challenge_locks.window_started_at_ms<=$6 THEN 0
                                  WHEN password_reset_challenge_locks.failed_attempts+1>=$7 THEN $8
                                  ELSE password_reset_challenge_locks.locked_until_ms END,
             updated_at=excluded.updated_at
           WHERE password_reset_challenge_locks.locked_until_ms<=$9
             AND EXISTS (
               SELECT 1 FROM password_reset_codes
               WHERE uid=$10 AND code_hash=$11 AND expires_at_ms>$12 AND claim_id IS NULL
             )
           RETURNING failed_attempts,locked_until_ms`,
          [
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
          ],
        );
        if (Number(attempts.rows[0]?.failed_attempts ?? 0) >= RESET_CHALLENGE_MAX_FAILURES) {
          await pg.query(
            "DELETE FROM password_reset_codes WHERE uid=$1 AND code_hash=$2 AND claim_id IS NULL",
            [uid, codeHash],
          );
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
    const claimConflict = new Error("RESET_CLAIM_CONFLICT");
    let ticketCreated = false;
    try {
      ticketCreated = await inNeonTransaction(pg, async () => {
        const claimed = await pg.query<{ uid: string }>(
          "UPDATE password_reset_codes SET claim_id=$1 WHERE uid=$2 AND code_hash=$3 AND expires_at_ms>$4 AND claim_id IS NULL RETURNING uid",
          [claimId, uid, codeHash, verifiedAt],
        );
        if (!claimed.rows.length) throw claimConflict;
        const ticket = await pg.query<{ ticket_hash: string }>(
          `INSERT INTO password_reset_tickets (ticket_hash,uid,expires_at_ms,created_at,claim_id)
           SELECT $1,uid,$2,$3,NULL FROM password_reset_codes
           WHERE uid=$4 AND code_hash=$5 AND claim_id=$6
           RETURNING ticket_hash`,
          [ticketHash, ticketExpiry, createdAt, uid, codeHash, claimId],
        );
        if (!ticket.rows.length) throw claimConflict;
        const deletedCode = await pg.query<{ uid: string }>(
          "DELETE FROM password_reset_codes WHERE uid=$1 AND code_hash=$2 AND claim_id=$3 RETURNING uid",
          [uid, codeHash, claimId],
        );
        if (!deletedCode.rows.length) throw claimConflict;
        await pg.query(
          `DELETE FROM password_reset_challenge_locks WHERE uid=$1
           AND EXISTS (SELECT 1 FROM password_reset_tickets WHERE ticket_hash=$2 AND uid=$3 AND claim_id IS NULL)`,
          [uid, ticketHash, uid],
        );
        return true;
      });
    } catch (error) {
      if (error !== claimConflict) throw error;
    }
    if (!ticketCreated) return invalid();
    return json({ ok: true, resetTicket });
  }

  if (path === "/api/auth/complete-password-reset") {
    const body = await input(req);
    const ticket = text(body.ticket, 200);
    const password = String(body.password ?? "").slice(0, 1000);
    if (!ticket || password.length < 12) return json({ ok: false, error: "A valid reset session and password of at least 12 characters are required" }, 400);
    if (!env.PG) return json({ ok: false, error: "Authentication database is not available" }, 503);
    const pg = env.PG;
    const ticketHash = await digest(ticket);
    const currentTime = Date.now();
    const ticketResult = await pg.query<{ uid: string }>(
      "SELECT uid FROM password_reset_tickets WHERE ticket_hash=$1 AND claim_id IS NULL AND expires_at_ms>$2 LIMIT 1",
      [ticketHash, currentTime],
    );
    const uid = text(ticketResult.rows[0]?.uid, 200);
    if (!uid) return json({ ok: false, error: "Reset verification has expired. Request a new code." }, 400);
    const hash = await passwordHash(password);
    const claimId = randomToken(16);
    const claimTime = Date.now();
    const passwordChanged = await inNeonTransaction(pg, async () => {
      await pg.query(
        "UPDATE password_reset_tickets SET claim_id=$1 WHERE ticket_hash=$2 AND uid=$3 AND claim_id IS NULL AND expires_at_ms>$4 RETURNING uid",
        [claimId, ticketHash, uid, claimTime],
      );
      const updated = await pg.query<{ uid: string }>(
        `UPDATE users
         SET password_hash_v2=$1,password_salt_v2=NULL,hash_algorithm='PBKDF2-SHA256',
             requires_password_reset=FALSE,session_version=session_version+1
         WHERE uid=$2 AND active=TRUE AND disabled=FALSE
            AND EXISTS (SELECT 1 FROM password_reset_tickets WHERE ticket_hash=$3 AND claim_id=$4)
         RETURNING uid`,
        [hash, uid, ticketHash, claimId],
      );
      await pg.query("DELETE FROM password_reset_codes WHERE uid=$1", [uid]);
      await pg.query("DELETE FROM password_reset_tickets WHERE uid=$1", [uid]);
      return updated.rows.length > 0;
    });
    if (!passwordChanged) return json({ ok: false, error: "Reset token is invalid or expired" }, 400);
    return json({ ok: true, message: "Password updated successfully" });
  }

  return null;
}