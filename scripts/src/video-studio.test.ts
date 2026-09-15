import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const projectRoot = new URL("../../", import.meta.url);
const indexHtml = readFileSync(new URL("index.html", projectRoot), "utf8");
const offlineSource = readFileSync(new URL("offline-manager.js", projectRoot), "utf8");
const videoStudioStart = indexHtml.indexOf("// ===== VIDEO STUDIO — CARTOON FOUNDATION =====");
const videoStudioEnd = indexHtml.indexOf("async function complianceApi", videoStudioStart);

function loadVideoStudioHelpers() {
  if (videoStudioStart < 0 || videoStudioEnd < 0) throw new Error("Video Studio helpers could not be located");
  const context = {
    classData: {
      primary: [{ id: 1, name: "Primary 1" }],
      secondary: [{ id: 1, name: "Senior 1" }],
    },
    navigator: { onLine: true },
    document: { getElementById: () => null, querySelectorAll: () => [] },
    window: {},
    escHtml: (value: unknown) => String(value ?? ""),
  } as Record<string, unknown>;
  const source = `${indexHtml.slice(videoStudioStart, videoStudioEnd)}
this.__videoStudioHelpers = {
  assets: videoStudioAssetRecords,
  captions: videoStudioBuildCaptions,
  selectScenes: videoStudioSelectScenes,
  validate: videoStudioValidate,
};`;
  runInNewContext(source, context);
  return context.__videoStudioHelpers as {
    assets: () => Array<Record<string, any>>;
    captions: (text: string, duration: number) => { captions: Array<Record<string, any>>; srt: string };
    selectScenes: (assets: Array<Record<string, any>>, character: string, topic: string) => Array<Record<string, any>>;
    validate: (values: Record<string, any>) => string[];
  };
}

describe("Video Studio data foundation", () => {
  it("declares all four Firestore collections and the Super Admin surface", () => {
    expect(indexHtml).toContain('id="superVideoStudioSection"');
    expect(indexHtml).toContain('id="videoStudioModal"');
    expect(indexHtml).toContain("video_studio_projects");
    expect(indexHtml).toContain("cartoon_assets");
    expect(indexHtml).toContain("video_generation_queue");
    expect(indexHtml).toContain("video_library");
    expect(indexHtml).toContain("Only Super Admins can generate cartoon lessons");
    expect(indexHtml).toContain("Only Super Admins can publish lessons");
  });

  it("seeds exactly four characters with five poses each", () => {
    const helpers = loadVideoStudioHelpers();
    const assets = helpers.assets();
    expect(assets).toHaveLength(20);
    expect(new Set(assets.map(asset => asset.character)).size).toBe(4);
    expect(new Set(assets.map(asset => asset.pose)).size).toBe(5);
    expect(new Set(assets.map(asset => asset.id)).size).toBe(20);
    expect(assets.every(asset => asset.imageDataUrl.startsWith("data:image/svg+xml"))).toBe(true);
  });

  it("selects six scenes in a stable five-pose-plus-repeat order", () => {
    const helpers = loadVideoStudioHelpers();
    const scenes = helpers.selectScenes(helpers.assets(), "teacher", "Plants");
    expect(scenes).toHaveLength(6);
    expect(scenes.map(scene => scene.pose)).toEqual(["intro", "explain", "point", "example", "practice", "explain"]);
  });

  it("builds timed captions and SRT output", () => {
    const helpers = loadVideoStudioHelpers();
    const result = helpers.captions(
      "Plants have roots stems leaves flowers fruits seeds roots stems leaves flowers fruits seeds roots stems leaves flowers fruits seeds roots stems leaves flowers fruits seeds",
      60,
    );
    expect(result.captions.length).toBeGreaterThan(1);
    expect(result.captions[0].start).toBe(0);
    expect(result.captions.at(-1)?.end).toBe(60);
    expect(result.srt).toContain("00:00:00,000 -->");
    expect(result.srt).toContain("1\n");
  });

  it("enforces required fields, supported duration, and the 2000-character limit", () => {
    const helpers = loadVideoStudioHelpers();
    expect(helpers.validate({}).length).toBeGreaterThan(0);
    expect(helpers.validate({
      topic: "Plants",
      type: "lesson",
      subject: "Science",
      classLevel: "P1",
      language: "English",
      character: "teacher",
      durationSeconds: 60,
      script: "Explain roots.",
    })).toEqual([]);
    expect(helpers.validate({
      topic: "Plants",
      type: "lesson",
      subject: "Science",
      classLevel: "P1",
      language: "English",
      character: "teacher",
      durationSeconds: 45,
      script: "x".repeat(2001),
    })).toEqual(expect.arrayContaining(["Choose a lesson duration", "Keep the script within 2,000 characters"]));
  });
});

