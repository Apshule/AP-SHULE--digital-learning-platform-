import type { AuthEnv, AuthUser } from "./backend-types";

interface R2Bucket {
  put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream } | null>;
  delete(key: string): Promise<unknown>;
}

export interface MediaReferralV10Env extends AuthEnv {
  FILES?: R2Bucket;
  VIDEOS?: R2Bucket;
}

type Row = Record<string, unknown>;
const LANGUAGES = ["english", "luganda", "lusoga", "runyankore", "runyoro", "acholi", "swahili"] as const;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const clean = (value: unknown, max = 240) => String(value ?? "").trim().slice(0, max);
const now = () => new Date().toISOString();
const makeId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;

function database(env: MediaReferralV10Env) {
  if (!env.PG) throw new Error("Neon database persistence is unavailable");
  return env.PG;
}

async function input(request: Request): Promise<Row> {
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
  } catch {
    return {};
  }
}

function normalizedRole(user: AuthUser) {
  const value = clean(user.role, 80).toLowerCase().replace(/[ -]+/g, "_");
  if (value === "super_admin") return "superadmin";
  if (["individual", "learner"].includes(value)) return "student";
  if (["teacher_staff", "teacher_independent"].includes(value)) return "teacher";
  if (["school", "school_admin", "head_teacher"].includes(value)) return "headteacher";
  return value;
}

function tenantScope(user: AuthUser, start = 1, alias = "") {
  const prefix = alias ? `${alias}.` : "";
  if (user.schoolId) return {
    sql: `(${prefix}school_id=$${start} OR (${prefix}school_id IS NULL AND ${prefix}institution_id=$${start + 1}))`,
    args: [user.schoolId, user.institutionId || ""],
  };
  if (user.institutionId) return { sql: `${prefix}institution_id=$${start}`, args: [user.institutionId] };
  return { sql: "1=0", args: [] as unknown[] };
}

async function hasCapability(env: MediaReferralV10Env, user: AuthUser, capabilities: string[]) {
  if (normalizedRole(user) === "superadmin") return true;
  const result = await database(env).query<{ capability: string }>(
    "SELECT capability FROM public.role_capabilities WHERE lower(role)=$1 AND sector='education'",
    [normalizedRole(user)],
  );
  return result.rows.some((row) => row.capability === "*" || capabilities.includes(row.capability));
}

async function requireCapability(env: MediaReferralV10Env, user: AuthUser, capabilities: string[]) {
  return (await hasCapability(env, user, capabilities))
    ? null
    : json({ ok: false, error: "Required education capability is missing" }, 403);
}

function validLanguage(value: unknown): value is typeof LANGUAGES[number] {
  return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
}

const videoReadCaps = ["video_studio.read", "video_studio.manage", "videos.read", "videos.manage", "lessons.read", "lessons.manage"];
const videoWriteCaps = ["video_studio.manage", "videos.manage", "lessons.manage"];

