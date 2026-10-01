import type { AuthUser } from "./backend-types";
import {
  cleanText,
  database,
  isPlatformSuperadmin,
  platformJson,
  PlatformV10Env,
  readJson,
} from "./platform-v10-common";

const LANGUAGES = new Set(["english", "luganda", "lusoga", "runyankore", "runyoro", "acholi", "swahili"]);
const MAX_LIST_PAGES = 25;
const MB = 1024 * 1024;
type Row = Record<string, unknown>;

function userIdForRequest(url: URL, user: AuthUser) {
  const requested = cleanText(url.searchParams.get("user_id"), 180);
  if (!requested) return user.uid;
  if (requested !== user.uid && !isPlatformSuperadmin(user)) return "";
  return requested;
}

function tenantPrefixes(user: AuthUser, targetUserId: string) {
  if (targetUserId !== user.uid) return [`users/${targetUserId}/`];
  const prefixes = new Set<string>();
  if (user.schoolId) {
    prefixes.add(`media/${user.institutionId || "personal"}/${user.schoolId}/`);
    prefixes.add(`projects/${user.schoolId}/`);
  } else if (user.institutionId) {
    prefixes.add(`media/${user.institutionId}/`);
  }
  if (user.institutionId) prefixes.add(`education/${user.institutionId}/`);
  if (!prefixes.size) prefixes.add(`users/${targetUserId}/`);
  return [...prefixes];
}

async function storageUsage(env: PlatformV10Env, user: AuthUser, targetUserId: string, localUsageMb: number) {
  const breakdown = { hd_videos: 0, light_videos: 0, pdfs: 0, projects: 0 };
  let r2Bytes = 0;
  if (!env.FILES) throw new Error("R2 file storage is unavailable");
  for (const prefix of tenantPrefixes(user, targetUserId)) {
    let cursor: string | undefined;
    let complete = false;
    for (let pageNumber = 0; pageNumber < MAX_LIST_PAGES; pageNumber++) {
      const page = await env.FILES.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
      for (const object of page.objects) {
        const size = Math.max(0, Number(object.size) || 0);
        r2Bytes += size;
        const key = object.key.toLowerCase();
        if (/\.(?:mp4|webm|mov)$/.test(key)) {
          if (/(?:\/light\/|_light\.|\/low\/)/.test(key)) breakdown.light_videos += size;
          else breakdown.hd_videos += size;
        } else if (key.endsWith(".pdf")) {
          breakdown.pdfs += size;
        } else if (key.startsWith("projects/")) {
          breakdown.projects += size;
        }
      }
      if (!page.truncated) {
        complete = true;
        break;
      }
      if (!page.cursor || pageNumber === MAX_LIST_PAGES - 1) break;
      cursor = page.cursor;
    }
    if (!complete) throw new Error("R2 storage listing exceeded its safe page limit");
  }
  const breakdownMb = {
    hd_videos: +(breakdown.hd_videos / MB).toFixed(2),
    light_videos: +(breakdown.light_videos / MB).toFixed(2),
    pdfs: +(breakdown.pdfs / MB).toFixed(2),
    projects: +(breakdown.projects / MB).toFixed(2),
  };
  const r2UsageMb = +(r2Bytes / MB).toFixed(2);
  const usageMb = +(Math.max(0, localUsageMb) + r2UsageMb).toFixed(2);
  return {
    estimate: {
      usage: `${usageMb}MB`,
      quota: "500MB",
      usage_mb: usageMb,
      quota_mb: 500,
    },
    breakdown: breakdownMb,
    indexeddb_usage_mb: Math.max(0, localUsageMb),
    r2_usage_mb: r2UsageMb,
  };
}

