import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const indexSource = readFileSync(resolve(root, "index.html"), "utf8");
const askAiStart = indexSource.indexOf("async function askAI(q)");
const askAiEnd = indexSource.indexOf("function parseMd", askAiStart);
const askAiSource = indexSource.slice(askAiStart, askAiEnd);
const routeSource = readFileSync(resolve(root, "artifacts/api-server/src/routes/ai-assistant.ts"), "utf8");

describe("sector AI assistant contracts", () => {
  it("uses the authenticated server assistant without exposing provider credentials", () => {
    expect(askAiSource).toContain("fetch((configuredBase||'')+'/api/ai/assistant'");
    expect(askAiSource).toContain("auth.currentUser.getIdToken()");
    expect(askAiSource).not.toContain("pollinations");
    expect(routeSource).toContain("GOOGLE_API_KEY");
  });

  it("keeps sector selection and role validation on the server", () => {
    expect(routeSource).toContain("verifyFirebaseCaller");
    expect(routeSource).toContain("const callerSector = sectorForRole(caller.role);");
    expect(routeSource).toContain("const sector = requestedSectorForCaller(callerSector, body.sector);");
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