async function sampleVideos(request: Request, env: MediaReferralV10Env, user: AuthUser) {
  if (request.method === "GET") {
    const denied = await requireCapability(env, user, videoReadCaps);
    if (denied) return denied;
    const scope = tenantScope(user);
    const result = await database(env).query<Row>(
      `SELECT id,title,topic,subject,class_level,mode,language,script_text,translated_script,status,
        object_key,metadata_json,created_by,created_at,updated_at
       FROM public.sample_videos WHERE ${normalizedRole(user) === "superadmin" ? "1=1" : `(school_id IS NULL AND institution_id IS NULL OR ${scope.sql})`}
       AND is_deleted=0 ORDER BY created_at DESC LIMIT 250`,
      normalizedRole(user) === "superadmin" ? [] : scope.args,
    );
    return json({ ok: true, sampleVideos: result.rows });
  }
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  const denied = await requireCapability(env, user, videoWriteCaps);
  if (denied) return denied;
  const value = await input(request);
  const title = clean(value.title, 200);
  const topic = clean(value.topic, 240);
  const language = value.language;
  const script = clean(value.scriptText, 24000);
  const mode = clean(value.mode || "cartoon", 40);
  if (!title || !topic || !validLanguage(language) || !["cartoon", "auto_ai", "teacher_twin"].includes(mode)) {
    return json({ ok: false, error: "Title, topic, supported language, and valid mode are required" }, 400);
  }
  const id = clean(value.id, 120) || makeId("sample_video");
  const timestamp = now();
  const metadata = {
    durationMinutes: Number.isSafeInteger(Number(value.durationMinutes)) ? Math.max(1, Math.min(120, Number(value.durationMinutes))) : null,
    isSeries: value.isSeries === true,
    seriesParentId: clean(value.seriesParentId, 120),
  };
  await database(env).query(
    `INSERT INTO public.sample_videos
      (id,institution_id,school_id,title,topic,subject,class_level,mode,language,script_text,translated_script,status,
       object_key,metadata_json,created_by,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'draft',NULL,$12,$13,$14,$14)
     ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,topic=EXCLUDED.topic,subject=EXCLUDED.subject,
       class_level=EXCLUDED.class_level,mode=EXCLUDED.mode,language=EXCLUDED.language,script_text=EXCLUDED.script_text,
       metadata_json=EXCLUDED.metadata_json,updated_at=EXCLUDED.updated_at
     WHERE sample_videos.institution_id IS NOT DISTINCT FROM EXCLUDED.institution_id
       AND sample_videos.school_id IS NOT DISTINCT FROM EXCLUDED.school_id`,
    [
      id, user.institutionId, user.schoolId, title, topic, clean(value.subject, 120),
      clean(value.classLevel, 120), mode, language, script, clean(value.translatedScript, 24000),
      JSON.stringify(metadata), user.uid, timestamp,
    ],
  );
  const saved = (await database(env).query<Row>("SELECT id,status FROM public.sample_videos WHERE id=$1", [id])).rows[0];
  if (!saved) return json({ ok: false, error: "Video metadata could not be saved" }, 502);
  return json({ ok: true, sampleVideo: saved }, 201);
}

async function generateVideo(request: Request, env: MediaReferralV10Env, user: AuthUser) {
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  const denied = await requireCapability(env, user, videoWriteCaps);
  if (denied) return denied;
  const value = await input(request);
  const videoId = clean(value.videoId || value.projectId, 120);
  if (!videoId) return json({ ok: false, error: "A sample video ID is required" }, 400);
  const scope = tenantScope(user, 2);
  const record = (await database(env).query<Row>(
    `SELECT id,mode FROM public.sample_videos WHERE id=$1 AND is_deleted=0 AND
      (${normalizedRole(user) === "superadmin" ? "1=1" : `((school_id IS NULL AND institution_id IS NULL) OR ${tenantScope(user, 2).sql})`})
      LIMIT 1`,
    normalizedRole(user) === "superadmin" ? [videoId] : [videoId, ...scope.args],
  )).rows[0];
  if (!record) return json({ ok: false, error: "Sample video not found in this tenant" }, 404);
  const jobId = makeId("video_job");
  const timestamp = now();
  await database(env).query(
    `INSERT INTO public.sample_video_jobs(id,video_id,mode,status,current_step,error_message,requested_by,created_at,updated_at)
     VALUES($1,$2,$3,'pending','queued','', $4,$5,$5)
     ON CONFLICT(video_id) WHERE status IN ('pending','in_progress') DO NOTHING`,
    [jobId, videoId, clean(record.mode, 40), user.uid, timestamp],
  );
  const job = (await database(env).query<Row>(
    "SELECT id,video_id,status,current_step,created_at FROM public.sample_video_jobs WHERE video_id=$1 AND status IN ('pending','in_progress') ORDER BY created_at DESC LIMIT 1",
    [videoId],
  )).rows[0];
  return json({
    ok: true,
    job,
    message: "Generation metadata was queued. Media generation is not available on this endpoint.",
    mediaGenerated: false,
  }, 202);
}

