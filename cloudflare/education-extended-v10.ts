import type { AuthEnv, AuthUser } from "./backend-types";

type Row = Record<string, unknown>;
type EducationExtendedEnv = AuthEnv & { GEMINI_API_KEY?: string };

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  },
});
const clean = (value: unknown, max: number) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
const now = () => new Date().toISOString();
const MAX_BODY_BYTES = 24 * 1024;
const DB_TIMEOUT_MS = 8_000;
const GEMINI_TIMEOUT_MS = 20_000;
const isTooLong = (value: unknown, limit: number) => typeof value === "string" && value.length > limit;

function db(env: EducationExtendedEnv) {
  if (!env.PG) throw new Error("database_unavailable");
  return env.PG;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("request_timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function query<T extends Row>(
  env: EducationExtendedEnv,
  statement: string,
  values: unknown[] = [],
) {
  return withTimeout(db(env).query<T>(statement, values), DB_TIMEOUT_MS);
}

async function readJson(request: Request): Promise<Row | null> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_BODY_BYTES) throw new Error("request_too_large");
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("request_too_large");
    }
    chunks.push(value);
  }
  const text = new TextDecoder().decode(
    chunks.reduce((all, chunk) => {
      const joined = new Uint8Array(all.length + chunk.length);
      joined.set(all);
      joined.set(chunk, all.length);
      return joined;
    }, new Uint8Array()),
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("invalid_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_json");
  return parsed as Row;
}

function role(user: AuthUser) {
  return clean(user.role, 50).toLowerCase().replace(/[ -]+/g, "_");
}
const teacherRole = (user: AuthUser) => ["teacher", "teacher_staff", "teacher_independent"].includes(role(user));
const adminRole = (user: AuthUser) => ["superadmin", "super_admin"].includes(role(user));
const schoolAdminRole = (user: AuthUser) => ["school", "school_admin", "headteacher", "head_teacher"].includes(role(user));
const sectorStaffRole = (user: AuthUser) => {
  const currentRole = role(user);
  return currentRole.includes("clinic") || currentRole.includes("farm") ||
    currentRole.includes("mfi") || currentRole.includes("microfinance") ||
    ["doctor", "nurse", "pharmacist", "clinician", "health_worker", "farmer", "field_officer", "loan_officer", "loan_manager", "borrower"].includes(currentRole);
};

function accessError(user: AuthUser | null, teachersOnly = false): Response | null {
  if (!user) return json({ ok: false, error: "A valid APSHULE login is required" }, 401);
  if (teachersOnly && !teacherRole(user) && !adminRole(user)) {
    return json({ ok: false, error: "Teacher access is required" }, 403);
  }
  return null;
}

function validDbString(value: unknown, max: number) {
  return typeof value === "string" && value.length <= max;
}

function validCurriculumRow(row: Row) {
  return validDbString(row.id, 160) &&
    validDbString(row.subject, 120) &&
    validDbString(row.class_level, 80) &&
    validDbString(row.topic, 300) &&
    validDbString(row.syllabus_ref, 300) &&
    (row.learner_book_page === null || validDbString(row.learner_book_page, 100)) &&
    (row.teacher_guide_page === null || validDbString(row.teacher_guide_page, 100)) &&
    validDbString(row.summary_text, 8000) &&
    (row.activity_suggestion === null || validDbString(row.activity_suggestion, 4000));
}

function validUnebRow(row: Row) {
  return validDbString(row.id, 160) &&
    validDbString(row.subject, 120) &&
    validDbString(row.class_level, 80) &&
    validDbString(row.topic, 300) &&
    validDbString(row.scenario_text, 12000) &&
    validDbString(row.competency, 2000) &&
    validDbString(row.marking_grid, 8000) &&
    (row.source_year == null || Number.isInteger(Number(row.source_year)));
}

function validProgressRow(row: Row) {
  return validDbString(row.id, 160) &&
    validDbString(row.teacher_id, 160) &&
    (row.school_id === null || validDbString(row.school_id, 160)) &&
    typeof row.module_id === "string" &&
    /^(10|[1-9])$/.test(row.module_id) &&
    typeof row.completed === "boolean" &&
    (row.quiz_score === null || (Number.isInteger(Number(row.quiz_score)) && Number(row.quiz_score) >= 0 && Number(row.quiz_score) <= 5)) &&
    typeof row.certificate_issued === "boolean" &&
    (row.practical_upload_path === null || validDbString(row.practical_upload_path, 500));
}

