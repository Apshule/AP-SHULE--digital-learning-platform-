import type { AuthUser } from "./backend-types";
import {
  cleanText,
  database,
  isPlatformSuperadmin,
  jsonAttachment,
  makeSimplePdf,
  platformJson,
  PlatformV10Env,
  safeId,
  userTenantId,
} from "./platform-v10-common";

const TYPES = new Set(["education", "mfi", "clinic", "farm"]);
const RANGE_DAYS: Record<string, number> = { week: 7, month: 30, term: 120 };
type Row = Record<string, unknown>;

function roleCanReadAnalytics(user: AuthUser) {
  const role = cleanText(user.role, 80).toLowerCase().replace(/[ -]+/g, "_");
  return isPlatformSuperadmin(user) || [
    "school", "school_admin", "head_teacher", "headteacher", "secretary", "bursar",
    "education_admin", "mfi_admin", "clinic_admin", "farm_admin", "institution_admin",
  ].includes(role);
}

function targetForRequest(request: Request, user: AuthUser, explicitParam = "institution_id") {
  const url = new URL(request.url);
  const requested = safeId(
    url.searchParams.get(explicitParam) ||
      url.searchParams.get("school_id") ||
      url.searchParams.get("mfi_id") ||
      url.searchParams.get("clinic_id") ||
      url.searchParams.get("farm_id"),
    180,
  );
  const target = requested || userTenantId(user);
  if (!target) return "";
  if (isPlatformSuperadmin(user) || target === user.schoolId || target === user.institutionId) return target;
  return "";
}

function dateRange(request: Request) {
  const range = cleanText(new URL(request.url).searchParams.get("range"), 20).toLowerCase() || "month";
  return RANGE_DAYS[range] ? { label: range, days: RANGE_DAYS[range] } : null;
}

async function countOverview(env: PlatformV10Env, institutionId: string, type: string, days: number) {
  const pg = database(env);
  const userCounts = await pg.query<Row>(
    `SELECT COUNT(*)::integer AS total_users
       FROM public.users
      WHERE institution_id=$1 OR school_id=$1`,
    [institutionId],
  );
  const activeUsers = await pg.query<Row>(
    `SELECT COUNT(DISTINCT student_id)::integer AS count
       FROM public.offline_views
      WHERE school_id=$1 AND watched_at >= NOW()-($2::text || ' days')::interval`,
    [institutionId, days],
  );
  const revenue = await pg.query<Row>(
    `SELECT COALESCE(SUM(amount),0)::numeric AS amount
       FROM public.payments
      WHERE lower(status) IN ('paid','completed','settled')
        AND upper(currency)='UGX'
        AND (institution_id=$1 OR school_id=$1)
        AND updated_at::timestamptz >= NOW()-($2::text || ' days')::interval`,
    [institutionId, days],
  );
  const views = await pg.query<Row>(
    `SELECT COUNT(*)::integer AS count
       FROM public.offline_views
      WHERE school_id=$1 AND watched_at >= NOW()-($2::text || ' days')::interval`,
    [institutionId, days],
  );
  const records = await pg.query<Row>(
    `SELECT sector,record_type,COUNT(*)::integer AS count
       FROM public.sector_records
      WHERE (institution_id=$1 OR school_id=$1) AND is_deleted=0
      GROUP BY sector,record_type ORDER BY sector,record_type`,
    [institutionId],
  );
  return {
    institution_id: institutionId,
    type,
    range_days: days,
    total_users: Number(userCounts.rows[0]?.total_users) || 0,
    active_users: Number(activeUsers.rows[0]?.count) || 0,
    revenue: Number(revenue.rows[0]?.amount) || 0,
    currency: "UGX",
    views: Number(views.rows[0]?.count) || 0,
    records: records.rows,
  };
}

