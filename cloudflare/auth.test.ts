import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { handleAuthRoute } from "./auth";
import { handleDomainRoute } from "./domain-routes";
import type { AuthEnv, AuthUser, SessionsKV } from "./backend-types";

type Row = Record<string, unknown>;
type TableName =
  | "users"
  | "signup_challenges"
  | "login_otp_challenges"
  | "password_reset_codes"
  | "password_reset_request_cooldowns"
  | "password_reset_tickets"
  | "password_reset_challenge_locks"
  | "teacher_applications";
type FakeState = {
  users: Map<string, Row>;
  signup_challenges: Map<string, Row>;
  login_otp_challenges: Map<string, Row>;
  password_reset_codes: Map<string, Row>;
  password_reset_request_cooldowns: Map<string, Row>;
  password_reset_tickets: Map<string, Row>;
  password_reset_challenge_locks: Map<string, Row>;
  teacher_applications: Map<string, Row>;
  audit: Row[];
};

function cloneMap(source: Map<string, Row>): Map<string, Row> {
  return new Map([...source].map(([key, row]) => [key, { ...row }]));
}

function cloneState(source: FakeState): FakeState {
  return {
    users: cloneMap(source.users),
    signup_challenges: cloneMap(source.signup_challenges),
    login_otp_challenges: cloneMap(source.login_otp_challenges),
    password_reset_codes: cloneMap(source.password_reset_codes),
    password_reset_request_cooldowns: cloneMap(
      source.password_reset_request_cooldowns,
    ),
    password_reset_tickets: cloneMap(source.password_reset_tickets),
    password_reset_challenge_locks: cloneMap(
      source.password_reset_challenge_locks,
    ),
    teacher_applications: cloneMap(source.teacher_applications),
    audit: source.audit.map((row) => ({ ...row })),
  };
}

/**
 * Small, isolated implementation of the Neon query surface exercised here.
 * It stores only per-test in-memory rows; SQL strings are matched explicitly
 * so unexpected persistence paths fail instead of silently succeeding.
 */
class FakePgClient {
  state: FakeState = {
    users: new Map(),
    signup_challenges: new Map(),
    login_otp_challenges: new Map(),
    password_reset_codes: new Map(),
    password_reset_request_cooldowns: new Map(),
    password_reset_tickets: new Map(),
    password_reset_challenge_locks: new Map(),
    teacher_applications: new Map(),
    audit: [],
  };
  private transactionSnapshot: FakeState | null = null;

