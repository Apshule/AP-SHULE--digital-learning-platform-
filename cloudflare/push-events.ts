import { authenticate } from "./auth";
import type { AuthEnv, AuthUser } from "./backend-types";
import { inNeonTransaction } from "./neon-db";
import { sendWebPush, validateWebPushEndpoint, type WebPushSubscription } from "./web-push";

export interface PushRouteEnv extends AuthEnv {
  PUSH_SECRET?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

interface PushEventRow {
  id: number | string;
  type: "success" | "error";
  message: string;
  created_at: string | Date;
}

interface PushSubscriptionRow {
  endpoint: string;
  user_id: string;
  p256dh: string;
  auth: string;
  created_at: string;
  updated_at: string;
}

const HISTORY_LIMIT = 50;
const MAX_EVENTS_KEPT = 500;
const MAX_SUBSCRIPTIONS_PER_USER = 10;
const DEFAULT_VAPID_SUBJECT = "https://appshule.com";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function sanitizeText(value: unknown, limit: number): string {
  return String(value ?? "")
    .replace(/(https?:\/\/)([^/\s:@]+):([^@\s/]+)@/gi, "$1[redacted]:[redacted]@")
    .replace(/\b(?:ghp|github_pat|gho|ghu|ghs|ghr)_[A-Za-z0-9_]+\b/g, "[redacted-github-token]")
    .replace(/(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const actualBytes = new TextEncoder().encode(actual);
  const expectedBytes = new TextEncoder().encode(expected);
  let difference = actualBytes.length ^ expectedBytes.length;
  const length = Math.max(actualBytes.length, expectedBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (actualBytes[index] ?? 0) ^ (expectedBytes[index] ?? 0);
  }
  return difference === 0;
}

function providedPushSecret(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  if (/^Bearer\s+/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, "").trim();
  return request.headers.get("x-push-secret") ?? "";
}

function secretIsValid(request: Request, env: PushRouteEnv): boolean {
  const expected = env.PUSH_SECRET ?? "";
  const provided = providedPushSecret(request);
  // Reject absent or unusably short configured secrets as unauthorized too.
  return expected.length >= 32 && provided.length > 0 && constantTimeEqual(provided, expected);
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.text();
    if (text.length > 16_384) return null;
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function eventResponse(row: PushEventRow) {
  return {
    id: Number(row.id),
    type: row.type,
    message: row.message,
    timestamp: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

function normalizedRole(role: string): string {
  return role.toLowerCase().replace(/[\s-]+/g, "_");
}

function isSuperAdmin(role: string): boolean {
  return ["superadmin", "super_admin"].includes(normalizedRole(role));
}

function vapidKeys(env: PushRouteEnv) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  return {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT || DEFAULT_VAPID_SUBJECT,
  };
}

async function sendToSubscriptions(
  env: PushRouteEnv,
  pg: NonNullable<PushRouteEnv["PG"]>,
  rows: PushSubscriptionRow[],
  payload: Record<string, unknown>,
): Promise<{ sent: number; failed: number }> {
  if (rows.length === 0) return { sent: 0, failed: 0 };
  const vapid = vapidKeys(env);
  if (!vapid) return { sent: 0, failed: rows.length };

  let sent = 0;
  let failed = 0;
  const stale: string[] = [];
  await Promise.all(rows.map(async (row) => {
    try {
      const subscription: WebPushSubscription = {
        endpoint: row.endpoint,
        keys: { p256dh: row.p256dh, auth: row.auth },
      };
      const result = await sendWebPush(subscription, JSON.stringify(payload), vapid);
      if (result.ok) sent += 1;
      else failed += 1;
      if (result.stale) stale.push(row.endpoint);
    } catch {
      failed += 1;
    }
  }));

  await Promise.all(stale.map((endpoint) =>
    pg.query("DELETE FROM public.push_subscriptions WHERE endpoint = $1", [endpoint]),
  ));
  return { sent, failed };
}

async function handleEventRoute(request: Request, env: PushRouteEnv, path: string): Promise<Response> {
  if (request.method === "GET" && path === "/api/push-events/history") {
    const pg = env.PG;
    if (!pg) return json({ ok: false, error: "PostgreSQL is unavailable" }, 503);
    const result = await pg.query<PushEventRow>(
      "SELECT id,type,message,created_at FROM public.push_events ORDER BY id DESC LIMIT $1",
      [HISTORY_LIMIT],
    );
    return json(result.rows.map(eventResponse));
  }

  if (request.method === "GET" && path === "/api/push-events") {
    const rawAfter = new URL(request.url).searchParams.get("afterId");
    if (rawAfter === null) {
      const pg = env.PG;
      if (!pg) return json({ ok: false, error: "PostgreSQL is unavailable" }, 503);
      const latest = await pg.query<{ id: number | string }>(
        "SELECT id FROM public.push_events ORDER BY id DESC LIMIT 1",
      );
      return json({ ok: true, events: [], latestId: Number(latest.rows[0]?.id ?? 0) });
    }
    if (!/^\d+$/.test(rawAfter)) return json({ ok: false, error: "afterId must be a non-negative integer" }, 400);
    const pg = env.PG;
    if (!pg) return json({ ok: false, error: "PostgreSQL is unavailable" }, 503);
    const result = await pg.query<PushEventRow>(
      "SELECT id,type,message,created_at FROM public.push_events WHERE id > $1 ORDER BY id ASC LIMIT $2",
      [Number(rawAfter), HISTORY_LIMIT],
    );
    const events = result.rows.map(eventResponse);
    return json({ ok: true, events, latestId: events.length ? events[events.length - 1].id : Number(rawAfter) });
  }

  if (request.method === "DELETE" && path === "/api/push-events/history") {
    const authentication = await authenticate(request, env);
    if (!authentication.authenticated) {
      return json({ ok: false, error: "Authentication is required" }, authentication.status);
    }
    if (!isSuperAdmin(authentication.user.role)) {
      return json({ ok: false, error: "Superadmin access required" }, 403);
    }
    const pg = env.PG;
    if (!pg) return json({ ok: false, error: "PostgreSQL is unavailable" }, 503);
    await pg.query("DELETE FROM public.push_events");
    return json({ ok: true });
  }

  if (request.method === "POST" && path === "/api/push-events") {
    // This endpoint is a server-to-server producer only. Never accept a browser
    // session as a substitute for PUSH_SECRET.
    if (!secretIsValid(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);

    const input = await readBody(request);
    if (!input) return json({ ok: false, error: "A valid JSON object is required" }, 400);
    const type = input.type;
    const message = sanitizeText(input.message, 1000);
    if (type !== "success" && type !== "error") {
      return json({ ok: false, error: "type must be 'success' or 'error'" }, 400);
    }
    if (!message) return json({ ok: false, error: "type and message are required" }, 400);
    const pg = env.PG;
    if (!pg) return json({ ok: false, error: "PostgreSQL is unavailable" }, 503);

    const timestamp = new Date().toISOString();
    const inserted = await pg.query<{ id: number | string }>(
      "INSERT INTO public.push_events (type,message,created_at) VALUES ($1,$2,$3) RETURNING id",
      [type, message, timestamp],
    );
    const eventId = inserted.rows[0] ? Number(inserted.rows[0].id) : null;
    if (eventId === null || !Number.isSafeInteger(eventId)) {
      return json({ ok: false, error: "The push event could not be stored" }, 503);
    }
    await pg.query(
      "DELETE FROM public.push_events WHERE id NOT IN (SELECT id FROM public.push_events ORDER BY id DESC LIMIT $1)",
      [MAX_EVENTS_KEPT],
    );

    const subscriptions = await pg.query<PushSubscriptionRow>(
      "SELECT endpoint,user_id,p256dh,auth,created_at,updated_at FROM public.push_subscriptions",
    );
    const title = type === "success" ? "APSHULE Push" : "APSHULE Push Failed";
    const body = `${type === "success" ? "✅ " : "❌ "}${message}`;
    const delivery = await sendToSubscriptions(env, pg, subscriptions.rows, {
      title, body, tag: "apshule-push-event", data: { url: "/", eventId },
    });
    return json({
      ok: true,
      eventId,
      notified: delivery.sent,
      webPush: delivery,
      ...(subscriptions.rows.length > 0 && !vapidKeys(env)
        ? { warning: "Web Push is not configured; the event was stored without device delivery." }
        : {}),
    });
  }

  return json({ ok: false, error: "method not allowed" }, 405);
}

async function handleSubscriptionRoute(request: Request, env: PushRouteEnv, path: string): Promise<Response> {
  if (request.method === "GET" && path === "/api/push-subscription/vapid-public-key") {
    if (!vapidKeys(env)) return json({ ok: false, error: "Web Push is not configured" }, 503);
    return json({ ok: true, publicKey: env.VAPID_PUBLIC_KEY });
  }

  const authentication = await authenticate(request, env);
  if (!authentication.authenticated) {
    return json({ ok: false, error: "Authentication is required" }, authentication.status);
  }

  if (request.method === "POST" && path === "/api/push-subscription") {
    const input = await readBody(request);
    if (!input || typeof input.endpoint !== "string" || typeof input.keys !== "object" || input.keys === null) {
      return json({ ok: false, error: "endpoint and subscription keys are required" }, 400);
    }
    const keys = input.keys as Record<string, unknown>;
    if (typeof keys.p256dh !== "string" || typeof keys.auth !== "string") {
      return json({ ok: false, error: "keys.p256dh and keys.auth are required" }, 400);
    }
    if (input.endpoint.length > 2048 || keys.p256dh.length > 200 || keys.auth.length > 100) {
      return json({ ok: false, error: "Push subscription fields are too long" }, 400);
    }
    if (!/^[A-Za-z0-9_-]{80,100}$/.test(keys.p256dh) || !/^[A-Za-z0-9_-]{20,30}$/.test(keys.auth)) {
      return json({ ok: false, error: "Invalid Web Push subscription keys" }, 400);
    }
    try {
      validateWebPushEndpoint(input.endpoint);
    } catch {
      return json({ ok: false, error: "Unsupported Web Push endpoint" }, 400);
    }

    const pg = env.PG;
    if (!pg) return json({ ok: false, error: "PostgreSQL is unavailable" }, 503);

    const timestamp = new Date().toISOString();
    const writeResult = await inNeonTransaction(pg, async () => {
      const owner = await pg.query<{ uid: string }>(
        "SELECT uid FROM public.users WHERE uid = $1 FOR UPDATE",
        [authentication.user.uid],
      );
      if (owner.rows.length === 0) return "user-unavailable" as const;

      const existing = await pg.query<{ endpoint: string }>(
        "SELECT endpoint FROM public.push_subscriptions WHERE endpoint = $1 AND user_id = $2 LIMIT 1",
        [input.endpoint, authentication.user.uid],
      );
      if (existing.rows.length === 0) {
        const count = await pg.query<{ total: number | string }>(
          "SELECT COUNT(*)::integer AS total FROM public.push_subscriptions WHERE user_id = $1",
          [authentication.user.uid],
        );
        if (Number(count.rows[0]?.total ?? 0) >= MAX_SUBSCRIPTIONS_PER_USER) {
          return "limit-reached" as const;
        }
      }

      await pg.query(
        `INSERT INTO public.push_subscriptions (endpoint,user_id,p256dh,auth,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT(endpoint) DO UPDATE SET user_id=EXCLUDED.user_id,p256dh=EXCLUDED.p256dh,
           auth=EXCLUDED.auth,updated_at=EXCLUDED.updated_at`,
        [input.endpoint, authentication.user.uid, keys.p256dh, keys.auth, timestamp, timestamp],
      );
      return "stored" as const;
    });
    if (writeResult === "user-unavailable") {
      return json({ ok: false, error: "PostgreSQL account record is unavailable" }, 503);
    }
    if (writeResult === "limit-reached") {
      return json({ ok: false, error: "This account has reached the device alert limit" }, 429);
    }
    return json({ ok: true }, 201);
  }

  if (request.method === "DELETE" && path === "/api/push-subscription") {
    const input = await readBody(request);
    if (!input || typeof input.endpoint !== "string" || input.endpoint.length > 2048) {
      return json({ ok: false, error: "endpoint is required" }, 400);
    }
    const pg = env.PG;
    if (!pg) return json({ ok: false, error: "PostgreSQL is unavailable" }, 503);
    await pg.query(
      "DELETE FROM public.push_subscriptions WHERE endpoint = $1 AND user_id = $2",
      [input.endpoint, authentication.user.uid],
    );
    return json({ ok: true });
  }

  return json({ ok: false, error: "method not allowed" }, 405);
}

async function handleTargetedNotification(request: Request, env: PushRouteEnv): Promise<Response> {
  const authentication = await authenticate(request, env);
  if (!authentication.authenticated) {
    return json({ ok: false, error: "Authentication is required" }, authentication.status);
  }
  const user = authentication.user as AuthUser;
  const role = normalizedRole(user.role);
  const superAdmin = isSuperAdmin(role);
  const allowedRoles = new Set(["superadmin", "super_admin", "headteacher", "school_admin", "school", "teacher", "secretary"]);
  if (!allowedRoles.has(role)) return json({ ok: false, error: "This role cannot send user alerts" }, 403);

  const input = await readBody(request);
  if (!input) return json({ ok: false, error: "A valid JSON object is required" }, 400);
  const targetUserId = sanitizeText(input.targetUserId, 200);
  const title = sanitizeText(input.title, 120);
  const body = sanitizeText(input.body, 1000);
  if (!targetUserId || !title) return json({ ok: false, error: "targetUserId and title are required" }, 400);
  const pg = env.PG;
  if (!pg) return json({ ok: false, error: "PostgreSQL is unavailable" }, 503);

  const targetResult = await pg.query<{ uid: string; school_id: string | null }>(
    "SELECT uid,school_id FROM public.users WHERE uid = $1 LIMIT 1",
    [targetUserId],
  );
  const target = targetResult.rows[0];
  if (!target) return json({ ok: false, error: "Target user not found" }, 404);
  if (!superAdmin && (!user.schoolId || target.school_id !== user.schoolId)) {
    return json({ ok: false, error: "Target user is outside your school" }, 403);
  }

  const subscriptions = await pg.query<PushSubscriptionRow>(
    "SELECT endpoint,user_id,p256dh,auth,created_at,updated_at FROM public.push_subscriptions WHERE user_id = $1",
    [targetUserId],
  );
  if (subscriptions.rows.length && !vapidKeys(env)) {
    return json({ ok: false, error: "Web Push is not configured" }, 503);
  }
  const delivery = await sendToSubscriptions(env, pg, subscriptions.rows, {
    title, body, tag: `apshule-user-${targetUserId}`, data: { url: "/" },
  });
  return json({ ok: true, ...delivery, subscriptions: subscriptions.rows.length });
}

export async function handlePushRoute(request: Request, env: PushRouteEnv): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path === "/api/push-events" || path === "/api/push-events/history") {
    return handleEventRoute(request, env, path);
  }
  if (path === "/api/push-subscription" || path === "/api/push-subscription/vapid-public-key") {
    return handleSubscriptionRoute(request, env, path);
  }
  if (path === "/api/push-notifications" && request.method === "POST") {
    return handleTargetedNotification(request, env);
  }
  return null;
}