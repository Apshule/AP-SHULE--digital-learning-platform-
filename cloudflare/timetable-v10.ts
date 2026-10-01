import type { AuthUser } from "./backend-types";
import { inNeonTransaction } from "./neon-db";
import {
  canManageTimetable,
  cleanText,
  database,
  DbRow,
  jsonAttachment,
  makeSimplePdf,
  makeStoredZip,
  PlatformV10Env,
  platformJson,
  readJson,
  safeId,
  userTenantId,
} from "./platform-v10-common";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DEFAULT_CONFIG = {
  periods_per_day: 8,
  days_per_week: 5,
  start_time: "08:00",
  period_minutes: 40,
  break_after_period: null as number | null,
};
const CLASS_SPECS = [
  ["P1", "P1", ""], ["P2", "P2", ""], ["P3", "P3", ""], ["P4", "P4", ""],
  ["P.5 A", "P5", "A"], ["P.5 B", "P5", "B"], ["P6", "P6", ""], ["P7", "P7", ""],
  ["S.1 East", "S1", "East"], ["S.1 West", "S1", "West"], ["S2", "S2", ""],
  ["S3", "S3", ""], ["S4", "S4", ""], ["S.5 Arts", "S5", "Arts"],
  ["S.5 Sciences", "S5", "Sciences"], ["S.6 Arts", "S6", "Arts"],
  ["S.6 Sciences", "S6", "Sciences"],
] as const;
type Row = DbRow;

function normalizedLevel(value: unknown) {
  return cleanText(value, 40).toUpperCase().replaceAll(".", "").replaceAll(" ", "");
}

function isoTime(start: unknown, offsetMinutes: number) {
  const raw = cleanText(start, 20) || DEFAULT_CONFIG.start_time;
  const [hours, minutes] = raw.split(":").map(Number);
  const total = Math.max(0, (Number.isFinite(hours) ? hours : 8) * 60 + (Number.isFinite(minutes) ? minutes : 0) + offsetMinutes);
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function canRead(user: AuthUser) {
  return canManageTimetable(user) ||
    [
      "teacher", "teacher_staff", "teacher_independent", "student", "learner",
      "parent", "guardian", "individual",
    ].includes(cleanText(user.role, 60).toLowerCase().replace(/[ -]+/g, "_"));
}

function schoolForRequest(request: Request, user: AuthUser, body: Row = {}) {
  const url = new URL(request.url);
  const requested = safeId(url.searchParams.get("school_id") || body.school_id, 180);
  const schoolId = requested || userTenantId(user);
  if (!schoolId || (!canManageTimetable(user) && schoolId !== user.schoolId && schoolId !== user.institutionId)) return "";
  if (!canManageTimetable(user) && !canRead(user)) return "";
  return schoolId;
}

async function ensureDefaultClasses(env: PlatformV10Env, schoolId: string) {
  const rows = CLASS_SPECS.map(([className, classLevel, stream]) => ({
    id: `class_${crypto.randomUUID().replaceAll("-", "")}`,
    school_id: schoolId,
    class_name: className,
    class_level: classLevel,
    stream,
    room: "",
  }));
  await database(env).query(
    `INSERT INTO public.school_classes(id,school_id,class_name,class_level,stream,room)
     SELECT x.id,x.school_id,x.class_name,x.class_level,x.stream,x.room
       FROM jsonb_to_recordset($1::jsonb) AS x(
         id TEXT,school_id TEXT,class_name TEXT,class_level TEXT,stream TEXT,room TEXT
       )
     ON CONFLICT(school_id,class_name) DO NOTHING`,
    [JSON.stringify(rows)],
  );
  return database(env).query<Row>(
    "SELECT id,school_id,class_name,class_level,stream,room,active FROM public.school_classes WHERE school_id=$1 AND active=TRUE ORDER BY class_level,class_name",
    [schoolId],
  );
}

async function getConfig(env: PlatformV10Env, schoolId: string) {
  const result = await database(env).query<Row>(
    `SELECT school_id,periods_per_day,days_per_week,start_time::text,period_minutes,break_after_period,updated_at
       FROM public.school_timetable_config WHERE school_id=$1 LIMIT 1`,
    [schoolId],
  );
  return { ...DEFAULT_CONFIG, ...(result.rows[0] ?? { school_id: schoolId }) };
}

async function upsertConfig(env: PlatformV10Env, user: AuthUser, body: Row, schoolId: string) {
  if (!canManageTimetable(user)) return platformJson({ ok: false, error: "Only school administrators can change timetable configuration" }, 403);
  const periods = Number(body.periods_per_day);
  const days = Number(body.days_per_week ?? 5);
  const periodMinutes = Number(body.period_minutes ?? 40);
  const startTime = cleanText(body.start_time, 8) || DEFAULT_CONFIG.start_time;
  const breakAfter = body.break_after_period == null || body.break_after_period === ""
    ? null
    : Number(body.break_after_period);
  if (!Number.isInteger(periods) || periods < 1 || periods > 16 ||
      !Number.isInteger(days) || days < 1 || days > 6 ||
      !Number.isInteger(periodMinutes) || periodMinutes < 20 || periodMinutes > 120 ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) ||
      (breakAfter !== null && (!Number.isInteger(breakAfter) || breakAfter < 1 || breakAfter >= periods))) {
    return platformJson({ ok: false, error: "Invalid period count, school day, start time, duration, or break period" }, 400);
  }
  await database(env).query(
    `INSERT INTO public.school_timetable_config
      (school_id,periods_per_day,days_per_week,start_time,period_minutes,break_after_period,updated_by,updated_at)
     VALUES($1,$2,$3,$4::time,$5,$6,$7,NOW())
     ON CONFLICT(school_id) DO UPDATE SET
       periods_per_day=EXCLUDED.periods_per_day,
       days_per_week=EXCLUDED.days_per_week,
       start_time=EXCLUDED.start_time,
       period_minutes=EXCLUDED.period_minutes,
       break_after_period=EXCLUDED.break_after_period,
       updated_by=EXCLUDED.updated_by,
       updated_at=EXCLUDED.updated_at`,
    [schoolId, periods, days, startTime, periodMinutes, breakAfter, user.uid],
  );
  const classes = await ensureDefaultClasses(env, schoolId);
  return platformJson({ ok: true, config: await getConfig(env, schoolId), classes: classes.rows });
}

