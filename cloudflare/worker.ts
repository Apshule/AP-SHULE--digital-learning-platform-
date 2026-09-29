import { authenticate, handleAuthRoute } from "./auth";
import { handleClinicWorkflowRoute } from "./clinic-workflows";
import { handleFarmWorkflowRoute } from "./farm-workflows";
import { handleMfiWorkflowRoute } from "./mfi-workflows";
import { handleDomainRoute } from "./domain-routes";
import { handleProfileFileRoute } from "./profile-files";
import { handlePushRoute } from "./push-events";
import { handleTechContactRoute } from "./tech-contact";
import type { AuthEnv, AuthUser } from "./backend-types";

interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

interface D1BatchResult {
  results?: Record<string, unknown>[];
  success?: boolean;
  meta?: { changes?: number };
}

interface D1Database {
  prepare(query: string): D1Statement;
  batch(statements: D1Statement[]): Promise<D1BatchResult[]>;
}

interface KVNamespace {
  get(key: string, type?: "text" | "json" | "arrayBuffer" | "stream"): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

interface R2Object {
  body: ReadableStream;
  httpMetadata?: { contentType?: string };
}

interface R2Bucket {
  head(key: string): Promise<unknown>;
  put(key: string, value: ReadableStream | ArrayBuffer | string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<R2Object | null>;
}

interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

interface Env extends AuthEnv {
  CACHE?: KVNamespace;
  VIDEOS?: R2Bucket;
  FILES?: R2Bucket;
  STATIC?: Fetcher;
  ENVIRONMENT: string;
  D1_DATABASE_NAME: string;
  APSHULE_API_WRITE_TOKEN?: string;
  PUSH_SECRET?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

const STATIC_ROUTE_PREFIXES = [
  "/admin/",
  "/clinic/",
  "/education/",
  "/farm/",
  "/mfi/",
  "/skills/",
  "/tech/",
  "/icons/",
  "/.well-known/",
];

const STATIC_ROOT_FILES = new Set([
  "/app.css",
  "/landing.css",
  "/login",
  "/manifest.json",
  "/manifest.webmanifest",
  "/profile.html",
  "/reset-password.html",
  "/sector.html",
  "/sw.js",
]);

const WORKSPACE_PAGE_FALLBACKS = [
  ["/workspace/admin", "/admin/"],
  ["/workspace/student", "/education/"],
  ["/workspace/individual", "/education/"],
  ["/workspace/learner", "/education/"],
  ["/workspace/teacher", "/education/"],
  ["/workspace/head_teacher", "/education/"],
  ["/workspace/headteacher", "/education/"],
  ["/workspace/secretary", "/education/"],
  ["/workspace/bursar", "/education/"],
  ["/workspace/parent", "/education/"],
  ["/workspace/education", "/education/"],
  ["/workspace/clinic", "/clinic/"],
  ["/workspace/farm", "/farm/"],
  ["/workspace/mfi", "/mfi/"],
  ["/education", "/education/"],
  ["/school", "/education/"],
  ["/student", "/education/"],
  ["/teacher", "/education/"],
  ["/mfi", "/mfi/"],
  ["/clinic", "/clinic/"],
  ["/farm", "/farm/"],
] as const;

function workspacePageFallback(pathname: string): string | null {
  if (pathname === "/login" || pathname === "/login/" || pathname === "/workspace" || pathname === "/workspace/") return "/";
  const match = WORKSPACE_PAGE_FALLBACKS.find(([prefix]) =>
    pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  return match?.[1] || null;
}

function isExplicitStaticRoute(pathname: string): boolean {
  return pathname === "/"
    || STATIC_ROOT_FILES.has(pathname)
    || STATIC_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(prefix))
    || Boolean(workspacePageFallback(pathname));
}

function redirectDirectoryRoot(pathname: string, search: string): Response | null {
  if (!["/admin", "/clinic", "/education", "/farm", "/mfi", "/skills", "/tech"].includes(pathname)) return null;
  return new Response(null, {
    status: 308,
    headers: { location: `${pathname}/${search}` },
  });
}

type ProviderRow = {
  id: string;
  name: string;
  description: string;
  logo_url: string;
  badge_url: string;
  physical_address: string;
  contact_email: string;
  contact_phone: string;
  referral_code: string;
  status: string;
  owner_id: string;
  created_at: string;
  updated_at: string;
  course_id?: string;
  course_title?: string;
  course_description?: string;
  course_duration?: string;
  course_fee_ugx?: number;
  course_category?: string;
  course_featured?: number;
};

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin") ?? "";
  const allowed = !origin || origin === "https://appshule.com" || origin === "https://www.appshule.com" || origin.includes(".replit.dev");
  return allowed ? { "access-control-allow-origin": origin || "*" } : {};
}

function withCors(request: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(request))) headers.set(key, value);
  headers.set("access-control-allow-headers", "Authorization, Content-Type");
  headers.set("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
  headers.set("access-control-allow-credentials", "true");
  headers.set("vary", "Origin");
  return new Response(response.body, { status: response.status, headers });
}

function now(): string {
  return new Date().toISOString();
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

function clean(value: unknown, max = 500): string {
  return String(value ?? "").trim().slice(0, max);
}

function youtubeId(value: unknown): string {
  const input = clean(value, 500);
  return input.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/i)?.[1] ?? "";
}

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function hasBearer(request: Request): boolean {
  return /^Bearer\s+\S+$/i.test(request.headers.get("authorization") ?? "");
}

function canWrite(request: Request, env: Env): boolean {
  const configured = env.APSHULE_API_WRITE_TOKEN;
  return Boolean(configured && request.headers.get("authorization") === `Bearer ${configured}`);
}

async function skillsEnrollmentRateLimit(request: Request, env: Env): Promise<"allowed" | "limited" | "unavailable"> {
  const ipAddress = request.headers.get("cf-connecting-ip");
  if (!env.CACHE || !ipAddress) return "unavailable";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ipAddress));
  const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const key = `skills-enrollment:${fingerprint}`;
  const stored = await env.CACHE.get(key, "text");
  const count = Number(stored ?? 0);
  if (Number.isFinite(count) && count >= 5) return "limited";
  await env.CACHE.put(key, String((Number.isFinite(count) ? count : 0) + 1), { expirationTtl: 600 });
  return "allowed";
}

