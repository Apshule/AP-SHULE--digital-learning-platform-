import type { AuthUser } from "./backend-types";

interface PgResult<T> { rows: T[]; rowCount?: number | null; }
interface NeonQuery { query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<PgResult<T>>; }
interface FilesBucket {
  put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream; httpMetadata?: { contentType?: string } } | null>;
  delete?(key: string): Promise<unknown>;
}
export interface ProjectsEarningsV10Env { PG?: NeonQuery; FILES?: FilesBucket; }
type Row = Record<string, unknown>;

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
const clean = (value: unknown, max = 500) => String(value ?? "").trim().slice(0, max);
const uid = () => crypto.randomUUID();
const roleOf = (user: AuthUser) => {
  const role = clean(user.role, 80).toLowerCase().replace(/[ -]+/g, "_");
  if (["individual", "learner"].includes(role)) return "student";
  if (["teacher_staff", "teacher_independent"].includes(role)) return "teacher";
  if (["school_admin", "head_teacher", "headteacher", "secretary"].includes(role)) return "school";
  if (role === "super_admin") return "superadmin";
  return role;
};
const isLearner = (role: string) => role === "student";
const isTeacher = (role: string) => role === "teacher";
const isSchoolAdmin = (role: string) => role === "school" || role === "superadmin";

function db(env: ProjectsEarningsV10Env): NeonQuery | null { return env.PG ?? null; }
async function readBody(request: Request): Promise<Row | null> {
  try {
    const parsed: unknown = await request.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Row : null;
  } catch { return null; }
}
function field(value: Row, camel: string, snake: string): unknown {
  return value[camel] ?? value[snake];
}
function projectJson(row: Row): Row {
  const keys: Record<string, string> = {
    learner_id: "learnerId", learner_name: "learnerName", school_id: "schoolId", class_name: "className",
    title_normalized: "titleNormalized", qr_code: "qrCode", qr_data_url: "qrDataUrl", qr_storage_url: "qrStorageUrl",
    qr_payload: "qrPayload", qr_generated_at: "qrGeneratedAt", milestone_1_date: "milestone1Date",
    milestone_1_photo: "milestone1Photo", milestone_1_status: "milestone1Status",
    milestone_1_comment: "milestone1Comment", milestone_1_uploaded_at: "milestone1UploadedAt",
    milestone_1_approved_at: "milestone1ApprovedAt", milestone_1_rejected_at: "milestone1RejectedAt",
    milestone_2_date: "milestone2Date", milestone_2_photo: "milestone2Photo", milestone_2_status: "milestone2Status",
    milestone_2_comment: "milestone2Comment", milestone_2_uploaded_at: "milestone2UploadedAt",
    milestone_2_approved_at: "milestone2ApprovedAt", milestone_2_rejected_at: "milestone2RejectedAt",
    final_date: "finalDate", final_photo: "finalPhoto", final_status: "finalStatus", final_comment: "finalComment",
    final_uploaded_at: "finalUploadedAt", final_approved_at: "finalApprovedAt", final_rejected_at: "finalRejectedAt",
    completed_at: "completedAt", teacher_observed_tick: "teacherObservedTick", viva_audio_path: "vivaAudioPath",
    viva_audio_uploaded_at: "vivaAudioUploadedAt", viva_audio_milestone: "vivaAudioMilestone",
    verified_by: "verifiedBy", verified_at: "verifiedAt", similarity_flag: "similarityFlag",
    similarity_match_id: "similarityMatchId", similarity_reason: "similarityReason", similarity_score: "similarityScore",
    previous_title_check: "previousTitleCheck", previous_title_match: "previousTitleMatch",
    previous_title: "previousTitle", previous_term: "previousTerm", improvement_note: "improvementNote",
    previous_project_id: "previousProjectId", photo_hashes: "photoHashes", cleared_by: "clearedBy",
    cleared_at: "clearedAt", school_gps_lat: "schoolGpsLat", school_gps_lng: "schoolGpsLng",
    device_type: "deviceType", uploaded_from_connection: "uploadedFromConnection",
    created_at: "createdAt", updated_at: "updatedAt",
  };
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [keys[key] ?? key, value]));
}
function caJson(row: Row): Row {
  const names: Record<string, string> = {
    project_id: "projectId", learner_id: "learnerId", school_id: "schoolId", evidence_1: "evidence1",
    evidence_2: "evidence2", evidence_3: "evidence3", final_level: "finalLevel", teacher_id: "teacherId",
    synced_at: "syncedAt", created_at: "createdAt",
  };
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [names[key] ?? key, value]));
}
function visibleProject(user: AuthUser, project: Row): boolean {
  const role = roleOf(user);
  if (role === "superadmin") return true;
  const school = clean(project.school_id ?? project.schoolId);
  if (role === "student") return clean(project.learner_id ?? project.learnerId) === user.uid;
  if (!user.schoolId || school !== user.schoolId) return false;
  if (role === "teacher") return true;
  return role === "school";
}
function currentTerm(date = new Date()): string {
  const month = date.getUTCMonth() + 1;
  return `${date.getUTCFullYear()}-${month <= 4 ? "T1" : month <= 8 ? "T2" : "T3"}`;
}
function normalizedTitle(title: string): string { return title.toLowerCase().trim().replace(/\s+/g, " "); }
function similarity(leftText: string, rightText: string): number {
  const words = (value: string) => normalizedTitle(value).replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const vector = (value: string) => words(value).reduce<Record<string, number>>((result, word) => {
    result[word] = (result[word] ?? 0) + 1;
    return result;
  }, {});
  const left = vector(leftText);
  const right = vector(rightText);
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  let dot = 0, leftSize = 0, rightSize = 0;
  for (const key of keys) {
    const a = left[key] ?? 0, b = right[key] ?? 0;
    dot += a * b;
    leftSize += a * a;
    rightSize += b * b;
  }
  return leftSize && rightSize ? dot / (Math.sqrt(leftSize) * Math.sqrt(rightSize)) : 0;
}
function parsedPhotoHash(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().toLowerCase();
  if (/^[a-f0-9]{16,128}$/.test(raw)) return raw;
  try {
    const parsed = JSON.parse(value) as { hash?: unknown };
    return typeof parsed.hash === "string" && /^[a-f0-9]{16,128}$/i.test(parsed.hash) ? parsed.hash.toLowerCase() : null;
  } catch { return null; }
}
function hammingDistance(left: string, right: string): number {
  if (left.length !== right.length) return Number.POSITIVE_INFINITY;
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) {
    let value = Number.parseInt(left[index], 16) ^ Number.parseInt(right[index], 16);
    while (value) { distance += value & 1; value >>= 1; }
  }
  return distance;
}
async function sha256Hex(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function validPhoto(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname.endsWith(".r2.dev") || url.hostname.endsWith(".r2.cloudflarestorage.com"));
  } catch {
    return /^projects\/[a-zA-Z0-9_-]{1,120}\/[a-zA-Z0-9_-]{1,120}\/[a-zA-Z0-9_.-]{1,160}$/.test(value)
      && !value.includes("..");
  }
}
function milestoneCols(milestone: string) {
  if (milestone === "1") return { status: "milestone_1_status", photo: "milestone_1_photo", comment: "milestone_1_comment", approved: "milestone_1_approved_at", rejected: "milestone_1_rejected_at" };
  if (milestone === "2") return { status: "milestone_2_status", photo: "milestone_2_photo", comment: "milestone_2_comment", approved: "milestone_2_approved_at", rejected: "milestone_2_rejected_at" };
  if (milestone === "3" || milestone === "final") return { status: "final_status", photo: "final_photo", comment: "final_comment", approved: "final_approved_at", rejected: "final_rejected_at" };
  return null;
}
function projectIdFromPath(path: string): string | null {
  const match = path.match(/^\/api\/projects\/([^/]+)(?:\/(verify|viva-audio))?$/);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return ""; }
}
function safeSchool(user: AuthUser, schoolId: string): boolean {
  return roleOf(user) === "superadmin" || Boolean(user.schoolId && user.schoolId === schoolId);
}
async function queryOne<T extends Row>(pg: NeonQuery, sql: string, values: unknown[] = []): Promise<T | undefined> {
  return (await pg.query<T>(sql, values)).rows[0];
}
async function transaction<T>(pg: NeonQuery, fn: () => Promise<T>): Promise<T> {
  await pg.query("BEGIN");
  try {
    const value = await fn();
    await pg.query("COMMIT");
    return value;
  } catch (error) {
    try { await pg.query("ROLLBACK"); } catch { /* keep the original failure */ }
    throw error;
  }
}

