import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("APSHULE Skills Cloudflare frontend", () => {
  it("uses the Cloudflare API config and ships no Firebase config", () => {
    expect(existsSync(resolve(root, "skills/firebase-config.js"))).toBe(false);
    expect(read("skills/api-config.js")).toContain('global.APSHULE_API_BASE = "";');
    expect(read("skills/api-config.js")).not.toMatch(/firebase/i);
    for (const path of [
      "skills/index.html",
      "skills/provider.html",
      "skills/join-provider.html",
      "cloudflare/static/skills/provider.html",
    ]) {
      expect(read(path), path).not.toMatch(/firebase|firestore|firebasestorage/i);
    }
  });

  it("restores a searchable course directory backed by the current providers API", () => {
    const directory = read("skills/index.html");
    expect(directory).toContain("Choose work");
    expect(directory).toContain('id="courseGrid"');
    expect(directory).toContain('id="search"');
    expect(directory).toContain('id="category"');
    expect(directory).toContain('id="duration"');
    expect(directory).toContain('fetch(api("/api/skills/providers"))');
    expect(directory).toContain("provider.referralCode === referral");
    expect(directory).toContain("./provider.html?id=");
    expect(directory).not.toContain("skills-enroll.html");
    expect(directory).not.toContain("/api/skills/enrollments");
  });

  it("preserves provider storefront and profile reads without reviving archived applications", () => {
    const directory = read("skills/index.html");
    const provider = read("cloudflare/static/skills/provider.html");
    expect(directory).toContain('id="storefront-section"');
    expect(directory).toContain("showStorefront");
    expect(provider).toContain("/api/skills/providers/");
    expect(provider).toContain("/api/skills/providers");
    expect(provider).toContain("contactPhone");
    expect(provider).toContain("contactEmail");
    expect(provider).toContain("Ask the provider about the next intake.");
    expect(provider).not.toContain("skills-enroll.html");
    expect(provider).not.toContain("Apply for this course");
    expect(provider).not.toContain("/api/skills/admission");
  });

  it("stages the restored UI and excludes archived Firebase and admission clients", () => {
    const stage = read("cloudflare/stage-assets.mjs");
    expect(stage).toContain('"firebase-config.js"');
    expect(stage).toContain('"skills-enroll.html"');
    expect(stage).toContain('"provider-register.html"');
    expect(stage).not.toContain('"join-provider.html"');
    const onboarding = read("skills/join-provider.html");
    expect(onboarding).toContain("/api/auth/request-login-otp");
    expect(onboarding).toContain("/api/auth/verify-login-otp");
    expect(onboarding).toContain("/api/skills/providers/register");
    expect(read("skills/styles.css")).toContain("--plum-dark: #35172f");
    expect(read("cloudflare/static/skills/api-config.js")).toContain('window.APSHULE_API_BASE = "";');
  });

  it("retains the D1 provider API and explicit static route boundary", () => {
    const worker = read("cloudflare/worker.ts");
    expect(worker).toContain('url.pathname === "/api/skills/providers"');
    expect(worker).toContain('url.pathname.match(/^\\/api\\/skills\\/providers\\/');
    expect(worker).toContain('"/skills/"');
    expect(worker).toContain('"/tech/"');
    expect(worker).toContain('"/clinic/"');
    expect(worker).toContain("isExplicitStaticRoute(url.pathname)");
    expect(worker).toContain('json({ ok: false, error: "not found" }, 404)');
  });
});