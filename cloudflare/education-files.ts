import type { AuthEnv, AuthUser } from "./backend-types";

interface R2Object { body: ReadableStream; }
interface R2Bucket {
  put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<R2Object | null>;
  delete(key: string): Promise<unknown>;
}
export interface EducationFileEnv extends AuthEnv { FILES?: R2Bucket; }
type Row = Record<string, unknown>;
const MAX_BYTES = 8 * 1024 * 1024;
const clean = (v: unknown, max = 200) => String(v ?? "").trim().slice(0, max);
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const scope = (u: AuthUser) => u.schoolId
  ? { sql: "(school_id=? OR (school_id IS NULL AND institution_id=?))", args: [u.schoolId, u.institutionId || ""] }
  : { sql: "institution_id=?", args: [u.institutionId || ""] };
const role = (u: AuthUser) => {
  const value = clean(u.role, 80).toLowerCase().replace(/[ -]+/g, "_");
  if (value === "super_admin") return "superadmin";
  if (["teacher_staff", "teacher_independent"].includes(value)) return "teacher";
  if (["school_admin", "school", "head_teacher"].includes(value)) return "headteacher";
  if (value === "accountant") return "bursar";
  if (value === "individual") return "student";
  if (value === "guardian") return "parent";
  return value;
};
async function caps(env: EducationFileEnv, u: AuthUser) {
  if (role(u) === "superadmin") return true;
  const rows = await env.DB.prepare("SELECT capability FROM role_capabilities WHERE lower(role)=? AND sector='education'")
    .bind(role(u)).all<{ capability: string }>();
  return rows.results.some((r) => r.capability === "lessons.manage" || r.capability === "*");
}
async function teacherAssigned(env: EducationFileEnv, u: AuthUser, lesson: Row) {
  if (role(u) === "superadmin") return true;
  const sc = scope(u);
  const rows = await env.DB.prepare(
    "SELECT record_json FROM sector_records WHERE sector='education' AND record_type='teacher_assignment' AND " + sc.sql + " LIMIT 500",
  ).bind(...sc.args).all<Row>();
  return rows.results.some((r) => {
    try {
      const raw = JSON.parse(String(r.record_json)) as Row;
      const x = raw.data && typeof raw.data === "object" ? { ...raw.data as Row, ...raw } : raw;
      const uid = clean(x.teacherUid || x.teacher_uid || x.teacherId || x.teacher_id);
      const email = clean(x.teacherEmail || x.teacher_email).toLowerCase();
      const ownsAssignment = Boolean(u.uid && uid === u.uid) ||
        Boolean(u.email && email && email === clean(u.email).toLowerCase());
      return ownsAssignment &&
        clean(x.className || x.class_name || x.class).toLowerCase() === clean(lesson.class_name).toLowerCase() &&
        clean(x.subject || x.subjectName || x.subject_name).toLowerCase() === clean(lesson.subject).toLowerCase();
    } catch { return false; }
  });
}
async function canLesson(env: EducationFileEnv, u: AuthUser, lesson: Row, write = false) {
  const r = role(u);
  const sc = scope(u);
  if (r === "superadmin") return true;
  const sameTenant = (record: Row) =>
    clean(record.school_id) === clean(lesson.school_id) &&
    clean(record.institution_id) === clean(lesson.institution_id);
  const inUserScope = u.schoolId
    ? clean(lesson.school_id) === clean(u.schoolId) &&
      (!u.institutionId || clean(lesson.institution_id) === clean(u.institutionId)) ||
      (!clean(lesson.school_id) && Boolean(u.institutionId) && clean(lesson.institution_id) === clean(u.institutionId))
    : Boolean(u.institutionId) && clean(lesson.institution_id) === clean(u.institutionId);
  if (write) {
    if (!inUserScope) return false;
    if (r === "teacher") return Boolean(u.uid && clean(lesson.owner_uid) === u.uid) && await teacherAssigned(env, u, lesson);
    return await caps(env, u);
  }
  if (r === "teacher") return inUserScope && await teacherAssigned(env, u, lesson);
  if (["secretary", "headteacher", "bursar"].includes(r)) return inUserScope && await caps(env, u);
  if (["student", "learner"].includes(r)) {
    if (Number(lesson.published) !== 1) return false;
    const userHasScope = Boolean(u.schoolId || u.institutionId);
    const scopeFilter = userHasScope ? ` AND ${sc.sql}` : "";
    const learners = await env.DB.prepare(
      "SELECT id,record_json,owner_uid,school_id,institution_id FROM sector_records WHERE sector='education' AND record_type IN ('learner','student') AND is_deleted=0" + scopeFilter,
    ).bind(...(userHasScope ? sc.args : [])).all<Row>();
    const matches = learners.results.filter((x) => {
      try {
        const raw = JSON.parse(String(x.record_json)) as Row;
        const d = raw.data && typeof raw.data === "object" ? { ...raw.data as Row, ...raw } : raw;
        const identityValues = [
          d.uid, d.userId, d.user_id, d.ownerUid, d.owner_uid, d.studentUid, d.student_uid,
          d.studentId, d.student_id, d.learnerUid, d.learner_uid, d.learnerId, d.learner_id,
        ].map((v) => clean(v)).filter(Boolean);
        const emailValues = [d.email, d.studentEmail, d.student_email, d.learnerEmail, d.learner_email]
          .map((v) => clean(v).toLowerCase()).filter(Boolean);
        const identity = Boolean(u.uid && (clean(x.owner_uid) === u.uid || clean(x.id) === u.uid || identityValues.includes(u.uid))) ||
          Boolean(u.email && emailValues.includes(clean(u.email).toLowerCase()));
        return identity;
      } catch { return false; }
    });
    const scopes = new Set(matches.map((x) => `${clean(x.institution_id)}\u0000${clean(x.school_id)}`));
    if (scopes.size !== 1) return false;
    return matches.some((x) => sameTenant(x) &&
      (() => {
        try {
          const raw = JSON.parse(String(x.record_json)) as Row;
          const d = raw.data && typeof raw.data === "object" ? { ...raw.data as Row, ...raw } : raw;
          return clean(d.className || d.class_name || d.class).toLowerCase() === clean(lesson.class_name).toLowerCase();
        } catch { return false; }
      })());
  }
  if (r === "parent") {
    const learners = await env.DB.prepare(
      "SELECT s.id,s.record_json FROM sector_records s JOIN parent_links p ON p.learner_id=s.id " +
      "WHERE s.sector='education' AND s.record_type IN ('learner','student') AND s.is_deleted=0 " +
      "AND p.parent_uid=? AND p.active=1 AND p.institution_id IS s.institution_id AND p.school_id IS s.school_id " +
      "AND p.institution_id IS ? AND p.school_id IS ?",
    ).bind(u.uid, lesson.institution_id ?? null, lesson.school_id ?? null).all<Row>();
    return learners.results.some((x) => {
      try {
        const raw = JSON.parse(String(x.record_json)) as Row;
        const d = raw.data && typeof raw.data === "object" ? { ...raw.data as Row, ...raw } : raw;
        return Number(lesson.published) === 1 &&
          clean(d.className || d.class_name || d.class).toLowerCase() === clean(lesson.class_name).toLowerCase();
      } catch { return false; }
    });
  }
  return false;
}
function safeFilename(name: string) {
  const base = name.replace(/[/\\\0-\x1f]/g, "_").replace(/[^\w .-]/g, "_").trim().slice(0, 120) || "lesson.pdf";
  return base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`;
}
export async function handleEducationFileRoute(request: Request, env: EducationFileEnv, user: AuthUser, pathname: string): Promise<Response> {
  const match = pathname.match(/^\/api\/school\/lessons\/([^/]+)\/files(?:\/([^/]+))?$/);
  if (!match) return json({ ok: false, error: "Unknown education file route" }, 404);
  let lessonId = "", fileId = "";
  try {
    lessonId = decodeURIComponent(match[1]);
    fileId = match[2] ? decodeURIComponent(match[2]) : "";
  } catch {
    return json({ ok: false, error: "Invalid education file route" }, 400);
  }
  const lesson = (await env.DB.prepare("SELECT * FROM education_lessons WHERE id=? LIMIT 1").bind(lessonId).all<Row>()).results[0];
  if (!lesson) return json({ ok: false, error: "Lesson not found" }, 404);
  const write = request.method !== "GET";
  if (!await canLesson(env, user, lesson, write)) return json({ ok: false, error: "Forbidden" }, 403);
  if (request.method === "GET") {
    const file = (await env.DB.prepare("SELECT * FROM education_files WHERE id=? AND lesson_id=? LIMIT 1").bind(fileId, lessonId).all<Row>()).results[0];
    if (!file || !env.FILES) return json({ ok: false, error: "File not found" }, 404);
    const object = await env.FILES.get(clean(file.object_key)); if (!object?.body) return json({ ok: false, error: "Stored file is unavailable" }, 404);
    return new Response(object.body, { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${safeFilename(clean(file.filename))}"`, "cache-control": "no-store" } });
  }
  if (request.method === "DELETE") {
    if (!fileId) return json({ ok: false, error: "File ID is required" }, 400);
    if (!env.FILES) return json({ ok: false, error: "File storage is unavailable" }, 503);
    const file = (await env.DB.prepare("SELECT object_key FROM education_files WHERE id=? AND lesson_id=?").bind(fileId, lessonId).all<Row>()).results[0];
    if (!file) return json({ ok: false, error: "File not found" }, 404);
    try {
      await env.FILES.delete(clean(file.object_key));
      await env.DB.prepare("DELETE FROM education_files WHERE id=? AND lesson_id=?").bind(fileId, lessonId).run();
    } catch { return json({ ok: false, error: "File deletion failed" }, 502); }
    return json({ ok: true, deleted: true });
  }
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  if (!env.FILES) return json({ ok: false, error: "File storage is unavailable" }, 503);
  const origin = request.headers.get("origin"); if (!origin || origin !== new URL(request.url).origin) return json({ ok: false, error: "Uploads must come from this site" }, 403);
  const form = await request.formData().catch(() => null); const file = form?.get("file");
  if (!(file instanceof File) || file.type !== "application/pdf") return json({ ok: false, error: "A PDF file is required" }, 415);
  if (file.size > MAX_BYTES) return json({ ok: false, error: "PDF files must be 8 MiB or smaller" }, 413);
  const raw = await file.arrayBuffer(); const head = new Uint8Array(raw).slice(0, 5);
  if (new TextDecoder().decode(head) !== "%PDF-") return json({ ok: false, error: "The file is not a valid PDF" }, 415);
  const digest = await crypto.subtle.digest("SHA-256", raw); const sha = [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
  const id = crypto.randomUUID();
  const key = `education/${clean(lesson.institution_id || "tenant")}/${lessonId}/${sha}-${id}.pdf`;
  const ts = new Date().toISOString();
  try {
    await env.FILES.put(key, raw, { httpMetadata: { contentType: "application/pdf" } });
    await env.DB.prepare("INSERT INTO education_files(id,lesson_id,institution_id,school_id,object_key,filename,content_type,size_bytes,sha256,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .bind(id, lessonId, lesson.institution_id, lesson.school_id, key, safeFilename(file.name), "application/pdf", raw.byteLength, sha, user.uid, ts).run();
  } catch {
    try { if (env.FILES.delete) await env.FILES.delete(key); } catch { /* preserve the explicit upload failure */ }
    return json({ ok: false, error: "File upload metadata could not be saved" }, 502);
  }
  return json({ ok: true, file: { id, lessonId, filename: safeFilename(file.name), sizeBytes: raw.byteLength } }, 201);
}