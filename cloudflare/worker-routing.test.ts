import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readNeonHealth } from "./neon-db";
import worker from "./worker";

vi.mock("./neon-db", () => ({
  readNeonHealth: vi.fn(),
}));

type WorkerEnv = Parameters<typeof worker.fetch>[1];

function previewEnv() {
  const staticFetch = vi.fn(async (request: Request) => {
    return new Response(`asset:${new URL(request.url).pathname}`);
  });
  const env = {
    ENVIRONMENT: "development",
    STATIC: { fetch: staticFetch },
    CACHE: { get: vi.fn(async () => null), put: vi.fn(async () => {}), delete: vi.fn(async () => {}) },
    SESSIONS: { get: vi.fn(async () => null), put: vi.fn(async () => {}), delete: vi.fn(async () => {}) },
  } as unknown as WorkerEnv;

  return { env, staticFetch };
}

describe("APSHULE Worker routing", () => {
  it("serves the core static pages from the frontend bundle", async () => {
    const { env, staticFetch } = previewEnv();
    const paths = [
      "/",
      "/education/",
      "/clinic/",
      "/farm/",
      "/mfi/",
      "/admin/",
      "/platform/",
      "/student/",
      "/teacher/",
      "/secretary/",
      "/bursar/",
      "/parent/",
      "/skills/",
      "/tech/",
      "/learn/",
      "/my-account/",
      "/profile.html",
      "/reset-password.html",
      "/manifest.json",
      "/.well-known/assetlinks.json",
    ];

    for (const path of paths) {
      const response = await worker.fetch(new Request(`https://appshule.com${path}`), env);
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toBe(`asset:${path}`);
    }
    expect(staticFetch).toHaveBeenCalledTimes(paths.length);
  });

  it("maps legacy login and workspace aliases to the correct frontend page", async () => {
    const { env, staticFetch } = previewEnv();
    const aliases = new Map([
      ["/login", "/"],
      ["/login/", "/"],
      ["/workspace", "/"],
      ["/workspace/", "/"],
      ["/workspace/student", "/student/"],
      ["/workspace/student/", "/student/"],
      ["/workspace/teacher", "/teacher/"],
      ["/workspace/teacher/", "/teacher/"],
      ["/workspace/secretary", "/secretary/"],
      ["/workspace/secretary/", "/secretary/"],
      ["/workspace/bursar", "/bursar/"],
      ["/workspace/bursar/", "/bursar/"],
      ["/workspace/parent", "/parent/"],
      ["/workspace/parent/", "/parent/"],
      ["/workspace/admin", "/admin/"],
      ["/workspace/admin/", "/admin/"],
      ["/workspace/clinic", "/clinic/"],
      ["/workspace/clinic/", "/clinic/"],
      ["/workspace/farm", "/farm/"],
      ["/workspace/farm/", "/farm/"],
      ["/workspace/mfi", "/mfi/"],
      ["/workspace/mfi/", "/mfi/"],
    ]);

    for (const [path, expectedAsset] of aliases) {
      const response = await worker.fetch(new Request(`https://appshule.com${path}`), env);
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toBe(`asset:${expectedAsset}`);
    }
    expect(staticFetch).toHaveBeenCalledTimes(aliases.size);
  });

  it("redirects directory roots before requesting an asset", async () => {
    const { env, staticFetch } = previewEnv();
    const response = await worker.fetch(new Request("https://appshule.com/education?from=workspace"), env);

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/education/?from=workspace");
    expect(staticFetch).not.toHaveBeenCalled();
  });

  it("normalizes the learning and account alias roots", async () => {
    const { env, staticFetch } = previewEnv();
    for (const path of ["/learn", "/my-account"]) {
      const response = await worker.fetch(new Request(`https://appshule.com${path}?from=home`), env);
      expect(response.status, path).toBe(308);
      expect(response.headers.get("location"), path).toBe(`${path}/?from=home`);
    }
    expect(staticFetch).not.toHaveBeenCalled();
  });

  it("normalizes the restored role dashboard URLs", async () => {
    const { env, staticFetch } = previewEnv();
    for (const path of ["/student", "/teacher", "/secretary", "/bursar", "/parent"]) {
      const response = await worker.fetch(new Request(`https://appshule.com${path}?from=login`), env);
      expect(response.status, path).toBe(308);
      expect(response.headers.get("location"), path).toBe(`${path}/?from=login`);
    }
    expect(staticFetch).not.toHaveBeenCalled();
  });

  it("routes health and API requests ahead of static assets", async () => {
    vi.mocked(readNeonHealth).mockResolvedValue({ users: 132, tables: 7 });
    const { env, staticFetch } = previewEnv();
    const health = await worker.fetch(new Request("https://appshule.com/health"), env);
    const apiHealth = await worker.fetch(new Request("https://appshule.com/api/healthz"), env);

    expect(health.status).toBe(200);
    expect((await health.json()).firebase).toBe(false);
    expect(apiHealth.status).toBe(200);
    expect((await apiHealth.json()).authentication).toBe("neon-postgresql-kv");
    expect(staticFetch).not.toHaveBeenCalled();
  });

  it("reports the Neon user count and checks for all 132 migrated users", async () => {
    vi.mocked(readNeonHealth).mockResolvedValue({ users: 132, tables: 7 });
    const { env, staticFetch } = previewEnv();
    env.ENVIRONMENT = "production";
    env.NEON_DATABASE_URL = "configured-for-test";

    const response = await worker.fetch(new Request("https://appshule.com/api/health"), env);
    const health = await response.json();

    expect(response.status).toBe(200);
    expect(health).toMatchObject({
      ok: true,
      env: "production",
      db: "neon",
      users: 132,
      expectedUsers: 132,
      usersMatchExpected: true,
      tables: 7,
      status: "ok",
    });
    expect(readNeonHealth).toHaveBeenCalledWith(env);
    expect(staticFetch).not.toHaveBeenCalled();
  });

  it("uses a read-only Neon snapshot for the isolated local Worker preview", async () => {
    vi.mocked(readNeonHealth).mockClear();
    const { env, staticFetch } = previewEnv();
    env.NEON_HEALTH_SNAPSHOT_JSON = JSON.stringify({
      users: 132,
      tables: 69,
      checkedAt: "2026-10-01T00:00:00.000Z",
    });

    const response = await worker.fetch(new Request("https://appshule.com/api/health"), env);
    const health = await response.json();

    expect(response.status).toBe(200);
    expect(health).toMatchObject({
      ok: true,
      env: "development",
      db: "neon",
      users: 132,
      expectedUsers: 132,
      usersMatchExpected: true,
      tables: 69,
      status: "ok",
      healthSource: "read-only-development-startup-snapshot",
      healthCheckedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(readNeonHealth).not.toHaveBeenCalled();
    expect(staticFetch).not.toHaveBeenCalled();
  });

  it("rejects malformed local Neon health snapshots instead of masking them", async () => {
    vi.mocked(readNeonHealth).mockClear();
    const { env, staticFetch } = previewEnv();
    env.NEON_HEALTH_SNAPSHOT_JSON = JSON.stringify({ users: "132", tables: 69 });

    const response = await worker.fetch(new Request("https://appshule.com/api/health"), env);
    const health = await response.json();

    expect(response.status).toBe(503);
    expect(health).toMatchObject({ ok: false, status: "unavailable" });
    expect(readNeonHealth).not.toHaveBeenCalled();
    expect(staticFetch).not.toHaveBeenCalled();
  });

  it("answers preflight requests without serving a frontend asset", async () => {
    const { env, staticFetch } = previewEnv();
    const response = await worker.fetch(new Request("https://appshule.com/api/healthz", {
      method: "OPTIONS",
      headers: { origin: "https://appshule.com" },
    }), env);

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://appshule.com");
    expect(staticFetch).not.toHaveBeenCalled();
  });

  it("requires an authenticated session before provider registration", async () => {
    const { env } = previewEnv();
    const response = await worker.fetch(new Request("https://appshule.com/api/skills/providers/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Test Training Centre",
        whatTheyTeach: "Welding",
        physicalAddress: "Wakiso",
        contactPhone: "+256700000000",
        contactEmail: "test@example.com",
      }),
    }), env);

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ ok: false, error: "Sign in before submitting a provider profile" });
  });

  it("binds provider registrations to the signed-in Neon account", async () => {
    const token = "provider-registration-session";
    const sessionKey = `auth:session:v2:${createHash("sha256").update(token).digest("base64url")}`;
    const user = {
      uid: "provider-user-123",
      email: "provider@example.com",
      display_name: "Provider",
      role: "provider",
      school_id: null,
      institution_id: null,
      session_version: 1,
      active: 1,
      disabled: 0,
    };
    const session = JSON.stringify({ uid: user.uid, sessionVersion: 1 });
    const insertedValues: unknown[][] = [];
    const cacheValues = new Map<string, string>();
    const env = {
      ENVIRONMENT: "development",
      SESSIONS: {
        get: vi.fn(async (key: string) => key === sessionKey ? session : null),
        put: vi.fn(async () => {}),
        delete: vi.fn(async () => {}),
      },
      CACHE: {
        get: vi.fn(async (key: string) => cacheValues.get(key) ?? null),
        put: vi.fn(async (key: string, value: string) => { cacheValues.set(key, value); }),
        delete: vi.fn(async (key: string) => { cacheValues.delete(key); }),
      },
      PG: {
        query: async <T,>(query: string, values?: unknown[]) => {
          if (query.includes("FROM users")) return { rows: [user as T], rowCount: 1 };
          if (query.includes("INSERT INTO skills_providers")) {
            insertedValues.push(values ?? []);
            return { rows: [], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
      },
    } as unknown as WorkerEnv;
    const response = await worker.fetch(new Request("https://appshule.com/api/skills/providers/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `aps_session=${token}`,
      },
      body: JSON.stringify({
        name: "Test Training Centre",
        whatTheyTeach: "Welding",
        physicalAddress: "Wakiso",
        contactPhone: "+256700000000",
        contactEmail: "provider@example.com",
      }),
    }), env);

    expect(response.status).toBe(201);
    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0][10]).toBe(user.uid);
    expect(await response.json()).toMatchObject({ ok: true, provider: { status: "pending" } });
  });

  it("keeps unknown frontend paths as 404s instead of falling through to the asset host", async () => {
    const { env, staticFetch } = previewEnv();
    const response = await worker.fetch(new Request("https://appshule.com/not-a-real-page"), env);

    expect(response.status).toBe(404);
    expect(staticFetch).not.toHaveBeenCalled();
  });
});