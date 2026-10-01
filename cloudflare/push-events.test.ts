import assert from "node:assert/strict";
import test from "node:test";
import { handlePushRoute, type PushRouteEnv } from "./push-events";

class FakeStatement {
  private values: unknown[] = [];

  constructor(private readonly database: FakeDatabase, private readonly sql: string) {}

  bind(...values: unknown[]): this {
    this.values = values;
    return this;
  }

  async all<T>(): Promise<{ results: T[] }> {
    this.database.queries.push({ sql: this.sql, values: this.values });
    if (this.sql.includes("FROM push_subscriptions")) {
      return { results: this.database.subscriptions as T[] };
    }
    if (this.sql.includes("FROM push_events")) {
      return {
        results: [{
          id: 7,
          type: "success",
          message: "Push succeeded",
          created_at: "2026-09-28T10:00:00.000Z",
        } as T],
      };
    }
    return { results: [] };
  }

  async run(): Promise<unknown> {
    this.database.queries.push({ sql: this.sql, values: this.values });
    return { meta: { last_row_id: 12 } };
  }
}

class FakeDatabase {
  queries: Array<{ sql: string; values: unknown[] }> = [];
  subscriptions: Record<string, unknown>[] = [];

  async query<T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<{ rows: T[] }> {
    this.queries.push({ sql: sql.replaceAll("public.", ""), values });
    if (sql.includes("SELECT id,type,message,created_at FROM public.push_events")) {
      return {
        rows: [{
          id: 7,
          type: "success",
          message: "Push succeeded",
          created_at: "2026-09-28T10:00:00.000Z",
        } as unknown as T],
      };
    }
    if (sql.includes("FROM public.push_subscriptions")) {
      return { rows: this.subscriptions as T[] };
    }
    if (sql.startsWith("INSERT INTO public.push_events")) {
      return { rows: [{ id: 12 } as unknown as T] };
    }
    if (sql.includes("SELECT id FROM public.push_events")) {
      return { rows: [] };
    }
    return { rows: [] };
  }

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }
}

function environment(pushSecret?: string): PushRouteEnv {
  const database = new FakeDatabase();
  return {
    DB: database as unknown as PushRouteEnv["DB"],
    PG: { query: database.query.bind(database) } as unknown as NonNullable<PushRouteEnv["PG"]>,
    PUBLIC_SITE_URL: "https://appshule.com",
    PUSH_SECRET: pushSecret,
    SESSIONS: { get: async () => null, put: async () => {}, delete: async () => {} },
  };
}

function request(path: string, init: RequestInit = {}) {
  return new Request(`https://appshule.com${path}`, init);
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

test("rejects missing or incorrect PUSH_SECRET with 401 before touching D1", async () => {
  const secret = "s".repeat(40);
  for (const [configured, supplied] of [
    [secret, ""],
    [secret, "Bearer wrong"],
    ["", `Bearer ${secret}`],
  ]) {
    const env = environment(configured || undefined);
    const headers = supplied ? { authorization: supplied } : {};
    const response = await handlePushRoute(request("/api/push-events", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ type: "success", message: "release complete" }),
    }), env);
    assert.equal(response?.status, 401);
    assert.equal((env.DB as unknown as FakeDatabase).queries.length, 0);
  }
});

test("records an authorized status event and returns its event ID", async () => {
  const secret = "s".repeat(40);
  const env = environment(secret);
  const response = await handlePushRoute(request("/api/push-events", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ type: "success", message: "release complete" }),
  }), env);

  assert.equal(response?.status, 200);
  const result = await response?.json() as { ok: boolean; eventId: number; webPush: { sent: number; failed: number } };
  assert.equal(result.ok, true);
  assert.equal(result.eventId, 12);
  assert.deepEqual(result.webPush, { sent: 0, failed: 0 });
  assert.equal((env.DB as unknown as FakeDatabase).queries.some((query) => query.sql.startsWith("INSERT INTO push_events")), true);
});

test("delivers D1 subscriptions through mocked Web Push without a network call", async () => {
  const secret = "p".repeat(40);
  const env = environment(secret);
  const database = env.DB as unknown as FakeDatabase;
  const subscriber = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const p256dh = base64Url(new Uint8Array(await crypto.subtle.exportKey("raw", subscriber.publicKey)));
  const auth = base64Url(crypto.getRandomValues(new Uint8Array(16)));
  const signer = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const publicKey = base64Url(new Uint8Array(await crypto.subtle.exportKey("raw", signer.publicKey)));
  const privateJwk = await crypto.subtle.exportKey("jwk", signer.privateKey);
  database.subscriptions = [{
    endpoint: "https://fcm.googleapis.com/send/mock",
    user_id: "student-1",
    p256dh,
    auth,
    created_at: "2026-09-28T10:00:00.000Z",
    updated_at: "2026-09-28T10:00:00.000Z",
  }];
  env.VAPID_PUBLIC_KEY = publicKey;
  env.VAPID_PRIVATE_KEY = privateJwk.d;
  env.VAPID_SUBJECT = "mailto:test@example.test";

  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(null, { status: 201 });
  };
  try {
    const response = await handlePushRoute(request("/api/push-events", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "success", message: "release complete" }),
    }), env);
    const result = await response?.json() as { webPush: { sent: number; failed: number } };
    assert.equal(response?.status, 200);
    assert.deepEqual(result.webPush, { sent: 1, failed: 0 });
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("returns newest-first history and rejects malformed poll cursors", async () => {
  const env = environment();
  const history = await handlePushRoute(request("/api/push-events/history"), env);
  assert.deepEqual(await history?.json(), [{
    id: 7,
    type: "success",
    message: "Push succeeded",
    timestamp: "2026-09-28T10:00:00.000Z",
  }]);

  const invalid = await handlePushRoute(request("/api/push-events?afterId=abc"), env);
  assert.equal(invalid?.status, 400);
});

test("targeted notifications require an authenticated Cloudflare session", async () => {
  const env = environment();
  const response = await handlePushRoute(request("/api/push-notifications", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetUserId: "student-1", title: "New alert" }),
  }), env);
  assert.equal(response?.status, 401);
  assert.equal((env.DB as unknown as FakeDatabase).queries.length, 0);
});