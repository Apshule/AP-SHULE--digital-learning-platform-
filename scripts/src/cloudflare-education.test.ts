import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const routes = readFileSync(resolve(root, "cloudflare/domain-routes.ts"), "utf8");
const capabilities = readFileSync(resolve(root, "cloudflare/migrations/0004_cloudflare_backend.sql"), "utf8");
const workspace = readFileSync(resolve(root, "cloudflare/static/education/index.html"), "utf8");
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

  it("keeps staged API calls on the current origin and out of Firebase/Render", () => {
    for (const file of staticApiFiles) {
      expect(file.source, file.path).not.toMatch(/fetch\([\s\S]{0,160}https:\/\/appshule\.com\/api/);
      expect(file.source, file.path).not.toMatch(/APSHULE_API_BASE\s*=\s*["']https?:/);
      expect(file.source, file.path).not.toMatch(/firebase|onrender|render\.com/i);
    }
  });

  it("versions the single root worker and precaches both role workspaces", () => {
    expect(serviceWorker).toContain('CACHE_NAME = "apshule-cloudflare-shell-v10"');
    expect(serviceWorker).toContain('"/education/"');
    expect(serviceWorker).toContain('"/admin/"');
    expect(readFileSync(resolve(root, "cloudflare/static/index.html"), "utf8"))
      .toContain('/sw.js?rev=cloudflare-shell-v10');
  });
});