  async query<T = Row>(
    query: string,
    values: unknown[] = [],
  ): Promise<{ rows: T[] }> {
    const sql = query.replace(/\s+/g, " ").trim().toLowerCase();
    const [a, b, c, d, e, f, g, h, i, j, k, l] = values;
    const result = (rows: Row[] = []) => ({ rows: rows as T[] });
    const userByEmail = (email: unknown) =>
      [...this.state.users.values()].find(
        (user) =>
          String(user.email).toLowerCase() === String(email).toLowerCase(),
      );

    if (sql === "begin") {
      this.transactionSnapshot = cloneState(this.state);
      return result();
    }
    if (sql === "commit") {
      this.transactionSnapshot = null;
      return result();
    }
    if (sql === "rollback") {
      if (this.transactionSnapshot) this.state = this.transactionSnapshot;
      this.transactionSnapshot = null;
      return result();
    }
    if (sql.startsWith("select pg_advisory_xact_lock(")) return result();

    if (
      sql.startsWith(
        "select uid,email,display_name,role,school_id,institution_id,session_version,active,disabled from users where uid =",
      )
    ) {
      const user = this.state.users.get(String(a));
      return result(user ? [{ ...user }] : []);
    }
    if (
      sql.startsWith(
        "select uid,password_hash_v2,email_verified,requires_password_reset,active,disabled,role from users where lower(email)=",
      )
    ) {
      const user = userByEmail(a);
      return result(user ? [{ ...user }] : []);
    }
    if (sql.startsWith("select uid,email from users where lower(email)=")) {
      const user = userByEmail(a);
      return result(
        user && user.active === true && user.disabled === false
          ? [{ ...user }]
          : [],
      );
    }
    if (sql.startsWith("select uid from users where lower(email)=")) {
      const user = userByEmail(a);
      const activeOnly = sql.includes("active=true");
      return result(
        user &&
          (!activeOnly || (user.active === true && user.disabled === false))
          ? [{ uid: user.uid }]
          : [],
      );
    }
    if (sql.startsWith("delete from signup_challenges where expires_at_ms<=")) {
      for (const [key, row] of this.state.signup_challenges)
        if (Number(row.expires_at_ms) <= Number(a))
          this.state.signup_challenges.delete(key);
      return result();
    }
    if (sql.startsWith("insert into signup_challenges")) {
      const existing = this.state.signup_challenges.get(String(a));
      if (
        existing &&
        (Number(existing.requested_at_ms) > Number(k) ||
          Number(existing.locked_until_ms) > Number(l) ||
          existing.consumed_at_ms !== null)
      )
        return result();
      this.state.signup_challenges.set(String(a), {
        email: a,
        uid: b,
        display_name: c,
        account_type: d,
        organization_name: e,
        teaching_details: f,
        password_hash: g,
        code_hash: h,
        expires_at_ms: i,
        requested_at_ms: j,
        failed_attempts: 0,
        locked_until_ms: 0,
        consumed_at_ms: null,
      });
      return result([{ email: a }]);
    }
    if (
      sql.startsWith(
        "select uid,code_hash,expires_at_ms,failed_attempts,locked_until_ms from signup_challenges",
      )
    ) {
      const challenge = this.state.signup_challenges.get(String(a));
      return result(
        challenge && challenge.consumed_at_ms === null
          ? [{ ...challenge }]
          : [],
      );
    }
    if (
      sql.startsWith(
        "update signup_challenges set failed_attempts=failed_attempts+1",
      )
    ) {
      const challenge = this.state.signup_challenges.get(String(c));
      if (
        challenge &&
        challenge.consumed_at_ms === null &&
        Number(challenge.failed_attempts) < Number(d)
      ) {
        const attempts = Number(challenge.failed_attempts) + 1;
        challenge.failed_attempts = attempts;
        if (attempts >= Number(a)) challenge.locked_until_ms = b;
      }
      return result();
    }
    if (sql.startsWith("update signup_challenges set consumed_at_ms=")) {
      const challenge = this.state.signup_challenges.get(String(b));
      if (
        !challenge ||
        challenge.uid !== c ||
        challenge.code_hash !== d ||
        Number(challenge.expires_at_ms) <= Number(a) ||
        Number(challenge.locked_until_ms) > Number(a) ||
        challenge.consumed_at_ms !== null
      )
        return result();
      challenge.consumed_at_ms = a;
      return result([{ uid: challenge.uid }]);
    }
    if (
      sql.startsWith("insert into users") &&
      sql.includes("from signup_challenges")
    ) {
      const challenge = this.state.signup_challenges.get(String(c));
      if (
        !challenge ||
        challenge.uid !== d ||
        Number(challenge.consumed_at_ms) !== Number(e) ||
        userByEmail(f)
      )
        return result();
      const user: Row = {
        uid: challenge.uid,
        email: challenge.email,
        display_name: challenge.display_name,
        role: challenge.account_type === "student" ? "student" : "",
        disabled: false,
        email_verified: true,
        requires_password_reset: false,
        raw_json: "{}",
        created_at: a,
        imported_at: b,
        password_hash_v2: challenge.password_hash,
        password_salt_v2: null,
        hash_algorithm: "PBKDF2-SHA256",
        active: challenge.account_type === "student",
        session_version: 1,
        school_id: null,
        institution_id: null,
      };
      this.state.users.set(String(user.uid), user);
      return result([{ ...user }]);
    }
    if (sql.startsWith("insert into teacher_applications")) {
      const challenge = this.state.signup_challenges.get(String(c));
      if (
        !challenge ||
        challenge.uid !== d ||
        Number(challenge.consumed_at_ms) !== Number(e) ||
        challenge.account_type === "student" ||
        !this.state.users.has(String(challenge.uid))
      )
        return result();
      const application: Row = {
        id: a,
        uid: challenge.uid,
        application_type: challenge.account_type,
        organization_name: challenge.organization_name,
        teaching_details: challenge.teaching_details,
        status: "pending",
        submitted_at: b,
        reviewed_at: null,
        reviewed_by: null,
        review_note: null,
        review_claim: null,
      };
      this.state.teacher_applications.set(String(a), application);
      return result([{ id: a }]);
    }
    if (sql.startsWith("delete from signup_challenges where email=")) {
      const challenge = this.state.signup_challenges.get(String(a));
      if (
        challenge &&
        (b === undefined ||
          challenge.code_hash === b ||
          Number(challenge.consumed_at_ms) === Number(b))
      ) {
        this.state.signup_challenges.delete(String(a));
      }
      return result();
    }

    if (
      sql.startsWith("delete from login_otp_challenges where expires_at_ms<=")
    ) {
      for (const [key, row] of this.state.login_otp_challenges) {
        if (
          Number(row.expires_at_ms) <= Number(a) ||
          (Number(row.locked_until_ms) > 0 &&
            Number(row.locked_until_ms) <= Number(a))
        )
          this.state.login_otp_challenges.delete(key);
      }
      return result();
    }
    if (sql.startsWith("insert into login_otp_challenges")) {
      const existing = this.state.login_otp_challenges.get(String(a));
      if (
        existing &&
        (Number(existing.locked_until_ms) > Number(e) ||
          Number(existing.requested_at_ms) > Number(f) ||
          existing.consumed_at_ms !== null)
      )
        return result();
      this.state.login_otp_challenges.set(String(a), {
        uid: a,
        code_hash: b,
        expires_at_ms: c,
        requested_at_ms: d,
        failed_attempts: 0,
        locked_until_ms: 0,
        consumed_at_ms: null,
      });
      return result([{ uid: a }]);
    }
    if (
      sql.startsWith(
        "select code_hash,expires_at_ms,failed_attempts,locked_until_ms from login_otp_challenges",
      )
    ) {
      const challenge = this.state.login_otp_challenges.get(String(a));
      return result(
        challenge && challenge.consumed_at_ms === null
          ? [{ ...challenge }]
          : [],
      );
    }
    if (sql.startsWith("update login_otp_challenges set failed_attempts=")) {
      const challenge = this.state.login_otp_challenges.get(String(c));
      if (
        challenge &&
        challenge.consumed_at_ms === null &&
        Number(challenge.failed_attempts) < Number(d)
      ) {
        const attempts = Number(challenge.failed_attempts) + 1;
        challenge.failed_attempts = attempts;
        if (attempts >= Number(a)) challenge.locked_until_ms = b;
      }
      return result(
        challenge ? [{ failed_attempts: challenge.failed_attempts }] : [],
      );
    }
    if (sql.startsWith("update login_otp_challenges set consumed_at_ms=")) {
      const challenge = this.state.login_otp_challenges.get(String(b));
      if (
        !challenge ||
        challenge.code_hash !== c ||
        challenge.consumed_at_ms !== null ||
        Number(challenge.expires_at_ms) <= Number(a) ||
        Number(challenge.locked_until_ms) > Number(a)
      )
        return result();
      challenge.consumed_at_ms = a;
      return result([{ uid: b }]);
    }
    if (sql.startsWith("delete from login_otp_challenges where uid=")) {
      this.state.login_otp_challenges.delete(String(a));
      return result();
    }

    if (
      sql.startsWith("delete from password_reset_codes where expires_at_ms<=")
    ) {
      for (const [key, row] of this.state.password_reset_codes)
        if (Number(row.expires_at_ms) <= Number(a))
          this.state.password_reset_codes.delete(key);
      return result();
    }
    if (
      sql.startsWith("delete from password_reset_tickets where expires_at_ms<=")
    ) {
      for (const [key, row] of this.state.password_reset_tickets)
        if (Number(row.expires_at_ms) <= Number(a))
          this.state.password_reset_tickets.delete(key);
      return result();
    }
    if (
      sql.startsWith("delete from password_reset_challenge_locks where uid=")
    ) {
      const ticket = this.state.password_reset_tickets.get(String(b));
      if (ticket && ticket.uid === c && ticket.claim_id === null)
        this.state.password_reset_challenge_locks.delete(String(a));
      return result();
    }
    if (sql.startsWith("delete from password_reset_challenge_locks")) {
      for (const [key, row] of this.state.password_reset_challenge_locks) {
        if (
          (Number(row.locked_until_ms) > 0 &&
            Number(row.locked_until_ms) <= Number(a)) ||
          (Number(row.locked_until_ms) === 0 &&
            Number(row.window_started_at_ms) <= Number(b))
        ) {
          this.state.password_reset_challenge_locks.delete(key);
        }
      }
      return result();
    }
    if (sql.startsWith("delete from password_reset_request_cooldowns")) {
      for (const [key, row] of this.state.password_reset_request_cooldowns)
        if (Number(row.requested_at_ms) < Number(a))
          this.state.password_reset_request_cooldowns.delete(key);
      return result();
    }
    if (
      sql.startsWith(
        "select locked_until_ms from password_reset_challenge_locks",
      )
    ) {
      const lock = this.state.password_reset_challenge_locks.get(String(a));
      return result(
        lock && Number(lock.locked_until_ms) > Number(b)
          ? [{ locked_until_ms: lock.locked_until_ms }]
          : [],
      );
    }
    if (sql.startsWith("insert into password_reset_request_cooldowns")) {
      const existing = this.state.password_reset_request_cooldowns.get(
        String(a),
      );
      if (existing && Number(existing.requested_at_ms) > Number(c))
        return result();
      this.state.password_reset_request_cooldowns.set(String(a), {
        uid: a,
        requested_at_ms: b,
      });
      return result([{ uid: a }]);
    }
    if (
      sql.startsWith("delete from password_reset_codes where uid=") &&
      sql.includes("returning uid")
    ) {
      const code = this.state.password_reset_codes.get(String(a));
      if (!code || code.code_hash !== b || code.claim_id !== c) return result();
      this.state.password_reset_codes.delete(String(a));
      return result([{ uid: a }]);
    }
    if (sql.startsWith("delete from password_reset_codes where uid=")) {
      const code = this.state.password_reset_codes.get(String(a));
      if (
        code &&
        (b === undefined || code.code_hash === b) &&
        (c === undefined || code.claim_id === c || code.claim_id === null)
      ) {
        this.state.password_reset_codes.delete(String(a));
      }
      return result();
    }
    if (sql.startsWith("delete from password_reset_tickets where uid=")) {
      for (const [key, ticket] of this.state.password_reset_tickets)
        if (ticket.uid === a) this.state.password_reset_tickets.delete(key);
      return result();
    }
    if (sql.startsWith("insert into password_reset_codes")) {
      this.state.password_reset_codes.set(String(a), {
        uid: a,
        code_hash: b,
        expires_at_ms: c,
        created_at: d,
        claim_id: null,
      });
      return result();
    }
    if (sql.startsWith("select code_hash from password_reset_codes")) {
      const code = this.state.password_reset_codes.get(String(a));
      return result(
        code && Number(code.expires_at_ms) > Number(b) && code.claim_id === null
          ? [{ code_hash: code.code_hash }]
          : [],
      );
    }
    if (sql.startsWith("insert into password_reset_challenge_locks")) {
      const existing = this.state.password_reset_challenge_locks.get(String(a));
      const code = this.state.password_reset_codes.get(String(j));
      if (
        !code ||
        code.code_hash !== k ||
        Number(code.expires_at_ms) <= Number(l) ||
        code.claim_id !== null ||
        (existing && Number(existing.locked_until_ms) > Number(i))
      )
        return result();
      const expiredWindow =
        existing && Number(existing.window_started_at_ms) <= Number(d);
      const attempts =
        !existing || expiredWindow ? 1 : Number(existing.failed_attempts) + 1;
      const lock: Row = {
        uid: a,
        failed_attempts: attempts,
        window_started_at_ms:
          !existing || expiredWindow ? b : existing.window_started_at_ms,
        locked_until_ms:
          !existing || expiredWindow
            ? 0
            : attempts >= Number(g)
              ? h
              : existing.locked_until_ms,
        updated_at: c,
      };
      this.state.password_reset_challenge_locks.set(String(a), lock);
      return result([
        { failed_attempts: attempts, locked_until_ms: lock.locked_until_ms },
      ]);
    }
    if (sql.startsWith("update password_reset_codes set claim_id=")) {
      const code = this.state.password_reset_codes.get(String(b));
      if (
        !code ||
        code.code_hash !== c ||
        Number(code.expires_at_ms) <= Number(d) ||
        code.claim_id !== null
      )
        return result();
      code.claim_id = a;
      return result([{ uid: b }]);
    }
    if (sql.startsWith("insert into password_reset_tickets")) {
      const code = this.state.password_reset_codes.get(String(d));
      if (!code || code.code_hash !== e || code.claim_id !== f) return result();
      this.state.password_reset_tickets.set(String(a), {
        ticket_hash: a,
        uid: d,
        expires_at_ms: b,
        created_at: c,
        claim_id: null,
      });
      return result([{ ticket_hash: a }]);
    }
    if (sql.startsWith("select uid from password_reset_tickets")) {
      const ticket = this.state.password_reset_tickets.get(String(a));
      return result(
        ticket &&
          ticket.claim_id === null &&
          Number(ticket.expires_at_ms) > Number(b)
          ? [{ uid: ticket.uid }]
          : [],
      );
    }
    if (sql.startsWith("update password_reset_tickets set claim_id=")) {
      const ticket = this.state.password_reset_tickets.get(String(b));
      if (
        ticket &&
        ticket.uid === c &&
        ticket.claim_id === null &&
        Number(ticket.expires_at_ms) > Number(d)
      ) {
        ticket.claim_id = a;
        return result([{ uid: c }]);
      }
      return result();
    }
    if (sql.startsWith("update users set password_hash_v2=")) {
      const user = this.state.users.get(String(b));
      const ticket = this.state.password_reset_tickets.get(String(c));
      if (
        !user ||
        user.active !== true ||
        user.disabled !== false ||
        !ticket ||
        ticket.claim_id !== d
      )
        return result();
      Object.assign(user, {
        password_hash_v2: a,
        password_salt_v2: null,
        hash_algorithm: "PBKDF2-SHA256",
        requires_password_reset: false,
        session_version: Number(user.session_version ?? 1) + 1,
      });
      return result([{ uid: user.uid }]);
    }
    if (sql.startsWith("update users set role=")) {
      const user = this.state.users.get(String(d));
      const application = this.state.teacher_applications.get(String(e));
      if (
        !user ||
        user.disabled !== false ||
        !application ||
        application.uid !== f ||
        application.status !== "approved" ||
        application.review_claim !== g
      )
        return result();
      Object.assign(user, {
        role: a,
        school_id: b,
        institution_id: c,
        active: true,
        session_version: Number(user.session_version ?? 1) + 1,
      });
      return result([{ uid: user.uid }]);
    }
    if (sql.startsWith("delete from password_reset_codes where uid=")) {
      this.state.password_reset_codes.delete(String(a));
      return result();
    }
    if (sql.startsWith("delete from password_reset_tickets where uid=")) {
      for (const [key, ticket] of this.state.password_reset_tickets)
        if (ticket.uid === a) this.state.password_reset_tickets.delete(key);
      return result();
    }

    if (
      sql.startsWith(
        "select uid,application_type,status from teacher_applications",
      )
    ) {
      const application = this.state.teacher_applications.get(String(a));
      return result(
        application
          ? [
              {
                uid: application.uid,
                application_type: application.application_type,
                status: application.status,
              },
            ]
          : [],
      );
    }
    if (sql.startsWith("update teacher_applications")) {
      const application = this.state.teacher_applications.get(String(e));
      const user = application && this.state.users.get(String(application.uid));
      if (
        !application ||
        application.status !== "pending" ||
        (sql.includes("exists (select 1 from users") &&
          user?.disabled !== false)
      )
        return result();
      Object.assign(application, {
        status: "approved",
        reviewed_at: a,
        reviewed_by: b,
        review_note: c,
        review_claim: d,
      });
      return result([{ uid: application.uid }]);
    }
    if (sql.startsWith("insert into audit")) {
      this.state.audit.push({
        id: a,
        institution_id: b,
        school_id: c,
        actor_id: d,
        action: e,
        resource_type: f,
        resource_id: g,
        metadata_json: h,
        created_at: i,
      });
      return result();
    }

    throw new Error(`FakePgClient does not implement SQL: ${query}`);
  }

