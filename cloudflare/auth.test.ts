import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { handleAuthRoute } from "./auth";
import { handleDomainRoute } from "./domain-routes";
import type { AuthUser, D1BatchResult, D1Database, D1Statement, SessionsKV } from "./backend-types";

type SqlValue = string | number | bigint | Uint8Array | null;

class LocalStatement implements D1Statement {
  private values: SqlValue[] = [];

  constructor(private readonly database: DatabaseSync, private readonly query: string) {}

  bind(...values: unknown[]): D1Statement {
    this.values = values as SqlValue[];
    return this;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    const results = this.database.prepare(this.query).all(...this.values) as T[];
    return { results };
  }

  async run(): Promise<unknown> {
    return this.database.prepare(this.query).run(...this.values);
  }
}

class LocalDatabase implements D1Database {
  constructor(readonly database: DatabaseSync) {}

  prepare(query: string): D1Statement {
    return new LocalStatement(this.database, query);
  }

  async batch(statements: D1Statement[]): Promise<D1BatchResult[]> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results: D1BatchResult[] = [];
      for (const statement of statements) {
        results.push(await (statement as LocalStatement).all());
      }
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

class LocalSessions implements SessionsKV {
  private readonly values = new Map<string, string>();

  async get(key: string): Promise<unknown> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

const migrations = [
  new URL("./migrations/0005_password_reset_tokens.sql", import.meta.url),
  new URL("./migrations/0006_password_reset_otp.sql", import.meta.url),
  new URL("./migrations/0007_password_reset_challenge_lock.sql", import.meta.url),
  new URL("./migrations/0015_auth_login_otp.sql", import.meta.url),
  new URL("./migrations/0019_public_signup_and_teacher_applications.sql", import.meta.url),
];

let rawDatabase: DatabaseSync;
let database: LocalDatabase;
let env: {
  DB: D1Database;
  SESSIONS: SessionsKV;
  PUBLIC_SITE_URL: string;
  RESEND_API_KEY: string;
  RESEND_FROM_EMAIL: string;
};
let originalFetch: typeof fetch;
let sentEmails: Array<Record<string, unknown>>;

function scalar(sql: string, ...values: SqlValue[]): number {
  return Number(rawDatabase.prepare(sql).get(...values)?.value ?? 0);
}

function field(sql: string, ...values: SqlValue[]): unknown {
  const row = rawDatabase.prepare(sql).get(...values) as Record<string, unknown> | undefined;
  return row ? Object.values(row)[0] : null;
}

async function post(path: string, body: Record<string, unknown>): Promise<{ response: Response; data: Record<string, unknown> }> {
  const response = await handleAuthRoute(
    new Request(`https://worker.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.15" },
      body: JSON.stringify(body),
    }),
    env,
  );
  assert.ok(response, `Expected an auth handler for ${path}`);
  return { response, data: await response.json() as Record<string, unknown> };
}

beforeEach(() => {
  rawDatabase = new DatabaseSync(":memory:");
  rawDatabase.exec(`
    CREATE TABLE users (
      uid TEXT PRIMARY KEY NOT NULL,
      email TEXT NOT NULL,
      display_name TEXT,
      role TEXT,
      email_verified INTEGER NOT NULL DEFAULT 0,
      school_id TEXT,
      institution_id TEXT,
      session_version INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1,
      disabled INTEGER NOT NULL DEFAULT 0,
      requires_password_reset INTEGER NOT NULL DEFAULT 1,
      password_hash_v2 TEXT,
      password_salt_v2 TEXT,
      hash_algorithm TEXT,
      raw_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT,
      imported_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE audit (
      id TEXT PRIMARY KEY NOT NULL,
      institution_id TEXT,
      school_id TEXT,
      actor_id TEXT,
      action TEXT NOT NULL,
      resource_type TEXT,
      resource_id TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );
    INSERT INTO users (uid,email,display_name,role,email_verified,active,disabled,requires_password_reset,hash_algorithm)
    VALUES ('test-user','otp-test@example.com','OTP Test','student',1,1,0,1,'SCRYPT');
  `);
  for (const migration of migrations) rawDatabase.exec(readFileSync(migration, "utf8"));
  database = new LocalDatabase(rawDatabase);
  env = {
    DB: database,
    SESSIONS: new LocalSessions(),
    PUBLIC_SITE_URL: "https://appshule.com",
    RESEND_API_KEY: "test-resend-key",
    RESEND_FROM_EMAIL: "noreply@appshule.com",
  };
  sentEmails = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sentEmails.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ id: `test-email-${sentEmails.length}` }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rawDatabase.close();
});

test("request, verify, and complete a single-use password reset", async () => {
  const startedAt = Date.now();
  const request = await post("/api/auth/request-password-reset", { email: "OTP-Test@example.com" });
  assert.equal(request.response.status, 200);
  assert.equal(request.data.ok, true);
  assert.equal(sentEmails.length, 1);

  const email = sentEmails[0];
  const text = String(email.text);
  const code = text.match(/code is (\d{6})/)?.[1];
  assert.ok(code, "email text contains a 6-digit code");
  assert.match(String(email.html), new RegExp(`>${code}<`));
  assert.match(String(email.html), /monospace/i);
  assert.match(text, /expires in 10 minutes/i);

  const storedCode = rawDatabase.prepare(
    "SELECT code_hash,expires_at_ms FROM password_reset_codes WHERE uid=?",
  ).get("test-user") as { code_hash: string; expires_at_ms: number } | undefined;
  assert.ok(storedCode);
  assert.notEqual(storedCode.code_hash, code);
  assert.match(storedCode.code_hash, /^pbkdf2-sha256\$100000\$/);
  assert.ok(storedCode.expires_at_ms >= startedAt + 10 * 60 * 1000 - 2_000);

  const wrongCode = code === "123456" ? "654321" : "123456";
  const wrong = await post("/api/auth/verify-password-reset-code", {
    email: "otp-test@example.com",
    code: wrongCode,
  });
  assert.equal(wrong.response.status, 400);
  assert.equal(scalar("SELECT COUNT(*) AS value FROM password_reset_codes WHERE uid=?", "test-user"), 1);

  const verified = await post("/api/auth/verify-password-reset-code", {
    email: "otp-test@example.com",
    code,
  });
  assert.equal(verified.response.status, 200);
  assert.equal(verified.data.ok, true);
  const resetTicket = String(verified.data.resetTicket);
  assert.ok(resetTicket.length >= 40);
  assert.equal(scalar("SELECT COUNT(*) AS value FROM password_reset_challenge_locks WHERE uid=?", "test-user"), 0);
  assert.equal(scalar("SELECT COUNT(*) AS value FROM password_reset_codes WHERE uid=?", "test-user"), 0);
  assert.equal(scalar("SELECT COUNT(*) AS value FROM password_reset_tickets WHERE uid=?", "test-user"), 1);
  assert.equal(
    scalar("SELECT COUNT(*) AS value FROM password_reset_tickets WHERE ticket_hash=?", resetTicket),
    0,
    "only the ticket hash is stored",
  );

  const replayCode = await post("/api/auth/verify-password-reset-code", {
    email: "otp-test@example.com",
    code,
  });
  assert.equal(replayCode.response.status, 400);

  const newPassword = "A-long-test-password-2026";
  const completed = await post("/api/auth/complete-password-reset", { ticket: resetTicket, password: newPassword });
  assert.equal(completed.response.status, 200);
  assert.equal(completed.data.ok, true);
  assert.equal(scalar("SELECT COUNT(*) AS value FROM password_reset_tickets WHERE uid=?", "test-user"), 0);

  const replayTicket = await post("/api/auth/complete-password-reset", { ticket: resetTicket, password: newPassword });
  assert.equal(replayTicket.response.status, 400);

  const login = await post("/api/auth/login", { email: "otp-test@example.com", password: newPassword });
  assert.equal(login.response.status, 200);
  assert.equal(login.data.ok, true);
  assert.match(login.response.headers.get("set-cookie") || "", /aps_session=.*HttpOnly/);
  assert.equal(sentEmails.length, 1, "only the initial request sends an email");
});

test("creates a student account only after a one-use email verification code", async () => {
  const startedAt = Date.now();
  const password = "Student-signup-password-2026";
  const requested = await post("/api/auth/request-signup-verification", {
    email: "new-student@example.com",
    displayName: "New Student",
    password,
    accountType: "student",
  });
  assert.equal(requested.response.status, 200);
  assert.equal(requested.data.ok, true);
  assert.equal(sentEmails.length, 1);
  assert.match(String(sentEmails[0].text), /expires in 5 minutes/i);
  assert.match(String(sentEmails[0].html), /expires in 5 minutes/i);
  const code = String(sentEmails[0].text).match(/code is (\d{6})/)?.[1];
  assert.ok(code);
  const challenge = rawDatabase.prepare(
    "SELECT password_hash,code_hash,expires_at_ms FROM signup_challenges WHERE email=?",
  ).get("new-student@example.com") as { password_hash: string; code_hash: string; expires_at_ms: number };
  assert.match(challenge.password_hash, /^pbkdf2-sha256\$100000\$/);
  assert.match(challenge.code_hash, /^pbkdf2-sha256\$100000\$/);
  assert.notEqual(challenge.code_hash, code);
  assert.ok(challenge.expires_at_ms >= startedAt + 5 * 60 * 1000 - 2_000);
  assert.ok(challenge.expires_at_ms <= startedAt + 5 * 60 * 1000 + 2_000);
  assert.equal(scalar("SELECT COUNT(*) AS value FROM users WHERE lower(email)=?", "new-student@example.com"), 0);
  await post("/api/auth/request-signup-verification", {
    email: "new-student@example.com",
    displayName: "New Student",
    password,
    accountType: "student",
  });
  assert.equal(sentEmails.length, 1, "signup verification requests respect the resend cooldown");

  const verified = await post("/api/auth/verify-signup", { email: "new-student@example.com", code });
  assert.equal(verified.response.status, 200);
  assert.equal(verified.data.ok, true);
  assert.equal((verified.data.user as Record<string, unknown>).role, "student");
  assert.match(verified.response.headers.get("set-cookie") || "", /aps_session=.*HttpOnly/);
  assert.equal(scalar("SELECT email_verified AS value FROM users WHERE lower(email)=?", "new-student@example.com"), 1);
  assert.equal(scalar("SELECT active AS value FROM users WHERE lower(email)=?", "new-student@example.com"), 1);
  assert.equal(scalar("SELECT COUNT(*) AS value FROM teacher_applications"), 0);
  const replay = await post("/api/auth/verify-signup", { email: "new-student@example.com", code });
  assert.equal(replay.response.status, 400);
});

test("allows six-character student passwords and keeps teacher applicants at twelve", async () => {
  const tooShortStudent = await post("/api/auth/request-signup-verification", {
    email: "short-student@example.com",
    displayName: "Short Student",
    password: "abc12",
    accountType: "student",
  });
  assert.equal(tooShortStudent.response.status, 400);

  const student = await post("/api/auth/request-signup-verification", {
    email: "six-char-student@example.com",
    displayName: "Six Character Student",
    password: "abc123",
    accountType: "student",
  });
  assert.equal(student.response.status, 200);
  assert.equal(student.data.ok, true);
  assert.equal(sentEmails.length, 1);

  const shortTeacher = await post("/api/auth/request-signup-verification", {
    email: "short-teacher@example.com",
    displayName: "Short Teacher",
    password: "teacher123",
    accountType: "teacher_independent",
  });
  assert.equal(shortTeacher.response.status, 400);
  assert.equal(sentEmails.length, 1);

  const teacher = await post("/api/auth/request-signup-verification", {
    email: "long-teacher@example.com",
    displayName: "Long Teacher",
    password: "Teacher-signup-password-2026",
    accountType: "teacher_independent",
  });
  assert.equal(teacher.response.status, 200);
  assert.equal(teacher.data.ok, true);
  assert.equal(sentEmails.length, 2);
});

test("holds teacher accounts inactive until a Super Admin approves and scopes them", async () => {
  const password = "Teacher-signup-password-2026";
  const requested = await post("/api/auth/request-signup-verification", {
    email: "teacher-applicant@example.com",
    displayName: "Teacher Applicant",
    password,
    accountType: "teacher_staff",
    organizationName: "Kampala Community School",
    teachingDetails: "Mathematics and science",
  });
  assert.equal(requested.response.status, 200);
  const code = String(sentEmails[0].text).match(/code is (\d{6})/)?.[1];
  assert.ok(code);
  const wrongCode = code === "123456" ? "654321" : "123456";
  const wrongAttempt = await post("/api/auth/verify-signup", { email: "teacher-applicant@example.com", code: wrongCode });
  assert.equal(wrongAttempt.response.status, 400);
  assert.equal(scalar("SELECT failed_attempts AS value FROM signup_challenges WHERE email=?", "teacher-applicant@example.com"), 1);
  const verified = await post("/api/auth/verify-signup", { email: "teacher-applicant@example.com", code });
  assert.equal(verified.response.status, 200);
  assert.equal(verified.data.pendingReview, true);
  assert.equal(verified.response.headers.get("set-cookie"), null);
  assert.equal(scalar("SELECT active AS value FROM users WHERE lower(email)=?", "teacher-applicant@example.com"), 0);
  assert.equal(scalar("SELECT role AS value FROM users WHERE lower(email)=?", "teacher-applicant@example.com"), 0);

  const application = rawDatabase.prepare(
    "SELECT id FROM teacher_applications WHERE uid=(SELECT uid FROM users WHERE lower(email)=?)",
  ).get("teacher-applicant@example.com") as { id: string };
  const superadmin: AuthUser = {
    uid: "test-superadmin", email: "admin@example.com", displayName: "Test Admin", role: "superadmin",
    schoolId: null, institutionId: null, sessionVersion: 1,
  };
  const callAdmin = async (path: string, body?: Record<string, unknown>, actor: AuthUser = superadmin) => {
    const response = await handleDomainRoute(
      new Request(`https://worker.test${path}`, {
        method: body ? "POST" : "GET",
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      }),
      env,
      actor,
    );
    assert.ok(response);
    return { response, data: await response.json() as Record<string, unknown> };
  };
  const forbidden = await callAdmin("/api/admin/teacher-applications", undefined, {
    ...superadmin, role: "student",
  });
  assert.equal(forbidden.response.status, 403);
  const missingScope = await callAdmin(`/api/admin/teacher-applications/${application.id}/review`, { decision: "approve" });
  assert.equal(missingScope.response.status, 400);
  const approved = await callAdmin(`/api/admin/teacher-applications/${application.id}/review`, {
    decision: "approve", schoolId: "school-kampala",
  });
  assert.equal(approved.response.status, 200);
  assert.equal(scalar("SELECT active AS value FROM users WHERE lower(email)=?", "teacher-applicant@example.com"), 1);
  assert.equal(field("SELECT role AS value FROM users WHERE lower(email)=?", "teacher-applicant@example.com"), "teacher_staff");
  assert.equal(field("SELECT school_id AS value FROM users WHERE lower(email)=?", "teacher-applicant@example.com"), "school-kampala");
  const login = await post("/api/auth/login", { email: "teacher-applicant@example.com", password });
  assert.equal(login.response.status, 200);
  assert.equal((login.data.user as Record<string, unknown>).role, "teacher_staff");
  assert.equal(scalar("SELECT COUNT(*) AS value FROM audit WHERE action='admin.teacher_application.approve'"), 1);
  let genericLoginError: unknown = null;
  for (const [column, deniedValue, restoredValue] of [
    ["email_verified", 0, 1],
    ["active", 0, 1],
    ["disabled", 1, 0],
    ["requires_password_reset", 1, 0],
  ] as const) {
    rawDatabase.prepare(`UPDATE users SET ${column}=? WHERE lower(email)=?`).run(deniedValue, "teacher-applicant@example.com");
    const denied = await post("/api/auth/login", { email: "teacher-applicant@example.com", password });
    assert.equal(denied.response.status, 401, `${column} accounts cannot use password login`);
    if (genericLoginError === null) genericLoginError = denied.data.error;
    else assert.equal(denied.data.error, genericLoginError);
    rawDatabase.prepare(`UPDATE users SET ${column}=? WHERE lower(email)=?`).run(restoredValue, "teacher-applicant@example.com");
  }
  assert.equal(typeof genericLoginError, "string");
});

