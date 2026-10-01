import { describe, expect, it } from "vitest";
import type { AuthUser } from "./backend-types";
import type { PlatformV10Env } from "./platform-v10-common";
import { handleOfflineSettingsV10Route } from "./offline-settings-v10";
import { handleTimetableV10Route } from "./timetable-v10";
import { handleInstitutionsV10Route } from "./institutions-v10";
import { handleAnalyticsV10Route } from "./analytics-v10";

type Row = Record<string, unknown>;

class MockNeon {
  calls: Array<{ sql: string; values: unknown[] }> = [];
  generated: Row[] = [];
  handler: (sql: string, values: unknown[]) => Row[] = () => [];

  async query<T = Row>(sql: string, values: unknown[] = []): Promise<{ rows: T[] }> {
    this.calls.push({ sql, values });
    const rows = this.handler(sql.replace(/\s+/g, " ").trim().toLowerCase(), values);
    return { rows: rows as T[] };
  }
}

class MockR2 {
  lists: Array<{ prefix?: string; limit?: number; cursor?: string }> = [];
  puts: Array<{ key: string; value: Uint8Array; contentType: string }> = [];
  objects = new Map<string, { bytes: Uint8Array; contentType: string }>();

  async list(options: { prefix?: string; limit?: number; cursor?: string } = {}) {
    this.lists.push(options);
    const objects = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(options.prefix ?? ""))
      .map(([key, value]) => ({ key, size: value.bytes.byteLength }));
    return { objects, truncated: false };
  }
  async put(key: string, value: ArrayBuffer | string, options?: { httpMetadata?: { contentType?: string } }) {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
    const contentType = options?.httpMetadata?.contentType ?? "";
    this.puts.push({ key, value: bytes, contentType });
    this.objects.set(key, { bytes, contentType });
  }
  async get(key: string) {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(object.bytes);
          controller.close();
        },
      }),
      httpMetadata: { contentType: object.contentType },
    };
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

const schoolAdmin: AuthUser = {
  uid: "admin-1",
  email: "admin@example.test",
  displayName: "School Admin",
  role: "school_admin",
  schoolId: "school-1",
  institutionId: "inst-1",
  sessionVersion: 1,
};

const superadmin: AuthUser = {
  ...schoolAdmin,
  uid: "super-1",
  role: "superadmin",
  schoolId: null,
  institutionId: null,
};