async function earningsRoute(request: Request, env: ProjectsEarningsV10Env, user: AuthUser | null, path: string): Promise<Response> {
  const pg = db(env);
  if (!pg) return json({ ok: false, error: "Neon database is unavailable" }, 503);
  if (!user) return json({ ok: false, error: "Authentication is required" }, 401);
  const role = roleOf(user);
  if (path === "/api/earnings/sync") {
    if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
    if (!isTeacher(role) && role !== "superadmin") return json({ ok: false, error: "Only teachers can sync offline views" }, 403);
    const body = await readBody(request);
    if (!body) return json({ ok: false, error: "A valid JSON body is required" }, 400);
    const rawEvents = Array.isArray(body.events) ? body.events : Array.isArray(body.views) ? body.views : [body];
    if (rawEvents.length > 200) return json({ ok: false, error: "A maximum of 200 events can be synced at once" }, 413);
    let accepted = 0;
    let duplicates = 0;
    const errors: Array<{ eventId: string; error: string }> = [];
    for (const raw of rawEvents) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        errors.push({ eventId: "", error: "Invalid event" });
        continue;
      }
      const event = raw as Row;
      const eventId = clean(field(event, "eventId", "event_id") ?? field(event, "viewId", "view_id"), 180);
      const type = clean(field(event, "eventType", "event_type") ?? event.type ?? event.source, 50).toLowerCase();
      const teacherId = clean(field(event, "teacherId", "teacher_id"), 180);
      const studentId = clean(field(event, "studentId", "student_id"), 180);
      const viewId = clean(field(event, "viewId", "view_id") ?? eventId, 180);
      const videoId = clean(field(event, "videoId", "video_id") ?? field(event, "videoKey", "video_key"), 180);
      const completion = Number(field(event, "completionPercent", "completion_percent") ?? 0);
      const completed = event.completed === true || completion >= 90;
      if (!eventId || !/^[\w.-]+$/.test(eventId) || !viewId || !/^[\w.-]+$/.test(viewId)) {
        errors.push({ eventId: "", error: "A valid eventId and viewId are required" });
        continue;
      }
      if (type !== "offline_view") {
        errors.push({ eventId, error: "Only offline_view events are payable" });
        continue;
      }
      const watchedSeconds = Number(field(event, "watchedSeconds", "watched_seconds") ?? 0);
      if (!studentId || !videoId || !teacherId || teacherId !== user.uid || !completed || !Number.isFinite(completion) || completion < 0 || completion > 100
        || !Number.isFinite(watchedSeconds) || watchedSeconds < 0) {
        errors.push({ eventId, error: "A valid completed offline view for the signed-in teacher is required" });
        continue;
      }
      const suppliedSchool = clean(field(event, "schoolId", "school_id"), 180);
      if (role === "teacher" && (!user.schoolId || (suppliedSchool && suppliedSchool !== user.schoolId))) {
        errors.push({ eventId, error: "Offline view school must match the signed-in teacher" });
        continue;
      }
      if (role === "teacher") {
        const student = await queryOne<Row>(pg,
          "SELECT uid FROM public.users WHERE uid=$1 AND school_id=$2 AND active=1 AND disabled=0 LIMIT 1",
          [studentId, user.schoolId]);
        if (!student) {
          errors.push({ eventId, error: "Offline view learner is outside the teacher's school" });
          continue;
        }
      }
      try {
        const added = await transaction(pg, async () => {
          const inserted = await queryOne(pg, `
            INSERT INTO public.offline_views
              (id,event_id,view_id,student_id,teacher_id,video_id,school_id,device_type,connection_mode,
               watched_seconds,completion_percent,completed,earnings_amount,watched_at,synced_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE,100,$12,NOW())
            ON CONFLICT DO NOTHING RETURNING id
          `, [
            uid(), eventId, viewId, studentId, teacherId, videoId,
            suppliedSchool || clean(user.schoolId, 180) || null,
            clean(field(event, "deviceType", "device_type"), 40) || "unknown",
            clean(field(event, "connectionMode", "connection_mode"), 40) || "offline",
            Math.floor(watchedSeconds),
            Math.floor(completion), clean(field(event, "watchedAt", "watched_at"), 50) || new Date().toISOString(),
          ]);
          if (!inserted) return false;
          await pg.query(`
            INSERT INTO public.teacher_earnings (id,event_id,view_id,teacher_id,student_id,video_id,school_id,amount_ugx,paid,earned_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,100,FALSE,$8)
            ON CONFLICT (view_id) DO NOTHING
          `, [uid(), eventId, viewId, teacherId, studentId, videoId,
            suppliedSchool || clean(user.schoolId, 180) || null,
            clean(field(event, "watchedAt", "watched_at"), 50) || new Date().toISOString()]);
          return true;
        });
        if (added) accepted += 1;
        else duplicates += 1;
      } catch {
        errors.push({ eventId, error: "Offline view could not be saved" });
      }
    }
    return json({ ok: errors.length === 0, synced: accepted, duplicates, errors });
  }
  if (request.method !== "GET" && request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  if (!isTeacher(role) && role !== "superadmin") return json({ ok: false, error: "Only teachers can view earnings reports" }, 403);
  const reportBody = request.method === "POST" ? await readBody(request) ?? {} : {};
  const requestedTeacher = clean(new URL(request.url).searchParams.get("teacherId") ?? reportBody.teacherId, 180);
  const teacherId = role === "superadmin" && requestedTeacher ? requestedTeacher : user.uid;
  if (role !== "superadmin" && requestedTeacher && requestedTeacher !== user.uid) return json({ ok: false, error: "Forbidden" }, 403);
  const rows = (await pg.query<Row>(
    `SELECT v.*, COALESCE(e.amount_ugx,100) AS amount_ugx, COALESCE(e.paid,FALSE) AS paid
       FROM public.offline_views v LEFT JOIN public.teacher_earnings e ON e.view_id=v.view_id
      WHERE v.teacher_id=$1 ORDER BY v.watched_at DESC LIMIT 1000`, [teacherId],
  )).rows;
  const earnings = rows.reduce((sum, row) => sum + Number(row.amount_ugx ?? 0), 0);
  return json({ ok: true, teacherId, views: rows, summary: { viewCount: rows.length, earningsUgx: earnings, pendingUgx: rows.filter((row) => row.paid !== true).reduce((sum, row) => sum + Number(row.amount_ugx ?? 0), 0) } });
}

