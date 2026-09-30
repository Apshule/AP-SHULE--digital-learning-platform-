import type { AuthEnv, AuthUser } from "./backend-types";

type Row = Record<string, unknown>;
export interface EducationPlatformEnv extends AuthEnv {
  FILES?: {
    put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
    get(key: string): Promise<{ body: ReadableStream } | null>;
    delete(key: string): Promise<unknown>;
  };
}
const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const clean = (x: unknown, n = 200) => String(x ?? "").trim().slice(0, n);
const id = (p: string) => `${p}_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
const now = () => new Date().toISOString();
const isAdmin = (u: AuthUser) => ["superadmin", "super_admin"].includes(clean(u.role, 40).toLowerCase().replace("-", "_"));
const educationRole = (u: AuthUser) => ["superadmin","super_admin","student","learner","individual","teacher","teacher_staff","teacher_independent","secretary","headteacher","head_teacher","bursar","accountant","parent","guardian","school","school_admin"].includes(clean(u.role, 60).toLowerCase());
const scope = (u: AuthUser, alias = "") => {
  if (isAdmin(u)) return { sql: "1=1", args: [] as unknown[] };
  const p = alias ? `${alias}.` : "";
  if (!u.schoolId && !u.institutionId) return { sql: "1=0", args: [] as unknown[] };
  return u.schoolId ? { sql: `(${p}school_id=? OR (${p}school_id IS NULL AND ${p}institution_id=?))`, args: [u.schoolId, u.institutionId || ""] } :
    { sql: `${p}institution_id=?`, args: [u.institutionId || ""] };
};
const visibleScope = (u: AuthUser, alias = "") => {
  if (isAdmin(u)) return { sql: "1=1", args: [] as unknown[] };
  const p = alias ? `${alias}.` : "";
  const tenantScope = scope(u, alias);
  return {
    sql: `((${p}school_id IS NULL AND ${p}institution_id IS NULL) OR ${tenantScope.sql})`,
    args: tenantScope.args,
  };
};
async function input(r: Request): Promise<Row> { try { const x = await r.json(); return x && typeof x === "object" ? x as Row : {}; } catch { return {}; } }
async function audit(env: EducationPlatformEnv, u: AuthUser, action: string, resource: string, resourceId: string) {
  await env.DB.prepare("INSERT INTO audit(id,institution_id,school_id,actor_id,action,resource_type,resource_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .bind(id("audit"), u.institutionId, u.schoolId, u.uid, action, resource, resourceId, "{}", now()).run();
}
function httpsUrl(value: string, host?: string) { try { const u = new URL(value); return u.protocol === "https:" && (!host || [host, `www.${host}`].includes(u.hostname.toLowerCase())) ? u.toString() : ""; } catch { return ""; } }
function norm(value: unknown) { return clean(value, 160).toLowerCase(); }
function recordClass(recordJson: unknown) {
  try {
    const raw = JSON.parse(String(recordJson || "{}")) as Row;
    const data = raw.data && typeof raw.data === "object" ? raw.data as Row : raw;
    return clean(data.className || data.class_name || data.class, 120);
  } catch { return ""; }
}
async function learnerClasses(env: EducationPlatformEnv, u: AuthUser): Promise<Set<string> | null> {
  const role = clean(u.role, 60).toLowerCase().replace(/[ -]+/g, "_");
  const isLearner = ["student", "learner", "individual"].includes(role);
  if (isAdmin(u) || (!isLearner && !["parent", "guardian"].includes(role))) return null;
  const records = role === "parent" || role === "guardian"
    ? await env.DB.prepare(`SELECT r.record_json,r.owner_uid FROM parent_links p JOIN sector_records r ON r.id=p.learner_id
        WHERE p.parent_uid=? AND p.active=1 AND r.is_deleted=0 AND ${scope(u, "p").sql}`)
        .bind(u.uid, ...scope(u, "p").args).all<Row>()
    : await env.DB.prepare(`SELECT record_json,owner_uid FROM sector_records
        WHERE sector='education' AND record_type IN ('learner','student') AND is_deleted=0 AND ${scope(u).sql} LIMIT 500`)
        .bind(...scope(u).args).all<Row>();
  const classes = new Set<string>();
  for (const row of records.results) {
    if (isLearner) {
      let raw: Row = {};
      try { raw = JSON.parse(String(row.record_json || "{}")) as Row; } catch { continue; }
      const data = raw.data && typeof raw.data === "object" ? raw.data as Row : raw;
      const uid = clean(data.uid || data.userId || data.user_id || data.studentUid || data.student_uid, 160);
      const email = clean(data.email || data.studentEmail || data.student_email, 200).toLowerCase();
      if (clean(row.owner_uid, 160) !== u.uid && uid !== u.uid && (!email || email !== clean(u.email, 200).toLowerCase())) continue;
    }
    const className = recordClass(row.record_json);
    if (className) classes.add(norm(className));
  }
  return classes;
}
function inLearnerClasses(item: Row, classes: Set<string> | null) {
  if (!classes) return true;
  const className = norm(item.class_name || item.className || item.class);
  return !className || classes.has(className);
}
function aboutValue(value: unknown) {
  try { return JSON.parse(String(value || "null")); } catch { return null; }
}
async function content(env: EducationPlatformEnv, u: AuthUser) {
  const sc = scope(u);
  const lessonScope = visibleScope(u, "l");
  const [plans, events, resources, videos, about, live, lessons, files] = await Promise.all([
    env.DB.prepare("SELECT id,name,amount_ugx,duration_days,display_order FROM education_subscription_plans WHERE active=1 ORDER BY display_order").all<Row>(),
    env.DB.prepare("SELECT id,title,event_date,fee_ugx,description FROM education_platform_events WHERE status='published' AND date(event_date)>=date('now') ORDER BY event_date LIMIT 200").all<Row>(),
    env.DB.prepare("SELECT id,title,url,class_name,subject FROM education_platform_resources WHERE active=1 ORDER BY created_at DESC LIMIT 200").all<Row>(),
    env.DB.prepare("SELECT id,class_name,subject,youtube_url FROM education_video_mappings WHERE active=1 ORDER BY class_name,subject").all<Row>(),
    env.DB.prepare("SELECT value FROM education_platform_settings WHERE setting_key='about' LIMIT 1").all<Row>(),
    env.DB.prepare(`SELECT id,title,class_name,subject,room_id,started_at,ended_at FROM education_live_lessons WHERE ${sc.sql} AND ended_at IS NULL ORDER BY started_at DESC LIMIT 100`).bind(...sc.args).all<Row>(),
    env.DB.prepare(`SELECT l.id,l.title,l.description,l.class_name,l.subject,l.youtube_url
      FROM education_lessons l WHERE l.published=1 AND ${lessonScope.sql} ORDER BY l.updated_at DESC LIMIT 500`)
      .bind(...lessonScope.args).all<Row>(),
    env.DB.prepare(`SELECT f.id,f.lesson_id,f.filename,l.class_name,l.subject FROM education_files f
      JOIN education_lessons l ON l.id=f.lesson_id WHERE l.published=1 AND ${lessonScope.sql}
      ORDER BY f.created_at DESC LIMIT 500`).bind(...lessonScope.args).all<Row>(),
  ]);
  const classes = await learnerClasses(env, u);
  const mappedVideos = videos.results.filter((item) => inLearnerClasses(item, classes));
  const existingVideos = lessons.results
    .filter((item) => clean(item.youtube_url, 500) && inLearnerClasses(item, classes))
    .map((item) => ({ ...item, lessonId: item.id }));
  const linkedResources = resources.results.filter((item) => inLearnerClasses(item, classes));
  const lessonFiles = files.results.filter((item) => inLearnerClasses(item, classes)).map((item) => ({
    id: item.id,
    lessonId: item.lesson_id,
    title: item.filename,
    class_name: item.class_name,
    subject: item.subject,
    url: `/api/school/lessons/${encodeURIComponent(clean(item.lesson_id, 160))}/files/${encodeURIComponent(clean(item.id, 160))}`,
  }));
  const liveLessons = live.results.filter((item) => inLearnerClasses(item, classes)).map((item) => ({
    ...item,
    joinUrl: `https://meet.jit.si/APSHULE-${encodeURIComponent(clean(item.room_id, 200))}`,
    warning: "Anyone holding this public Jitsi link can join; admission and revocation are not server-enforced.",
  }));
  return {
    ok: true,
    plans: plans.results,
    events: events.results,
    resources: [...linkedResources, ...lessonFiles],
    videoMappings: [...mappedVideos, ...existingVideos],
    educationFiles: lessonFiles,
    educationLessonVideos: existingVideos,
    about: aboutValue(about.results[0]?.value),
    liveLessons,
  };
}
export async function handleEducationPlatformRoute(request: Request, env: EducationPlatformEnv, user: AuthUser, pathname: string): Promise<Response | null> {
  if (!educationRole(user)) return json({ ok: false, error: "Education role required" }, 403);
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return json({ ok: false, error: "Cross-origin platform requests are not allowed" }, 403);
  if (pathname === "/api/school/platform-content" && request.method === "GET") return json(await content(env, user));
  if (pathname === "/api/school/platform-feedback" && request.method === "POST") {
    const x = await input(request), message = clean(x.message, 2000);
    if (!message) return json({ ok: false, error: "Message is required" }, 400);
    const fid = id("feedback"), t = now();
    await env.DB.prepare("INSERT INTO education_platform_feedback(id,institution_id,school_id,user_id,message,status,created_at,updated_at) VALUES(?,?,?,?,?,'new',?,?)").bind(fid,user.institutionId,user.schoolId,user.uid,message,t,t).run();
    return json({ ok: true, id: fid }, 201);
  }
  const view = pathname.match(/^\/api\/school\/platform-views\/([^/]+)$/);
  if (view && request.method === "POST") {
    let lessonId = "";
    try { lessonId = clean(decodeURIComponent(view[1]), 160); } catch {}
    if (!lessonId) return json({ ok: false, error: "Lesson ID is required" }, 400);
    const mapped = (await env.DB.prepare("SELECT class_name FROM education_video_mappings WHERE id=? AND active=1 LIMIT 1").bind(lessonId).all<Row>()).results[0];
    const lessonScope = visibleScope(user);
    const existing = mapped || (await env.DB.prepare(`SELECT id,class_name FROM education_lessons
      WHERE id=? AND published=1 AND ${lessonScope.sql} LIMIT 1`).bind(lessonId, ...lessonScope.args).all<Row>()).results[0];
    if (!existing) return json({ ok: false, error: "Video lesson not found" }, 404);
    const role = clean(user.role, 60).toLowerCase().replace(/[ -]+/g, "_");
    if (["student", "learner", "individual", "parent", "guardian"].includes(role)) {
      const classes = await learnerClasses(env, user);
      if (!classes || !inLearnerClasses(existing, classes)) return json({ ok: false, error: "This video is not assigned to your class" }, 403);
    }
    const timestamp = now();
    await env.DB.prepare("INSERT OR IGNORE INTO education_lesson_views(lesson_id,user_id,institution_id,school_id,view_day,viewed_at) VALUES(?,?,?,?,?,?)")
      .bind(lessonId, user.uid, user.institutionId, user.schoolId, timestamp.slice(0, 10), timestamp).run();
    return json({ ok: true });
  }
  if (pathname === "/api/school/platform-logo" && request.method === "GET") {
    const setting = (await env.DB.prepare("SELECT value FROM education_platform_settings WHERE setting_key='brand_logo'").all<Row>()).results[0];
    if (!setting || !env.FILES) return json({ ok: false, error: "Platform logo is not set" }, 404);
    let key = clean(setting.value, 500);
    let type = "image/png";
    try {
      const metadata = JSON.parse(key) as Row;
      if (typeof metadata.key === "string") key = clean(metadata.key, 500);
      if (typeof metadata.contentType === "string") type = clean(metadata.contentType, 40);
    } catch {
      if (key.endsWith(".jpg")) type = "image/jpeg";
      else if (key.endsWith(".webp")) type = "image/webp";
    }
    const object = await env.FILES.get(key);
    if (!object) return json({ ok: false, error: "Platform logo is unavailable" }, 404);
    return new Response(object.body, { headers: { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  }
  if (!pathname.startsWith("/api/admin/platform")) return null;
  if (!isAdmin(user)) return json({ ok: false, error: "Superadmin access required" }, 403);
  if (pathname === "/api/admin/platform" && request.method === "GET") {
    const [schools, feedback, summary, about, live, allEvents, allResources, allVideos, mostWatched] = await Promise.all([
      env.DB.prepare("SELECT school_id,institution_id,name,contact,location,logo_url,active,created_at FROM education_schools ORDER BY created_at DESC").all<Row>(),
      env.DB.prepare("SELECT id,institution_id,school_id,user_id,message,status,created_at,updated_at FROM education_platform_feedback ORDER BY created_at DESC LIMIT 500").all<Row>(),
      env.DB.prepare(`SELECT
        (SELECT COUNT(*) FROM users WHERE disabled=0) AS totalUsers,
        (SELECT COUNT(*) FROM education_schools WHERE active=1) AS schoolCount,
        (SELECT COUNT(*) FROM education_lesson_views) AS videoViews,
        (SELECT COUNT(*) FROM education_lessons WHERE published=1) AS lessonCount,
        (SELECT COUNT(*) FROM education_platform_events WHERE status='published') AS eventCount`).all<Row>(),
      env.DB.prepare("SELECT value FROM education_platform_settings WHERE setting_key='about'").all<Row>(),
      env.DB.prepare("SELECT * FROM education_live_lessons ORDER BY started_at DESC LIMIT 500").all<Row>(),
      env.DB.prepare("SELECT id,title,event_date,fee_ugx,description,status FROM education_platform_events ORDER BY event_date DESC LIMIT 500").all<Row>(),
      env.DB.prepare("SELECT id,title,url,class_name,subject,active,created_at FROM education_platform_resources ORDER BY created_at DESC LIMIT 500").all<Row>(),
      env.DB.prepare("SELECT id,class_name,subject,youtube_url,active,created_at FROM education_video_mappings ORDER BY created_at DESC LIMIT 500").all<Row>(),
      env.DB.prepare(`SELECT v.lesson_id AS id,
          COALESCE(l.title,m.subject,'YouTube lesson') AS title,
          COALESCE(l.class_name,m.class_name,'') AS class_name,
          COALESCE(l.subject,m.subject,'') AS subject,
          COUNT(*) AS views
        FROM education_lesson_views v
        LEFT JOIN education_video_mappings m ON m.id=v.lesson_id
        LEFT JOIN education_lessons l ON l.id=v.lesson_id
        GROUP BY v.lesson_id,l.title,m.subject,l.class_name,m.class_name,l.subject
        ORDER BY views DESC,title LIMIT 20`).all<Row>(),
    ]);
    const c = await content(env, user);
    const analytics = summary.results[0] || {};
    const liveLessons = live.results.map((item) => ({
      ...item,
      status: item.ended_at ? "ended" : "live",
      joinUrl: `https://meet.jit.si/APSHULE-${encodeURIComponent(clean(item.room_id, 200))}`,
      warning: "Anyone holding this public Jitsi link can join; admission and revocation are not server-enforced.",
    }));
    return json({
      ...c,
      schools: schools.results,
      events: allEvents.results,
      resources: allResources.results,
      videoMappings: allVideos.results,
      educationFiles: c.educationFiles,
      educationLessonVideos: c.educationLessonVideos,
      feedback: feedback.results,
      analytics: {
        ...analytics,
        mostWatchedVideos: mostWatched.results,
      },
      about: aboutValue(about.results[0]?.value),
      liveLessons,
    });
  }
  const x = await input(request);
  if (pathname === "/api/admin/platform/schools" && request.method === "POST") {
    const name=clean(x.name,200), contact=clean(x.contact,200), location=clean(x.location,300), logoUrl=clean(x.logoUrl,500);
    if (!name) return json({ok:false,error:"Name is required"},400);
    const sid=id("school"), iid=id("institution");
    if (logoUrl && !httpsUrl(logoUrl)) return json({ ok: false, error: "School logo URL must use HTTPS" }, 400);
    await env.DB.prepare("INSERT INTO education_schools(school_id,institution_id,name,contact,location,logo_url,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(sid,iid,name,contact,location,logoUrl,user.uid,now()).run();
    await audit(env,user,"admin.platform.school.create","education_school",sid); return json({ok:true,schoolId:sid,institutionId:iid},201);
  }
  if (pathname === "/api/admin/platform/events" && request.method === "POST") {
    const title=clean(x.title,200), date=clean(x.eventDate,40), fee=Number(x.feeUgx ?? 0), description=clean(x.description,2000);
    if (!title || !date || Number.isNaN(Date.parse(date)) || !Number.isSafeInteger(fee) || fee<0) return json({ok:false,error:"Valid title, event date, and non-negative fee are required"},400);
    const eid=id("event"); await env.DB.prepare("INSERT INTO education_platform_events(id,title,event_date,fee_ugx,description,status,created_by,created_at) VALUES(?,?,?,?,?,'published',?,?)").bind(eid,title,date,fee,description,user.uid,now()).run(); await audit(env,user,"admin.platform.event.create","event",eid); return json({ok:true,id:eid},201);
  }
  if (pathname === "/api/admin/platform/resources" && request.method === "POST") {
    let pdf = ""; try { const parsed = new URL(clean(x.url,500)); if (parsed.protocol === "https:" && parsed.pathname.toLowerCase().endsWith(".pdf")) pdf = parsed.toString(); } catch {}
    if(!clean(x.title,200)||!pdf) return json({ok:false,error:"Title and an HTTPS PDF URL are required"},400);
    const rid=id("resource"); await env.DB.prepare("INSERT INTO education_platform_resources(id,title,url,class_name,subject,active,created_by,created_at) VALUES(?,?,?,?,?,1,?,?)").bind(rid,clean(x.title,200),pdf,clean(x.className,120),clean(x.subject,120),user.uid,now()).run(); await audit(env,user,"admin.platform.resource.create","resource",rid); return json({ok:true,id:rid},201);
  }
  if (pathname === "/api/admin/platform/video-mappings" && request.method === "POST") {
    const url=httpsUrl(clean(x.youtubeUrl,500),"youtube.com") || httpsUrl(clean(x.youtubeUrl,500),"youtu.be"); if(!clean(x.className,120)||!clean(x.subject,120)||!url) return json({ok:false,error:"Class, subject, and HTTPS YouTube URL are required"},400);
    const vid=id("video"); await env.DB.prepare("INSERT INTO education_video_mappings(id,class_name,subject,youtube_url,active,created_by,created_at) VALUES(?,?,?,?,1,?,?)").bind(vid,clean(x.className,120),clean(x.subject,120),url,user.uid,now()).run(); await audit(env,user,"admin.platform.video.create","video_mapping",vid); return json({ok:true,id:vid},201);
  }
  if (pathname === "/api/admin/platform/about" && request.method === "PUT") {
    const title=clean(x.title,200), body=clean(x.body,10000); if(!title||!body)return json({ok:false,error:"Title and body are required"},400); await env.DB.prepare("INSERT OR REPLACE INTO education_platform_settings(setting_key,value,updated_by,updated_at) VALUES('about',?,?,?)").bind(JSON.stringify({title,body}),user.uid,now()).run(); await audit(env,user,"admin.platform.about.update","platform_settings","about"); return json({ok:true});
  }
  if (pathname === "/api/admin/platform/brand-logo" && request.method === "POST") {
    if (!env.FILES) return json({ ok: false, error: "File storage is unavailable" }, 503);
    const form = await request.formData().catch(() => null), file = form?.get("file");
    if (!(file instanceof File) || file.size > 2 * 1024 * 1024) return json({ ok: false, error: "A PNG, JPEG, or WebP file up to 2 MiB is required" }, 413);
    const raw = await file.arrayBuffer(), bytes = new Uint8Array(raw);
    let type = "";
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) type = "image/png";
    else if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) type = "image/jpeg";
    else if (bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP") type = "image/webp";
    if (!type) return json({ ok: false, error: "The file is not a valid PNG, JPEG, or WebP image" }, 415);
    const extension = type === "image/jpeg" ? "jpg" : type === "image/webp" ? "webp" : "png";
    const key = `education/platform/logo-${crypto.randomUUID()}.${extension}`;
    try {
      await env.FILES.put(key, raw, { httpMetadata: { contentType: type } });
      await env.DB.prepare("INSERT OR REPLACE INTO education_platform_settings(setting_key,value,updated_by,updated_at) VALUES('brand_logo',?,?,?)")
        .bind(JSON.stringify({ key, contentType: type }),user.uid,now()).run();
    } catch { try { await env.FILES.delete(key); } catch {} return json({ ok: false, error: "Logo metadata could not be saved" }, 502); }
    await audit(env,user,"admin.platform.brand_logo.update","platform_settings","brand_logo");
    return json({ ok: true }, 201);
  }
  const schoolRoute = pathname.match(/^\/api\/admin\/platform\/schools\/([^/]+)$/);
  if (schoolRoute && request.method === "PATCH") {
    let schoolId = "";
    try { schoolId = decodeURIComponent(schoolRoute[1]); } catch {}
    if (!schoolId) return json({ ok: false, error: "Invalid school ID" }, 400);
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, column, max] of [
      ["name", "name", 200], ["contact", "contact", 200], ["location", "location", 300], ["logoUrl", "logo_url", 500],
    ] as const) {
      if (x[key] === undefined) continue;
      const value = clean(x[key], max);
      if (key === "name" && !value) return json({ ok: false, error: "School name cannot be blank" }, 400);
      if (key === "logoUrl" && value && !httpsUrl(value)) return json({ ok: false, error: "School logo URL must use HTTPS" }, 400);
      fields.push(`${column}=?`);
      values.push(value);
    }
    if (!fields.length) return json({ ok: false, error: "No school details were provided" }, 400);
    const result = await env.DB.prepare(`UPDATE education_schools SET ${fields.join(",")} WHERE school_id=?`)
      .bind(...values, schoolId).run();
    if (Number((result as { meta?: { changes?: number } })?.meta?.changes ?? 0) === 0) return json({ ok: false, error: "School not found" }, 404);
    await audit(env, user, "admin.platform.school.update", "education_school", schoolId);
    return json({ ok: true });
  }
  const eventRoute = pathname.match(/^\/api\/admin\/platform\/events\/([^/]+)$/);
  if (eventRoute && ["PATCH", "DELETE"].includes(request.method)) {
    let eventId = "";
    try { eventId = decodeURIComponent(eventRoute[1]); } catch {}
    if (!eventId) return json({ ok: false, error: "Invalid event ID" }, 400);
    if (request.method === "DELETE") {
      await env.DB.prepare("UPDATE education_platform_events SET status='archived' WHERE id=?").bind(eventId).run();
    } else {
      const title = x.title === undefined ? null : clean(x.title, 200);
      const date = x.eventDate === undefined ? null : clean(x.eventDate, 40);
      const fee = x.feeUgx === undefined ? null : Number(x.feeUgx);
      if (title === "" || (date !== null && Number.isNaN(Date.parse(date))) ||
          (fee !== null && (!Number.isSafeInteger(fee) || fee < 0))) {
        return json({ ok: false, error: "Event title, date, or fee is invalid" }, 400);
      }
      const status = x.status === undefined ? null : clean(x.status, 20).toLowerCase();
      if (status !== null && !["published", "archived"].includes(status)) return json({ ok: false, error: "Invalid event status" }, 400);
      await env.DB.prepare(`UPDATE education_platform_events SET
        title=COALESCE(?,title),event_date=COALESCE(?,event_date),fee_ugx=COALESCE(?,fee_ugx),
        description=COALESCE(?,description),status=COALESCE(?,status) WHERE id=?`)
        .bind(title, date, fee, x.description === undefined ? null : clean(x.description, 2000), status, eventId).run();
    }
    await audit(env, user, `admin.platform.event.${request.method.toLowerCase()}`, "event", eventId);
    return json({ ok: true });
  }
  const resourceRoute = pathname.match(/^\/api\/admin\/platform\/resources\/([^/]+)$/);
  if (resourceRoute && ["PATCH", "DELETE"].includes(request.method)) {
    let resourceId = "";
    try { resourceId = decodeURIComponent(resourceRoute[1]); } catch {}
    if (!resourceId) return json({ ok: false, error: "Invalid resource ID" }, 400);
    if (request.method === "DELETE") {
      await env.DB.prepare("UPDATE education_platform_resources SET active=0 WHERE id=?").bind(resourceId).run();
    } else {
      const title = x.title === undefined ? null : clean(x.title, 200);
      let url: string | null = null;
      if (x.url !== undefined) {
        try {
          const parsed = new URL(clean(x.url, 1000));
          if (parsed.protocol !== "https:" || !parsed.pathname.toLowerCase().endsWith(".pdf")) throw new Error();
          url = parsed.toString();
        } catch { return json({ ok: false, error: "An HTTPS PDF URL is required" }, 400); }
      }
      if (title === "") return json({ ok: false, error: "Resource title cannot be blank" }, 400);
      const active = x.active === undefined ? null : x.active ? 1 : 0;
      await env.DB.prepare(`UPDATE education_platform_resources SET title=COALESCE(?,title),url=COALESCE(?,url),
        class_name=COALESCE(?,class_name),subject=COALESCE(?,subject),active=COALESCE(?,active) WHERE id=?`)
        .bind(title, url, x.className === undefined ? null : clean(x.className, 120),
          x.subject === undefined ? null : clean(x.subject, 120), active, resourceId).run();
    }
    await audit(env, user, `admin.platform.resource.${request.method.toLowerCase()}`, "resource", resourceId);
    return json({ ok: true });
  }
  const videoRoute = pathname.match(/^\/api\/admin\/platform\/video-mappings\/([^/]+)$/);
  if (videoRoute && ["PATCH", "DELETE"].includes(request.method)) {
    let videoId = "";
    try { videoId = decodeURIComponent(videoRoute[1]); } catch {}
    if (!videoId) return json({ ok: false, error: "Invalid video mapping ID" }, 400);
    if (request.method === "DELETE") {
      await env.DB.prepare("UPDATE education_video_mappings SET active=0 WHERE id=?").bind(videoId).run();
    } else {
      const className = x.className === undefined ? null : clean(x.className, 120);
      const subject = x.subject === undefined ? null : clean(x.subject, 120);
      const youtubeUrl = x.youtubeUrl === undefined ? null :
        httpsUrl(clean(x.youtubeUrl, 500), "youtube.com") || httpsUrl(clean(x.youtubeUrl, 500), "youtu.be");
      if (className === "" || subject === "" || (x.youtubeUrl !== undefined && !youtubeUrl)) {
        return json({ ok: false, error: "Class, subject, and HTTPS YouTube URL are required" }, 400);
      }
      const active = x.active === undefined ? null : x.active ? 1 : 0;
      await env.DB.prepare(`UPDATE education_video_mappings SET class_name=COALESCE(?,class_name),
        subject=COALESCE(?,subject),youtube_url=COALESCE(?,youtube_url),active=COALESCE(?,active) WHERE id=?`)
        .bind(className, subject, youtubeUrl, active, videoId).run();
    }
    await audit(env, user, `admin.platform.video.${request.method.toLowerCase()}`, "video_mapping", videoId);
    return json({ ok: true });
  }
  const fm=pathname.match(/^\/api\/admin\/platform\/feedback\/([^/]+)$/);
  if(fm && request.method==="PATCH"){const status=clean(x.status,20).toLowerCase(); if(!["new","read","resolved"].includes(status))return json({ok:false,error:"Invalid feedback status"},400); await env.DB.prepare("UPDATE education_platform_feedback SET status=?,updated_at=? WHERE id=?").bind(status,now(),decodeURIComponent(fm[1])).run(); await audit(env,user,"admin.platform.feedback.update","feedback",fm[1]); return json({ok:true});}
  if(pathname==="/api/admin/platform/live-lessons"&&request.method==="POST"){const title=clean(x.title,200), cls=clean(x.className,120), sub=clean(x.subject,120);if(!title||!cls||!sub)return json({ok:false,error:"Title, className, and subject are required"},400);const lid=id("live"), room=crypto.randomUUID()+crypto.randomUUID();await env.DB.prepare("INSERT INTO education_live_lessons(id,institution_id,school_id,title,class_name,subject,room_id,started_at,created_by) VALUES(?,?,?,?,?,?,?,?,?)").bind(lid,user.institutionId,user.schoolId,title,cls,sub,room,now(),user.uid).run();await audit(env,user,"admin.platform.live.create","live_lesson",lid);return json({ok:true,id:lid,roomId:room,warning:"Anyone holding this public Jitsi link can join; admission and revocation are not server-enforced."},201);}
  const end=pathname.match(/^\/api\/admin\/platform\/live-lessons\/([^/]+)\/end$/);if(end&&request.method==="POST"){await env.DB.prepare("UPDATE education_live_lessons SET ended_at=? WHERE id=? AND ended_at IS NULL").bind(now(),decodeURIComponent(end[1])).run();await audit(env,user,"admin.platform.live.end","live_lesson",end[1]);return json({ok:true});}
  return json({ok:false,error:"Not found"},404);
}