async function listClasses(env: PlatformV10Env, schoolId: string) {
  const result = await database(env).query<Row>(
    `SELECT id,school_id,class_name,class_level,stream,room,active
       FROM public.school_classes WHERE school_id=$1 AND active=TRUE
       ORDER BY class_level,class_name`,
    [schoolId],
  );
  const classes = result.rows.length ? result.rows : CLASS_SPECS.map(([class_name, class_level, stream]) => ({
    id: "",
    school_id: schoolId,
    class_name,
    class_level,
    stream,
    room: "",
    active: true,
    is_template: true,
  }));
  return platformJson({ ok: true, classes });
}

async function listSubjects(env: PlatformV10Env, request: Request, schoolId: string) {
  const url = new URL(request.url);
  const classLevel = cleanText(url.searchParams.get("class_level"), 40);
  const params: unknown[] = [schoolId];
  let classFilter = "";
  if (classLevel) {
    params.push(normalizedLevel(classLevel));
    classFilter = " AND regexp_replace(upper(class_level),'[. ]','','g')=$2";
  }
  const result = await database(env).query<Row>(
    `SELECT DISTINCT ON (regexp_replace(upper(class_level),'[. ]','','g'),lower(subject_code))
       id,school_id,subject_code,subject_name,class_level,periods_per_week,active
       FROM public.school_subjects
       WHERE active=TRUE AND (school_id=$1 OR school_id IS NULL)${classFilter}
      ORDER BY regexp_replace(upper(class_level),'[. ]','','g'),lower(subject_code),(school_id=$1) DESC`,
    params,
  );
  return platformJson({ ok: true, subjects: result.rows });
}