function sectorFor(user: AuthUser, requested: unknown) {
  const supplied = clean(requested, 30).toLowerCase();
  if (supplied && ["education", "mfi", "clinic", "farm"].includes(supplied)) return supplied;
  const currentRole = role(user);
  if (currentRole.includes("clinic") || ["doctor", "nurse", "pharmacist", "clinician", "health_worker"].includes(currentRole)) return "clinic";
  if (currentRole.includes("farm") || ["farmer", "field_officer"].includes(currentRole)) return "farm";
  if (currentRole.includes("mfi") || currentRole.includes("microfinance") || ["loan_officer", "loan_manager", "borrower"].includes(currentRole)) return "mfi";
  return "education";
}

async function generateGemini(
  env: EducationExtendedEnv,
  prompt: string,
  maxOutputTokens: number,
): Promise<string> {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("gemini_not_configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens, temperature: 0.35 },
        }),
      },
    );
    const responseText = await readTextLimited(response, 80_000);
    let data: unknown;
    try {
      data = JSON.parse(responseText);
    } catch {
      throw new Error("gemini_response_invalid");
    }
    if (!response.ok) throw new Error("gemini_request_failed");
    if (!data || typeof data !== "object") throw new Error("gemini_response_invalid");
    const candidates = (data as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> }).candidates;
    const content = candidates?.[0]?.content?.parts
      ?.map((part) => typeof part.text === "string" ? part.text : "")
      .join("")
      .trim();
    if (!content || content.length > 30_000) throw new Error("gemini_response_invalid");
    return content;
  } finally {
    clearTimeout(timer);
  }
}

async function readTextLimited(response: Response, limit: number) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel();
      throw new Error("gemini_response_invalid");
    }
    text += decoder.decode(value, { stream: true });
  }
}