async function educationAnalytics(env: PlatformV10Env, schoolId: string) {
  const [grades, projects, retooling] = await Promise.all([
    database(env).query<Row>(
      `SELECT COALESCE(NULLIF(data->>'performanceLevel',''),NULLIF(data->>'performance_level',''),
                       NULLIF(data->>'grade',''),NULLIF(data->>'level',''),'Unclassified') AS level,
              COUNT(*)::integer AS count
         FROM (
           SELECT record_json::jsonb AS data FROM public.sector_records
            WHERE sector='education' AND record_type IN ('ca_record','ca_records','assessment')
              AND (school_id=$1 OR institution_id=$1) AND is_deleted=0
         ) records
        GROUP BY 1 ORDER BY 1`,
      [schoolId],
    ),
    database(env).query<Row>(
      `SELECT COUNT(*)::integer AS count FROM public.projects
        WHERE school_id=$1
          AND (milestone_1_status NOT IN ('approved','complete')
            OR milestone_2_status NOT IN ('approved','complete')
            OR final_status NOT IN ('approved','complete'))`,
      [schoolId],
    ),
    database(env).query<Row>(
      `SELECT CASE WHEN COUNT(*)=0 THEN 0
                   ELSE ROUND(100.0*COUNT(*) FILTER (WHERE completed=TRUE)/COUNT(*),1)
              END AS percent
         FROM public.teacher_retooling_progress WHERE school_id=$1`,
      [schoolId],
    ),
  ]);
  const caRecordsByLevel: Record<string, number> = {};
  for (const row of grades.rows) caRecordsByLevel[cleanText(row.level, 80) || "Unclassified"] = Number(row.count) || 0;
  return {
    school_id: schoolId,
    ca_records_by_level: caRecordsByLevel,
    projects_pending: Number(projects.rows[0]?.count) || 0,
    retooling_progress: Number(retooling.rows[0]?.percent) || 0,
  };
}

