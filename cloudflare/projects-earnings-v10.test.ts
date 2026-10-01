import { describe, expect, it } from "vitest";
import type { AuthUser } from "./backend-types";
import { handleProjectsEarningsV10Route } from "./projects-earnings-v10";

type DbRow = Record<string, unknown>;

class MockNeon {
  calls: Array<{ sql: string; values: unknown[] }> = [];
  projects: DbRow[] = [];
  offlineViews: DbRow[] = [];
  earnings: DbRow[] = [];
  caRecords: DbRow[] = [];
  transactions: string[] = [];
  query<T = DbRow>(sql: string, values: unknown[] = []): Promise<{ rows: T[] }> {
    this.calls.push({ sql, values });
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (["begin", "commit", "rollback"].includes(normalized)) {
      this.transactions.push(normalized);
      return Promise.resolve({ rows: [] });
    }
    if (normalized.startsWith("select uid from public.users")) {
      const [id, school] = values.map(String);
      const valid = (id === "learner-1" || id === "student-1") && school === "school-1";
      return Promise.resolve({ rows: (valid ? [{ uid: id }] : []) as T[] });
    }
    if (normalized.startsWith("insert into public.offline_views")) {
      const [id, eventId, viewId, studentId, teacherId, videoId, schoolId, deviceType, connectionMode, watchedSeconds, completionPercent, watchedAt] = values;
      if (this.offlineViews.some((item) => item.event_id === eventId || item.view_id === viewId)) return Promise.resolve({ rows: [] });
      this.offlineViews.push({ id, event_id: eventId, view_id: viewId, student_id: studentId, teacher_id: teacherId, video_id: videoId, school_id: schoolId, device_type: deviceType, connection_mode: connectionMode, watched_seconds: watchedSeconds, completion_percent: completionPercent, completed: true, earnings_amount: 100, watched_at: watchedAt });
      return Promise.resolve({ rows: [{ id }] as T[] });
    }
    if (normalized.startsWith("insert into public.teacher_earnings")) {
      const [id, eventId, viewId, teacherId, studentId, videoId, schoolId, earnedAt] = values;
      if (!this.earnings.some((item) => item.view_id === viewId)) this.earnings.push({ id, event_id: eventId, view_id: viewId, teacher_id: teacherId, student_id: studentId, video_id: videoId, school_id: schoolId, amount_ugx: 100, paid: false, earned_at: earnedAt });
      return Promise.resolve({ rows: [] });
    }
    if (normalized.startsWith("select v.*")) {
      const teacher = String(values[0]);
      return Promise.resolve({ rows: this.offlineViews.filter((item) => item.teacher_id === teacher).map((item) => ({ ...item, amount_ugx: 100, paid: false })) as T[] });
    }
    if (normalized.startsWith("select * from public.projects where id=")) {
      return Promise.resolve({ rows: this.projects.filter((item) => item.id === values[0]) as T[] });
    }
    if (normalized.startsWith("select id,title,term from public.projects")) {
      return Promise.resolve({ rows: this.projects.filter((item) => item.learner_id === values[0] && item.title_normalized === values[1]).map(({ id, title, term }) => ({ id, title, term })) as T[] });
    }
    if (normalized.startsWith("select * from public.projects order by")) {
      return Promise.resolve({ rows: this.projects as T[] });
    }
    if (normalized.startsWith("select * from public.projects where learner_id=")) {
      return Promise.resolve({ rows: this.projects.filter((item) => item.learner_id === values[0]) as T[] });
    }
    if (normalized.startsWith("update public.projects set")) {
      const projectId = String(values.at(-1));
      const project = this.projects.find((item) => item.id === projectId);
      if (project && normalized.includes("viva_audio_path=$1")) {
        project.viva_audio_path = values[0];
        project.viva_audio_milestone = values[1];
      } else if (project && normalized.includes("teacher_observed_tick=")) {
        const statusColumn = normalized.match(/set ([a-z0-9_]+)=\$1/)?.[1];
        if (statusColumn) project[statusColumn] = values[0];
        project.teacher_observed_tick = Boolean(project.teacher_observed_tick || values[4]);
      } else if (project) {
        const photoCol = normalized.match(/,([a-z0-9_]+)=\$1,([a-z0-9_]+)='pending'/)?.[1];
        if (photoCol) project[photoCol] = values[0];
      }
      return Promise.resolve({ rows: [] });
    }
    if (normalized.startsWith("insert into public.ca_records")) {
      const [id, projectId, milestone] = values;
      if (!this.caRecords.some((item) => item.project_id === projectId && item.milestone === milestone)) {
        this.caRecords.push({ id, project_id: projectId, milestone });
      }
      return Promise.resolve({ rows: [] });
    }
    if (normalized.startsWith("select * from public.ca_records")) {
      if (normalized.includes("where learner_id=")) return Promise.resolve({ rows: this.caRecords.filter((item) => item.learner_id === values[0]) as T[] });
      if (normalized.includes("where school_id=")) return Promise.resolve({ rows: this.caRecords.filter((item) => item.school_id === values[0]) as T[] });
      return Promise.resolve({ rows: this.caRecords as T[] });
    }
    return Promise.resolve({ rows: [] });
  }
}