async function cartoonAssets(request: Request, env: MediaReferralV10Env, user: AuthUser) {
  const cap = request.method === "GET" ? videoReadCaps : videoWriteCaps;
  const denied = await requireCapability(env, user, cap);
  if (denied) return denied;
  if (request.method === "GET") {
    const scope = tenantScope(user);
    const result = await database(env).query<Row>(
      `SELECT id,character_type,pose,object_key,tags_json,metadata_json,created_by,created_at
       FROM public.cartoon_assets WHERE is_deleted=0 AND
       (${normalizedRole(user) === "superadmin" ? "1=1" : `(school_id IS NULL AND institution_id IS NULL OR ${scope.sql})`})
       ORDER BY character_type,pose LIMIT 500`,
      normalizedRole(user) === "superadmin" ? [] : scope.args,
    );
    return json({ ok: true, cartoonAssets: result.rows });
  }
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  const value = await input(request);
  const characterType = clean(value.characterType, 60);
  const pose = clean(value.pose, 60);
  const objectKey = clean(value.objectKey, 500);
  if (!["boy", "girl", "teacher_mama", "teacher_mzee"].includes(characterType) ||
      !["standing", "pointing", "writing", "smiling", "talking"].includes(pose) ||
      !objectKey || !objectKey.startsWith(`media/${user.institutionId || "personal"}/`)) {
    return json({ ok: false, error: "Valid character, pose, and same-tenant R2 upload key are required" }, 400);
  }
  const upload = (await database(env).query<Row>(
    "SELECT object_key FROM public.media_uploads WHERE object_key=$1 AND institution_id IS NOT DISTINCT FROM $2 AND school_id IS NOT DISTINCT FROM $3 AND created_by=$4",
    [objectKey, user.institutionId, user.schoolId, user.uid],
  )).rows[0];
  if (!upload) return json({ ok: false, error: "Upload key was not found in this tenant" }, 400);
  const id = clean(value.id, 120) || makeId("cartoon");
  const timestamp = now();
  const tags = Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 30).map((tag) => clean(tag, 60)) : [];
  await database(env).query(
    `INSERT INTO public.cartoon_assets(id,institution_id,school_id,character_type,pose,object_key,tags_json,metadata_json,created_by,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
     ON CONFLICT(id) DO UPDATE SET character_type=EXCLUDED.character_type,pose=EXCLUDED.pose,
       object_key=EXCLUDED.object_key,tags_json=EXCLUDED.tags_json,metadata_json=EXCLUDED.metadata_json,updated_at=EXCLUDED.updated_at
     WHERE cartoon_assets.institution_id IS NOT DISTINCT FROM EXCLUDED.institution_id
       AND cartoon_assets.school_id IS NOT DISTINCT FROM EXCLUDED.school_id`,
    [id, user.institutionId, user.schoolId, characterType, pose, objectKey, JSON.stringify(tags),
      JSON.stringify({ description: clean(value.description, 500) }), user.uid, timestamp],
  );
  return json({ ok: true, id }, 201);
}

function sniffContentType(bytes: Uint8Array, claimed: string) {
  if (claimed === "image/png" && bytes.length >= 8 &&
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => bytes[i] === v)) return "image/png";
  if (claimed === "image/jpeg" && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (claimed === "image/webp" && bytes.length >= 12 &&
      new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP") return "image/webp";
  if (claimed === "video/mp4" && bytes.length >= 12 && new TextDecoder().decode(bytes.slice(4, 8)) === "ftyp") return "video/mp4";
  if (claimed === "video/webm" && bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "video/webm";
  return "";
}

async function uploadR2(request: Request, env: MediaReferralV10Env, user: AuthUser) {
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  const denied = await requireCapability(env, user, ["video_studio.manage", "videos.manage", "lessons.manage"]);
  if (denied) return denied;
  const bucket = env.FILES || env.VIDEOS;
  if (!bucket) return json({ ok: false, error: "R2 file storage is unavailable" }, 503);
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) return json({ ok: false, error: "Uploads must come from this site" }, 403);
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size < 1) return json({ ok: false, error: "A non-empty media file is required" }, 400);
  if (file.size > MAX_UPLOAD_BYTES) return json({ ok: false, error: "Media uploads must be 8 MiB or smaller" }, 413);
  const purpose = clean(form?.get("purpose"), 40);
  if (!["cartoon_asset", "sample_video"].includes(purpose)) return json({ ok: false, error: "Upload purpose must be cartoon_asset or sample_video" }, 400);
  const raw = await file.arrayBuffer();
  const type = sniffContentType(new Uint8Array(raw), file.type);
  if (!type) return json({ ok: false, error: "File content does not match a supported PNG, JPEG, WebP, MP4, or WebM type" }, 415);
  const digest = await crypto.subtle.digest("SHA-256", raw);
  const sha = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm" } as Record<string, string>)[type];
  const key = `media/${clean(user.institutionId, 100) || "personal"}/${clean(user.schoolId, 100) || "school"}/${makeId("asset")}-${sha.slice(0, 16)}.${extension}`;
  try {
    await bucket.put(key, raw, { httpMetadata: { contentType: type } });
    await database(env).query(
      `INSERT INTO public.media_uploads(object_key,institution_id,school_id,owner_id,purpose,content_type,size_bytes,sha256,created_by,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$4,$9)`,
      [key, user.institutionId, user.schoolId, user.uid, purpose, type, raw.byteLength, sha, now()],
    );
  } catch {
    try { await bucket.delete(key); } catch { /* Keep the storage error response explicit. */ }
    return json({ ok: false, error: "Upload metadata could not be saved" }, 502);
  }
  return json({ ok: true, objectKey: key, contentType: type, sizeBytes: raw.byteLength }, 201);
}

