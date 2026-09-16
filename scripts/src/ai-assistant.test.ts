import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const indexSource = readFileSync(resolve(root, "index.html"), "utf8");

describe("sector AI assistant contracts", () => {
  it("uses the existing client-side Pollinations endpoints without a server deployment", () => {
    expect(indexSource).toContain("https://text.pollinations.ai/");
    expect(indexSource).toContain("https://api.pollinations.ai/v1/chat/completions");
    expect(indexSource).not.toContain("fetch('/api/ai/assistant'");
    expect(indexSource).not.toContain("auth.currentUser.getIdToken()");
  });

  it("builds one role-aware client prompt for every APSHULE sector", () => {
    for (const sector of ["education", "mfi", "clinic", "farm", "platform"]) {
      expect(indexSource).toContain(`${sector}:`);
    }
    expect(indexSource).toContain("const role=String(currentUser?.role||'').toLowerCase();");
    expect(indexSource).toContain("const systemPrompt=(prompts[sector]||prompts.platform)");
  });

  it("includes safety guidance for every APSHULE sector", () => {
    expect(indexSource).toContain("Never make final credit decisions");
    expect(indexSource).toContain("Never diagnose or replace a qualified clinician");
    expect(indexSource).toContain("recommend veterinary review");
    expect(indexSource).toContain("Ugandan NCDC curriculum");
  });
});