test("enforces the 60-second resend cooldown and allows resend afterward", async () => {
  await post("/api/auth/request-password-reset", { email: "otp-test@example.com" });
  assert.equal(sentEmails.length, 1);

  const immediateResend = await post("/api/auth/request-password-reset", { email: "otp-test@example.com" });
  assert.equal(immediateResend.response.status, 200);
  assert.equal(sentEmails.length, 1);

  rawDatabase.prepare("UPDATE password_reset_request_cooldowns SET requested_at_ms=? WHERE uid=?")
    .run(Date.now() - 60_001, "test-user");
  await post("/api/auth/request-password-reset", { email: "otp-test@example.com" });
  assert.equal(sentEmails.length, 2);
});

test("locks a reset challenge after three wrong codes and blocks resend", async () => {
  await post("/api/auth/request-password-reset", { email: "otp-test@example.com" });
  const firstCode = String(sentEmails[0].text).match(/code is (\d{6})/)?.[1];
  assert.ok(firstCode);
  const firstWrongCode = firstCode === "123456" ? "654321" : "123456";

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const wrong = await post("/api/auth/verify-password-reset-code", {
      email: "otp-test@example.com",
      code: firstWrongCode,
    });
    assert.equal(wrong.response.status, 400);
    assert.match(String(wrong.data.error), /invalid or expired/i);
    assert.equal(
      scalar("SELECT failed_attempts AS value FROM password_reset_challenge_locks WHERE uid=?", "test-user"),
      attempt,
    );
  }

  rawDatabase.prepare("UPDATE password_reset_request_cooldowns SET requested_at_ms=? WHERE uid=?")
    .run(Date.now() - 60_001, "test-user");
  const resendWithTwoFailures = await post("/api/auth/request-password-reset", { email: "otp-test@example.com" });
  assert.equal(resendWithTwoFailures.response.status, 200);
  assert.equal(sentEmails.length, 2);
  const replacementCode = String(sentEmails[1].text).match(/code is (\d{6})/)?.[1];
  assert.ok(replacementCode);
  const replacementWrongCode = replacementCode === "123456" ? "654321" : "123456";
  const thirdWrong = await post("/api/auth/verify-password-reset-code", {
    email: "otp-test@example.com",
    code: replacementWrongCode,
  });
  assert.equal(thirdWrong.response.status, 400);

  assert.equal(scalar("SELECT COUNT(*) AS value FROM password_reset_codes WHERE uid=?", "test-user"), 0);
  assert.equal(scalar("SELECT COUNT(*) AS value FROM password_reset_challenge_locks WHERE uid=?", "test-user"), 1);
  assert.equal(scalar("SELECT failed_attempts AS value FROM password_reset_challenge_locks WHERE uid=?", "test-user"), 3);

  rawDatabase.prepare("UPDATE password_reset_request_cooldowns SET requested_at_ms=? WHERE uid=?")
    .run(Date.now() - 60_001, "test-user");
  const resend = await post("/api/auth/request-password-reset", { email: "otp-test@example.com" });
  assert.equal(resend.response.status, 200);
  assert.equal(resend.data.ok, true);
  assert.equal(sentEmails.length, 2, "challenge lock prevents bypassing the resend cooldown");
});

