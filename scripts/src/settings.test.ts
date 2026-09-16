import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "../..");
const indexSource = readFileSync(resolve(projectRoot, "index.html"), "utf8");
const offlineSource = readFileSync(resolve(projectRoot, "offline-manager.js"), "utf8");

describe("Task 8 settings and preferences contracts", () => {
  it("A: places the settings card in the account flow with five accordion sections", () => {
    expect(indexSource).toContain('id="connectionSettingsCard"');
    expect(indexSource).toContain("Connection &amp; Data");
    expect(indexSource).toContain("Language");
    expect(indexSource).toContain("Storage");
    expect(indexSource).toContain("Sync");
    expect(indexSource).toContain("About &amp; Help");
    expect(indexSource).toContain("myVideoQList");
  });

  it("B: persists connection toggles, mode changes, and usage values offline", () => {
    expect(indexSource).toContain("downloadHdWifiToggle");
    expect(indexSource).toContain("autoSyncWifiToggle");
    expect(indexSource).toContain("autoSyncMobileToggle");
    expect(indexSource).toContain("settingsConnectionMode");
    expect(indexSource).toContain("settingsDownloadedBytes");
    expect(indexSource).toContain("saveConnectionSettings");
    expect(offlineSource).toContain("recordDataUsage");
  });

  it("C: supports all seven Ugandan language choices and Firestore preferences", () => {
    for (const language of ["English", "Luganda", "Lusoga", "Runyankore", "Runyoro", "Acholi", "Swahili"]) {
      expect(indexSource).toContain(`value="${language}"`);
    }
    expect(indexSource).toContain("'preferences.language'");
    expect(indexSource).toContain("'preferences.videoLanguage'");
    expect(indexSource).toContain("Language updated");
  });

  it("D: calculates storage categories and supports safe category clearing", () => {
    expect(offlineSource).toContain("getStorageBreakdown");
    expect(offlineSource).toContain("clearStorageCategory");
    expect(offlineSource).toContain("'offline_pdfs'");
    expect(indexSource).toContain("data-clear-category=\"cartoonVideos\"");
    expect(indexSource).toContain("data-clear-category=\"aiVideos\"");
    expect(indexSource).toContain("data-clear-category=\"pdfs\"");
    expect(indexSource).toContain("data-clear-category=\"all\"");
    expect(indexSource).toContain("Clear all cached lessons");
  });

  it("E: exposes sync status, manual sync, schedule, and persistent history", () => {
    expect(indexSource).toContain("settingsPendingProjects");
    expect(indexSource).toContain("settingsPendingViews");
    expect(indexSource).toContain("settingsSyncHistory");
    expect(indexSource).toContain("30*60*1000");
    expect(offlineSource).toContain("offline_sync_history");
    expect(offlineSource).toContain("recordSyncHistory");
  });

  it("F: includes offline user-guide and FAQ content", () => {
    expect(indexSource).toContain("APSHULE User Guide");
    expect(indexSource).toContain("Getting Started");
    expect(indexSource).toContain("Watching Videos");
    expect(indexSource).toContain("Offline Mode");
    expect(indexSource).toContain("Frequently Asked Questions");
  });

  it("G: submits bug reports and feature requests to separate collections", () => {
    expect(indexSource).toContain("bug_reports");
    expect(indexSource).toContain("feature_requests");
    expect(indexSource).toContain("settingsFeedbackSubmitBtn");
  });

  it("H: provides support and legal links", () => {
    expect(indexSource).toContain("https://wa.me/256705732540");
    expect(indexSource).toContain("https://apshule.com/legal");
  });

  it("I: keeps live Firestore error callbacks from throwing secondary ReferenceErrors", () => {
    expect(indexSource).toContain("Student Q&A listener unavailable:");
    expect(indexSource).not.toContain("c.innerHTML=`<div style=\"color:#c62828;font-size:13px;\">${escHtml(error.message || 'Questions are unavailable right now.')}</div>`");
  });
});