async function skillsProviderRegistrationRateLimit(env: Env, userId: string): Promise<boolean> {
  if (!env.CACHE) return false;
  const key = `skills-provider-registration:${userId}`;
  const count = Number(await env.CACHE.get(key, "text") || 0);
  if (!Number.isFinite(count) || count >= 5) return false;
  await env.CACHE.put(key, String(count + 1), { expirationTtl: 600 });
  return true;
}

function publicProvider(row: ProviderRow, courses: Record<string, unknown>[]) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    badgeUrl: row.badge_url,
    logoUrl: row.logo_url,
    physicalAddress: row.physical_address,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    referralCode: row.referral_code,
    status: row.status,
    courses,
    rating: 0,
    reviewCount: 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function providerRows(env: Env, providerId = ""): Promise<ProviderRow[]> {
  const sql = `
    SELECT p.*, c.id AS course_id, c.title AS course_title,
      c.description AS course_description, c.duration AS course_duration,
      c.fee_ugx AS course_fee_ugx, c.category AS course_category,
      c.featured AS course_featured
    FROM skills_providers p
    LEFT JOIN vocational_courses c ON c.provider_id = p.id AND c.active = 1
    ${providerId ? "WHERE p.id = ?" : ""}
    ORDER BY p.created_at DESC, c.title ASC
  `;
  const statement = env.DB.prepare(sql);
  const result = providerId ? await statement.bind(providerId).all<ProviderRow>() : await statement.all<ProviderRow>();
  return result.results;
}

function groupedProviders(rows: ProviderRow[]) {
  const providers = new Map<string, { row: ProviderRow; courses: Record<string, unknown>[] }>();
  for (const row of rows) {
    if (!providers.has(row.id)) providers.set(row.id, { row, courses: [] });
    if (row.course_id) {
      providers.get(row.id)?.courses.push({
        id: row.course_id,
        title: row.course_title ?? "",
        description: row.course_description ?? "",
        duration: row.course_duration ?? "",
        feeUgx: Number(row.course_fee_ugx ?? 0),
        category: row.course_category ?? "Vocational",
        featured: Number(row.course_featured ?? 0) === 1,
      });
    }
  }
  return [...providers.values()];
}