test("counts concurrent wrong reset codes atomically", async () => {
  await post("/api/auth/request-password-reset", { email: "otp-test@example.com" });
  const code = String(sentEmails[0].text).match(/code is (\d{6})/)?.[1];
  assert.ok(code);
  const wrongCode = code === "123456" ? "654321" : "123456";

  const attempts = await Promise.all(Array.from({ length: 4 }, () =>
    post("/api/auth/verify-password-reset-code", {
      email: "otp-test@example.com",
      code: wrongCode,
    }),
  ));
  for (const attempt of attempts) assert.equal(attempt.response.status, 400);

  assert.equal(
    scalar("SELECT failed_attempts AS value FROM password_reset_challenge_locks WHERE uid=?", "test-user"),
    3,
  );
  assert.ok(scalar("SELECT locked_until_ms AS value FROM password_reset_challenge_locks WHERE uid=?", "test-user") > Date.now());
  assert.equal(scalar("SELECT COUNT(*) AS value FROM password_reset_codes WHERE uid=?", "test-user"), 0);
});

test("allows a new reset challenge after the lock expires", async () => {
  await post("/api/auth/request-password-reset", { email: "otp-test@example.com" });
  const code = String(sentEmails[0].text).match(/code is (\d{6})/)?.[1];
  assert.ok(code);
  const wrongCode = code === "123456" ? "654321" : "123456";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await post("/api/auth/verify-password-reset-code", {
      email: "otp-test@example.com",
      code: wrongCode,
    });
  }

  rawDatabase.prepare("UPDATE password_reset_challenge_locks SET locked_until_ms=? WHERE uid=?")
    .run(Date.now() - 1, "test-user");
  rawDatabase.prepare("UPDATE password_reset_request_cooldowns SET requested_at_ms=? WHERE uid=?")
    .run(Date.now() - 60_001, "test-user");
  const afterExpiry = await post("/api/auth/request-password-reset", { email: "otp-test@example.com" });
  assert.equal(afterExpiry.response.status, 200);
  assert.equal(afterExpiry.data.ok, true);
  assert.equal(sentEmails.length, 2);
  assert.equal(scalar("SELECT COUNT(*) AS value FROM password_reset_challenge_locks WHERE uid=?", "test-user"), 0);
  const replacementCode = String(sentEmails[1].text).match(/code is (\d{6})/)?.[1];
  assert.ok(replacementCode);
  const verified = await post("/api/auth/verify-password-reset-code", {
    email: "otp-test@example.com",
    code: replacementCode,
  });
  assert.equal(verified.response.status, 200);
  assert.equal(verified.data.ok, true);
});