  row(table: TableName, key: string): Row | undefined {
    const row = this.state[table].get(key);
    return row ? { ...row } : undefined;
  }

  count(
    table: TableName,
    predicate: (row: Row) => boolean = () => true,
  ): number {
    return [...this.state[table].values()].filter(predicate).length;
  }

  update(table: TableName, key: string, patch: Row): void {
    const row = this.state[table].get(key);
    if (!row) throw new Error(`No ${table} row found for ${key}`);
    Object.assign(row, patch);
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

let pg: FakePgClient;
let env: AuthEnv;
let originalFetch: typeof fetch;
let sentEmails: Array<Record<string, unknown>>;

function userByEmail(email: string): Row | undefined {
  return [...pg.state.users.values()].find(
    (user) => String(user.email).toLowerCase() === email.toLowerCase(),
  );
}

async function post(
  path: string,
  body: Record<string, unknown>,
): Promise<{ response: Response; data: Record<string, unknown> }> {
  const response = await handleAuthRoute(
    new Request(`https://worker.test${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.15",
      },
      body: JSON.stringify(body),
    }),
    env,
  );
  assert.ok(response, `Expected an auth handler for ${path}`);
  return { response, data: (await response.json()) as Record<string, unknown> };
}

beforeEach(() => {
  pg = new FakePgClient();
  pg.state.users.set("test-user", {
    uid: "test-user",
    email: "otp-test@example.com",
    display_name: "OTP Test",
    role: "student",
    email_verified: true,
    school_id: null,
    institution_id: null,
    session_version: 1,
    active: true,
    disabled: false,
    requires_password_reset: true,
    password_hash_v2: null,
    password_salt_v2: null,
    hash_algorithm: "SCRYPT",
  });
  env = {
    PG: pg as unknown as AuthEnv["PG"],
    SESSIONS: new LocalSessions(),
    PUBLIC_SITE_URL: "https://appshule.com",
    RESEND_API_KEY: "test-resend-key",
    RESEND_FROM_EMAIL: "noreply@appshule.com",
  } as AuthEnv;
  sentEmails = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sentEmails.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(
      JSON.stringify({ id: `test-email-${sentEmails.length}` }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("request, verify, and complete a single-use password reset", async () => {
  const startedAt = Date.now();
  const request = await post("/api/auth/request-password-reset", {
    email: "OTP-Test@example.com",
  });
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

  const storedCode = pg.row("password_reset_codes", "test-user") as
    { code_hash: string; expires_at_ms: number } | undefined;
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
  assert.equal(
    pg.count("password_reset_codes", (row) => row.uid === "test-user"),
    1,
  );

  const verified = await post("/api/auth/verify-password-reset-code", {
    email: "otp-test@example.com",
    code,
  });
  assert.equal(verified.response.status, 200);
  assert.equal(verified.data.ok, true);
  const resetTicket = String(verified.data.resetTicket);
  assert.ok(resetTicket.length >= 40);
  assert.equal(
    pg.count(
      "password_reset_challenge_locks",
      (row) => row.uid === "test-user",
    ),
    0,
  );
  assert.equal(
    pg.count("password_reset_codes", (row) => row.uid === "test-user"),
    0,
  );
  assert.equal(
    pg.count("password_reset_tickets", (row) => row.uid === "test-user"),
    1,
  );
  assert.equal(
    pg.count(
      "password_reset_tickets",
      (row) => row.ticket_hash === resetTicket,
    ),
    0,
    "only the ticket hash is stored",
  );

  const replayCode = await post("/api/auth/verify-password-reset-code", {
    email: "otp-test@example.com",
    code,
  });
  assert.equal(replayCode.response.status, 400);

  const newPassword = "A-long-test-password-2026";
  const completed = await post("/api/auth/complete-password-reset", {
    ticket: resetTicket,
    password: newPassword,
  });
  assert.equal(completed.response.status, 200);
  assert.equal(completed.data.ok, true);
  assert.equal(
    pg.count("password_reset_tickets", (row) => row.uid === "test-user"),
    0,
  );

  const replayTicket = await post("/api/auth/complete-password-reset", {
    ticket: resetTicket,
    password: newPassword,
  });
  assert.equal(replayTicket.response.status, 400);

  const login = await post("/api/auth/login", {
    email: "otp-test@example.com",
    password: newPassword,
  });
  assert.equal(login.response.status, 200);
  assert.equal(login.data.ok, true);
  assert.match(
    login.response.headers.get("set-cookie") || "",
    /aps_session=.*HttpOnly/,
  );
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
  const challenge = pg.row("signup_challenges", "new-student@example.com") as {
    password_hash: string;
    code_hash: string;
    expires_at_ms: number;
  };
  assert.match(challenge.password_hash, /^pbkdf2-sha256\$100000\$/);
  assert.match(challenge.code_hash, /^pbkdf2-sha256\$100000\$/);
  assert.notEqual(challenge.code_hash, code);
  assert.ok(challenge.expires_at_ms >= startedAt + 5 * 60 * 1000 - 2_000);
  assert.ok(challenge.expires_at_ms <= startedAt + 5 * 60 * 1000 + 2_000);
  assert.equal(
    pg.count(
      "users",
      (row) => String(row.email).toLowerCase() === "new-student@example.com",
    ),
    0,
  );
  await post("/api/auth/request-signup-verification", {
    email: "new-student@example.com",
    displayName: "New Student",
    password,
    accountType: "student",
  });
  assert.equal(
    sentEmails.length,
    1,
    "signup verification requests respect the resend cooldown",
  );

  const verified = await post("/api/auth/verify-signup", {
    email: "new-student@example.com",
    code,
  });
  assert.equal(verified.response.status, 200);
  assert.equal(verified.data.ok, true);
  assert.equal((verified.data.user as Record<string, unknown>).role, "student");
  assert.match(
    verified.response.headers.get("set-cookie") || "",
    /aps_session=.*HttpOnly/,
  );
  assert.equal(userByEmail("new-student@example.com")?.email_verified, true);
  assert.equal(userByEmail("new-student@example.com")?.active, true);
  assert.equal(pg.count("teacher_applications"), 0);
  const replay = await post("/api/auth/verify-signup", {
    email: "new-student@example.com",
    code,
  });
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
  const wrongAttempt = await post("/api/auth/verify-signup", {
    email: "teacher-applicant@example.com",
    code: wrongCode,
  });
  assert.equal(wrongAttempt.response.status, 400);
  assert.equal(
    pg.row("signup_challenges", "teacher-applicant@example.com")
      ?.failed_attempts,
    1,
  );
  const verified = await post("/api/auth/verify-signup", {
    email: "teacher-applicant@example.com",
    code,
  });
  assert.equal(verified.response.status, 200);
  assert.equal(verified.data.pendingReview, true);
  assert.equal(verified.response.headers.get("set-cookie"), null);
  assert.equal(userByEmail("teacher-applicant@example.com")?.active, false);
  assert.equal(userByEmail("teacher-applicant@example.com")?.role, "");

  const applicant = userByEmail("teacher-applicant@example.com");
  assert.ok(applicant);
  const application = [...pg.state.teacher_applications.values()].find(
    (row) => row.uid === applicant.uid,
  ) as Row;
  const superadmin: AuthUser = {
    uid: "test-superadmin",
    email: "admin@example.com",
    displayName: "Test Admin",
    role: "superadmin",
    schoolId: null,
    institutionId: null,
    sessionVersion: 1,
  };
  const callAdmin = async (
    path: string,
    body?: Record<string, unknown>,
    actor: AuthUser = superadmin,
  ) => {
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
    return {
      response,
      data: (await response.json()) as Record<string, unknown>,
    };
  };
  const forbidden = await callAdmin(
    "/api/admin/teacher-applications",
    undefined,
    {
      ...superadmin,
      role: "student",
    },
  );
  assert.equal(forbidden.response.status, 403);
  const missingScope = await callAdmin(
    `/api/admin/teacher-applications/${application.id}/review`,
    { decision: "approve" },
  );
  assert.equal(missingScope.response.status, 400);
  const approved = await callAdmin(
    `/api/admin/teacher-applications/${application.id}/review`,
    {
      decision: "approve",
      schoolId: "school-kampala",
    },
  );
  assert.equal(approved.response.status, 200);
  assert.equal(userByEmail("teacher-applicant@example.com")?.active, true);
  assert.equal(
    userByEmail("teacher-applicant@example.com")?.role,
    "teacher_staff",
  );
  assert.equal(
    userByEmail("teacher-applicant@example.com")?.school_id,
    "school-kampala",
  );
  const login = await post("/api/auth/login", {
    email: "teacher-applicant@example.com",
    password,
  });
  assert.equal(login.response.status, 200);
  assert.equal(
    (login.data.user as Record<string, unknown>).role,
    "teacher_staff",
  );
  assert.equal(
    pg.state.audit.filter(
      (row) => row.action === "admin.teacher_application.approve",
    ).length,
    1,
  );
  let genericLoginError: unknown = null;
  for (const [column, deniedValue, restoredValue] of [
    ["email_verified", 0, 1],
    ["active", 0, 1],
    ["disabled", 1, 0],
    ["requires_password_reset", 1, 0],
  ] as const) {
    const targetUser = userByEmail("teacher-applicant@example.com");
    assert.ok(targetUser);
    pg.update("users", String(targetUser.uid), {
      [column]: Boolean(deniedValue),
    });
    const denied = await post("/api/auth/login", {
      email: "teacher-applicant@example.com",
      password,
    });
    assert.equal(
      denied.response.status,
      401,
      `${column} accounts cannot use password login`,
    );
    if (genericLoginError === null) genericLoginError = denied.data.error;
    else assert.equal(denied.data.error, genericLoginError);
    pg.update("users", String(targetUser.uid), {
      [column]: Boolean(restoredValue),
    });
  }
  assert.equal(typeof genericLoginError, "string");
});

test("enforces the 60-second resend cooldown and allows resend afterward", async () => {
  await post("/api/auth/request-password-reset", {
    email: "otp-test@example.com",
  });
  assert.equal(sentEmails.length, 1);

  const immediateResend = await post("/api/auth/request-password-reset", {
    email: "otp-test@example.com",
  });
  assert.equal(immediateResend.response.status, 200);
  assert.equal(sentEmails.length, 1);

  pg.update("password_reset_request_cooldowns", "test-user", {
    requested_at_ms: Date.now() - 60_001,
  });
  await post("/api/auth/request-password-reset", {
    email: "otp-test@example.com",
  });
  assert.equal(sentEmails.length, 2);
});

test("locks a reset challenge after three wrong codes and blocks resend", async () => {
  await post("/api/auth/request-password-reset", {
    email: "otp-test@example.com",
  });
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
      Number(
        pg.row("password_reset_challenge_locks", "test-user")?.failed_attempts,
      ),
      attempt,
    );
  }

  pg.update("password_reset_request_cooldowns", "test-user", {
    requested_at_ms: Date.now() - 60_001,
  });
  const resendWithTwoFailures = await post("/api/auth/request-password-reset", {
    email: "otp-test@example.com",
  });
  assert.equal(resendWithTwoFailures.response.status, 200);
  assert.equal(sentEmails.length, 2);
  const replacementCode = String(sentEmails[1].text).match(
    /code is (\d{6})/,
  )?.[1];
  assert.ok(replacementCode);
  const replacementWrongCode =
    replacementCode === "123456" ? "654321" : "123456";
  const thirdWrong = await post("/api/auth/verify-password-reset-code", {
    email: "otp-test@example.com",
    code: replacementWrongCode,
  });
  assert.equal(thirdWrong.response.status, 400);

  assert.equal(
    pg.count("password_reset_codes", (row) => row.uid === "test-user"),
    0,
  );
  assert.equal(
    pg.count(
      "password_reset_challenge_locks",
      (row) => row.uid === "test-user",
    ),
    1,
  );
  assert.equal(
    pg.row("password_reset_challenge_locks", "test-user")?.failed_attempts,
    3,
  );

  pg.update("password_reset_request_cooldowns", "test-user", {
    requested_at_ms: Date.now() - 60_001,
  });
  const resend = await post("/api/auth/request-password-reset", {
    email: "otp-test@example.com",
  });
  assert.equal(resend.response.status, 200);
  assert.equal(resend.data.ok, true);
  assert.equal(
    sentEmails.length,
    2,
    "challenge lock prevents bypassing the resend cooldown",
  );
});

test("counts concurrent wrong reset codes atomically", async () => {
  await post("/api/auth/request-password-reset", {
    email: "otp-test@example.com",
  });
  const code = String(sentEmails[0].text).match(/code is (\d{6})/)?.[1];
  assert.ok(code);
  const wrongCode = code === "123456" ? "654321" : "123456";

  const attempts = await Promise.all(
    Array.from({ length: 4 }, () =>
      post("/api/auth/verify-password-reset-code", {
        email: "otp-test@example.com",
        code: wrongCode,
      }),
    ),
  );
  for (const attempt of attempts) assert.equal(attempt.response.status, 400);

  assert.equal(
    Number(
      pg.row("password_reset_challenge_locks", "test-user")?.failed_attempts,
    ),
    3,
  );
  assert.ok(
    Number(
      pg.row("password_reset_challenge_locks", "test-user")?.locked_until_ms,
    ) > Date.now(),
  );
  assert.equal(
    pg.count("password_reset_codes", (row) => row.uid === "test-user"),
    0,
  );
});

test("allows a new reset challenge after the lock expires", async () => {
  await post("/api/auth/request-password-reset", {
    email: "otp-test@example.com",
  });
  const code = String(sentEmails[0].text).match(/code is (\d{6})/)?.[1];
  assert.ok(code);
  const wrongCode = code === "123456" ? "654321" : "123456";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await post("/api/auth/verify-password-reset-code", {
      email: "otp-test@example.com",
      code: wrongCode,
    });
  }

  pg.update("password_reset_challenge_locks", "test-user", {
    locked_until_ms: Date.now() - 1,
  });
  pg.update("password_reset_request_cooldowns", "test-user", {
    requested_at_ms: Date.now() - 60_001,
  });
  const afterExpiry = await post("/api/auth/request-password-reset", {
    email: "otp-test@example.com",
  });
  assert.equal(afterExpiry.response.status, 200);
  assert.equal(afterExpiry.data.ok, true);
  assert.equal(sentEmails.length, 2);
  assert.equal(
    pg.count(
      "password_reset_challenge_locks",
      (row) => row.uid === "test-user",
    ),
    0,
  );
  const replacementCode = String(sentEmails[1].text).match(
    /code is (\d{6})/,
  )?.[1];
  assert.ok(replacementCode);
  const verified = await post("/api/auth/verify-password-reset-code", {
    email: "otp-test@example.com",
    code: replacementCode,
  });
  assert.equal(verified.response.status, 200);
  assert.equal(verified.data.ok, true);
});

test("rejects expired codes and does not disclose unknown accounts", async () => {
  await post("/api/auth/request-password-reset", {
    email: "otp-test@example.com",
  });
  const email = sentEmails[0];
  const code = String(email.text).match(/code is (\d{6})/)?.[1];
  assert.ok(code);
  pg.update("password_reset_codes", "test-user", { expires_at_ms: 0 });

  const expired = await post("/api/auth/verify-password-reset-code", {
    email: "otp-test@example.com",
    code,
  });
  assert.equal(expired.response.status, 400);
  assert.equal(pg.count("password_reset_tickets"), 0);

  const unknown = await post("/api/auth/request-password-reset", {
    email: "nobody@example.com",
  });
  assert.equal(unknown.response.status, 200);
  assert.equal(unknown.data.ok, true);
  assert.equal(sentEmails.length, 1);
});

test("requests and verifies a one-use login OTP without changing credentials", async () => {
  const before = pg.row("users", "test-user");
  const requested = await post("/api/auth/request-login-otp", {
    email: "OTP-Test@example.com",
  });
  assert.equal(requested.response.status, 200);
  assert.equal(requested.data.ok, true);
  assert.equal(sentEmails.length, 1);
  const email = sentEmails[0];
  const code = String(email.text).match(/code is (\d{6})/)?.[1];
  assert.ok(code);
  assert.match(String(email.text), /expires in 10 minutes/i);
  const stored = pg.row("login_otp_challenges", "test-user") as {
    code_hash: string;
    expires_at_ms: number;
    failed_attempts: number;
  };
  assert.notEqual(stored.code_hash, code);
  assert.equal(stored.failed_attempts, 0);
  assert.ok(stored.expires_at_ms > Date.now());
  const immediateResend = await post("/api/auth/request-login-otp", {
    email: "otp-test@example.com",
  });
  assert.equal(immediateResend.response.status, 200);
  assert.equal(sentEmails.length, 1);

  const verified = await post("/api/auth/verify-login-otp", {
    email: "otp-test@example.com",
    code,
  });
  assert.equal(verified.response.status, 200);
  assert.equal(verified.data.ok, true);
  assert.match(
    verified.response.headers.get("set-cookie") || "",
    /aps_session=.*HttpOnly/,
  );
  assert.equal(pg.count("login_otp_challenges"), 0);

  const replay = await post("/api/auth/verify-login-otp", {
    email: "otp-test@example.com",
    code,
  });
  assert.equal(replay.response.status, 400);
  const after = pg.row("users", "test-user");
  assert.deepEqual(after, before);
});

test("keeps login OTP responses neutral, enforces resend cooldown, and locks after three failures", async () => {
  const unknown = await post("/api/auth/request-login-otp", {
    email: "nobody@example.com",
  });
  assert.equal(unknown.response.status, 200);
  assert.match(String(unknown.data.message), /active account/i);
  assert.equal(sentEmails.length, 0);

  await post("/api/auth/request-login-otp", { email: "otp-test@example.com" });
  assert.equal(sentEmails.length, 1);
  const firstCode = String(sentEmails[0].text).match(/code is (\d{6})/)?.[1];
  assert.ok(firstCode);
  const wrongCode = firstCode === "123456" ? "654321" : "123456";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const wrong = await post("/api/auth/verify-login-otp", {
      email: "otp-test@example.com",
      code: wrongCode,
    });
    assert.equal(wrong.response.status, 400);
    assert.match(String(wrong.data.error), /invalid or expired/i);
    if (attempt < 3)
      assert.equal(
        Number(pg.row("login_otp_challenges", "test-user")?.failed_attempts),
        attempt,
      );
  }
  assert.equal(pg.count("login_otp_challenges"), 1);

  const resendLocked = await post("/api/auth/request-login-otp", {
    email: "otp-test@example.com",
  });
  assert.equal(resendLocked.response.status, 200);
  assert.equal(sentEmails.length, 1);
});
