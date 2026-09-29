import { describe, expect, it, vi } from "vitest";
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

  it("keeps unknown frontend paths as 404s instead of falling through to the asset host", async () => {
    const { env, staticFetch } = previewEnv();
    const response = await worker.fetch(new Request("https://appshule.com/not-a-real-page"), env);

    expect(response.status).toBe(404);
    expect(staticFetch).not.toHaveBeenCalled();
  });
});