async function getProject(pg: NeonQuery, id: string): Promise<Row | undefined> {
  return queryOne(pg, "SELECT * FROM public.projects WHERE id=$1 LIMIT 1", [id]);
}
async function projectsRoute(request: Request, env: ProjectsEarningsV10Env, user: AuthUser | null, path: string): Promise<Response> {
  const pg = db(env);
  if (!pg) return json({ ok: false, error: "Neon database is unavailable" }, 503);
  if (!user) return json({ ok: false, error: "Authentication is required" }, 401);
  const role = roleOf(user);
  const url = new URL(request.url);
  const id = projectIdFromPath(path);
  const suffix = path.match(/^\/api\/projects\/[^/]+(?:\/(verify|viva-audio))?$/)?.[1] ?? "";
  if (path === "/api/projects") {
    if (request.method === "GET") {
      const rows = (await pg.query<Row>("SELECT * FROM public.projects ORDER BY created_at DESC LIMIT 2000")).rows;
      const visible = rows.filter((project) => visibleProject(user, project)
        && (!url.searchParams.get("school_id") || clean(project.school_id) === clean(url.searchParams.get("school_id")))
        && (!url.searchParams.get("className") && !url.searchParams.get("class_name") || clean(project.class_name) === clean(url.searchParams.get("className") ?? url.searchParams.get("class_name")))
        && (!url.searchParams.get("subject") || clean(project.subject) === clean(url.searchParams.get("subject"))));
      return json({ ok: true, projects: visible.map(projectJson) });
    }
    if (request.method === "PUT") {
      const input = await readBody(request);
      const projectId = clean(input?.projectId ?? input?.id ?? input?.project_id, 180);
      if (!input || !projectId || !/^[\w.-]+$/.test(projectId)) return json({ ok: false, error: "A valid projectId is required" }, 400);
      const target = `/api/projects/${encodeURIComponent(projectId)}`;
      return projectsRoute(new Request(new URL(target, request.url), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }), env, user, target);
    }
    if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
    if (!isLearner(role)) return json({ ok: false, error: "Only learners can create projects" }, 403);
    const input = await readBody(request);
    if (!input) return json({ ok: false, error: "A valid JSON body is required" }, 400);
    const title = clean(input.title, 101);
    const schoolId = clean(field(input, "schoolId", "school_id"), 180);
    const className = clean(field(input, "className", "class_name"), 100);
    const subject = clean(input.subject, 100);
    const description = clean(input.description, 300);
    const term = clean(input.term ?? currentTerm(), 20);
    const note = clean(field(input, "improvementNote", "improvement_note"), 500);
    if (!title || title.length > 100 || !schoolId || !className || !subject) return json({ ok: false, error: "schoolId, className, subject and title are required" }, 400);
    if (user.schoolId && schoolId !== user.schoolId) return json({ ok: false, error: "The project school must match your school account" }, 403);
    const normalized = normalizedTitle(title);
    const previous = await queryOne<Row>(pg,
      "SELECT id,title,term FROM public.projects WHERE learner_id=$1 AND COALESCE(title_normalized,lower(trim(title)))=$2 ORDER BY created_at DESC LIMIT 1",
      [user.uid, normalized]);
    if (previous && clean(previous.term) === term) return json({
      ok: false, code: "DUPLICATE_CURRENT_TERM", error: "This project title has already been used this term",
    }, 409);
    if (previous && clean(previous.term) !== term && note.length < 20) return json({
      ok: false, code: "PREVIOUS_TERM_REPEAT",
      error: "This title was used in a previous term. Add at least 20 characters explaining what is improved.",
      previousProjectId: previous.id, previousTitle: previous.title, previousTerm: previous.term, improvementRequired: true,
    }, 409);
    const projectId = uid();
    const now = new Date().toISOString();
    const existingLin = await queryOne<Row>(pg,
      "SELECT lin FROM public.projects WHERE learner_id=$1 AND lin IS NOT NULL ORDER BY created_at ASC LIMIT 1", [user.uid]);
    let lin = clean(existingLin?.lin ?? field(input, "lin", "lin"), 80)
      || `APSH-${schoolId.replace(/[^a-z0-9]/gi, "").slice(0, 6).toUpperCase() || "SCHOOL"}-${new Date().getUTCFullYear()}-${user.uid.slice(-6).toUpperCase()}`;
    const collision = await queryOne<Row>(pg, "SELECT learner_id FROM public.projects WHERE lin=$1 LIMIT 1", [lin]);
    if (collision && clean(collision.learner_id) !== user.uid) lin = `${lin}-${user.uid.slice(-6).toUpperCase()}`;
    const qrUnsigned = { version: 1, projectId, lin, learnerId: user.uid, schoolId, title, term, issuedAt: now };
    const qrHash = await sha256Hex(JSON.stringify(qrUnsigned));
    const qrCode = `APSHULE-QR-${qrHash.slice(0, 20).toUpperCase()}`;
    const qrPayload = JSON.stringify({ ...qrUnsigned, hash: qrHash });
    const photo = clean(input.photo, 500);
    if (photo && !validPhoto(photo)) return json({ ok: false, error: "Project evidence must use an approved R2 object key or HTTPS R2 URL" }, 400);
    const candidates = (await pg.query<Row>("SELECT id,title,description,learner_name FROM public.projects WHERE school_id=$1", [schoolId])).rows;
    const similar = candidates
      .map((candidate) => ({ candidate, score: similarity(`${title} ${description}`, `${clean(candidate.title)} ${clean(candidate.description)}`) }))
      .filter((entry) => entry.score >= 0.82)
      .sort((a, b) => b.score - a.score)[0];
    await pg.query(`
      INSERT INTO public.projects
        (id,learner_id,learner_name,school_id,class_name,subject,title,description,term,title_normalized,lin,
         qr_code,qr_payload,previous_title_check,previous_title_match,previous_title,previous_term,improvement_note,
         previous_project_id,similarity_flag,similarity_match_id,similarity_reason,similarity_score,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,TRUE,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$23)
    `, [projectId, user.uid, clean(user.displayName, 160) || user.uid, schoolId, className, subject, title,
      description || null, term, normalized, lin, qrCode, qrPayload, Boolean(previous),
      previous?.title ?? null, previous?.term ?? null, note || null, previous?.id ?? null,
      Boolean(similar), similar?.candidate.id ?? null,
      similar ? `Project text is ${(similar.score * 100).toFixed(0)}% similar to ${clean(similar.candidate.learner_name) || "another learner"}'s project` : null,
      similar?.score ?? null, now]);
    const project = await getProject(pg, projectId);
    return json({ ok: true, project: project ? projectJson(project) : { id: projectId } }, 201);
  }
  if (!id) return json({ ok: false, error: "Invalid project ID" }, 400);
  const project = await getProject(pg, id);
  if (!project || !visibleProject(user, project)) return json({ ok: false, error: "Project not found" }, 404);
  if (request.method === "GET" && !suffix) return json({ ok: true, project: projectJson(project) });
  if (suffix === "viva-audio") {
    if (request.method === "GET") {
      if (!project.viva_audio_path || !env.FILES) return json({ ok: false, error: "Viva audio not found" }, 404);
      const key = clean(project.viva_audio_path, 300);
      if (!validVivaKey(key, project)) return json({ ok: false, error: "Stored viva audio key is invalid" }, 409);
      const file = await env.FILES.get(key);
      if (!file?.body) return json({ ok: false, error: "Stored viva audio is unavailable" }, 404);
      const ext = key.split(".").pop() ?? "";
      const contentType = audioTypes[ext] ?? file.httpMetadata?.contentType ?? "application/octet-stream";
      return new Response(file.body, { headers: { "content-type": contentType, "content-disposition": "inline", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    }
    if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
    if (!isTeacher(role) || !safeSchool(user, clean(project.school_id))) return json({ ok: false, error: "Only a teacher in this school can upload viva audio" }, 403);
    if (!env.FILES) return json({ ok: false, error: "R2 file storage is unavailable" }, 503);
    const origin = request.headers.get("origin");
    if (!origin || origin !== new URL(request.url).origin) return json({ ok: false, error: "Uploads must come from this site" }, 403);
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(clean(project.school_id)) || !/^[a-zA-Z0-9_-]{1,120}$/.test(clean(project.id))) {
      return json({ ok: false, error: "Project storage scope is invalid" }, 409);
    }
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    const milestone = clean(form?.get("milestone") ?? "final", 12);
    if (!colsFor(milestone)) return json({ ok: false, error: "milestone must be 1, 2 or 3" }, 400);
    if (!(file instanceof File)) return json({ ok: false, error: "An audio file is required" }, 400);
    if (file.size <= 0 || file.size > 2 * 1024 * 1024) return json({ ok: false, error: "Viva audio must be between 1 byte and 2 MiB" }, 413);
    const ext = audioExtensions[file.type];
    if (!ext) return json({ ok: false, error: "Unsupported viva audio type" }, 415);
    const bytes = await file.arrayBuffer();
    if (!validAudioHeader(new Uint8Array(bytes), file.type)) return json({ ok: false, error: "Audio file contents do not match the declared media type" }, 415);
    const normalizedMilestone = milestone === "final" ? "3" : milestone;
    const key = `projects/${clean(project.school_id)}/${clean(project.id)}/viva/${normalizedMilestone}-${uid()}.${ext}`;
    try {
      await env.FILES.put(key, bytes, { httpMetadata: { contentType: file.type } });
      await pg.query("UPDATE public.projects SET viva_audio_path=$1,viva_audio_uploaded_at=NOW(),viva_audio_milestone=$2,updated_at=NOW() WHERE id=$3", [key, normalizedMilestone, id]);
    } catch {
      try { await env.FILES.delete?.(key); } catch { /* preserve the storage error response */ }
      return json({ ok: false, error: "Viva audio metadata could not be saved" }, 502);
    }
    return json({ ok: true, key, milestone: normalizedMilestone }, 201);
  }
  if (suffix === "verify" || (request.method === "PUT" && (isTeacher(role) || role === "superadmin"))) {
    if (request.method !== "PUT") return json({ ok: false, error: "Method not allowed" }, 405);
    if (!isTeacher(role) || !safeSchool(user, clean(project.school_id))) return json({ ok: false, error: "Only a teacher in this school can verify projects" }, 403);
    const input = await readBody(request);
    if (!input) return json({ ok: false, error: "A valid JSON body is required" }, 400);
    const milestone = clean(input.milestone ?? "final", 12);
    const cols = milestoneCols(milestone);
    if (!cols) return json({ ok: false, error: "milestone must be 1, 2 or 3" }, 400);
    const status = input.status === "approved" ? "approved" : input.status === "rejected" ? "rejected" : "";
    const comment = clean(input.comment, 500);
    const observed = Boolean(input.observed || input.teacherObservedTick || project.teacher_observed_tick);
    const approveWithoutViva = input.approveWithoutViva === true;
    if (!status && observed) {
      await pg.query("UPDATE public.projects SET teacher_observed_tick=TRUE,verified_by=$1,verified_at=NOW(),updated_at=NOW() WHERE id=$2", [user.uid, id]);
      return json({ ok: true, projectId: id, teacherObservedTick: true });
    }
    if (!status) return json({ ok: false, error: "status must be approved or rejected" }, 400);
    if (status === "rejected" && !comment) return json({ ok: false, error: "A rejection comment is required" }, 400);
    if (status === "approved" && !observed && !approveWithoutViva) return json({ ok: false, error: "Confirm that the student was observed or use the approve-without-viva override" }, 400);
    const vivaKey = clean(input.vivaAudioPath ?? input.viva_audio_path, 300);
    if (vivaKey && !validVivaKey(vivaKey, project)) {
      return json({ ok: false, error: "Viva audio must reference this project's R2 object" }, 400);
    }
    try {
      const updated = await transaction(pg, async () => {
        const locked = await queryOne<Row>(pg, "SELECT * FROM public.projects WHERE id=$1 FOR UPDATE", [id]);
        if (!locked || !visibleProject(user, locked)) return null;
        const timestamp = new Date().toISOString();
        await pg.query(`
          UPDATE public.projects SET ${cols.status}=$1,${cols.comment}=$2,${cols.approved}=$3,${cols.rejected}=$4,
            teacher_observed_tick=teacher_observed_tick OR $5,viva_audio_path=COALESCE($6,viva_audio_path),
            viva_audio_uploaded_at=CASE WHEN $6 IS NOT NULL THEN $8 ELSE viva_audio_uploaded_at END,
            viva_audio_milestone=CASE WHEN $6 IS NOT NULL THEN $9 ELSE viva_audio_milestone END,
            verified_by=$7,verified_at=$8,completed_at=CASE WHEN $1='approved' AND $9='3' THEN $8 ELSE completed_at END,
            updated_at=$8 WHERE id=$10
        `, [status, comment || null, status === "approved" ? timestamp : null, status === "rejected" ? timestamp : null,
          observed, vivaKey || null, user.uid, timestamp, milestone === "final" ? "3" : milestone, id]);
        if (status === "approved") {
          await pg.query(`
            INSERT INTO public.ca_records
              (id,project_id,milestone,learner_id,school_id,subject,competency,evidence_1,evidence_2,evidence_3,final_level,term,teacher_id)
            VALUES ($1,$2,$3,$4,$5,$6,'Project work and communication','Project milestone evidence',$7,$8,'Meets',$9,$10)
            ON CONFLICT (project_id,milestone) WHERE project_id IS NOT NULL DO NOTHING
          `, [uid(), id, milestone === "final" ? "3" : milestone, clean(locked.learner_id), clean(locked.school_id),
            clean(locked.subject), observed ? "Teacher observed" : "Teacher review override",
            `${milestone === "3" || milestone === "final" ? "Final" : `Milestone ${milestone}`} project photo`,
            clean(input.term ?? locked.term ?? currentTerm(), 20), user.uid]);
        }
        return true;
      });
      if (!updated) return json({ ok: false, error: "Project not found" }, 404);
      return json({ ok: true, projectId: id, milestone: milestone === "final" ? "3" : milestone, status });
    } catch {
      return json({ ok: false, error: "Project review could not be saved" }, 502);
    }
  }
  if (request.method !== "PUT") return json({ ok: false, error: "Method not allowed" }, 405);
  if (!isLearner(role) || clean(project.learner_id) !== user.uid) return json({ ok: false, error: "Only the project learner can update this project" }, 403);
  const input = await readBody(request);
  if (!input) return json({ ok: false, error: "A valid JSON body is required" }, 400);
  const photo = clean(input.photo ?? input.finalPhoto ?? input.final_photo, 500);
  if (!photo || !validPhoto(photo)) return json({ ok: false, error: "An approved R2 evidence object key or URL is required" }, 400);
  const milestone = clean(input.milestone ?? "final", 12);
  const cols = milestoneCols(milestone);
  if (!cols) return json({ ok: false, error: "milestone must be 1, 2 or 3" }, 400);
  const currentStatus = clean(project[cols.status]);
  const currentPhoto = clean(project[cols.photo]);
  if (currentStatus === "approved") return json({ ok: false, error: "Approved milestones are read-only" }, 409);
  if (currentStatus === "pending" && currentPhoto) return json({ ok: false, error: "This milestone is awaiting teacher approval" }, 409);
  if (milestone === "2" && clean(project.milestone_1_status) !== "approved") return json({ ok: false, error: "Complete Milestone 1 first" }, 409);
  if ((milestone === "3" || milestone === "final") && clean(project.milestone_2_status) !== "approved") return json({ ok: false, error: "Complete Milestone 2 first" }, 409);
  const dateColumn = milestone === "1" ? "milestone_1_date" : milestone === "2" ? "milestone_2_date" : "final_date";
  const uploadedColumn = milestone === "1" ? "milestone_1_uploaded_at" : milestone === "2" ? "milestone_2_uploaded_at" : "final_uploaded_at";
  const rejectedColumn = milestone === "1" ? "milestone_1_rejected_at" : milestone === "2" ? "milestone_2_rejected_at" : "final_rejected_at";
  const gpsLat = Number(field(input, "gpsLat", "gps_lat"));
  const gpsLng = Number(field(input, "gpsLng", "gps_lng"));
  const device = clean(field(input, "deviceType", "device_type"), 30);
  const connection = clean(field(input, "uploadedFromConnection", "uploaded_from_connection"), 30);
  const deviceType = ["phone", "tablet", "laptop", "desktop"].includes(device) ? device : null;
  const connectionType = ["offline", "mobile_data", "wifi"].includes(connection) ? connection : null;
  const photoHash = parsedPhotoHash(field(input, "photoHash", "photo_hash"));
  const schoolProjects = photoHash
    ? (await pg.query<Row>("SELECT id,learner_name,photo_hashes FROM public.projects WHERE school_id=$1", [project.school_id])).rows
    : [];
  const photoMatch = photoHash ? schoolProjects
    .filter((candidate) => clean(candidate.id) !== id)
    .flatMap((candidate) => (Array.isArray(candidate.photo_hashes) ? candidate.photo_hashes : [])
      .map((stored) => ({ candidate, hash: parsedPhotoHash(stored) }))
      .filter((entry): entry is { candidate: Row; hash: string } => Boolean(entry.hash)))
    .map((entry) => ({ ...entry, distance: hammingDistance(entry.hash, photoHash) }))
    .filter((entry) => entry.distance <= 6)
    .sort((left, right) => left.distance - right.distance)[0]
    : undefined;
  const hashEntry = photoHash ? JSON.stringify({ milestone, hash: photoHash, uploadedAt: new Date().toISOString() }) : null;
  const matchScore = photoMatch ? 1 - photoMatch.distance / 64 : null;
  await pg.query(`UPDATE public.projects SET ${dateColumn}=NOW(),${cols.photo}=$1,${cols.status}='pending',${uploadedColumn}=NOW(),${rejectedColumn}=NULL,
    school_gps_lat=$2,school_gps_lng=$3,device_type=$4,uploaded_from_connection=$5,
    photo_hashes=CASE WHEN $7::text IS NULL THEN photo_hashes ELSE array_append(photo_hashes,$7) END,
    similarity_flag=similarity_flag OR $8,similarity_match_id=COALESCE($9,similarity_match_id),
    similarity_reason=COALESCE($10,similarity_reason),similarity_score=GREATEST(COALESCE(similarity_score,0),COALESCE($11,0)),
    updated_at=NOW() WHERE id=$6`,
  [photo, Number.isFinite(gpsLat) ? gpsLat : null, Number.isFinite(gpsLng) ? gpsLng : null, deviceType, connectionType, id,
    hashEntry, Boolean(photoMatch), photoMatch?.candidate.id ?? null,
    photoMatch ? `Milestone ${milestone} photo is visually similar to ${clean(photoMatch.candidate.learner_name) || "another learner"}'s evidence` : null,
    matchScore]);
  const updated = await getProject(pg, id);
  return json({
    ok: true,
    project: updated ? projectJson(updated) : { id },
    similarityFlag: Boolean(project.similarity_flag || photoMatch),
    similarityMatchId: photoMatch?.candidate.id ?? project.similarity_match_id ?? null,
  });
}
function colsFor(milestone: string) { return milestoneCols(milestone); }
function validVivaKey(key: string, project: Row): boolean {
  const prefix = `projects/${clean(project.school_id)}/${clean(project.id)}/viva/`;
  return key.startsWith(prefix)
    && /^projects\/[a-zA-Z0-9_-]{1,120}\/[a-zA-Z0-9_-]{1,120}\/viva\/[123]-[0-9a-f-]{36}\.(?:webm|ogg|wav|mp3|m4a|aac)$/.test(key)
    && !key.includes("..");
}

const audioExtensions: Record<string, string> = {
  "audio/webm": "webm", "audio/ogg": "ogg", "audio/wav": "wav", "audio/x-wav": "wav",
  "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a", "audio/aac": "aac",
};
const audioTypes: Record<string, string> = {
  webm: "audio/webm", ogg: "audio/ogg", wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac",
};
function validAudioHeader(bytes: Uint8Array, type: string): boolean {
  if (type === "audio/webm") return bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  if (type === "audio/ogg") return bytes.length >= 4 && new TextDecoder().decode(bytes.slice(0, 4)) === "OggS";
  if (type === "audio/wav" || type === "audio/x-wav") return bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WAVE";
  if (type === "audio/mpeg" || type === "audio/mp3") return bytes.length >= 3 && (new TextDecoder().decode(bytes.slice(0, 3)) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0));
  if (type === "audio/mp4") return bytes.length >= 8 && new TextDecoder().decode(bytes.slice(4, 8)) === "ftyp";
  if (type === "audio/aac") return bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0;
  return false;
}

