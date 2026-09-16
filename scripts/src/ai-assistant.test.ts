import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const indexSource = readFileSync(resolve(root, "index.html"), "utf8");
const askAiStart = indexSource.indexOf("async function askAI(q)");
const askAiEnd = indexSource.indexOf("function parseMd", askAiStart);
const askAiSource = indexSource.slice(askAiStart, askAiEnd);
const routeSource = readFileSync(resolve(root, "artifacts/api-server/src/routes/ai-assistant.ts"), "utf8");
const complianceSource = readFileSync(resolve(root, "artifacts/api-server/src/routes/compliance.ts"), "utf8");
const appSource = readFileSync(resolve(root, "artifacts/api-server/src/app.ts"), "utf8");

describe("sector AI assistant contracts", () => {
  it("uses the authenticated server assistant without exposing provider credentials", () => {
    expect(indexSource).toContain("const AI_ASSISTANT_ENDPOINT='https://ap-shule-digital-learning-platform-3.onrender.com/api/ai/assistant'");
    expect(indexSource).toContain("window.apshuleApiUrl");
    expect(askAiSource).toContain("fetch(endpoint");
    expect(askAiSource).toContain("auth.currentUser.getIdToken()");
    expect(askAiSource).not.toContain("pollinations");
    expect(routeSource).toContain("GEMINI_API_KEY");
    expect(routeSource).not.toContain("GOOGLE_API_KEY");
    expect(complianceSource).toContain("GEMINI_API_KEY");
    expect(complianceSource).not.toContain("GOOGLE_API_KEY");
  });

  it("keeps sector selection and role validation on the server", () => {
    expect(routeSource).toContain("verifyFirebaseCaller");
    expect(routeSource).toContain("const callerSector = sectorForRole(caller.role);");
    expect(routeSource).toContain("const sector = requestedSectorForCaller(callerSector, body.sector);");
    for (const sector of ["education", "mfi", "clinic", "farm", "platform"]) {
      expect(routeSource).toContain(`${sector}:`);
    }
    expect(routeSource).toContain('education_admin: "education"');
  });

  it("includes safety guidance for every APSHULE sector", () => {
    expect(routeSource).toContain("Never approve or reject a loan");
    expect(routeSource).toContain("Do not diagnose, prescribe");
    expect(routeSource).toContain("qualified veterinary professional");
    expect(routeSource).toContain("Uganda-curriculum learning coach");
  });

  it("restricts browser CORS to approved APSHULE origins", () => {
    expect(appSource).toContain('"https://appshule.com"');
    expect(appSource).toContain('"https://www.appshule.com"');
    expect(appSource).not.toContain("app.use(cors());");
  });
});