async function api(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });

  const authResponse = await handleAuthRoute(request, env);
  if (authResponse) return authResponse;

  const pushResponse = await handlePushRoute(request, env);
  if (pushResponse) return pushResponse;

  const techContactResponse = await handleTechContactRoute(request, env);
  if (techContactResponse) return techContactResponse;

  if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/api/healthz")) {
    return json({
      ok: true,
      environment: env.ENVIRONMENT,
      cloudflare: { d1: env.D1_DATABASE_NAME, kv: Boolean(env.CACHE || env.SESSIONS), r2: Boolean(env.FILES || env.VIDEOS) },
      firebase: false,
      authentication: "cloudflare-d1-kv",
    });
  }

  if (url.pathname === "/api/profile/photo") {
    const authentication = await authenticate(request, env);
    if (!authentication.authenticated) return json({ ok: false, error: "Authentication is required" }, (authentication as { status: number }).status);
    return handleProfileFileRoute(request, env, authentication.user);
  }

  const domainPath = url.pathname === "/api/pay"
    || url.pathname.startsWith("/api/payments")
    || url.pathname.startsWith("/api/school")
    || url.pathname.startsWith("/api/clinic")
    || url.pathname.startsWith("/api/farm")
    || url.pathname.startsWith("/api/mfi")
    || url.pathname.startsWith("/api/admin");
  if (domainPath) {
    const authentication = await authenticate(request, env);
    const clinicResponse = await handleClinicWorkflowRoute(
      request,
      env,
      authentication.authenticated ? authentication.user as AuthUser : null,
    );
    if (clinicResponse) return clinicResponse;
    const farmResponse = await handleFarmWorkflowRoute(
      request,
      env,
      authentication.authenticated ? authentication.user as AuthUser : null,
    );
    if (farmResponse) return farmResponse;
    const mfiResponse = await handleMfiWorkflowRoute(
      request,
      env,
      authentication.authenticated ? authentication.user as AuthUser : null,
    );
    if (mfiResponse) return mfiResponse;
    const response = await handleDomainRoute(
      request,
      env,
      authentication.authenticated ? authentication.user as AuthUser : null,
    );
    if (response) return response;
  }

  if (request.method === "GET" && url.pathname === "/api/skills/providers") {
    const providers = groupedProviders((await providerRows(env)).filter((row) => row.status === "active"))
      .map(({ row, courses }) => publicProvider(row, courses));
    return json({ ok: true, providers });
  }

  const providerMatch = url.pathname.match(/^\/api\/skills\/providers\/([^/]+)$/);
  if (request.method === "GET" && providerMatch) {
    let providerId = "";
    try {
      providerId = clean(decodeURIComponent(providerMatch[1]), 120);
    } catch {
      return json({ ok: false, error: "Provider not found" }, 404);
    }
    const provider = groupedProviders((await providerRows(env, providerId)).filter((row) => row.status === "active"))[0];
    if (!provider) return json({ ok: false, error: "Provider not found" }, 404);
    return json({ ok: true, provider: publicProvider(provider.row, provider.courses) });
  }

  if (request.method === "GET" && url.pathname === "/api/skills/courses") {
    const category = clean(url.searchParams.get("category"), 80).toLowerCase();
    const referralCode = clean(url.searchParams.get("referralCode"), 120);
    const rows = groupedProviders((await providerRows(env)).filter((row) =>
      row.status === "active" && (!referralCode || row.referral_code === referralCode),
    ));
    const courses: Record<string, unknown>[] = [];
    for (const { row, courses: providerCourses } of rows) {
      for (const course of providerCourses) {
        const courseCategory = clean(course.category, 80).toLowerCase();
        if (category && category !== "vocational" && courseCategory !== category) continue;
        const video = await env.DB.prepare(
          "SELECT youtube_url, youtube_id, thumbnail_url FROM videos WHERE provider_id = ? AND course_id = ? ORDER BY created_at DESC LIMIT 1",
        ).bind(row.id, course.id).all<{ youtube_url: string; youtube_id: string; thumbnail_url: string }>();
        const linked = video.results[0];
        const linkedId = youtubeId(linked?.youtube_url || linked?.youtube_id);
        courses.push({
          id: `${row.id}:${course.id}`,
          courseId: course.id,
          providerId: row.id,
          providerName: row.name,
          referralCode: row.referral_code,
          ...course,
          youtubeUrl: linked?.youtube_url || (linkedId ? `https://www.youtube.com/watch?v=${linkedId}` : ""),
          youtubeId: linkedId,
          thumbnailUrl: linked?.thumbnail_url || (linkedId ? `https://img.youtube.com/vi/${linkedId}/hqdefault.jpg` : ""),
        });
      }
    }
    return json({ ok: true, category: category || "vocational", courses });
  }

  if (request.method === "POST" && (url.pathname === "/api/skills/providers" || url.pathname === "/api/skills/providers/register")) {
    const isRegistration = url.pathname === "/api/skills/providers/register";
    const authentication = isRegistration ? await authenticate(request, env) : null;
    const hasWriteAuthorization = canWrite(request, env);
    if (!isRegistration && !hasWriteAuthorization) {
      return json({ ok: false, error: "Cloudflare application write authorization is not configured" }, 503);
    }
    if (isRegistration && !hasWriteAuthorization && authentication?.authenticated !== true) {
      const status = authentication?.status ?? 401;
      return json({
        ok: false,
        error: status === 503 ? "Provider registration is temporarily unavailable" : "Sign in before submitting a provider profile",
      }, status);
    }
    const input = await body(request);
    const providerName = clean(input.name, 160);
    const description = clean(input.whatTheyTeach || input.description, 800);
    const physicalAddress = clean(input.physicalAddress, 300);
    const contactEmail = clean(input.contactEmail, 160).toLowerCase();
    const contactPhone = clean(input.contactPhone, 80);
    if (isRegistration && (!providerName || !description || !physicalAddress || !contactPhone ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail))) {
      return json({ ok: false, error: "Enter the institution name, training focus, address, valid email, and phone number" }, 400);
    }
    if (isRegistration && authentication?.authenticated === true &&
      !await skillsProviderRegistrationRateLimit(env, authentication.user.uid)) {
      return json({ ok: false, error: "Provider registration is temporarily unavailable. Please try again later." }, 429);
    }
    const providerId = id("provider");
    const timestamp = now();
    const values = [
      providerId, providerName, description,
      clean(input.logoUrl, 500), clean(input.badgeUrl, 500), clean(input.physicalAddress, 300),
      contactEmail, contactPhone, `PROVIDER-${providerId.slice(-8).toUpperCase()}`,
      "pending", authentication?.authenticated === true ? authentication.user.uid : clean(input.ownerId, 160), timestamp, timestamp,
    ];
    await env.DB.prepare(
      `INSERT INTO skills_providers (id,name,description,logo_url,badge_url,physical_address,contact_email,contact_phone,referral_code,status,owner_id,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(...values).run();
    return json({ ok: true, provider: { id: providerId, referralCode: values[8], status: "pending" } }, 201);
  }

  if (request.method === "POST" && url.pathname === "/api/pay") {
    return json({
      ok: false,
      error: "The shared APSHULE payment-gateway.js must be configured on the live site before payments can be started",
      gateway: `${env.PUBLIC_SITE_URL}/js/payment-gateway.js`,
    }, 503);
  }

  if (request.method === "POST" && ["/api/skills/enroll", "/api/skills/admission", "/api/skills/admissions"].includes(url.pathname)) {
    const input = await body(request);
    if (clean(input.website, 200)) return json({ ok: true }, 202);
    const providerId = clean(input.providerId, 120);
    const referralCode = clean(input.referralCode, 120);
    const courseId = clean(input.courseId, 120);
    const fullName = clean(input.fullName, 160);
    const phone = clean(input.phone, 40);
    const email = clean(input.email, 254).toLowerCase();
    if (!providerId || !referralCode || !courseId || fullName.length < 2) {
      return json({ ok: false, error: "Choose a course and enter your full name" }, 400);
    }
    if (!phone && !email) return json({ ok: false, error: "Enter a phone number or email address" }, 400);
    if (phone && !/^[+\d().\-\s]{7,40}$/.test(phone)) return json({ ok: false, error: "Enter a valid phone number" }, 400);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ ok: false, error: "Enter a valid email address" }, 400);
    const provider = (await providerRows(env, providerId)).find((row) => row.status === "active" && row.referral_code === referralCode && row.course_id === courseId);
    if (!provider) return json({ ok: false, error: "That provider course link is no longer active" }, 400);
    const limit = await skillsEnrollmentRateLimit(request, env);
    if (limit === "unavailable") return json({ ok: false, error: "Enrollment is temporarily unavailable" }, 503);
    if (limit === "limited") return json({ ok: false, error: "Please wait before submitting another enrollment" }, 429);
    const enrollmentId = id("enrollment");
    const timestamp = now();
    const enrollment = {
      id: enrollmentId,
      type: "vocational",
      providerId,
      courseId,
      referralCode,
      studentId: clean(input.studentId, 160),
      fullName,
      phone,
      email,
      educationLevel: clean(input.educationLevel, 120),
      previousExperience: clean(input.previousExperience, 800),
      submittedAt: timestamp,
    };
    await env.DB.prepare(
      `INSERT INTO vocational_enrollments
        (id,provider_id,course_id,referral_code,student_id,full_name,phone,email,education_level,previous_experience,amount_ugx,payment_reference,payment_status,status,record_json,is_deleted,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      enrollmentId, providerId, courseId, referralCode, enrollment.studentId,
      fullName, phone, email, enrollment.educationLevel, enrollment.previousExperience,
      20000, "", "pending", "pending", JSON.stringify(enrollment), 0, timestamp, timestamp,
    ).run();
    return json({ ok: true, enrollment: { id: enrollmentId, status: "pending" } }, 201);
  }

  if (request.method === "POST" && url.pathname === "/api/skills/marks") {
    if (!canWrite(request, env)) return json({ ok: false, error: "Cloudflare application write authorization is not configured" }, 503);
    const input = await body(request);
    const theory = Number(input.theory);
    const practical = Number(input.practical);
    if (!Number.isFinite(theory) || !Number.isFinite(practical) || theory < 0 || theory > 100 || practical < 0 || practical > 100) {
      return json({ ok: false, error: "Theory and practical marks must each be between 0 and 100" }, 400);
    }
    const total = Math.round((theory + practical) * 100) / 100;
    const grade = total >= 140 ? "Distinction" : total >= 120 ? "Credit" : total >= 100 ? "Pass" : "Fail";
    const markId = id("mark");
    const timestamp = now();
    const mark = {
      id: markId, admissionId: clean(input.enrollmentId || input.admissionId, 160),
      providerId: clean(input.providerId, 120), studentId: clean(input.studentId, 160),
      courseId: clean(input.courseId, 120), courseTitle: clean(input.courseTitle, 160),
      theory, practical, total, grade, passed: grade !== "Fail", createdAt: timestamp, updatedAt: timestamp,
    };
    await env.DB.prepare(
      `INSERT INTO vocational_marks (id,admission_id,provider_id,student_id,course_id,course_title,theory,practical,total,grade,passed,entered_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(markId, mark.admissionId, mark.providerId, mark.studentId, mark.courseId, mark.courseTitle, theory, practical, total, grade, mark.passed ? 1 : 0, "cloudflare-authorized", timestamp, timestamp).run();
    return json({ ok: true, mark }, 201);
  }

  if (request.method === "POST" && url.pathname === "/api/skills/certificate") {
    if (!canWrite(request, env)) return json({ ok: false, error: "Cloudflare application write authorization is not configured" }, 503);
    const input = await body(request);
    const marksId = clean(input.marksId, 160);
    const result = await env.DB.prepare("SELECT * FROM vocational_marks WHERE id = ? LIMIT 1").bind(marksId).all<Record<string, unknown>>();
    const mark = result.results[0];
    if (!mark) return json({ ok: false, error: "Marks record not found" }, 404);
    if (Number(mark.passed) !== 1) return json({ ok: false, error: "A certificate can only be issued for a passing result" }, 409);
    const certificateId = id("certificate");
    const certificateNumber = `APSHULE-VOC-${new Date().getUTCFullYear()}-${certificateId.slice(-10).toUpperCase()}`;
    const issuedAt = now();
    await env.DB.prepare(
      `INSERT INTO certificates (id,certificate_number,marks_id,provider_id,student_id,student_name,course_id,course_title,theory,practical,total,grade,border_style,border_color,issued_by,issued_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      certificateId, certificateNumber, marksId, clean(mark.provider_id, 120), clean(mark.student_id, 160),
      clean(input.studentName, 160), clean(mark.course_id, 120), clean(mark.course_title, 160),
      Number(mark.theory), Number(mark.practical), Number(mark.total), clean(mark.grade, 30),
      "double", "#FF7A1A", "cloudflare-authorized", issuedAt,
    ).run();
    return json({ ok: true, certificate: { id: certificateId, certificateNumber, borderStyle: "double", borderColor: "#FF7A1A", issuedAt } }, 201);
  }

  return json({ ok: false, error: "not found" }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/") || url.pathname === "/health") {
        return withCors(request, await api(request, env));
      }
      const directoryRedirect = redirectDirectoryRoot(url.pathname, url.search);
      if (directoryRedirect) return directoryRedirect;
      if (env.STATIC && isExplicitStaticRoute(url.pathname)) {
        const fallbackPath = workspacePageFallback(url.pathname);
        if (fallbackPath && (request.method === "GET" || request.method === "HEAD")) {
          const assetUrl = new URL(request.url);
          assetUrl.pathname = fallbackPath;
          return env.STATIC.fetch(new Request(assetUrl, request));
        }
        return env.STATIC.fetch(request);
      }
      return json({ ok: false, error: "not found" }, 404);
    } catch (error) {
      return withCors(request, json({ ok: false, error: error instanceof Error ? error.message : "Worker request failed" }, 500));
    }
  },
};