async function geminiRoute(request: Request, env: EducationExtendedEnv, user: AuthUser, pathname: string) {
  if (!teacherRole(user) && !adminRole(user) && !sectorStaffRole(user)) {
    return json({ ok: false, error: "A teacher or sector staff account is required" }, 403);
  }
  let body: Row;
  try {
    body = (await readJson(request)) ?? {};
  } catch (error) {
    return json({ ok: false, error: error instanceof Error && error.message === "request_too_large" ? "Request body is too large" : "A valid JSON body is required" }, error instanceof Error && error.message === "request_too_large" ? 413 : 400);
  }
  const sector = sectorFor(user, body.sector);
  let prompt = "";
  let tokens = 2048;
  if (pathname === "/api/gemini/activity") {
    if (isTooLong(body.topic, 240) || isTooLong(body.subject, 120) ||
        isTooLong(body.classLevel ?? body.class_level, 80) ||
        isTooLong(body.syllabusRef ?? body.syllabus_ref, 200) ||
        [body.competencies, body.genericSkills].some((list) =>
          Array.isArray(list) && (list.length > 8 || list.some((value) => isTooLong(value, 120)))) ||
        (Array.isArray(body.values) && (body.values.length > 8 || body.values.some((value) => isTooLong(value, 100))))) {
      return json({ ok: false, error: "Activity input contains fields that are too long" }, 400);
    }
    const topic = clean(body.topic, 240);
    const subject = clean(body.subject, 120);
    const classLevel = clean(body.classLevel ?? body.class_level, 80);
    const syllabusRef = clean(body.syllabusRef ?? body.syllabus_ref, 200);
    const competencies = Array.isArray(body.competencies) ? body.competencies.slice(0, 8).map((value) => clean(value, 120)).filter(Boolean).join(", ") : "";
    const skills = Array.isArray(body.genericSkills) ? body.genericSkills.slice(0, 8).map((value) => clean(value, 120)).filter(Boolean).join(", ") : "";
    const values = Array.isArray(body.values) ? body.values.slice(0, 8).map((value) => clean(value, 100)).filter(Boolean).join(", ") : "";
    if (!topic || !subject || !classLevel) return json({ ok: false, error: "topic, subject, and classLevel are required" }, 400);
    prompt = `You are an expert in the ${sector} sector and a Ugandan CBC educator. Create a practical competency-based classroom activity.\nTopic: ${topic}\nSubject: ${subject}\nClass: ${classLevel}\nSyllabus reference (cite only if supplied): ${syllabusRef || "Not supplied"}\nKnown competencies: ${competencies || "Select suitable competencies"}\nGeneric skills: ${skills || "communication, collaboration, critical thinking"}\nValues: ${values || "responsibility, cooperation, respect"}\nInclude a locally relevant scenario, learning steps, assessment criteria, and reflection. Do not invent citations.`;
  } else if (pathname === "/api/gemini/lesson-plan") {
    if (isTooLong(body.subject, 120) || isTooLong(body.classLevel ?? body.class_level, 80) ||
        isTooLong(body.topic, 240) || isTooLong(body.duration, 60) ||
        isTooLong(body.syllabusRef ?? body.syllabus_ref, 200)) {
      return json({ ok: false, error: "Lesson plan input contains fields that are too long" }, 400);
    }
    const subject = clean(body.subject, 120);
    const classLevel = clean(body.classLevel ?? body.class_level, 80);
    const topic = clean(body.topic, 240);
    const duration = clean(body.duration, 60);
    const syllabusRef = clean(body.syllabusRef ?? body.syllabus_ref, 200);
    if (!subject || !classLevel || !topic || !duration) {
      return json({ ok: false, error: "subject, classLevel, topic, and duration are required" }, 400);
    }
    tokens = 4096;
    prompt = `You are a Ugandan CBC expert working in the ${sector} sector. Generate a printable NCDC-format lesson plan in clear plain text.\nSubject: ${subject}\nClass: ${classLevel}\nTopic: ${topic}\nDuration: ${duration}\nSyllabus reference (cite only if supplied): ${syllabusRef || "Not supplied"}\nInclude learning outcomes, competency, values, generic skills, prior knowledge, materials, teacher activities, learner activities, assessment, and reflection. Never invent page citations.`;
  } else {
    if (isTooLong(body.text ?? body.content, 10_000) ||
        isTooLong(body.targetLanguage ?? body.target_language ?? body.language, 80) ||
        isTooLong(body.sourceLanguage ?? body.source_language, 80)) {
      return json({ ok: false, error: "Translation input contains fields that are too long" }, 400);
    }
    const text = clean(body.text ?? body.content, 10_000);
    const targetLanguage = clean(body.targetLanguage ?? body.target_language ?? body.language, 80);
    const sourceLanguage = clean(body.sourceLanguage ?? body.source_language, 80);
    if (!text || !targetLanguage) return json({ ok: false, error: "text and targetLanguage are required" }, 400);
    prompt = `You are a careful translator for the ${sector} sector. Translate the supplied text into ${targetLanguage}${sourceLanguage ? ` from ${sourceLanguage}` : ""}. Preserve meaning, names, numbers, and formatting. Return only the translation.\n\nText:\n${text}`;
  }
  try {
    const content = await generateGemini(env, prompt, tokens);
    return json({ ok: true, content });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    const notConfigured = error instanceof Error && error.message === "gemini_not_configured";
    return json({
      ok: false,
      error: timedOut ? "AI generation timed out" : notConfigured ? "AI generation is not configured" : "AI generation failed",
    }, notConfigured ? 503 : 502);
  }
}