function referralOwnerType(user: AuthUser): "school" | "student" | "teacher" | "" {
  const role = normalizedRole(user);
  if (role === "student") return "student";
  if (role === "teacher") return "teacher";
  if (["headteacher", "secretary"].includes(role)) return "school";
  return "";
}

async function referrals(request: Request, env: MediaReferralV10Env, user: AuthUser, pathname: string) {
  const role = referralOwnerType(user);
  if (!role) return json({ ok: false, error: "School, student, or teacher referral accounts are required" }, 403);
  if (pathname === "/api/referrals" && request.method === "GET") {
    const result = await database(env).query<Row>(
      "SELECT code,owner_type,active,created_at FROM public.media_referral_codes WHERE owner_id=$1 AND institution_id IS NOT DISTINCT FROM $2 AND school_id IS NOT DISTINCT FROM $3 ORDER BY created_at DESC",
      [user.uid, user.institutionId, user.schoolId],
    );
    return json({ ok: true, referrals: result.rows });
  }
  if (pathname === "/api/referrals" && request.method === "POST") {
    const denied = await requireCapability(env, user, ["referrals.manage", "students.manage", "teacher_assignments.manage"]);
    if (denied) return denied;
    const code = `${role.toUpperCase()}-${crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    await database(env).query(
      `INSERT INTO public.media_referral_codes(code,owner_id,owner_type,institution_id,school_id,active,created_at)
       VALUES($1,$2,$3,$4,$5,1,$6)`,
      [code, user.uid, role, user.institutionId, user.schoolId, now()],
    );
    return json({ ok: true, referral: { code, ownerType: role } }, 201);
  }
  if (pathname === "/api/referrals/redeem" && request.method === "POST") {
    const denied = await requireCapability(env, user, ["referrals.redeem", "referrals.manage", "records.own.read"]);
    if (denied) return denied;
    const value = await input(request);
    const code = clean(value.referralCode, 80).toUpperCase();
    const paymentId = clean(value.paymentId, 160);
    const rewardChoice = clean(value.rewardChoice, 20).toLowerCase() === "cash" ? "cash" : "day";
    if (!code) return json({ ok: false, error: "A referral code is required" }, 400);
    const pg = database(env);
    const referrer = (await pg.query<Row>(
      "SELECT code,owner_id,owner_type,institution_id,school_id FROM public.media_referral_codes WHERE code=$1 AND active=1 LIMIT 1",
      [code],
    )).rows[0];
    if (!referrer || clean(referrer.owner_id) === user.uid) return json({ ok: false, error: "That referral link is invalid" }, 404);
    const signupRole = normalizedRole(user);
    if (signupRole !== "student" && signupRole !== "teacher") return json({ ok: false, error: "Only student or teacher accounts can redeem this referral" }, 403);
    if (referrer.owner_type === "teacher" && signupRole === "teacher") {
      if (!paymentId) return json({ ok: false, error: "Teacher registration requires a confirmed UGX 240,000 payment" }, 402);
      const payment = (await pg.query<Row>(
        "SELECT id FROM public.payments WHERE id=$1 AND payer_id=$2 AND amount=240000 AND upper(currency)='UGX' AND lower(status) IN ('paid','completed','settled') AND institution_id IS NOT DISTINCT FROM $3 AND school_id IS NOT DISTINCT FROM $4 LIMIT 1",
        [paymentId, user.uid, user.institutionId, user.schoolId],
      )).rows[0];
      if (!payment) return json({ ok: false, error: "A confirmed teacher registration payment is required before reward eligibility" }, 402);
    } else if (referrer.owner_type === "student" && signupRole === "student") {
      if (!paymentId) return json({ ok: false, error: "Student referrals require the UGX 1,000 registration payment before rewards can be granted" }, 402);
      const payment = (await pg.query<Row>(
        "SELECT id FROM public.payments WHERE id=$1 AND payer_id=$2 AND amount=1000 AND upper(currency)='UGX' AND lower(status) IN ('paid','completed','settled') AND institution_id IS NOT DISTINCT FROM $3 AND school_id IS NOT DISTINCT FROM $4 LIMIT 1",
        [paymentId, user.uid, user.institutionId, user.schoolId],
      )).rows[0];
      if (!payment) return json({ ok: false, error: "A confirmed student registration payment is required before reward eligibility" }, 402);
    }
    if (referrer.owner_type === "school" && signupRole !== "student") return json({ ok: false, error: "School referral codes are for student registrations" }, 400);
    const rewardType = referrer.owner_type === "student" ? rewardChoice
      : referrer.owner_type === "teacher" ? (signupRole === "teacher" ? "teacher_teacher_cash" : "teacher_cash")
        : "school_referral";
    const amount = rewardType === "cash" ? 500 : rewardType === "teacher_cash" ? 600
      : rewardType === "teacher_teacher_cash" ? 80000 : 0;
    const rewardId = makeId("ref_reward");
    const timestamp = now();
    try {
      await pg.query("BEGIN");
      const inserted = await pg.query<Row>(
        `INSERT INTO public.media_referral_rewards(id,referral_code,referrer_id,referred_user_id,owner_type,reward_type,amount_ugx,currency,status,payment_id,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,'UGX',$8,$9,$10)
         ON CONFLICT(referral_code,referred_user_id) DO NOTHING RETURNING id`,
        [rewardId, code, referrer.owner_id, user.uid, referrer.owner_type, rewardType, amount,
          paymentId || "", amount ? "pending" : "tracked", paymentId || null, timestamp],
      );
      const duplicate = !inserted.rows.length;
      if (!duplicate && amount > 0) {
        await pg.query(
          "INSERT INTO public.media_referral_balances(owner_id,owner_type,institution_id,school_id,balance_ugx,updated_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(owner_id) DO UPDATE SET balance_ugx=media_referral_balances.balance_ugx+EXCLUDED.balance_ugx,updated_at=EXCLUDED.updated_at",
          [referrer.owner_id, referrer.owner_type, referrer.institution_id, referrer.school_id, amount, timestamp],
        );
      }
      await pg.query("COMMIT");
      return json({ ok: true, duplicate, rewardType, amountUgx: amount, status: duplicate ? "already_recorded" : amount ? "pending" : "tracked" }, duplicate ? 200 : 201);
    } catch {
      try { await pg.query("ROLLBACK"); } catch { /* Preserve a generic persistence error. */ }
      return json({ ok: false, error: "Referral reward could not be recorded" }, 503);
    }
  }
  return json({ ok: false, error: "Unknown school/student/teacher referral route" }, 404);
}

export async function handleMediaReferralV10Route(
  request: Request,
  env: MediaReferralV10Env,
  user: AuthUser | null,
): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  const known = ["/api/sample_videos", "/api/sample_videos/generate", "/api/cartoon_assets", "/api/upload/r2",
    "/api/referrals", "/api/referrals/redeem"].includes(pathname);
  if (!known) return null;
  if (!user) return json({ ok: false, error: "Authentication is required" }, 401);
  if (!env.PG) return json({ ok: false, error: "Neon database persistence is unavailable" }, 503);
  try {
    if (pathname === "/api/sample_videos") return await sampleVideos(request, env, user);
    if (pathname === "/api/sample_videos/generate") return await generateVideo(request, env, user);
    if (pathname === "/api/cartoon_assets") return await cartoonAssets(request, env, user);
    if (pathname === "/api/upload/r2") return await uploadR2(request, env, user);
    return await referrals(request, env, user, pathname);
  } catch {
    return json({ ok: false, error: "Media/referral persistence request failed" }, 503);
  }
}