async function listTeachers(env: PlatformV10Env, schoolId: string) {
  const result = await database(env).query<Row>(
    `SELECT DISTINCT d.teacher_id,COALESCE(u.display_name,'') AS teacher_name,
            d.subject_id,d.class_id,d.class_level,d.periods_per_week,d.room
       FROM public.timetable_teacher_duty d
       LEFT JOIN public.users u ON u.uid=d.teacher_id
      WHERE d.school_id=$1 AND d.active=TRUE
      ORDER BY teacher_name,d.subject_id`,
    [schoolId],
  );
  return platformJson({ ok: true, teachers: result.rows });
}

interface Duty {
  teacher_id: string;
  teacher_name: string;
  subject_id: string;
  class_id: string | null;
  class_level: string | null;
  periods_per_week: number;
  room: string;
}

interface ScheduleItem {
  id: string;
  school_id: string;
  class_id: string;
  class_name: string;
  day: string;
  period: number;
  subject_id: string;
  subject_name: string;
  teacher_id: string;
  teacher_name: string;
  room: string;
  term: string;
  start_time: string;
  end_time: string;
}

async function generateTimetable(env: PlatformV10Env, user: AuthUser, body: Row, schoolId: string) {
  if (!canManageTimetable(user)) return platformJson({ ok: false, error: "Only school administrators can generate timetables" }, 403);
  const term = cleanText(body.term, 30);
  if (!term) return platformJson({ ok: false, error: "A term is required" }, 400);
  const [config, classesResult, subjectsResult, dutyResult] = await Promise.all([
    getConfig(env, schoolId),
    ensureDefaultClasses(env, schoolId),
    database(env).query<Row>(
      `SELECT DISTINCT ON (regexp_replace(upper(class_level),'[. ]','','g'),lower(subject_code))
         id,subject_code,subject_name,class_level,periods_per_week,school_id
         FROM public.school_subjects
         WHERE active=TRUE AND (school_id=$1 OR school_id IS NULL)
        ORDER BY regexp_replace(upper(class_level),'[. ]','','g'),lower(subject_code),(school_id=$1) DESC`,
      [schoolId],
    ),
    database(env).query<Duty>(
      `SELECT d.teacher_id,COALESCE(u.display_name,'') AS teacher_name,d.subject_id,d.class_id,
              d.class_level,d.periods_per_week,d.room
         FROM public.timetable_teacher_duty d
         LEFT JOIN public.users u ON u.uid=d.teacher_id
        WHERE d.school_id=$1 AND d.active=TRUE
        ORDER BY d.periods_per_week,d.teacher_id`,
      [schoolId],
    ),
  ]);
  const classes = classesResult.rows;
  const subjects = subjectsResult.rows;
  const duties = dutyResult.rows;
  if (!subjects.length) return platformJson({ ok: false, error: "The NCDC subject catalogue is unavailable" }, 503);
  if (!duties.length) return platformJson({ ok: false, error: "Assign teachers to subjects before generating a timetable" }, 409);

  const periodsPerDay = Math.min(16, Math.max(1, Number(config.periods_per_day) || DEFAULT_CONFIG.periods_per_day));
  const daysPerWeek = Math.min(6, Math.max(1, Number(config.days_per_week) || DEFAULT_CONFIG.days_per_week));
  const periodMinutes = Math.min(120, Math.max(20, Number(config.period_minutes) || DEFAULT_CONFIG.period_minutes));
  const slots = Array.from({ length: daysPerWeek * periodsPerDay }, (_, index) => ({
    day: DAYS[Math.floor(index / periodsPerDay)],
    period: index % periodsPerDay + 1,
  }));
  const classBusy = new Set<string>();
  const teacherBusy = new Set<string>();
  const roomBusy = new Set<string>();
  const assignments: ScheduleItem[] = [];
  const unassigned: string[] = [];
  const tasks: Array<{ classRow: Row; subject: Row; candidates: Duty[]; count: number }> = [];

  for (const classRow of classes) {
    const level = normalizedLevel(classRow.class_level);
    for (const subject of subjects.filter((row) => normalizedLevel(row.class_level) === level)) {
      const candidates = duties.filter((duty) =>
        duty.subject_id === subject.id &&
        (duty.class_id === classRow.id || (!duty.class_id &&
          (!duty.class_level || normalizedLevel(duty.class_level) === level))),
      );
      if (!candidates.length) {
        unassigned.push(`${cleanText(classRow.class_name, 80)} — ${cleanText(subject.subject_name, 100)}`);
        continue;
      }
      const count = Math.min(30, Math.max(1, Number(candidates[0].periods_per_week) || Number(subject.periods_per_week) || 1));
      tasks.push({ classRow, subject, candidates, count });
    }
  }
  if (unassigned.length) {
    return platformJson({
      ok: false,
      error: "Teacher duty assignments are missing for one or more class subjects",
      missingAssignments: unassigned.slice(0, 40),
    }, 409);
  }
  tasks.sort((a, b) => a.candidates.length - b.candidates.length || b.count - a.count);
  let load = 0;
  for (const task of tasks) {
    for (let occurrence = 0; occurrence < task.count; occurrence++) {
      const startAt = (load * 7 + occurrence * 3) % slots.length;
      let placed: { slot: typeof slots[number]; duty: Duty } | null = null;
      for (let offset = 0; offset < slots.length && !placed; offset++) {
        const slot = slots[(startAt + offset) % slots.length];
        const classKey = `${task.classRow.id}|${slot.day}|${slot.period}`;
        if (classBusy.has(classKey)) continue;
        const duty = [...task.candidates].sort((a, b) => {
          const aBusy = teacherBusy.has(`${a.teacher_id}|${slot.day}|${slot.period}`) ? 1 : 0;
          const bBusy = teacherBusy.has(`${b.teacher_id}|${slot.day}|${slot.period}`) ? 1 : 0;
          return aBusy - bBusy;
        }).find((candidate) =>
          !teacherBusy.has(`${candidate.teacher_id}|${slot.day}|${slot.period}`) &&
          (!(candidate.room || cleanText(task.classRow.room, 80)) ||
            !roomBusy.has(`${candidate.room || cleanText(task.classRow.room, 80)}|${slot.day}|${slot.period}`)),
        );
        if (duty) placed = { slot, duty };
      }
      if (!placed) {
        return platformJson({ ok: false, error: "No clash-free timetable could be generated with the current teacher, room, and period assignments" }, 409);
      }
      const { slot, duty } = placed;
      const classKey = `${task.classRow.id}|${slot.day}|${slot.period}`;
      classBusy.add(classKey);
      teacherBusy.add(`${duty.teacher_id}|${slot.day}|${slot.period}`);
      const room = duty.room || cleanText(task.classRow.room, 80);
      if (room) roomBusy.add(`${room}|${slot.day}|${slot.period}`);
      const startTime = isoTime(config.start_time, (slot.period - 1) * periodMinutes);
      assignments.push({
        id: `timetable_${crypto.randomUUID().replaceAll("-", "")}`,
        school_id: schoolId,
        class_id: String(task.classRow.id),
        class_name: cleanText(task.classRow.class_name, 100),
        day: slot.day,
        period: slot.period,
        subject_id: String(task.subject.id),
        subject_name: cleanText(task.subject.subject_name, 120),
        teacher_id: duty.teacher_id,
        teacher_name: duty.teacher_name,
        room,
        term,
        start_time: startTime,
        end_time: isoTime(startTime, periodMinutes),
      });
      load++;
    }
  }

  const client = database(env);
  await inNeonTransaction(client, async () => {
    await client.query("DELETE FROM public.school_timetables WHERE school_id=$1 AND term=$2", [schoolId, term]);
    await client.query("DELETE FROM public.school_combined_periods WHERE school_id=$1 AND term=$2", [schoolId, term]);
    await client.query(
      `INSERT INTO public.school_timetables
        (id,school_id,class_id,class_name,day,period,subject_id,subject_name,teacher_id,teacher_name,room,term,start_time,end_time)
       SELECT x.id,x.school_id,x.class_id,x.class_name,x.day,x.period,x.subject_id,x.subject_name,
              x.teacher_id,x.teacher_name,x.room,x.term,x.start_time::time,x.end_time::time
         FROM jsonb_to_recordset($1::jsonb) AS x(
           id TEXT,school_id TEXT,class_id TEXT,class_name TEXT,day TEXT,period INTEGER,
           subject_id TEXT,subject_name TEXT,teacher_id TEXT,teacher_name TEXT,room TEXT,term TEXT,
           start_time TEXT,end_time TEXT
         )`,
      [JSON.stringify(assignments)],
    );
    await client.query(
      `INSERT INTO public.school_combined_periods
        (id,school_id,class_id,day,period,subject_id,teacher_id,room,term)
       SELECT 'combined_'||id,school_id,class_id,day,period,subject_id,teacher_id,room,term
         FROM public.school_timetables WHERE school_id=$1 AND term=$2`,
      [schoolId, term],
    );
  });
  return platformJson({ ok: true, term, generated: assignments.length, timetables: assignments });
}