async function curriculumSearch(request: Request, env: EducationExtendedEnv) {
  const url = new URL(request.url);
  if (isTooLong(url.searchParams.get("q"), 160) ||
      isTooLong(url.searchParams.get("subject"), 120) ||
      isTooLong(url.searchParams.get("classLevel") ?? url.searchParams.get("class_level"), 80)) {
    return json({ ok: false, error: "Curriculum search filters are too long" }, 400);
  }
  const q = clean(url.searchParams.get("q"), 160);
  const subject = clean(url.searchParams.get("subject"), 120);
  const classLevel = clean(url.searchParams.get("classLevel") ?? url.searchParams.get("class_level"), 80);
  const params: unknown[] = [];
  const filters: string[] = [];
  if (q) {
    params.push(`%${q.replace(/[\\%_]/g, "\\$&")}%`);
    filters.push(`topic ILIKE $${params.length} ESCAPE '\\'`);
  }
  if (subject) {
    params.push(subject);
    filters.push(`subject ILIKE $${params.length}`);
  }
  if (classLevel) {
    params.push(classLevel);
    filters.push(`class_level = $${params.length}`);
  }
  params.push(50);
  const result = await query<Row>(
    env,
    `SELECT id,subject,class_level,topic,syllabus_ref,learner_book_page,teacher_guide_page,summary_text,activity_suggestion,created_at
       FROM public.curriculum_links${filters.length ? ` WHERE ${filters.join(" AND ")}` : ""}
       ORDER BY subject,class_level,topic LIMIT $${params.length}`,
    params,
  );
  const links = result.rows.filter(validCurriculumRow);
  if (links.length !== result.rows.length) return json({ ok: false, error: "Curriculum data is invalid" }, 502);
  return json({ ok: true, links });
}

