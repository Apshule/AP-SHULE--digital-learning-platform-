import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const pageSource = readFileSync(resolve(root, "youtube-sync.html"), "utf8");
const indexSource = readFileSync(resolve(root, "index.html"), "utf8");
const appSource = readFileSync(resolve(root, "artifacts/api-server/src/app.ts"), "utf8");

describe("YouTube sync superadmin page", () => {
  it("is linked from the Command Center and served by the API app", () => {
    expect(indexSource).toContain('data-command-action="youtube"');
    expect(indexSource).toContain("youtube-sync.html");
    expect(appSource).toContain('app.get("/youtube-sync.html"');
  });

  it("uses the authenticated Firebase session for the YouTube API", () => {
    for (const value of ["firebase.auth()", "getIdToken()", "/api/youtube/sync", "/api/youtube/videos", "/api/youtube/mappings"]) {
      expect(pageSource).toContain(value);
    }
    expect(pageSource).toContain("profile.role !== \"superadmin\"");
  });

  it("shows mappings and supports manual review for unresolved videos", () => {
    for (const value of ["videoMappings", "mappingStatus", "Review & map", "Class", "Subject", "Topic", "Save mapping"]) {
      expect(pageSource).toContain(value);
    }
    expect(pageSource).toContain("data-map-video");
  });
});