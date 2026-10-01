import { afterEach, describe, expect, it, vi } from "vitest";
import { handleEducationExtendedV10Route } from "./education-extended-v10";
import type { AuthEnv, AuthUser } from "./backend-types";

const teacher: AuthUser = {
  uid: "teacher-17",
  email: "teacher@example.test",
  displayName: "Test Teacher",
  role: "teacher",
  schoolId: "school-1",
  institutionId: "institution-1",
  sessionVersion: 1,
};
const testCertificateId = `NCDC-${"A".repeat(32)}`;

function setup(responder: (sql: string, values: unknown[]) => { rows?: unknown[]; rowCount?: number } = () => ({ rows: [] })) {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const env = {
    GEMINI_API_KEY: "test-gemini-secret",
    PG: {
      query: vi.fn(async <T,>(sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        const result = responder(sql, values);
        return { rows: (result.rows ?? []) as T[], rowCount: result.rowCount ?? result.rows?.length ?? 0 };
      }),
    },
  } as unknown as AuthEnv & { GEMINI_API_KEY?: string };
  return { env, queries };
}

const request = (path: string, method = "GET", body?: unknown) => new Request(`https://example.test${path}`, {
  method,
  headers: body === undefined ? undefined : { "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

afterEach(() => vi.unstubAllGlobals());

describe("education extended V10 routes", () => {
  it("uses bounded, parameterized Neon curriculum search and validates returned rows", async () => {
    const { env, queries } = setup(() => ({
      rows: [{
        id: "link-1",
        subject: "Biology",
        class_level: "S2",
        topic: "Photosynthesis",
        syllabus_ref: "S2.3",
        learner_book_page: "45",
        teacher_guide_page: "21",
        summary_text: "Plant nutrition",
        activity_suggestion: "Observe leaves",
      }],
    }));
    const response = await handleEducationExtendedV10Route(
      request("/api/curriculum/search?q=photosynthesis&subject=Biology"),
      env,
      teacher,
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ ok: true, links: [{ topic: "Photosynthesis" }] });
    expect(queries[0].sql).toContain("topic ILIKE");
    expect(queries[0].values).toEqual(["%photosynthesis%", "Biology", 50]);
  });

  it("returns one validated random UNEB item using Neon ORDER BY RANDOM", async () => {
    const item = {
      id: "uneb-1",
      subject: "Biology",
      class_level: "S2",
      topic: "Ecology",
      scenario_text: "A wetland is being restored.",
      competency: "Evaluate conservation actions",
      marking_grid: "Award marks for evidence",
    };
    const { env, queries } = setup(() => ({ rows: [item] }));
    const response = await handleEducationExtendedV10Route(
      request("/api/uneb/random?subject=Biology"),
      env,
      teacher,
    );
    expect(response?.status, JSON.stringify(await response?.clone().json())).toBe(200);
    expect(await response?.json()).toMatchObject({ ok: true, ...item });
    expect(queries[0].sql).toContain("ORDER BY RANDOM() LIMIT 1");
    expect(queries[0].values).toEqual(["Biology"]);
  });

  it("calls Gemini directly with bounded input, sector context, timeout signal, and validated output", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "Activity plan" }] } }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { env } = setup();
    const response = await handleEducationExtendedV10Route(
      request("/api/gemini/activity", "POST", {
        topic: "Water conservation",
        subject: "Science",
        classLevel: "S2",
        sector: "education",
      }),
      env,
      teacher,
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ ok: true, content: "Activity plan" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("generativelanguage.googleapis.com");
    expect(String(url)).toContain("test-gemini-secret");
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
    const prompt = JSON.parse(String((init as RequestInit).body)).contents[0].parts[0].text;
    expect(prompt).toContain("expert in the education sector");
    expect(prompt).toContain("Water conservation");
  });

  it("rejects forged completion and issues a certificate only after verified Neon progress", async () => {
    const { env, queries } = setup((sql, values) => {
      if (sql.includes("WITH eligible AS")) return { rows: [{ certificate_id: values[0], certificate_issued_at: values[1] }] };
      return { rows: [] };
    });
    const forged = await handleEducationExtendedV10Route(
      request("/api/retooling/progress", "POST", { moduleId: 2, completed: true, quizScore: 2 }),
      env,
      teacher,
    );
    expect(forged?.status).toBe(400);
    expect(queries).toHaveLength(0);

    const response = await handleEducationExtendedV10Route(
      request("/api/retooling/certificate", "POST", {}),
      env,
      teacher,
    );
    expect(response?.status, JSON.stringify({
      body: await response?.clone().json(),
      queries,
    })).toBe(201);
    const result = await response?.json() as { ok: boolean; certificate: { certificateId: string } };
    expect(result.ok).toBe(true);
    expect(result.certificate.certificateId).toMatch(/^NCDC-[A-F0-9]{32}$/);
    expect(queries.some(({ sql }) => sql.includes("COUNT(DISTINCT module_id) FILTER"))).toBe(true);
  });

  it("requires login and allows public verification without returning teacher identifiers", async () => {
    const { env } = setup((sql) => {
      if (sql.includes("SELECT teacher_id FROM public.teacher_retooling_progress")) {
        return { rows: [{ teacher_id: teacher.uid }] };
      }
      if (sql.includes("SELECT p.certificate_id")) {
        return { rows: [{ certificate_id: testCertificateId, certificate_issued_at: "2026-01-02T00:00:00.000Z" }] };
      }
      return { rows: [] };
    });
    const unauthenticated = await handleEducationExtendedV10Route(request("/api/uneb"), env, null);
    expect(unauthenticated?.status).toBe(401);

    const verified = await handleEducationExtendedV10Route(
      request(`/api/retooling/certificate/verify?certificateId=${testCertificateId}`),
      env,
      null,
    );
    expect(verified?.status, JSON.stringify(await verified?.clone().json())).toBe(200);
    expect(await verified?.json()).toEqual({
      ok: true,
      verified: true,
      certificate: {
        certificateId: testCertificateId,
        courseTitle: "NCDC Teacher Retooling Course",
        modulesCompleted: 10,
        cpdPoints: 20,
        status: "active",
        issuedAt: "2026-01-02T00:00:00.000Z",
      },
    });
  });
});