describe("Video Studio UI and offline contracts", () => {
  it("includes the four tabs, preview controls, publishing, and library pagination", () => {
    expect(indexHtml).toContain('data-video-studio-tab="cartoon"');
    expect(indexHtml).toContain('data-video-studio-tab="auto"');
    expect(indexHtml).toContain('data-video-studio-tab="twin"');
    expect(indexHtml).toContain('data-video-studio-tab="library"');
    expect(indexHtml).toContain('data-video-studio-tab="stats"');
    expect(indexHtml).toContain('id="videoStudioAutoForm"');
    expect(indexHtml).toContain('id="videoStudioAutoProgress"');
    expect(indexHtml).toContain('id="videoTwinList"');
    expect(indexHtml).toContain('id="studentVideoTutorialsSection"');
    expect(indexHtml).toContain('id="teacherVideoLibrarySection"');
    expect(indexHtml).toContain('id="videoDownloadsSection"');
    expect(indexHtml).toContain('id="videoStudioPlayPauseBtn"');
    expect(indexHtml).toContain('id="videoStudioRestartBtn"');
    expect(indexHtml).toContain('id="publishVideoStudioBtn"');
    expect(indexHtml).toContain('id="loadMoreVideoStudioBtn"');
    expect(indexHtml).toContain("SpeechSynthesis");
    expect(indexHtml).toContain("Connect to the internet before generating a lesson");
  });

  it("keeps AI Auto-Video generation and series mode offline-safe", () => {
    expect(indexHtml).toContain("video_generation_stats");
    expect(indexHtml).toContain("videoStudioSplitSeriesScript");
    expect(indexHtml).toContain("videoStudioGenerateAutoScript");
    expect(indexHtml).toContain("durationMode === 'series'");
    expect(indexHtml).toContain("videoStudioCachePublished");
    expect(indexHtml).toContain("SpeechSynthesis");
  });

  it("keeps Digital Teacher Twin consent and credential handling server-safe", () => {
    expect(indexHtml).toContain("teacher_twins");
    expect(indexHtml).toContain("twin_generation_jobs");
    expect(indexHtml).toContain("twin_api_config");
    expect(indexHtml).toContain("keyStorage:'server-secret-required'");
    expect(indexHtml).toContain("secure server integration is still required");
    expect(indexHtml).toContain("downloadTwinConsentTemplate");
    expect(indexHtml).not.toContain("fetch('https://api.elevenlabs.io");
    expect(indexHtml).not.toContain("fetch('https://api.d-id.com");
  });

  it("covers assignments, analytics, sharing, and download management", () => {
    expect(indexHtml).toContain("video_assignments");
    expect(indexHtml).toContain("videoViews");
    expect(indexHtml).toContain("downloadVideoAnalyticsBtn");
    expect(indexHtml).toContain("videoStudioShare");
    expect(indexHtml).toContain("clearVideoDownloads");
    expect(indexHtml).toContain("mapping.mode === 'teacher_twin' ? 250");
  });

  it("extends IndexedDB with a published cartoon slideshow store", () => {
    expect(offlineSource).toContain("var DB_VERSION = 22");
    expect(offlineSource).toContain("'offline_video_studio'");
    expect(offlineSource).toContain("cacheVideoStudio");
    expect(offlineSource).toContain("getVideoStudio");
    expect(offlineSource).toContain("listVideoStudio");
  });

  it("keeps Video Studio collections role-scoped in Firestore rules and indexed for library browsing", () => {
    const rules = readFileSync(new URL("firestore.rules", projectRoot), "utf8");
    const indexes = JSON.parse(readFileSync(new URL("firestore.indexes.json", projectRoot), "utf8")) as {
      indexes: Array<{ collectionGroup: string }>;
    };
    expect(rules).toContain("function isSuperAdmin()");
    expect(rules).toContain("match /video_studio_projects/{projectId}");
    expect(rules).toContain("allow create, update, delete: if isSuperAdmin()");
    expect(indexes.indexes.map(index => index.collectionGroup)).toEqual(expect.arrayContaining([
      "cartoon_assets",
      "video_studio_projects",
      "video_library",
      "video_assignments",
      "teacher_twins",
      "videoViews",
    ]));
  });
});