import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const routeSource = readFileSync(resolve(root, "artifacts/api-server/src/routes/youtube.ts"), "utf8");
const routesSource = readFileSync(resolve(root, "artifacts/api-server/src/routes/index.ts"), "utf8");

describe("YouTube channel integration contracts", () => {
  it("keeps the YouTube credential server-side and registers the route", () => {
    expect(routeSource).toContain('process.env["YOUTUBE_API_KEY"]');
    expect(routeSource).toContain('router.post("/youtube/sync"');
    expect(routesSource).toContain('import youtubeRouter from "./youtube"');
    expect(routesSource).toContain("router.use(youtubeRouter)");
    expect(routeSource).not.toContain("console.log(apiKey");
  });

  it("resolves the channel uploads playlist and imports video metadata", () => {
    for (const value of ["channels", "playlistItems", "videos", "uploadsPlaylistId", "youtubeVideos"]) {
      expect(routeSource).toContain(value);
    }
    expect(routeSource).toContain("source: \"youtube_channel\"");
    expect(routeSource).toContain("youtubeUrl");
  });

  it("maps structured class, subject, and topic metadata to existing app placements", () => {
    for (const value of ["parsePlacement", "suggestedClassKey", "suggestedSubject", "suggestedTopic", "videoMappings", "mappingStatus"]) {
      expect(routeSource).toContain(value);
    }
    expect(routeSource).toContain('router.post("/youtube/mappings"');
    expect(routeSource).toContain("mappingStatus: \"conflict\"");
  });

  it("restricts channel sync and placement writes to superadmins", () => {
    expect(routeSource).toContain("verifyFirebaseAdmin");
    expect(routeSource).toContain("requireSuperadmin");
    expect(routeSource).toContain('router.get("/youtube/status"');
    expect(routeSource).toContain('router.get("/youtube/videos"');
  });
});