function request(path: string, method = "GET", body?: unknown) {
  return new Request(`https://example.test${path}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { "content-type": "application/json", origin: "https://example.test" },
      body: JSON.stringify(body),
    }),
  });
}

function setup(handler?: (sql: string, values: unknown[]) => Row[]) {
  const pg = new MockNeon();
  if (handler) pg.handler = handler;
  const files = new MockR2();
  const env = { PG: pg, FILES: files } as unknown as PlatformV10Env;
  return { pg, files, env };
}

describe("V10 settings and R2 storage routes", () => {
  it("returns safe settings defaults and rejects another user's settings", async () => {
    const { env, pg } = setup();
    const response = await handleOfflineSettingsV10Route(request("/api/settings"), env, schoolAdmin);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      user_id: "admin-1",
      hd_only_wifi: true,
      auto_sync_wifi: true,
      auto_sync_mobile: false,
      language: "english",
      total_mb: 45,
    });
    expect(pg.calls[0].values).toEqual(["admin-1"]);

    const denied = await handleOfflineSettingsV10Route(request("/api/settings?user_id=other"), env, schoolAdmin);
    expect(denied?.status).toBe(403);
  });

  it("saves only supported preferences and estimates storage from scoped R2 prefixes", async () => {
    const { env, pg, files } = setup();
    const saved = await handleOfflineSettingsV10Route(request("/api/settings", "POST", {
      hd_only_wifi: false,
      auto_sync_wifi: true,
      auto_sync_mobile: false,
      language: "luganda",
    }), env, schoolAdmin);
    expect(saved?.status).toBe(200);
    expect(pg.calls[0].sql).toContain("INSERT INTO public.offline_settings");
    expect(pg.calls[0].values).toEqual(["admin-1", false, true, false, "luganda", expect.any(String)]);

    files.objects.set("media/inst-1/school-1/high.mp4", { bytes: new Uint8Array(2 * 1024 * 1024), contentType: "video/mp4" });
    files.objects.set("media/inst-1/school-1/clip_light.mp4", { bytes: new Uint8Array(1024 * 1024), contentType: "video/mp4" });
    files.objects.set("projects/school-1/p1/viva/voice.mp3", { bytes: new Uint8Array(500), contentType: "audio/mpeg" });
    files.objects.set("education/inst-1/lesson-1/handout.pdf", { bytes: new Uint8Array(2048), contentType: "application/pdf" });
    const storage = await handleOfflineSettingsV10Route(
      request("/api/settings/storage?indexeddb_usage_mb=1.5"), env, schoolAdmin,
    );
    expect(storage?.status).toBe(200);
    const report = await storage?.json() as Row;
    expect(report).toMatchObject({
      estimate: { quota: "500MB", quota_mb: 500, usage_mb: 4.5 },
      breakdown: { hd_videos: 2, light_videos: 1, pdfs: 0 },
      indexeddb_usage_mb: 1.5,
    });
    expect(files.lists.map((item) => item.prefix)).toEqual([
      "media/inst-1/school-1/",
      "projects/school-1/",
      "education/inst-1/",
    ]);
    expect(JSON.stringify(report)).not.toContain("handout.pdf");
  });
});

describe("V10 timetable routes", () => {
  it("returns class templates without writing and rejects malformed configuration", async () => {
    const { env, pg } = setup();
    const classes = await handleTimetableV10Route(request("/api/timetable/classes"), env, schoolAdmin);
    expect(classes?.status).toBe(200);
    const body = await classes?.json() as { classes: Row[] };
    expect(body.classes.some((row) => row.class_name === "P.5 A")).toBe(true);
    expect(pg.calls).toHaveLength(1);

    const invalid = await handleTimetableV10Route(request("/api/timetable/config", "POST", {
      periods_per_day: 30,
      days_per_week: 5,
      period_minutes: 40,
    }), env, schoolAdmin);
    expect(invalid?.status).toBe(400);
    expect(pg.calls).toHaveLength(1);
  });

  it("generates a conflict-free timetable using tenant-scoped teacher duties", async () => {
    const { env, pg } = setup();
    pg.handler = (sql, values) => {
      if (sql.startsWith("select school_id,periods_per_day")) {
        return [{
          school_id: "school-1", periods_per_day: 4, days_per_week: 5,
          start_time: "08:00:00", period_minutes: 40, break_after_period: null,
        }];
      }
      if (sql.startsWith("select id,school_id,class_name,class_level,stream,room,active")) {
        return [{
          id: "class-p1", school_id: "school-1", class_name: "P1", class_level: "P1",
          stream: "", room: "", active: true,
        }];
      }
      if (sql.includes("from public.school_subjects")) {
        return [{
          id: "subject-math", subject_code: "MATH", subject_name: "Mathematics",
          class_level: "P1", periods_per_week: 2,
        }];
      }
      if (sql.includes("from public.timetable_teacher_duty")) {
        return [{
          teacher_id: "teacher-1", teacher_name: "Teacher One", subject_id: "subject-math",
          class_id: null, class_level: "P1", periods_per_week: 2, room: "R1",
        }];
      }
      if (sql.startsWith("insert into public.school_timetables")) {
        pg.generated = JSON.parse(String(values[0])) as Row[];
      }
      return [];
    };
    const response = await handleTimetableV10Route(
      request("/api/timetable/generate", "POST", { school_id: "school-1", term: "Term 1" }),
      env,
      schoolAdmin,
    );
    expect(response?.status).toBe(200);
    const result = await response?.json() as { generated: number };
    expect(result.generated).toBe(2);
    expect(pg.generated).toHaveLength(2);
    expect(new Set(pg.generated.map((row) => `${row.day}:${row.period}`)).size).toBe(2);
    expect(pg.calls.some(({ sql }) => sql.includes("school_id IS NULL") && !sql.includes("school_id=''"))).toBe(true);
    expect(pg.calls.some(({ sql }) => sql === "BEGIN")).toBe(true);
    expect(pg.calls.some(({ sql }) => sql === "COMMIT")).toBe(true);
    expect(pg.calls.every(({ values }) => !values.includes("other-school"))).toBe(true);
  });
});

describe("V10 institution routes", () => {
  it("returns public dual-header branding and only lets a Super Admin create an institution", async () => {
    const { env, pg } = setup((sql) => {
      if (sql.startsWith("select id,name,type,logo_url,subdomain,contact_phone,email,branding_config")) {
        return [{
          id: "inst-1", name: "Example School", type: "school", logo_url: "/api/institutions/inst-1/logo",
          subdomain: "school", contact_phone: "256700000000", email: "school@example.test",
          branding_config: { header: "dual", footer: { col1: "School footer" } },
        }];
      }
      return [];
    });
    const branding = await handleInstitutionsV10Route(request("/api/institutions/inst-1/branding"), env, null);
    expect(branding?.status).toBe(200);
    expect(await branding?.json()).toMatchObject({
      name: "Example School",
      header: "dual",
      header_mode: "APSHULE +256731038702",
      footer: { col1: "School footer" },
      whatsapp: "https://wa.me/256700000000",
    });

    const forbidden = await handleInstitutionsV10Route(
      request("/api/institutions", "POST", { name: "Other", type: "school" }), env, schoolAdmin,
    );
    expect(forbidden?.status).toBe(403);
    expect(pg.calls).toHaveLength(1);
  });

  it("creates a tenant record in Neon for a Super Admin", async () => {
    const { env, pg } = setup();
    const response = await handleInstitutionsV10Route(
      request("/api/institutions", "POST", {
        id: "new-school", name: "New School", type: "school", contact: "+256 700 000 000",
      }),
      env,
      superadmin,
    );
    expect(response?.status).toBe(201);
    expect(pg.calls[0].sql).toContain("INSERT INTO public.institutions");
    expect(pg.calls[0].values).toContain("New School");
  });

  it("keeps institution logo references inside the tenant's R2 scope on PUT", async () => {
    const { env, pg, files } = setup((sql) => {
      if (sql.startsWith("update public.institutions set")) {
        return [{
          id: "inst-1", name: "Example School", type: "school",
          logo_url: "/api/institutions/inst-1/logo", updated_at: "2026-10-01T00:00:00Z",
        }];
      }
      if (sql.startsWith("select logo_object_key")) return [{ logo_object_key: "institutions/another-school/logo.png" }];
      return [];
    });
    const updated = await handleInstitutionsV10Route(
      request("/api/institutions/inst-1", "PUT", {
        branding_config: { header: "single" },
        logo_object_key: "institutions/another-school/logo.png",
      }),
      env,
      schoolAdmin,
    );
    expect(updated?.status).toBe(200);
    expect(pg.calls[0].values[9]).toBeNull();

    const invalidReference = await handleInstitutionsV10Route(
      request("/api/institutions/inst-1", "PUT", {
        logo_url: "/api/institutions/another-school/logo?v=0123456789ab",
      }),
      env,
      schoolAdmin,
    );
    expect(invalidReference?.status).toBe(400);

    files.objects.set("institutions/another-school/logo.png", {
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      contentType: "image/png",
    });
    const leakedLogo = await handleInstitutionsV10Route(
      request("/api/institutions/inst-1/logo"),
      env,
      null,
    );
    expect(leakedLogo?.status).toBe(409);
  });
});

describe("V10 analytics routes", () => {
  it("returns tenant overview counts and denies cross-tenant analytics", async () => {
    const { env, pg } = setup((sql) => {
      if (sql.startsWith("select count(*)::integer as total_users")) return [{ total_users: 8 }];
      if (sql.startsWith("select count(distinct student_id)")) return [{ count: 3 }];
      if (sql.startsWith("select coalesce(sum(amount)")) return [{ amount: "15000" }];
      if (sql.startsWith("select count(*)::integer as count")) return [{ count: 12 }];
      if (sql.startsWith("select sector,record_type,count(*)")) return [{ sector: "education", record_type: "assessment", count: 5 }];
      return [];
    });
    const response = await handleAnalyticsV10Route(
      request("/api/analytics/overview?institution_id=school-1&type=education&range=week"),
      env,
      schoolAdmin,
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      ok: true,
      institution_id: "school-1",
      total_users: 8,
      active_users: 3,
      revenue: 15000,
      views: 12,
      range_days: 7,
    });

    const denied = await handleAnalyticsV10Route(
      request("/api/analytics/overview?institution_id=another-school&type=education"),
      env,
      schoolAdmin,
    );
    expect(denied?.status).toBe(403);
    expect(pg.calls).toHaveLength(5);
  });

  it("computes education and MFI metrics from tenant-scoped Neon records", async () => {
    const { env, pg } = setup((sql) => {
      if (sql.includes("record_type in ('ca_record','ca_records','assessment')")) return [{ level: "P1", count: 3 }];
      if (sql.startsWith("select count(*)::integer as count from public.projects")) return [{ count: 2 }];
      if (sql.includes("from public.teacher_retooling_progress")) return [{ percent: "64.5" }];
      if (sql.includes("from records")) {
        return [{
          loans_active: 6, overdue: 1, collateral_scoring_avg: "72.5", disbursed_total: "850000",
        }];
      }
      return [];
    });
    const education = await handleAnalyticsV10Route(
      request("/api/analytics/education?school_id=school-1"),
      env,
      schoolAdmin,
    );
    expect(education?.status).toBe(200);
    expect(await education?.json()).toMatchObject({
      ok: true,
      school_id: "school-1",
      ca_records_by_level: { P1: 3 },
      projects_pending: 2,
      retooling_progress: 64.5,
    });
    expect(pg.calls.slice(0, 3).every(({ values }) => values[0] === "school-1")).toBe(true);

    const mfi = await handleAnalyticsV10Route(
      request("/api/analytics/mfi?mfi_id=inst-1"),
      env,
      schoolAdmin,
    );
    expect(mfi?.status).toBe(200);
    expect(await mfi?.json()).toMatchObject({
      ok: true,
      mfi_id: "inst-1",
      loans_active: 6,
      overdue: 1,
      collateral_scoring_avg: 72.5,
      disbursed_total: 850000,
    });
    const mfiQuery = pg.calls.at(-1);
    expect(mfiQuery?.values).toEqual(["inst-1"]);
    expect(mfiQuery?.sql).toContain("(institution_id=$1 OR school_id=$1)");
  });

  it("stores a PDF export in R2 without exposing its storage key", async () => {
    const { env, files } = setup((sql) => {
      if (sql.includes("record_type in ('ca_record','ca_records','assessment')")) return [{ level: "P2", count: 1 }];
      if (sql.startsWith("select count(*) from public.projects")) return [{ count: 0 }];
      if (sql.includes("from public.teacher_retooling_progress")) return [{ percent: 0 }];
      return [];
    });
    const response = await handleAnalyticsV10Route(
      request("/api/analytics/export/pdf?type=education&institution_id=school-1"),
      env,
      schoolAdmin,
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toContain("application/pdf");
    expect(response?.headers.get("x-r2-object-key")).toBeNull();
    expect(files.puts).toHaveLength(1);
    expect(files.puts[0].key).toMatch(/^exports\/analytics\/school-1\/education\//);
    expect(new TextDecoder().decode(files.puts[0].value.slice(0, 8))).toContain("%PDF-1.");
  });
});