async function listTimetable(request: Request, env: PlatformV10Env, schoolId: string) {
  const url = new URL(request.url);
  const classId = safeId(url.searchParams.get("class_id"), 180);
  const term = cleanText(url.searchParams.get("term"), 30);
  const values: unknown[] = [schoolId];
  let filters = "";
  if (classId) {
    values.push(classId);
    filters += ` AND t.class_id=$${values.length}`;
  }
  if (term) {
    values.push(term);
    filters += ` AND t.term=$${values.length}`;
  }
  const result = await database(env).query<Row>(
    `SELECT t.id,t.school_id,t.class_id,t.class_name,t.day,t.period,t.subject_id,t.subject_name,
            t.teacher_id,t.teacher_name,t.room,t.term,t.start_time::text,t.end_time::text
       FROM public.school_timetables t
      WHERE t.school_id=$1${filters}
      ORDER BY t.class_name,array_position(ARRAY['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'],t.day),t.period
      LIMIT 2000`,
    values,
  );
  return result.rows;
}

async function expectedOutcomes(request: Request, env: PlatformV10Env, schoolId: string) {
  const subjectId = safeId(new URL(request.url).searchParams.get("subject_id"), 180);
  if (!subjectId) return platformJson({ ok: false, error: "subject_id is required" }, 400);
  const result = await database(env).query<Row>(
    `SELECT id,subject_id,class_level,outcome_text
       FROM public.school_timetable_expected_outcomes
       WHERE subject_id=$1 AND (school_id=$2 OR school_id IS NULL)
      ORDER BY class_level,id LIMIT 200`,
    [subjectId, schoolId],
  );
  return platformJson({ ok: true, outcomes: result.rows });
}

