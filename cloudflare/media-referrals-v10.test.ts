import { describe, expect, it, vi } from "vitest";
import { handleMediaReferralV10Route, type MediaReferralV10Env } from "./media-referrals-v10";
import type { AuthUser } from "./backend-types";

const user = (role = "teacher"): AuthUser => ({
  uid: `${role}-1`,
  email: `${role}@example.test`,
  displayName: role,
  role,
  schoolId: "school-1",
  institutionId: "tenant-1",
  sessionVersion: 1,
});

function fixture(queryImpl?: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number }>) {
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (queryImpl) return queryImpl(sql, values);
    if (sql.includes("role_capabilities")) return { rows: [{ capability: "video_studio.manage" }] };
    if (sql.includes("SELECT id,status FROM public.sample_videos")) return { rows: [{ id: values?.[0], status: "draft" }] };
    return { rows: [] };
  });
  const env = { PG: { query } } as unknown as MediaReferralV10Env;
  return { env, query };
}

const request = (path: string, method = "GET", body?: unknown) => new Request(`https://example.test${path}`, {
  method,
  headers: body === undefined ? undefined : { "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describe("media and education referrals V10 routes", () => {
  it("leaves unrelated URLs to the caller and requires an authenticated user", async () => {
    const { env } = fixture();
    expect(await handleMediaReferralV10Route(request("/api/not-media"), env, user())).toBeNull();
    const response = await handleMediaReferralV10Route(request("/api/sample_videos"), env, null);
    expect(response?.status).toBe(401);
  });

  it("accepts the exact legacy seven language values and rejects other spellings", async () => {
    const { env, query } = fixture();
    const languages = ["english", "luganda", "lusoga", "runyankore", "runyoro", "acholi", "swahili"];
    for (const language of languages) {
      const response = await handleMediaReferralV10Route(
        request("/api/sample_videos", "POST", { title: "Fractions", topic: "Fractions", language }),
        env, user(),
      );
      expect(response?.status).toBe(201);
    }
    const rejected = await handleMediaReferralV10Route(
      request("/api/sample_videos", "POST", { title: "Fractions", topic: "Fractions", language: "English" }),
      env, user(),
    );
    expect(rejected?.status).toBe(400);
    expect(query.mock.calls.filter(([sql]) => sql.includes("INSERT INTO public.sample_videos"))).toHaveLength(7);
  });

  it("queues only metadata and a job without claiming to generate media", async () => {
    const { env, query } = fixture(async (sql) => {
      if (sql.includes("role_capabilities")) return { rows: [{ capability: "video_studio.manage" }] };
      if (sql.includes("SELECT id,mode FROM public.sample_videos")) return { rows: [{ id: "v1", mode: "cartoon" }] };
      if (sql.includes("SELECT id,video_id,status,current_step")) return { rows: [{ id: "job1", status: "pending" }] };
      return { rows: [] };
    });
    const response = await handleMediaReferralV10Route(
      request("/api/sample_videos/generate", "POST", { videoId: "v1" }), env, user(),
    );
    const result = await response!.json() as { mediaGenerated: boolean; message: string };
    expect(response?.status).toBe(202);
    expect(result.mediaGenerated).toBe(false);
    expect(result.message).toContain("not available");
    expect(query.mock.calls.some(([sql]) => sql.includes("INSERT INTO public.sample_video_jobs"))).toBe(true);
  });

  it("stores upload bytes only in mocked R2 and persists metadata in Neon", async () => {
    const { env, query } = fixture();
    const put = vi.fn(async () => undefined);
    env.FILES = { put, get: vi.fn(), delete: vi.fn() };
    const form = new FormData();
    form.set("purpose", "cartoon_asset");
    form.set("file", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: "image/png" }), "image.png");
    const response = await handleMediaReferralV10Route(
      new Request("https://example.test/api/upload/r2", {
        method: "POST", headers: { origin: "https://example.test" }, body: form,
      }), env, user(),
    );
    expect(response?.status).toBe(201);
    expect(put).toHaveBeenCalledOnce();
    expect(put.mock.calls[0][0]).toMatch(/^media\/tenant-1\/school-1\//);
    const metadata = query.mock.calls.find(([sql]) => sql.includes("INSERT INTO public.media_uploads"));
    expect(metadata).toBeDefined();
    expect(metadata?.[1]?.some((value) => value instanceof ArrayBuffer)).toBe(false);
  });

  it("requires a completed payment before a student-to-student reward can be claimed", async () => {
    const { env, query } = fixture(async (sql) => {
      if (sql.includes("role_capabilities")) return { rows: [{ capability: "referrals.redeem" }] };
      if (sql.includes("FROM public.media_referral_codes")) {
        return { rows: [{ code: "STUDENT-CODE", owner_id: "student-2", owner_type: "student" }] };
      }
      return { rows: [] };
    });
    const response = await handleMediaReferralV10Route(
      request("/api/referrals/redeem", "POST", { referralCode: "student-code" }),
      env, user("student"),
    );
    expect(response?.status).toBe(402);
    expect(query.mock.calls.some(([sql]) => sql.includes("INSERT INTO public.media_referral_rewards"))).toBe(false);
  });

  it("returns an existing idempotent reward without crediting its balance again", async () => {
    const { env, query } = fixture(async (sql) => {
      if (sql.includes("role_capabilities")) return { rows: [{ capability: "referrals.redeem" }] };
      if (sql.includes("FROM public.media_referral_codes")) {
        return { rows: [{ code: "TEACHER-CODE", owner_id: "teacher-2", owner_type: "teacher" }] };
      }
      if (sql.includes("INSERT INTO public.media_referral_rewards")) return { rows: [] };
      return { rows: [] };
    });
    const response = await handleMediaReferralV10Route(
      request("/api/referrals/redeem", "POST", { referralCode: "teacher-code" }),
      env, user("student"),
    );
    const result = await response!.json() as { duplicate: boolean };
    expect(response?.status).toBe(200);
    expect(result.duplicate).toBe(true);
    expect(query.mock.calls.some(([sql]) => sql.includes("INSERT INTO public.media_referral_balances"))).toBe(false);
  });
});