test("rejects expired codes and does not disclose unknown accounts", async () => {
  await post("/api/auth/request-password-reset", { email: "otp-test@example.com" });
  const email = sentEmails[0];
  const code = String(email.text).match(/code is (\d{6})/)?.[1];
  assert.ok(code);
  rawDatabase.prepare("UPDATE password_reset_codes SET expires_at_ms=0 WHERE uid=?").run("test-user");

  const expired = await post("/api/auth/verify-password-reset-code", { email: "otp-test@example.com", code });
  assert.equal(expired.response.status, 400);
  assert.equal(scalar("SELECT COUNT(*) AS value FROM password_reset_tickets"), 0);

  const unknown = await post("/api/auth/request-password-reset", { email: "nobody@example.com" });
  assert.equal(unknown.response.status, 200);
  assert.equal(unknown.data.ok, true);
  assert.equal(sentEmails.length, 1);
});

test("requests and verifies a one-use login OTP without changing credentials", async () => {
  const before = rawDatabase.prepare(
    "SELECT password_hash_v2,requires_password_reset,session_version FROM users WHERE uid=?",
  ).get("test-user") as Record<string, unknown>;
  const requested = await post("/api/auth/request-login-otp", { email: "OTP-Test@example.com" });
  assert.equal(requested.response.status, 200);
  assert.equal(requested.data.ok, true);
  assert.equal(sentEmails.length, 1);
  const email = sentEmails[0];
  const code = String(email.text).match(/code is (\d{6})/)?.[1];
  assert.ok(code);
  assert.match(String(email.text), /expires in 10 minutes/i);
  const stored = rawDatabase.prepare(
    "SELECT code_hash,expires_at_ms,failed_attempts FROM login_otp_challenges WHERE uid=?",
  ).get("test-user") as { code_hash: string; expires_at_ms: number; failed_attempts: number };
  assert.notEqual(stored.code_hash, code);
  assert.equal(stored.failed_attempts, 0);
  assert.ok(stored.expires_at_ms > Date.now());
  const immediateResend = await post("/api/auth/request-login-otp", { email: "otp-test@example.com" });
  assert.equal(immediateResend.response.status, 200);
  assert.equal(sentEmails.length, 1);

  const verified = await post("/api/auth/verify-login-otp", { email: "otp-test@example.com", code });
  assert.equal(verified.response.status, 200);
  assert.equal(verified.data.ok, true);
  assert.match(verified.response.headers.get("set-cookie") || "", /aps_session=.*HttpOnly/);
  assert.equal(scalar("SELECT COUNT(*) AS value FROM login_otp_challenges"), 0);

  const replay = await post("/api/auth/verify-login-otp", { email: "otp-test@example.com", code });
  assert.equal(replay.response.status, 400);
  const after = rawDatabase.prepare(
    "SELECT password_hash_v2,requires_password_reset,session_version FROM users WHERE uid=?",
  ).get("test-user") as Record<string, unknown>;
  assert.deepEqual(after, before);
});