async function exportPdf(request: Request, env: PlatformV10Env, schoolId: string, user: AuthUser, bulk: boolean) {
  const url = new URL(request.url);
  const term = cleanText(url.searchParams.get("term"), 30);
  const rows = await listTimetable(request, env, schoolId);
  const filtered = term ? rows.filter((row) => row.term === term) : rows;
  if (!filtered.length) return platformJson({ ok: false, error: "No timetable entries are available for export" }, 404);
  if (!env.FILES) return platformJson({ ok: false, error: "R2 export storage is unavailable" }, 503);

  const makeLines = (items: Row[]) => items.map((row) =>
    `${row.day} P${row.period} ${row.start_time || ""}-${row.end_time || ""} | ${row.class_name} | ${row.subject_name} | ${row.teacher_name || row.teacher_id} | ${row.room || "Room TBA"}`,
  );
  const termPart = (term || String(filtered[0].term || "term")).replace(/[^A-Za-z0-9_-]/g, "_");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  if (!bulk) {
    const className = cleanText(url.searchParams.get("class_id"), 80) || "school";
    const bytes = makeSimplePdf(`APSHULE Timetable — ${className} — ${termPart}`, makeLines(filtered));
    const key = `exports/timetable/${schoolId}/${termPart}/${stamp}.pdf`;
    await env.FILES.put(key, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { httpMetadata: { contentType: "application/pdf" } });
    return jsonAttachment(bytes, "application/pdf", `timetable-${termPart}.pdf`);
  }

  const grouped = new Map<string, Row[]>();
  for (const row of filtered) {
    const key = cleanText(row.class_name, 100) || "Class";
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  if (grouped.size > 100) return platformJson({ ok: false, error: "Bulk timetable export is limited to 100 classes" }, 413);
  const entries = [...grouped.entries()].map(([className, items]) => ({
    name: `${className.replace(/[^A-Za-z0-9_-]/g, "_")}.pdf`,
    bytes: makeSimplePdf(`APSHULE Timetable — ${className} — ${termPart}`, makeLines(items)),
  }));
  const bytes = makeStoredZip(entries);
  const key = `exports/timetable/${schoolId}/${termPart}/${stamp}.zip`;
  await env.FILES.put(key, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { httpMetadata: { contentType: "application/zip" } });
  return jsonAttachment(bytes, "application/zip", `timetables-${termPart}.zip`);
}

const KNOWN = [
  "/api/timetable/config",
  "/api/timetable/classes",
  "/api/timetable/subjects",
  "/api/timetable/teachers",
  "/api/timetable/generate",
  "/api/timetable/list",
  "/api/timetable/expected-outcomes",
  "/api/timetable/export/pdf",
  "/api/timetable/export/bulk",
];

export async function handleTimetableV10Route(
  request: Request,
  env: PlatformV10Env,
  user: AuthUser | null,
): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  if (!KNOWN.includes(pathname)) return null;
  if (!user) return platformJson({ ok: false, error: "Authentication is required" }, 401);
  if (!env.PG) return platformJson({ ok: false, error: "Neon database persistence is unavailable" }, 503);
  if (!canRead(user)) return platformJson({ ok: false, error: "Education timetable access is required" }, 403);
  if (request.method !== "GET" && request.method !== "POST") {
    return platformJson({ ok: false, error: "Method not allowed" }, 405);
  }
  const input = request.method === "POST" ? await readJson(request) : {};
  const schoolId = schoolForRequest(request, user, input);
  if (!schoolId) return platformJson({ ok: false, error: "A valid school_id in your assigned school is required" }, 403);
  const origin = request.headers.get("origin");
  if (request.method === "POST" && origin && origin !== new URL(request.url).origin) {
    return platformJson({ ok: false, error: "Cross-origin requests are not allowed" }, 403);
  }
  try {
    if (pathname === "/api/timetable/config") {
      return request.method === "GET"
        ? platformJson({ ok: true, config: await getConfig(env, schoolId) })
        : await upsertConfig(env, user, input, schoolId);
    }
    if (pathname === "/api/timetable/classes") {
      if (request.method !== "GET") return platformJson({ ok: false, error: "Method not allowed" }, 405);
      return await listClasses(env, schoolId);
    }
    if (pathname === "/api/timetable/subjects") {
      if (request.method !== "GET") return platformJson({ ok: false, error: "Method not allowed" }, 405);
      return await listSubjects(env, request, schoolId);
    }
    if (pathname === "/api/timetable/teachers") {
      if (request.method !== "GET") return platformJson({ ok: false, error: "Method not allowed" }, 405);
      return await listTeachers(env, schoolId);
    }
    if (pathname === "/api/timetable/generate") {
      if (request.method !== "POST") return platformJson({ ok: false, error: "Method not allowed" }, 405);
      return await generateTimetable(env, user, input, schoolId);
    }
    if (pathname === "/api/timetable/list") {
      if (request.method !== "GET") return platformJson({ ok: false, error: "Method not allowed" }, 405);
      return platformJson({ ok: true, timetables: await listTimetable(request, env, schoolId) });
    }
    if (pathname === "/api/timetable/expected-outcomes") {
      if (request.method !== "GET") return platformJson({ ok: false, error: "Method not allowed" }, 405);
      return await expectedOutcomes(request, env, schoolId);
    }
    if (pathname === "/api/timetable/export/pdf" || pathname === "/api/timetable/export/bulk") {
      if (request.method !== "GET") return platformJson({ ok: false, error: "Method not allowed" }, 405);
      return await exportPdf(request, env, schoolId, user, pathname.endsWith("/bulk"));
    }
    return platformJson({ ok: false, error: "Timetable route not found" }, 404);
  } catch {
    return platformJson({ ok: false, error: "Timetable operation could not be completed" }, 503);
  }
}