async function sectorAnalytics(env: PlatformV10Env, type: "mfi" | "clinic" | "farm", institutionId: string) {
  const pg = database(env);
  const numericJson = (alias: string, keys: string[]) => {
    const value = `COALESCE(${keys.map((key) => `NULLIF(${alias}->>'${key}','')`).join(",")},'')`;
    return `CASE WHEN ${value} ~ '^-?[0-9]+([.][0-9]+)?$' THEN (${value})::numeric ELSE 0 END`;
  };
  const textJson = (alias: string, keys: string[]) =>
    `COALESCE(${keys.map((key) => `NULLIF(${alias}->>'${key}','')`).join(",")},'')`;
  if (type === "mfi") {
    const score = numericJson("data", ["score", "totalScore", "total_score"]);
    const amount = numericJson("data", ["disbursedAmount", "disbursed_amount", "amount", "principal"]);
    const status = `lower(${textJson("data", ["status"])})`;
    const result = await pg.query<Row>(
      `WITH records AS (
         SELECT record_type,record_json::jsonb AS data
           FROM public.sector_records
          WHERE sector='mfi' AND record_type IN ('loan','collateral_score')
            AND (institution_id=$1 OR school_id=$1) AND is_deleted=0
       )
       SELECT
         COUNT(*) FILTER (WHERE record_type='loan' AND ${status} IN ('approved','disbursed','repaying','active'))::integer AS loans_active,
         COUNT(*) FILTER (WHERE record_type='loan' AND ${status}='overdue')::integer AS overdue,
         COALESCE((
           SELECT AVG(${score}) FROM records WHERE record_type='collateral_score'
         ),0)::numeric AS collateral_scoring_avg,
         COALESCE(SUM(${amount}) FILTER (
           WHERE record_type='loan' AND ${status} IN ('disbursed','repaying','active')
         ),0)::numeric AS disbursed_total
       FROM records`,
      [institutionId],
    );
    const row = result.rows[0] ?? {};
    return {
      mfi_id: institutionId,
      loans_active: Number(row.loans_active) || 0,
      overdue: Number(row.overdue) || 0,
      collateral_scoring_avg: Number(row.collateral_scoring_avg) || 0,
      disbursed_total: Number(row.disbursed_total) || 0,
    };
  }
  if (type === "clinic") {
    const today = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const quantity = numericJson("data", ["quantity", "stock", "currentStock"]);
    const threshold = numericJson("data", ["reorderLevel", "reorder_level", "minimumStock", "minimum_stock"]);
    const revenue = numericJson("data", ["totalAmount", "total_amount", "total", "amount"]);
    const appointmentDate = textJson("data", ["appointmentDate", "appointment_date", "date"]);
    const billDate = textJson("data", ["billDate", "bill_date", "date", "createdAt"]);
    const result = await pg.query<Row>(
      `WITH records AS (
         SELECT record_type,created_at,record_json::jsonb AS data
           FROM public.sector_records
          WHERE sector='clinic'
            AND record_type IN ('patient','appointment','billing','clinic_billing','pharmacy_inventory','clinic_pharmacy_inventory')
            AND institution_id=$1 AND is_deleted=0
       )
       SELECT
         COUNT(*) FILTER (WHERE record_type='patient')::integer AS patients_total,
         COUNT(*) FILTER (
           WHERE record_type='appointment'
             AND COALESCE(NULLIF(${appointmentDate},''),created_at) LIKE $2 || '%'
         )::integer AS appointments_today,
         COALESCE(SUM(${revenue}) FILTER (
           WHERE record_type IN ('billing','clinic_billing')
             AND COALESCE(NULLIF(${billDate},''),created_at) LIKE $2 || '%'
         ),0)::numeric AS revenue_today,
         COUNT(*) FILTER (
           WHERE record_type IN ('pharmacy_inventory','clinic_pharmacy_inventory')
             AND ${quantity} <= ${threshold}
         )::integer AS pharmacy_low_stock
       FROM records`,
      [institutionId, today],
    );
    const row = result.rows[0] ?? {};
    return {
      clinic_id: institutionId,
      patients_total: Number(row.patients_total) || 0,
      appointments_today: Number(row.appointments_today) || 0,
      revenue_today: Number(row.revenue_today) || 0,
      pharmacy_low_stock: Number(row.pharmacy_low_stock) || 0,
    };
  }
  const today = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const quantity = numericJson("data", ["quantity", "count", "animals", "totalEggs", "total_eggs"]);
  const movementType = `upper(${textJson("data", ["movementType", "direction", "type"])})`;
  const eggDate = textJson("data", ["date", "collectionDate", "collection_date"]);
  const expenseDate = textJson("data", ["date", "expenseDate", "expense_date"]);
  const feedAmount = numericJson("data", ["quantityUsed", "quantity_used", "usedQuantity", "quantity", "amount"]);
  const expenseAmount = numericJson("data", ["amount", "total"]);
  const result = await pg.query<Row>(
    `WITH records AS (
       SELECT record_type,created_at,record_json::jsonb AS data
         FROM public.sector_records
        WHERE sector='farm'
          AND record_type IN ('animal_movement','egg_collection','feed_consumption','expense')
          AND (institution_id=$1 OR school_id=$1) AND is_deleted=0
     )
     SELECT
       COALESCE(SUM(${quantity}) FILTER (
         WHERE record_type='animal_movement' AND ${movementType} IN ('IN','MOVED_IN')
       ),0)::numeric AS animals_in,
       COALESCE(SUM(${quantity}) FILTER (
         WHERE record_type='egg_collection'
           AND COALESCE(NULLIF(${eggDate},''),created_at) LIKE $2 || '%'
       ),0)::numeric AS eggs_today,
       COALESCE(SUM(${feedAmount}) FILTER (WHERE record_type='feed_consumption'),0)::numeric AS feed_used,
       COALESCE(SUM(${expenseAmount}) FILTER (
         WHERE record_type='expense'
           AND COALESCE(NULLIF(${expenseDate},''),created_at) LIKE $2 || '%'
       ),0)::numeric AS expenses_today
     FROM records`,
    [institutionId, today],
  );
  const row = result.rows[0] ?? {};
  return {
    farm_id: institutionId,
    animals_in: Number(row.animals_in) || 0,
    eggs_today: Number(row.eggs_today) || 0,
    feed_used: Number(row.feed_used) || 0,
    expenses_today: Number(row.expenses_today) || 0,
  };
}