test("keeps login OTP responses neutral, enforces resend cooldown, and locks after three failures", async () => {
  const unknown = await post("/api/auth/request-login-otp", { email: "nobody@example.com" });
  assert.equal(unknown.response.status, 200);
  assert.match(String(unknown.data.message), /active account/i);
  assert.equal(sentEmails.length, 0);

  await post("/api/auth/request-login-otp", { email: "otp-test@example.com" });
  assert.equal(sentEmails.length, 1);
  const firstCode = String(sentEmails[0].text).match(/code is (\d{6})/)?.[1];
  assert.ok(firstCode);
  const wrongCode = firstCode === "123456" ? "654321" : "123456";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const wrong = await post("/api/auth/verify-login-otp", { email: "otp-test@example.com", code: wrongCode });
    assert.equal(wrong.response.status, 400);
    assert.match(String(wrong.data.error), /invalid or expired/i);
    if (attempt < 3) assert.equal(
      scalar("SELECT failed_attempts AS value FROM login_otp_challenges WHERE uid=?", "test-user"),
      attempt,
    );
  }
  assert.equal(scalar("SELECT COUNT(*) AS value FROM login_otp_challenges"), 1);

  const resendLocked = await post("/api/auth/request-login-otp", { email: "otp-test@example.com" });
  assert.equal(resendLocked.response.status, 200);
  assert.equal(sentEmails.length, 1);
});