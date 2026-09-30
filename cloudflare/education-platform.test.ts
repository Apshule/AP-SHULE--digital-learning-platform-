import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { handleEducationPlatformRoute } from "./education-platform";
import { handleDomainRoute } from "./domain-routes";
import type { EducationPlatformEnv } from "./education-platform";
import type { AuthEnv } from "./backend-types";
import type { AuthUser } from "./backend-types";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE audit(id TEXT,institution_id TEXT,school_id TEXT,actor_id TEXT,action TEXT,resource_type TEXT,resource_id TEXT,metadata_json TEXT,created_at TEXT);
    CREATE TABLE users(uid TEXT PRIMARY KEY,email TEXT,role TEXT,active INTEGER DEFAULT 1,disabled INTEGER DEFAULT 0);
    CREATE TABLE sector_records(
      id TEXT PRIMARY KEY,sector TEXT,institution_id TEXT,school_id TEXT,owner_uid TEXT,
      record_type TEXT,record_json TEXT,is_deleted INTEGER DEFAULT 0
    );
    CREATE TABLE parent_links(
      id TEXT PRIMARY KEY,institution_id TEXT,school_id TEXT,parent_uid TEXT,learner_id TEXT,active INTEGER DEFAULT 1
    );
    CREATE TABLE education_lessons(
      id TEXT PRIMARY KEY,institution_id TEXT,school_id TEXT,owner_uid TEXT,title TEXT,description TEXT,
      class_name TEXT,subject TEXT,youtube_url TEXT,published INTEGER,created_at TEXT,updated_at TEXT
    );
    CREATE TABLE education_files(
      id TEXT PRIMARY KEY,lesson_id TEXT,institution_id TEXT,school_id TEXT,filename TEXT,created_at TEXT
    );
  `);
  db.exec(readFileSync(new URL("./migrations/0021_education_legacy_features.sql", import.meta.url), "utf8"));
  const DB = { prepare(sql: string) {
    return {
      bind(...args: unknown[]) {
        const s = db.prepare(sql);
        return { all: async <T>() => ({ results: s.all(...args) as T[] }), run: async () => s.run(...args) };
      },
      all: async <T>() => ({ results: db.prepare(sql).all() as T[] }),
    };
  }};
  return { db, env: { DB } as unknown as EducationPlatformEnv };
}
const user = (role = "student", schoolId: string | null = "s1", institutionId: string | null = "i1"): AuthUser =>
  ({ uid: `${role}-1`, email: `${role}@example.test`, displayName: role, role, schoolId, institutionId, sessionVersion: 1 });
const request = (url: string, method = "GET", value?: unknown) =>
  new Request(`https://example.test${url}`, { method, headers: value ? { "content-type": "application/json" } : undefined, body: value ? JSON.stringify(value) : undefined });

