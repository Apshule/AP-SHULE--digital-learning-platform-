import type { AuthEnv, AuthUser } from "./backend-types";

interface R2Object {
  body: ReadableStream;
  httpMetadata?: { contentType?: string };
}
interface R2Bucket {
  put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<R2Object | null>;
}
interface ProfileEnv extends AuthEnv {
  FILES?: R2Bucket;
}

const MAX_BYTES = 5 * 1024 * 1024;
const SVG_PLACEHOLDER = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="Profile photo placeholder"><rect width="256" height="256" rx="128" fill="#e2f3ef"/><circle cx="128" cy="96" r="48" fill="#087a68"/><path d="M40 224c8-46 43-72 88-72s80 26 88 72" fill="#087a68"/></svg>`;

function response(body: BodyInit, status = 200, contentType = "application/json; charset=utf-8"): Response {
  return new Response(body, {
    status,
    headers: { "content-type": contentType, "cache-control": "no-store" },
  });
}
function json(body: unknown, status = 200) {
  return response(JSON.stringify(body), status);
}
function extension(type: string): string {
  return type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
}
function signature(bytes: Uint8Array, type: string): boolean {
  if (type === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === "image/png") return bytes.length >= 8 && bytes.slice(0, 8).every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index]);
  return bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
}
async function digest(bytes: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
async function digestText(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  return digest(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}
function allowedContentType(type: string): boolean {
  return type === "image/jpeg" || type === "image/png" || type === "image/webp";
}
function validProfileObjectKey(key: string, uidHash: string, type: string): boolean {
  const match = key.match(/^profile\/([a-f0-9]{64})\/([a-f0-9]{64})\.(jpg|png|webp)$/);
  return Boolean(match && match[1] === uidHash && match[3] === extension(type));
}
async function boundedBody(request: Request): Promise<ArrayBuffer | null> {
  const reader = request.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output.buffer;
}
async function placeholder(env: ProfileEnv, pg: NonNullable<ProfileEnv["PG"]>): Promise<Response> {
  let rows: { object_key: string; content_type: string }[];
  try {
    const result = await pg.query<{ object_key: string; content_type: string }>(
      `SELECT object_key,COALESCE(placeholder_content_type,content_type) AS content_type
       FROM public.storage_migration_manifest
       WHERE is_placeholder=1
         AND COALESCE(placeholder_content_type,content_type)='image/jpeg'
       ORDER BY object_key LIMIT 1`,
    );
    rows = result.rows;
  } catch {
    return json({ ok: false, error: "Profile photo placeholder metadata is unavailable" }, 503);
  }
  const key = rows[0]?.object_key;
  if (key && env.FILES) {
    const object = await env.FILES.get(key);
    if (object?.body) return new Response(object.body, { headers: { "content-type": "image/jpeg", "cache-control": "no-store" } });
  }
  return response(SVG_PLACEHOLDER, 200, "image/svg+xml; charset=utf-8");
}

export async function handleProfileFileRoute(request: Request, env: ProfileEnv, user: AuthUser): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  const pg = env.PG;
  if (!pg) return json({ ok: false, error: "Neon database is unavailable" }, 503);

  if (request.method === "GET") {
    const result = await pg.query<{ active_key: string; content_type: string }>(
      "SELECT active_key,content_type FROM profile_photos WHERE uid=$1 LIMIT 1",
      [user.uid],
    );
    const row = result.rows[0];
    if (!row || !env.FILES) return placeholder(env, pg);
    const uidHash = await digestText(user.uid);
    if (!allowedContentType(row.content_type) || !validProfileObjectKey(row.active_key, uidHash, row.content_type)) {
      return json({ ok: false, error: "Profile photo metadata is invalid" }, 500);
    }
    const object = await env.FILES.get(row.active_key);
    if (!object?.body) return placeholder(env, pg);
    return new Response(object.body, { headers: { "content-type": row.content_type, "cache-control": "no-store" } });
  }
  if (!env.FILES) return json({ ok: false, error: "Profile photo storage is unavailable" }, 503);
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) {
    return json({ ok: false, error: "Profile photo uploads must come from this site" }, 403);
  }
  const type = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!["image/jpeg", "image/png", "image/webp"].includes(type)) return json({ ok: false, error: "Only JPEG, PNG, and WebP images are accepted" }, 415);
  const contentLength = request.headers.get("content-length");
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BYTES)) {
    return json({ ok: false, error: "Profile photos must be 5 MB or smaller" }, 413);
  }
  const bytes = await boundedBody(request);
  if (bytes === null || bytes.byteLength > MAX_BYTES) return json({ ok: false, error: "Profile photos must be 5 MB or smaller" }, 413);
  if (!bytes.byteLength) return json({ ok: false, error: "Choose a photo before uploading" }, 400);
  if (!signature(new Uint8Array(bytes), type)) return json({ ok: false, error: "The file content does not match its image type" }, 415);
  const sha256 = await digest(bytes);
  const uidHash = await digestText(user.uid);
  const key = `profile/${uidHash}/${sha256}.${extension(type)}`;
  if (!validProfileObjectKey(key, uidHash, type)) return json({ ok: false, error: "Profile photo object key is invalid" }, 500);
  await env.FILES.put(key, bytes, { httpMetadata: { contentType: type } });
  const timestamp = new Date().toISOString();
  await pg.query(
    `INSERT INTO profile_photos (uid,active_key,content_type,size_bytes,sha256,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (uid) DO UPDATE SET active_key=EXCLUDED.active_key,content_type=EXCLUDED.content_type,
       size_bytes=EXCLUDED.size_bytes,sha256=EXCLUDED.sha256,updated_at=EXCLUDED.updated_at`,
    [user.uid, key, type, bytes.byteLength, sha256, timestamp, timestamp],
  );
  return json({ ok: true, contentType: type, sizeBytes: bytes.byteLength, updatedAt: timestamp });
}