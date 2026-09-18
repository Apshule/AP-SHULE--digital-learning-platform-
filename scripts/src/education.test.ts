import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const educationSource = readFileSync(resolve(root, "education/index.html"), "utf8");
const educationScript = readFileSync(resolve(root, "education/app.js"), "utf8");
const serverSource = readFileSync(resolve(root, "artifacts/api-server/src/app.ts"), "utf8");
const landingSource = readFileSync(resolve(root, "index.html"), "utf8");

describe("Education workspace integration", () => {
  it("serves a standalone credential-free education workspace", () => {
    expect(educationSource).toContain("<title>APSHULE Education");
    expect(educationSource).toContain('href="../"');
    expect(educationSource).toContain('id="workspaceNav"');
    expect(educationSource).toContain('id="workspaceContent"');
    expect(educationSource).not.toContain("secretary@apshule.com");
    expect(educationSource).not.toContain('value="password"');
    expect(educationScript).toContain("studentModal");
    expect(educationScript).toContain("Preview learner saved locally");
  });

  it("keeps the route and landing-page education entry connected", () => {
    expect(serverSource).toContain('app.get(["/education", "/education/"]');
    expect(serverSource).toContain('app.use("/education", express.static(educationPath))');
    expect(landingSource).toContain('<a href="education/">For Schools</a>');
    expect(landingSource).toContain('<a class="landing-link" href="education/">Explore education →</a>');
  });
});