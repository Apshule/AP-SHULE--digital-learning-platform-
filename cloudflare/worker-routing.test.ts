import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import worker from "./worker";

type WorkerEnv = Parameters<typeof worker.fetch>[1];

function previewEnv() {
  const staticFetch = vi.fn(async (request: Request) => {
    return new Response(`asset:${new URL(request.url).pathname}`);
  });
  const env = {
    ENVIRONMENT: "development",
    D1_DATABASE_NAME: "apshule-preview-local",
    STATIC: { fetch: staticFetch },
    DB: { prepare: vi.fn(() => { throw new Error("Unexpected D1 access in route test"); }) },
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
      "/skills/",
      "/tech/",
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
      ["/workspace/student", "/education/"],
      ["/workspace/student/", "/education/"],
      ["/workspace/teacher", "/education/"],
      ["/workspace/teacher/", "/education/"],
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

  it("routes health and API requests ahead of static assets", async () => {
    const { env, staticFetch } = previewEnv();
    const health = await worker.fetch(new Request("https://appshule.com/health"), env);
    const apiHealth = await worker.fetch(new Request("https://appshule.com/api/healthz"), env);

    expect(health.status).toBe(200);
    expect((await health.json()).firebase).toBe(false);
    expect(apiHealth.status).toBe(200);
    expect((await apiHealth.json()).authentication).toBe("cloudflare-d1-kv");
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

  it("requires an authenticated D1 session before provider registration", async () => {
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

  it("binds provider registrations to the signed-in D1 account", async () => {
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
      D1_DATABASE_NAME: "apshule-preview-local",
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
      DB: {
        prepare: (query: string) => {
          let values: unknown[] = [];
          return {
            bind(...bound: unknown[]) {
              values = bound;
              return this;
            },
            async all<T>() {
              return { results: query.includes("FROM users") ? [user as T] : [] };
            },
            async run() {
              insertedValues.push(values);
              return { success: true };
            },
          };
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