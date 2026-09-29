import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const routes = readFileSync(resolve(root, "cloudflare/domain-routes.ts"), "utf8");
const capabilities = readFileSync(resolve(root, "cloudflare/migrations/0004_cloudflare_backend.sql"), "utf8");
const workspace = readFileSync(resolve(root, "cloudflare/static/education/index.html"), "utf8");
const landing = readFileSync(resolve(root, "cloudflare/static/index.html"), "utf8");
const worker = readFileSync(resolve(root, "cloudflare/worker.ts"), "utf8");
const wrangler = readFileSync(resolve(root, "wrangler.toml"), "utf8");
const staticApiFiles = [
  "index.html",
  "education/index.html",
  "clinic/index.html",
  "farm/index.html",
  "mfi/index.html",
  "admin/index.html",
  "profile.html",
  "reset-password.html",
  "sector.html",
  "skills/api-config.js",
  "tech/index.html",
  "tech/script.js",
].map((path) => ({
  path,
  source: readFileSync(resolve(root, "cloudflare/static", path), "utf8"),
}));
const serviceWorker = readFileSync(resolve(root, "cloudflare/static/sw.js"), "utf8");

describe("Cloudflare Education learner creation permissions", () => {
  it("uses the headteacher secondary-student capability on learner writes", () => {
    expect(routes).toContain(
      'write: currentRole === "headteacher" ? "students.secondary.manage" : "students.manage"',
    );
    expect(capabilities).toContain("('headteacher', 'education', 'students.secondary.manage', 'tenant')");
    expect(workspace).toContain('if (cap("students.manage") || cap("students.secondary.manage"))');
    expect(workspace).toContain('"/api/school/learners"');
  });

  it("keeps generic educator and bursar controls behind their role capabilities", () => {
    expect(workspace).toContain('if (cap("attendance.manage"))');
    expect(workspace).toContain('if (cap("marks.manage"))');
    expect(workspace).toContain('if (cap("fees.manage"))');
    expect(workspace).toContain('if (cap("statements.manage"))');
  });

  it("shows a useful signed-out state and does not request school data before authentication", () => {
    expect(workspace).toContain('const session = await request("/api/auth/session"');
    expect(workspace).toContain('const data = await request("/api/school/education-workspace"');
    expect(workspace).toContain("/authentication|\\b401\\b/i.test(message)");
    expect(workspace).toContain('link.href = "/#account-access"');
    expect(workspace).toContain('link.textContent = "Go to APSHULE sign-in"');
    expect(workspace).toContain('$("logout").classList.add("hidden")');
    expect(workspace).toContain('$("profile-link").classList.add("hidden")');
  });

  it("restores the multi-sector landing and routes student and teacher accounts to Education", () => {
    expect(landing).toContain('id="landingSectors"');
    expect(landing).toContain('id="landingFeatures"');
    expect(landing).toContain('id="landingHow"');
    expect(landing).toContain("Command Center");
    expect(landing).toContain('"teacher_independent"');
    expect(landing).toContain('["student", "learner", "individual"]');
    expect(landing).toContain('return "/workspace/student";');
    expect(landing).toContain('/sw.js?rev=cloudflare-shell-v13');
  });

  it("routes legacy workspace URLs to the matching Cloudflare page", () => {
    for (const route of [
      '["/workspace/admin", "/admin/"]',
      '["/workspace/student", "/education/"]',
      '["/workspace/teacher", "/education/"]',
      '["/workspace/clinic", "/clinic/"]',
      '["/workspace/farm", "/farm/"]',
      '["/workspace/mfi", "/mfi/"]',
      '["/education", "/education/"]',
      '["/school", "/education/"]',
      '["/student", "/education/"]',
      '["/teacher", "/education/"]',
      '["/mfi", "/mfi/"]',
      '["/clinic", "/clinic/"]',
      '["/farm", "/farm/"]',
    ]) {
      expect(worker).toContain(route);
    }
    expect(worker).toContain('pathname === "/workspace" || pathname === "/workspace/"');
    expect(wrangler.match(/not_found_handling = "none"/g)).toHaveLength(2);
    for (const prefix of ["/education/", "/mfi/", "/clinic/", "/farm/"]) {
      expect(worker).toContain(`"${prefix}"`);
    }
  });

  it("keeps staged API calls on the current origin and out of Firebase/Render", () => {
    for (const file of staticApiFiles) {
      expect(file.source, file.path).not.toMatch(/fetch\([\s\S]{0,160}https:\/\/appshule\.com\/api/);
      expect(file.source, file.path).not.toMatch(/APSHULE_API_BASE\s*=\s*["']https?:/);
      expect(file.source, file.path).not.toMatch(/firebase|onrender|render\.com/i);
    }
  });

  it("versions the single root worker and precaches both role workspaces", () => {
    expect(serviceWorker).toContain('CACHE_NAME = "apshule-cloudflare-shell-v13"');
    expect(serviceWorker).toContain('"/education/"');
    expect(serviceWorker).toContain('"/admin/"');
    for (const route of ["/workspace/student", "/workspace/teacher", "/workspace/head_teacher", "/school/", "/student/", "/teacher/"]) {
      expect(serviceWorker).toContain(`"${route}"`);
    }
    expect(readFileSync(resolve(root, "cloudflare/static/index.html"), "utf8"))
      .toContain('/sw.js?rev=cloudflare-shell-v13');
  });
});