describe("education platform D1 routes", () => {
  it("returns the seeded display-only catalog", async () => {
    const { env } = fixture();
    const response = await handleEducationPlatformRoute(request("/api/school/platform-content"), env, user(), "/api/school/platform-content");
    const result = await response!.json() as { ok: boolean; plans: Array<{ name: string; amount_ugx: number; duration_days: number }> };
    expect(result.ok).toBe(true);
    expect(result.plans.map(({ name, amount_ugx, duration_days }) => [name, amount_ugx, duration_days])).toEqual([
      ["Daily", 500, 1], ["Weekly", 3000, 7], ["Monthly", 10000, 30],
      ["Term", 50000, 90], ["Half-year", 80000, 182], ["Full-year", 150000, 365],
    ]);
  });
  it("rejects non-superadmin mutations", async () => {
    const { env } = fixture();
    const response = await handleEducationPlatformRoute(request("/api/admin/platform/events", "POST", { title: "x", eventDate: "2025-01-01" }), env, user(), "/api/admin/platform/events");
    expect(response!.status).toBe(403);
  });
  it("does not expose live lessons across tenants", async () => {
    const { env, db } = fixture();
    db.prepare("INSERT INTO education_live_lessons VALUES(?,?,?,?,?,?,?,?,?,?)").run("l1","other-i","other-s","x","P1","Math","room","now",null,"admin");
    const response = await handleEducationPlatformRoute(request("/api/school/platform-content"), env, user(), "/api/school/platform-content");
    expect(((await response!.json()) as { liveLessons: unknown[] }).liveLessons).toHaveLength(0);
  });
  it("deduplicates lesson views", async () => {
    const { env, db } = fixture();
    db.prepare("INSERT INTO sector_records VALUES(?,?,?,?,?,?,?,0)")
      .run("student-profile","education","i1","s1","student-1","learner",JSON.stringify({ className: "P1", uid: "student-1" }));
    db.prepare("INSERT INTO education_video_mappings(id,class_name,subject,youtube_url,created_by,created_at) VALUES(?,?,?,?,?,?)")
      .run("v1","P1","Math","https://youtube.com/watch?v=abc123","admin","now");
    await handleEducationPlatformRoute(request("/api/school/platform-views/v1", "POST"), env, user(), "/api/school/platform-views/v1");
    await handleEducationPlatformRoute(request("/api/school/platform-views/v1", "POST"), env, user(), "/api/school/platform-views/v1");
    expect((db.prepare("SELECT COUNT(*) n FROM education_lesson_views").get() as { n: number }).n).toBe(1);
    const adminResponse = await handleDomainRoute(request("/api/admin/platform"), env as unknown as AuthEnv, user("superadmin"));
    const adminResult = await adminResponse!.json() as { analytics: { videoViews: number; mostWatchedVideos: unknown[] } };
    expect(adminResult.analytics.videoViews).toBe(1);
    expect(adminResult.analytics.mostWatchedVideos).toHaveLength(1);
  });
  it("validates YouTube mapping URLs", async () => {
    const { env } = fixture();
    const response = await handleEducationPlatformRoute(request("/api/admin/platform/video-mappings", "POST", { className: "P1", subject: "Math", youtubeUrl: "http://youtube.com/watch?v=x" }), env, user("superadmin"), "/api/admin/platform/video-mappings");
    expect(response!.status).toBe(400);
  });
  it("routes Super Admin platform requests before the generic admin router", async () => {
    const { env } = fixture();
    const response = await handleDomainRoute(request("/api/admin/platform"), env as unknown as AuthEnv, user("superadmin"));
    expect(response?.status).toBe(200);
    expect(((await response!.json()) as { analytics: { mostWatchedVideos: unknown[] } }).analytics.mostWatchedVideos).toEqual([]);
  });
  it("includes existing tenant lesson videos and PDFs only for the learner's class", async () => {
    const { env, db } = fixture();
    db.prepare("INSERT INTO sector_records VALUES(?,?,?,?,?,?,?,0)")
      .run("student-profile","education","i1","s1","student-1","learner",JSON.stringify({ className: "P3", uid: "student-1" }));
    db.prepare(`INSERT INTO education_lessons
      (id,institution_id,school_id,owner_uid,title,description,class_name,subject,youtube_url,published,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,1,?,?)`)
      .run("lesson-p3","i1","s1","teacher-1","Fractions","Practice","P3","Math","https://youtube.com/watch?v=abc123","now","now");
    db.prepare("INSERT INTO education_files(id,lesson_id,institution_id,school_id,filename,created_at) VALUES(?,?,?,?,?,?)")
      .run("file-p3","lesson-p3","i1","s1","fractions.pdf","now");
    db.prepare(`INSERT INTO education_lessons
      (id,institution_id,school_id,owner_uid,title,description,class_name,subject,youtube_url,published,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,1,?,?)`)
      .run("lesson-p4","i1","s1","teacher-1","Other class","Practice","P4","Math","https://youtube.com/watch?v=def456","now","now");
    const response = await handleEducationPlatformRoute(
      request("/api/school/platform-content"), env, user(), "/api/school/platform-content",
    );
    const result = await response!.json() as { videoMappings: Array<{ id: string }>; resources: Array<{ id: string; url: string }> };
    expect(result.videoMappings.map((item) => item.id)).toEqual(["lesson-p3"]);
    expect(result.resources).toContainEqual(expect.objectContaining({
      id: "file-p3", url: "/api/school/lessons/lesson-p3/files/file-p3",
    }));
    const otherClassView = await handleEducationPlatformRoute(
      request("/api/school/platform-views/lesson-p4", "POST"), env, user(), "/api/school/platform-views/lesson-p4",
    );
    expect(otherClassView!.status).toBe(403);
  });
});