async function reportForType(env: PlatformV10Env, request: Request, type: string, institutionId: string, overview = false) {
  if (overview) {
    const range = dateRange(request);
    if (!range) return null;
    return await countOverview(env, institutionId, type, range.days);
  }
  if (type === "education") return await educationAnalytics(env, institutionId);
  if (type === "mfi" || type === "clinic" || type === "farm") return await sectorAnalytics(env, type, institutionId);
  const range = dateRange(request);
  if (!range) return null;
  return await countOverview(env, institutionId, type, range.days);
}

async function exportPdf(request: Request, env: PlatformV10Env, type: string, institutionId: string) {
  if (!env.FILES) return platformJson({ ok: false, error: "R2 export storage is unavailable" }, 503);
  const report = await reportForType(env, request, type, institutionId);
  if (!report) return platformJson({ ok: false, error: "range must be week, month, or term" }, 400);
  const title = `APSHULE ${type.toUpperCase()} Analytics — ${institutionId}`;
  const lines = Object.entries(report as Row).flatMap(([key, value]) => {
    if (value && typeof value === "object") return [`${key}: ${JSON.stringify(value)}`];
    return [`${key}: ${String(value)}`];
  });
  const bytes = makeSimplePdf(title, lines);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const key = `exports/analytics/${institutionId}/${type}/${stamp}.pdf`;
  await env.FILES.put(key, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
    httpMetadata: { contentType: "application/pdf" },
  });
  return jsonAttachment(bytes, "application/pdf", `analytics-${type}.pdf`);
}

export async function handleAnalyticsV10Route(
  request: Request,
  env: PlatformV10Env,
  user: AuthUser | null,
): Promise<Response | null> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/analytics(?:\/(overview|education|mfi|clinic|farm|export\/pdf))?$/);
  if (!match) return null;
  if (!user) return platformJson({ ok: false, error: "Authentication is required" }, 401);
  if (!env.PG) return platformJson({ ok: false, error: "Neon database persistence is unavailable" }, 503);
  if (!roleCanReadAnalytics(user)) return platformJson({ ok: false, error: "Institution analytics access is required" }, 403);
  if (request.method !== "GET") return platformJson({ ok: false, error: "Method not allowed" }, 405);

  const pathType = match[1] === "export/pdf" || match[1] === "overview"
    ? cleanText(url.searchParams.get("type"), 20).toLowerCase()
    : match[1];
  const type = pathType || cleanText(url.searchParams.get("type"), 20).toLowerCase() || "education";
  if (!TYPES.has(type)) return platformJson({ ok: false, error: "type must be education, mfi, clinic, or farm" }, 400);
  const overview = match[1] === "overview" || match[1] === undefined;
  const isPdfExport = match[1] === "export/pdf";
  const param = overview || isPdfExport ? "institution_id"
    : type === "education" ? "school_id"
      : type === "mfi" ? "mfi_id"
        : type === "clinic" ? "clinic_id" : "farm_id";
  const institutionId = targetForRequest(request, user, param);
  if (!institutionId) return platformJson({ ok: false, error: "A valid tenant ID in your assigned institution is required" }, 403);
  try {
    if (isPdfExport) return await exportPdf(request, env, type, institutionId);
    const report = await reportForType(env, request, type, institutionId, overview);
    if (!report) return platformJson({ ok: false, error: "range must be week, month, or term" }, 400);
    return platformJson({ ok: true, ...report as Row });
  } catch {
    return platformJson({ ok: false, error: "Analytics are unavailable" }, 503);
  }
}