class MockR2 {
  objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  async put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }) {
    this.objects.set(key, { bytes: new Uint8Array(value.slice(0)), contentType: options?.httpMetadata?.contentType ?? "" });
  }
  async get(key: string) {
    const item = this.objects.get(key);
    if (!item) return null;
    return {
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(item.bytes); controller.close(); } }),
      httpMetadata: { contentType: item.contentType },
    };
  }
  async delete(key: string) { this.objects.delete(key); }
}

const teacher: AuthUser = {
  uid: "teacher-1", email: "teacher@example.test", displayName: "Teacher", role: "teacher",
  schoolId: "school-1", institutionId: null, sessionVersion: 1,
};
const request = (path: string, method = "GET", value?: unknown) => new Request(`https://example.test${path}`, {
  method,
  headers: value === undefined ? undefined : { "content-type": "application/json" },
  body: value === undefined ? undefined : JSON.stringify(value),
});

describe("projects and earnings V10 routes", () => {
  it("deduplicates event IDs and view IDs while paying exactly 100 UGX only for offline_view events", async () => {
    const PG = new MockNeon();
    const env = { PG };
    const event = {
      eventId: "evt-1", viewId: "learner-1_video-1_2026-03-01", eventType: "offline_view",
      teacherId: teacher.uid, studentId: "learner-1", videoId: "video-1",
      completed: true, completionPercent: 100, earningsAmount: 9000, schoolId: "school-1",
    };
    const first = await handleProjectsEarningsV10Route(request("/api/earnings/sync", "POST", { events: [event, event] }), env, teacher);
    expect((await first!.json()).synced).toBe(1);
    expect(PG.earnings).toHaveLength(1);
    expect(PG.earnings[0].amount_ugx).toBe(100);
    const wrongEvent = await handleProjectsEarningsV10Route(request("/api/earnings/sync", "POST", {
      ...event, eventId: "evt-2", viewId: "another-view", eventType: "education_lesson_view",
    }), env, teacher);
    expect(wrongEvent!.status).toBe(200);
    expect(PG.offlineViews).toHaveLength(1);
    expect(PG.calls.some((call) => call.sql.includes("education_lesson_views"))).toBe(false);
    const report = await handleProjectsEarningsV10Route(request("/api/earnings/report"), env, teacher);
    expect(((await report!.json()) as { summary: { earningsUgx: number } }).summary.earningsUgx).toBe(100);
  });

  it("atomically reviews a project and creates no more than one CA record per project milestone", async () => {
    const PG = new MockNeon();
    PG.projects.push({
      id: "project-1", learner_id: "learner-1", school_id: "school-1", subject: "Science", term: "2026-T1",
      milestone_1_status: "pending", teacher_observed_tick: false,
    });
    const env = { PG };
    const review = () => request("/api/projects/project-1/verify", "PUT", {
      status: "approved", milestone: "1", observed: true,
    });
    const first = await handleProjectsEarningsV10Route(review(), env, teacher);
    const second = await handleProjectsEarningsV10Route(review(), env, teacher);
    expect(first!.status).toBe(200);
    expect(second!.status).toBe(200);
    expect(PG.caRecords).toHaveLength(1);
    expect(PG.transactions).toEqual(["begin", "commit", "begin", "commit"]);
  });

  it("stores and reads viva audio only with an allowed MIME, valid signature, and server-owned R2 key", async () => {
    const PG = new MockNeon();
    const FILES = new MockR2();
    PG.projects.push({
      id: "project-1", learner_id: "learner-1", school_id: "school-1", subject: "Science",
      milestone_1_status: "pending", teacher_observed_tick: false,
    });
    const env = { PG, FILES };
    const valid = new File([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1])], "viva.webm", { type: "audio/webm" });
    const form = new FormData();
    form.set("file", valid);
    form.set("milestone", "1");
    const upload = await handleProjectsEarningsV10Route(new Request("https://example.test/api/projects/project-1/viva-audio", { method: "POST", headers: { origin: "https://example.test" }, body: form }), env, teacher);
    expect(upload!.status).toBe(201);
    const result = await upload!.json() as { key: string };
    expect(result.key).toMatch(/^projects\/school-1\/project-1\/viva\/1-/);
    expect(FILES.objects.has(result.key)).toBe(true);
    const read = await handleProjectsEarningsV10Route(request("/api/projects/project-1/viva-audio"), env, teacher);
    expect(read!.status).toBe(200);
    expect(new Uint8Array(await read!.arrayBuffer())).toEqual(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1]));

    const invalidForm = new FormData();
    invalidForm.set("file", new File(["not audio"], "viva.webm", { type: "audio/webm" }));
    const invalid = await handleProjectsEarningsV10Route(new Request("https://example.test/api/projects/project-1/viva-audio", { method: "POST", headers: { origin: "https://example.test" }, body: invalidForm }), env, teacher);
    expect(invalid!.status).toBe(415);
    expect(FILES.objects.size).toBe(1);
  });

  it("enforces learner ownership and teacher school scoping", async () => {
    const PG = new MockNeon();
    PG.projects.push({ id: "project-1", learner_id: "learner-1", school_id: "other-school", subject: "Science" });
    const denied = await handleProjectsEarningsV10Route(request("/api/projects/project-1"), { PG }, teacher);
    expect(denied!.status).toBe(404);
    const anonymous = await handleProjectsEarningsV10Route(request("/api/projects"), { PG }, null);
    expect(anonymous!.status).toBe(401);
  });
});