async function complianceCaRoute(request: Request, env: ProjectsEarningsV10Env, user: AuthUser | null, path: string): Promise<Response> {
  const pg = db(env);
  if (!pg) return json({ ok: false, error: "Neon database is unavailable" }, 503);
  if (!user) return json({ ok: false, error: "Authentication is required" }, 401);
  const role = roleOf(user);
  const url = new URL(request.url);
  const queryRecords = async () => {
    if (role === "superadmin") return (await pg.query<Row>("SELECT * FROM public.ca_records ORDER BY created_at DESC LIMIT 5000")).rows;
    if (role === "student") return (await pg.query<Row>("SELECT * FROM public.ca_records WHERE learner_id=$1 ORDER BY created_at DESC", [user.uid])).rows;
    if (role === "teacher" && user.schoolId) return (await pg.query<Row>("SELECT * FROM public.ca_records WHERE school_id=$1 AND teacher_id=$2 ORDER BY created_at DESC", [user.schoolId, user.uid])).rows;
    if (role === "school" && user.schoolId) return (await pg.query<Row>("SELECT * FROM public.ca_records WHERE school_id=$1 ORDER BY created_at DESC", [user.schoolId])).rows;
    return [];
  };
  if (path === "/api/compliance" || path === "/api/compliance/summary") {
    if (request.method === "GET") {
      const records = await queryRecords();
      const projects = role === "student"
        ? (await pg.query<Row>("SELECT * FROM public.projects WHERE learner_id=$1", [user.uid])).rows
        : user.schoolId && (role === "teacher" || role === "school")
          ? (await pg.query<Row>("SELECT * FROM public.projects WHERE school_id=$1", [user.schoolId])).rows
          : role === "superadmin" ? (await pg.query<Row>("SELECT * FROM public.projects")).rows : [];
      const requestedTerm = clean(url.searchParams.get("term"), 20);
      const filtered = records.filter((row) => !requestedTerm || clean(row.term) === requestedTerm);
      const counts: Record<string, number> = {};
      for (const row of filtered) counts[clean(row.final_level)] = (counts[clean(row.final_level)] ?? 0) + 1;
      return json({ ok: true, records: filtered.map(caJson), projects: projects.filter((project) => visibleProject(user, project)).map(projectJson), summary: { totalRecords: filtered.length, levels: counts, totalProjects: projects.length } });
    }
    if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
    if (!isTeacher(role) || !user.schoolId) return json({ ok: false, error: "Only school teachers can submit competency assessments" }, 403);
    const input = await readBody(request);
    if (!input) return json({ ok: false, error: "A valid JSON body is required" }, 400);
    const learnerId = clean(field(input, "learnerId", "learner_id"), 180);
    const schoolId = clean(field(input, "schoolId", "school_id") ?? user.schoolId, 180);
    const subject = clean(input.subject, 100);
    const competency = clean(input.competency, 200);
    const term = clean(input.term ?? currentTerm(), 20);
    if (!learnerId || !schoolId || !subject || !competency || !term) return json({ ok: false, error: "learnerId, schoolId, subject, competency and term are required" }, 400);
    if (schoolId !== user.schoolId) return json({ ok: false, error: "Assessment school must match your school" }, 403);
    const learner = await queryOne<Row>(pg,
      "SELECT uid FROM public.users WHERE uid=$1 AND school_id=$2 AND active=1 AND disabled=0 LIMIT 1",
      [learnerId, schoolId]);
    if (!learner) return json({ ok: false, error: "Learner is outside your school" }, 403);
    const quiz = Number(input.evidence1 ?? 0);
    if (!Number.isFinite(quiz) || quiz < 0 || quiz > 100) return json({ ok: false, error: "evidence1 must be between 0 and 100" }, 400);
    const observed = Boolean(input.evidence2);
    const hasProject = Boolean(input.evidence3);
    const points = (quiz >= 80 ? 2 : quiz >= 50 ? 1 : 0) + (observed ? 1 : 0) + (hasProject ? 1 : 0);
    const finalLevel = points >= 4 ? "Exceeds" : points >= 3 ? "Meets" : points >= 1 ? "Approaching" : "Needs Support";
    const record = {
      id: uid(), learnerId, schoolId, subject, competency, evidence1: String(quiz),
      evidence2: observed ? "Observed" : "Not observed", evidence3: hasProject ? "Project evidence" : "No project evidence",
      finalLevel, term, teacherId: user.uid,
    };
    await pg.query(`
      INSERT INTO public.ca_records
        (id,learner_id,school_id,subject,competency,evidence_1,evidence_2,evidence_3,final_level,term,teacher_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    `, [record.id, learnerId, schoolId, subject, competency, record.evidence1, record.evidence2, record.evidence3, finalLevel, term, user.uid]);
    return json({ ok: true, record }, 201);
  }
  if (path === "/api/ca_records" || path === "/api/ca_records/export") {
    const exportPath = path.endsWith("/export");
    if (request.method === "GET") {
      const requestedLearner = clean(url.searchParams.get("learner_id") ?? url.searchParams.get("learnerId"), 180);
      let rows = await queryRecords();
      if (requestedLearner) {
        if (role === "student" && requestedLearner !== user.uid) return json({ ok: false, error: "Forbidden" }, 403);
        if (role === "teacher") rows = rows.filter((row) => clean(row.learner_id) === requestedLearner);
      }
      const term = clean(url.searchParams.get("term"), 20);
      rows = rows.filter((row) => !term || clean(row.term) === term);
      if (exportPath) {
        const columns = ["id", "learner_id", "school_id", "subject", "competency", "evidence_1", "evidence_2", "evidence_3", "final_level", "term", "teacher_id"];
        const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
        const csv = [columns.join(","), ...rows.map((row) => columns.map((column) => escape(row[column])).join(","))].join("\r\n");
        return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=\"ca_records.csv\"", "cache-control": "no-store" } });
      }
      return json({ ok: true, records: rows.map(caJson) });
    }
    if (exportPath) return json({ ok: false, error: "Method not allowed" }, 405);
    if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
    if (!isTeacher(role) || !user.schoolId) return json({ ok: false, error: "Only school teachers can create CA records" }, 403);
    const input = await readBody(request);
    if (!input) return json({ ok: false, error: "A valid JSON body is required" }, 400);
    const learnerId = clean(field(input, "learnerId", "learner_id"), 180);
    const schoolId = clean(field(input, "schoolId", "school_id") ?? user.schoolId, 180);
    const subject = clean(input.subject, 100);
    const competency = clean(input.competency, 200);
    const evidence1 = clean(field(input, "evidence1", "evidence_1"), 500);
    const evidence2 = clean(field(input, "evidence2", "evidence_2"), 500);
    const evidence3 = clean(field(input, "evidence3", "evidence_3"), 500);
    const finalLevel = clean(field(input, "finalLevel", "final_level"), 40);
    const term = clean(input.term ?? currentTerm(), 20);
    if (!learnerId || !subject || !competency || !evidence1 || !evidence2 || !evidence3 || !finalLevel || !term) return json({ ok: false, error: "Learner, subject, competency, three evidence fields, finalLevel and term are required" }, 400);
    if (schoolId !== user.schoolId) return json({ ok: false, error: "CA record school must match your school" }, 403);
    const learner = await queryOne<Row>(pg,
      "SELECT uid FROM public.users WHERE uid=$1 AND school_id=$2 AND active=1 AND disabled=0 LIMIT 1",
      [learnerId, schoolId]);
    if (!learner) return json({ ok: false, error: "Learner is outside your school" }, 403);
    if (!["Exceeds", "Meets", "Approaching", "Needs Support"].includes(finalLevel)) return json({ ok: false, error: "Invalid finalLevel" }, 400);
    const id = uid();
    await pg.query("INSERT INTO public.ca_records(id,learner_id,school_id,subject,competency,evidence_1,evidence_2,evidence_3,final_level,term,teacher_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [id, learnerId, schoolId, subject, competency, evidence1, evidence2, evidence3, finalLevel, term, user.uid]);
    return json({ ok: true, record: { id, learnerId, schoolId, subject, competency, evidence1, evidence2, evidence3, finalLevel, term, teacherId: user.uid } }, 201);
  }
  return json({ ok: false, error: "Unknown compliance route" }, 404);
}

/**
 * Standalone Worker handler for earnings, project and competency routes.
 * Return null for paths not owned by this module so the main Worker can continue routing.
 */
export async function handleProjectsEarningsV10Route(
  request: Request,
  env: ProjectsEarningsV10Env,
  user: AuthUser | null,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  try {
    if (pathname === "/api/earnings/sync" || pathname === "/api/earnings/report") return await earningsRoute(request, env, user, pathname);
    if (pathname === "/api/projects" || /^\/api\/projects\/[^/]+(?:\/(?:verify|viva-audio))?$/.test(pathname)) return await projectsRoute(request, env, user, pathname);
    if (["/api/compliance", "/api/compliance/summary", "/api/ca_records", "/api/ca_records/export"].includes(pathname)) return await complianceCaRoute(request, env, user, pathname);
    return null;
  } catch {
    return json({ ok: false, error: "Neon request could not be completed" }, 503);
  }
}