import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const indexSource = readFileSync(resolve(root, "index.html"), "utf8");
const routeSource = readFileSync(resolve(root, "artifacts/api-server/src/routes/ai-assistant.ts"), "utf8");

describe("sector AI assistant contracts", () => {
  it("uses the authenticated server assistant instead of public client-side fallbacks", () => {
    expect(indexSource).toContain("fetch('/api/ai/assistant'");
    expect(indexSource).toContain("auth.currentUser.getIdToken()");
    expect(indexSource).not.toContain("text.pollinations.ai/");
    expect(indexSource).not.toContain("api.pollinations.ai/v1/chat/completions");
  });

  it("keeps sector selection and role validation on the server", () => {
    expect(routeSource).toContain("verifyFirebaseCaller");
    expect(routeSource).toContain("const callerSector = sectorForRole(caller.role);");
    expect(routeSource).toContain("const sector = allowedSector(callerSector, body.sector);");
    for (const sector of ["education", "mfi", "clinic", "farm", "platform"]) {
      expect(routeSource).toContain(`${sector}:`);
    }
  });

  it("includes safety guidance for every APSHULE sector", () => {
    expect(routeSource).toContain("Never approve or reject a loan");
    expect(routeSource).toContain("Do not diagnose, prescribe");
    expect(routeSource).toContain("qualified veterinary professional");
    expect(routeSource).toContain("Uganda-curriculum learning coach");
  });
});