async function getSettings(request: Request, env: PlatformV10Env, user: AuthUser) {
  const url = new URL(request.url);
  const targetUserId = userIdForRequest(url, user);
  if (!targetUserId) return platformJson({ ok: false, error: "Settings are available only to their owner" }, 403);
  const result = await database(env).query<Row>(
    `SELECT user_id,hd_only_wifi,auto_sync_wifi,auto_sync_mobile,language,
            data_used_mb,total_mb,last_sync,updated_at
       FROM public.offline_settings WHERE user_id=$1 LIMIT 1`,
    [targetUserId],
  );
  const row = result.rows[0] ?? {};
  return platformJson({
    user_id: targetUserId,
    hd_only_wifi: row.hd_only_wifi ?? true,
    auto_sync_wifi: row.auto_sync_wifi ?? true,
    auto_sync_mobile: row.auto_sync_mobile ?? false,
    language: LANGUAGES.has(String(row.language)) ? row.language : "english",
    data_used_mb: Math.max(0, Number(row.data_used_mb) || 0),
    total_mb: Math.max(1, Number(row.total_mb) || 45),
    last_sync: row.last_sync instanceof Date ? row.last_sync.toISOString() : row.last_sync ?? null,
  });
}

async function saveSettings(request: Request, env: PlatformV10Env, user: AuthUser) {
  const input = await readJson(request);
  const bodyUserId = cleanText(input.user_id, 180);
  const targetUserId = bodyUserId || user.uid;
  if (!targetUserId || (targetUserId !== user.uid && !isPlatformSuperadmin(user))) {
    return platformJson({ ok: false, error: "Settings are available only to their owner" }, 403);
  }
  if (typeof input.hd_only_wifi !== "boolean" ||
      typeof input.auto_sync_wifi !== "boolean" ||
      typeof input.auto_sync_mobile !== "boolean" ||
      !LANGUAGES.has(String(input.language))) {
    return platformJson({ ok: false, error: "Wi-Fi, mobile sync, and supported language settings are required" }, 400);
  }
  const timestamp = new Date().toISOString();
  await database(env).query(
    `INSERT INTO public.offline_settings
      (user_id,hd_only_wifi,auto_sync_wifi,auto_sync_mobile,language,last_sync,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$6)
     ON CONFLICT(user_id) DO UPDATE SET
       hd_only_wifi=EXCLUDED.hd_only_wifi,
       auto_sync_wifi=EXCLUDED.auto_sync_wifi,
       auto_sync_mobile=EXCLUDED.auto_sync_mobile,
       language=EXCLUDED.language,
       last_sync=EXCLUDED.last_sync,
       updated_at=EXCLUDED.updated_at`,
    [targetUserId, input.hd_only_wifi, input.auto_sync_wifi, input.auto_sync_mobile, input.language, timestamp],
  );
  return platformJson({ ok: true });
}

async function getStorage(request: Request, env: PlatformV10Env, user: AuthUser) {
  const url = new URL(request.url);
  const targetUserId = userIdForRequest(url, user);
  if (!targetUserId) return platformJson({ ok: false, error: "Storage is available only to its owner" }, 403);
  const localUsageMb = Number(url.searchParams.get("indexeddb_usage_mb") || 0);
  if (!Number.isFinite(localUsageMb) || localUsageMb < 0 || localUsageMb > 100_000) {
    return platformJson({ ok: false, error: "Invalid IndexedDB storage estimate" }, 400);
  }
  return platformJson(await storageUsage(env, user, targetUserId, localUsageMb));
}

export async function handleOfflineSettingsV10Route(
  request: Request,
  env: PlatformV10Env,
  user: AuthUser | null,
): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  if (pathname !== "/api/settings" && pathname !== "/api/settings/storage") return null;
  if (!user) return platformJson({ ok: false, error: "Authentication is required" }, 401);
  if (!env.PG) return platformJson({ ok: false, error: "Neon database persistence is unavailable" }, 503);
  if (request.method !== "GET" && request.method !== "POST") {
    return platformJson({ ok: false, error: "Method not allowed" }, 405);
  }
  const origin = request.headers.get("origin");
  if (request.method === "POST" && origin && origin !== new URL(request.url).origin) {
    return platformJson({ ok: false, error: "Cross-origin requests are not allowed" }, 403);
  }
  try {
    if (pathname === "/api/settings/storage") {
      if (request.method !== "GET") return platformJson({ ok: false, error: "Method not allowed" }, 405);
      return await getStorage(request, env, user);
    }
    if (request.method === "GET") return await getSettings(request, env, user);
    return await saveSettings(request, env, user);
  } catch {
    return platformJson({ ok: false, error: "Settings could not be loaded or saved" }, 503);
  }
}