async function unebRoute(request: Request, env: EducationExtendedEnv, pathname: string) {
  const url = new URL(request.url);
  if (isTooLong(url.searchParams.get("subject"), 120)) return json({ ok: false, error: "Subject is too long" }, 400);
  const subject = clean(url.searchParams.get("subject"), 120);
  if (pathname === "/api/uneb/random") {
    const params: unknown[] = [];
    const filter = subject ? "WHERE subject ILIKE $1" : "";
    if (subject) params.push(subject);
    const result = await query<Row>(
      env,
       `SELECT id,subject,class_level,topic,scenario_text,competency,marking_grid,source_year,created_at
         FROM public.uneb_items ${filter} ORDER BY RANDOM() LIMIT 1`,
      params,
    );
    const item = result.rows[0];
    if (!item) return json({ ok: false, error: "No UNEB items are available" }, 404);
    if (!validUnebRow(item)) return json({ ok: false, error: "UNEB item data is invalid" }, 502);
    // The legacy scenario launcher consumes the selected item at the top level.
    return json({ ok: true, ...item });
  }
  const params: unknown[] = [];
  const filter = subject ? "WHERE subject ILIKE $1" : "";
  if (subject) params.push(subject);
  params.push(50);
  const result = await query<Row>(
    env,
    `SELECT id,subject,class_level,topic,scenario_text,competency,marking_grid,source_year,created_at
       FROM public.uneb_items ${filter} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  if (result.rows.some((item) => !validUnebRow(item))) return json({ ok: false, error: "UNEB item data is invalid" }, 502);
  return json({ ok: true, items: result.rows });
}

function mapProgress(row: Row) {
  return {
    id: row.id,
    teacherId: row.teacher_id,
    schoolId: row.school_id,
    moduleId: row.module_id,
    moduleNumber: Number(row.module_id),
    completed: row.completed === true,
    quizScore: row.quiz_score === null ? null : Number(row.quiz_score),
    certificateIssued: row.certificate_issued === true,
    practicalUploadPath: row.practical_upload_path,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

async function getRetooling(
  request: Request,
  env: EducationExtendedEnv,
  user: AuthUser,
  pathname: string,
) {
  if (!teacherRole(user) && !adminRole(user) && !schoolAdminRole(user)) {
    return json({ ok: false, error: "Teacher or school administrator access is required" }, 403);
  }
  const teacherIdMatch = pathname.match(/^\/api\/retooling\/progress\/([^/]+)$/);
  let requestedTeacherId = user.uid;
  if (teacherIdMatch) {
    try {
      requestedTeacherId = decodeURIComponent(teacherIdMatch[1]);
    } catch {
      return json({ ok: false, error: "Invalid teacher ID" }, 400);
    }
  } else {
    requestedTeacherId = clean(new URL(request.url).searchParams.get("teacherId") || user.uid, 160);
  }
  if (!requestedTeacherId || requestedTeacherId.length > 160) return json({ ok: false, error: "Invalid teacher ID" }, 400);
  if (requestedTeacherId !== user.uid && !adminRole(user) && !(schoolAdminRole(user) && user.schoolId)) {
    return json({ ok: false, error: "You may only view your own course progress" }, 403);
  }
  const values: unknown[] = [requestedTeacherId];
  let sql = `SELECT id,teacher_id,school_id,module_id,completed,quiz_score,certificate_issued,practical_upload_path,completed_at,updated_at
               FROM public.teacher_retooling_progress WHERE teacher_id=$1`;
  if (schoolAdminRole(user) && !adminRole(user) && requestedTeacherId !== user.uid) {
    values.push(user.schoolId);
    sql += ` AND school_id=$${values.length}`;
  }
  const result = await query<Row>(env, `${sql} ORDER BY module_id LIMIT 50`, values);
  if (result.rows.some((row) => !validProgressRow(row))) return json({ ok: false, error: "Retooling progress data is invalid" }, 502);
  const progress = result.rows.map(mapProgress);
  if (pathname.includes("/certificate")) {
    return json({ ok: true, progress, certificate: await certificateForTeacher(env, requestedTeacherId) });
  }
  return json({ ok: true, progress });
}

async function saveRetooling(request: Request, env: EducationExtendedEnv, user: AuthUser) {
  if (!teacherRole(user)) return json({ ok: false, error: "Only teachers can update course progress" }, 403);
  let body: Row;
  try {
    body = (await readJson(request)) ?? {};
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === "request_too_large";
    return json({ ok: false, error: tooLarge ? "Request body is too large" : "A valid JSON body is required" }, tooLarge ? 413 : 400);
  }
  const moduleNumber = Number(body.moduleId ?? body.moduleNumber);
  if (!Number.isInteger(moduleNumber) || moduleNumber < 1 || moduleNumber > 10) {
    return json({ ok: false, error: "moduleId must be an integer from 1 to 10" }, 400);
  }
  const rawScore = body.quizScore;
  const quizScore = rawScore === null || rawScore === undefined || rawScore === ""
    ? null
    : Number(rawScore);
  if (quizScore !== null && (!Number.isInteger(quizScore) || quizScore < 0 || quizScore > 5)) {
    return json({ ok: false, error: "quizScore must be an integer from 0 to 5" }, 400);
  }
  if (isTooLong(body.practicalUploadPath ?? body.practicalUrl, 500)) {
    return json({ ok: false, error: "Practical upload path is too long" }, 400);
  }
  const practicalUploadPath = clean(body.practicalUploadPath ?? body.practicalUrl, 500);
  if (practicalUploadPath && !practicalUploadPath.startsWith(`teacher_retooling/${user.uid}/`)) {
    return json({ ok: false, error: "Practical upload must belong to the signed-in teacher" }, 400);
  }
  const requestedComplete = body.completed === true || body.moduleCompleted === true;
  if (requestedComplete && (quizScore === null || quizScore < 3 || !practicalUploadPath)) {
    return json({ ok: false, error: "A passing quiz score and practical upload are required to complete a module" }, 400);
  }
  const completed = requestedComplete;
  const moduleId = String(moduleNumber);
  const existing = await query<Row>(
    env,
    "SELECT id FROM public.teacher_retooling_progress WHERE teacher_id=$1 AND module_id=$2 ORDER BY updated_at DESC LIMIT 1",
    [user.uid, moduleId],
  );
  const updatedAt = now();
  if (existing.rows[0]) {
    await query<Row>(
      env,
      `UPDATE public.teacher_retooling_progress
          SET completed=$1,quiz_score=$2,practical_upload_path=$3,completed_at=$4,updated_at=$5
        WHERE id=$6`,
      [completed, quizScore, practicalUploadPath || null, completed ? updatedAt : null, updatedAt, existing.rows[0].id],
    );
  } else {
    await query<Row>(
      env,
      `INSERT INTO public.teacher_retooling_progress
         (id,teacher_id,school_id,module_id,completed,quiz_score,certificate_issued,practical_upload_path,completed_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,FALSE,$7,$8,$9)`,
      [id("retool"), user.uid, user.schoolId, moduleId, completed, quizScore, practicalUploadPath || null, completed ? updatedAt : null, updatedAt],
    );
  }
  return json({ ok: true, moduleId, completed, quizScore, practicalUploadPath: practicalUploadPath || null, updatedAt });
}

async function certificateForTeacher(env: EducationExtendedEnv, teacherId: string) {
  const result = await query<Row>(
    env,
    `SELECT p.certificate_id,p.certificate_issued_at
       FROM public.teacher_retooling_progress p
      WHERE p.teacher_id=$1 AND p.module_id='10' AND p.certificate_issued=TRUE
        AND p.certificate_id IS NOT NULL
        AND (SELECT COUNT(DISTINCT x.module_id)
               FROM public.teacher_retooling_progress x
              WHERE x.teacher_id=$1 AND x.module_id ~ '^[1-9]$|^10$'
                AND x.completed=TRUE AND x.quiz_score>=3
                AND NULLIF(trim(x.practical_upload_path),'') IS NOT NULL)=10
      ORDER BY p.updated_at DESC LIMIT 1`,
    [teacherId],
  );
  const row = result.rows[0];
  const certificateId = row?.certificate_id;
  const issuedAt = row?.certificate_issued_at;
  if (!row || typeof certificateId !== "string" || certificateId.length > 100 ||
      !/^NCDC-[A-F0-9]{32}$/.test(certificateId) ||
      !(typeof issuedAt === "string" || issuedAt instanceof Date)) return null;
  return {
    certificateId,
    teacherId,
    courseTitle: "NCDC Teacher Retooling Course",
    modulesCompleted: 10,
    cpdPoints: 20,
    status: "active",
    issuedAt: issuedAt instanceof Date ? issuedAt.toISOString() : issuedAt,
  };
}

async function issueCertificate(request: Request, env: EducationExtendedEnv, user: AuthUser) {
  if (!teacherRole(user)) return json({ ok: false, error: "Only teachers can request a certificate" }, 403);
  const existing = await certificateForTeacher(env, user.uid);
  if (existing) return json({ ok: true, certificate: existing });
  const certificateId = `NCDC-${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`;
  const issuedAt = now();
  const updated = await query<Row>(
    env,
    `WITH eligible AS (
       SELECT teacher_id
         FROM public.teacher_retooling_progress
        WHERE teacher_id=$3 AND module_id ~ '^[1-9]$|^10$'
        GROUP BY teacher_id
       HAVING COUNT(DISTINCT module_id)=10
          AND COUNT(DISTINCT module_id) FILTER (
                WHERE completed=TRUE AND quiz_score>=3
                  AND NULLIF(trim(practical_upload_path),'') IS NOT NULL
              )=10
     )
     UPDATE public.teacher_retooling_progress
        SET certificate_issued=TRUE,
            certificate_id=COALESCE(certificate_id,$1),
            certificate_issued_at=COALESCE(certificate_issued_at,$2),
            updated_at=$2
      WHERE id=(
        SELECT id FROM public.teacher_retooling_progress
         WHERE teacher_id=$3 AND module_id='10'
         ORDER BY updated_at DESC LIMIT 1
      ) AND EXISTS (SELECT 1 FROM eligible)
      RETURNING certificate_id,certificate_issued_at`,
    [certificateId, issuedAt, user.uid],
  );
  if (!updated.rows.length) {
    return json({ ok: false, error: "Complete all 10 modules, pass each quiz, and submit each practical before requesting a certificate" }, 409);
  }
  const issuedCertificateId = updated.rows[0].certificate_id;
  const recordedIssuedAt = updated.rows[0].certificate_issued_at;
  if (typeof issuedCertificateId !== "string" || !/^NCDC-[A-F0-9]{32}$/.test(issuedCertificateId)) {
    return json({ ok: false, error: "Certificate could not be issued" }, 503);
  }
  const certificateIssuedAt = recordedIssuedAt instanceof Date ? recordedIssuedAt.toISOString() : clean(recordedIssuedAt, 80);
  if (!certificateIssuedAt || !Number.isFinite(Date.parse(certificateIssuedAt))) {
    return json({ ok: false, error: "Certificate could not be issued" }, 503);
  }
  return json({
    ok: true,
    certificate: {
      certificateId: issuedCertificateId,
      teacherId: user.uid,
      courseTitle: "NCDC Teacher Retooling Course",
      modulesCompleted: 10,
      cpdPoints: 20,
      status: "active",
      issuedAt: certificateIssuedAt,
      verificationUrl: `/api/retooling/certificate/verify?certificateId=${encodeURIComponent(issuedCertificateId)}`,
    },
  }, 201);
}

async function verifyCertificate(request: Request, env: EducationExtendedEnv) {
  const url = new URL(request.url);
  const certificateId = clean(url.searchParams.get("certificateId"), 100);
  if (!certificateId) return json({ ok: false, error: "certificateId is required" }, 400);
  const found = await query<Row>(
    env,
    "SELECT teacher_id FROM public.teacher_retooling_progress WHERE module_id='10' AND certificate_id=$1 AND certificate_issued=TRUE LIMIT 1",
    [certificateId],
  );
  const teacherId = clean(found.rows[0]?.teacher_id, 160);
  if (!teacherId) return json({ ok: true, verified: false });
  const certificate = await certificateForTeacher(env, teacherId);
  const verified = Boolean(certificate && certificate.certificateId === certificateId);
  if (!verified || !certificate) return json({ ok: true, verified: false });
  return json({
    ok: true,
    verified: true,
    certificate: {
      certificateId: certificate.certificateId,
      courseTitle: certificate.courseTitle,
      modulesCompleted: certificate.modulesCompleted,
      cpdPoints: certificate.cpdPoints,
      status: certificate.status,
      issuedAt: certificate.issuedAt,
    },
  });
}

function isMatchedRoute(pathname: string) {
  return pathname === "/api/curriculum/search" ||
    pathname === "/api/gemini/activity" ||
    pathname === "/api/gemini/lesson-plan" ||
    pathname === "/api/gemini/translate" ||
    pathname === "/api/uneb" ||
    pathname === "/api/uneb/random" ||
    pathname === "/api/retooling" ||
    pathname.startsWith("/api/retooling/");
}

export async function handleEducationExtendedV10Route(
  request: Request,
  env: EducationExtendedEnv,
  user: AuthUser | null,
): Promise<Response | null> {
  const url = new URL(request.url);
  const pathname = url.pathname;
  if (!isMatchedRoute(pathname)) return null;
  if (request.method !== "GET" && request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }
  const origin = request.headers.get("origin");
  if (request.method === "POST" && origin && origin !== url.origin) {
    return json({ ok: false, error: "Cross-origin requests are not allowed" }, 403);
  }

  if (pathname === "/api/retooling/certificate/verify" && request.method === "GET") {
    try {
      return await verifyCertificate(request, env);
    } catch {
      return json({ ok: false, error: "Certificate verification is unavailable" }, 503);
    }
  }
  const teacherOnly = request.method === "POST" && pathname.startsWith("/api/retooling");
  const authFailure = accessError(user, teacherOnly);
  if (authFailure) return authFailure;

  try {
    if (pathname === "/api/curriculum/search" && request.method === "GET") {
      return await curriculumSearch(request, env);
    }
    if (pathname === "/api/uneb" && request.method === "GET") return await unebRoute(request, env, pathname);
    if (pathname === "/api/uneb/random" && request.method === "GET") return await unebRoute(request, env, pathname);
    if (pathname.startsWith("/api/gemini/") && request.method === "POST") {
      return await geminiRoute(request, env, user!, pathname);
    }
    if (pathname === "/api/retooling/progress" && request.method === "GET") {
      return await getRetooling(request, env, user!, pathname);
    }
    if (/^\/api\/retooling\/progress\/[^/]+$/.test(pathname) && request.method === "GET") {
      return await getRetooling(request, env, user!, pathname);
    }
    if (pathname === "/api/retooling/certificate" && request.method === "GET") {
      return await getRetooling(request, env, user!, pathname);
    }
    if (pathname === "/api/retooling/progress" && request.method === "POST") {
      return await saveRetooling(request, env, user!);
    }
    if (pathname === "/api/retooling/certificate" && request.method === "POST") {
      return await issueCertificate(request, env, user!);
    }
    if (pathname.startsWith("/api/retooling/")) return json({ ok: false, error: "Retooling route not found" }, 404);
    return json({ ok: false, error: "Method not allowed" }, 405);
  } catch (error) {
    if (error instanceof Error && error.message === "request_timeout") {
      return json({ ok: false, error: "Request timed out" }, 504);
    }
    if (error instanceof Error && error.message.startsWith("database_unavailable")) {
      return json({ ok: false, error: "PostgreSQL persistence is unavailable" }, 503);
    }
    return json({ ok: false, error: "Education service is temporarily unavailable" }, 503);
  }
}