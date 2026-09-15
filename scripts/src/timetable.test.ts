import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd(), "..");
const indexSource = readFileSync(resolve(root, "index.html"), "utf8");
const offlineSource = readFileSync(resolve(root, "offline-manager.js"), "utf8");
const rulesSource = readFileSync(resolve(root, "firestore.rules"), "utf8");
const indexesSource = readFileSync(resolve(root, "firestore.indexes.json"), "utf8");

describe("Task 15 landing page", () => {
  it("keeps the existing authentication entry points", () => {
    expect(indexSource).toContain('id="landingSignupBtn"');
    expect(indexSource).toContain('id="landingSignupBtn2"');
    expect(indexSource).toContain('id="landingLoginBtn"');
    expect(indexSource).toContain("data-landing-auth");
    expect(indexSource).toContain("landingPricing");
  });

  it("contains all required sector and trust sections", () => {
    for (const marker of [
      "landingSectors",
      "landingFace",
      "landingFeatures",
      "landingAllFeatures",
      "landingHow",
      "landingPricing",
      "landingStories",
      "landingFooter",
      "landingDemoModal",
      "landingBackTop",
    ]) {
      expect(indexSource).toContain(`id="${marker}"`);
    }
    expect(indexSource).toContain("For Microfinance Institutions");
    expect(indexSource).toContain("For Clinics and Pharmacies");
    expect(indexSource).toContain("For Farms");
  });
});

describe("Task 15 timetable data contract", () => {
  it("uses every required Firestore collection", () => {
    for (const collection of [
      "school_timetable_config",
      "school_classes",
      "school_subjects",
      "timetable_teacher_duty",
      "school_timetables",
      "school_combined_periods",
      "school_timetable_expected_outcomes",
      "school_teacher_assignments",
    ]) {
      expect(indexSource).toContain(collection);
    }
  });

  it("has an explicit IndexedDB migration after the previous version", () => {
    expect(offlineSource).toContain("var DB_VERSION = 24");
    expect(offlineSource).toContain("if (oldVersion < 24)");
    expect(offlineSource).toContain("offline_timetables");
    expect(offlineSource).toContain("offline_timetable_outcomes");
  });

  it("keeps timetable reads scoped and excludes them from the catch-all rule", () => {
    expect(rulesSource).toContain("function sameSchool(institutionId)");
    expect(rulesSource).toContain("allow read: if sameSchool(resource.data.institutionId);");
    expect(rulesSource).toContain("school_timetable_expected_outcomes");
    expect(rulesSource).toContain("school_timetables)(/.*)?$");
  });

  it("declares six timetable query indexes", () => {
    const parsed = JSON.parse(indexesSource) as { indexes: Array<{ collectionGroup: string }> };
    const groups = parsed.indexes.map((item) => item.collectionGroup);
    expect(groups).toEqual(expect.arrayContaining([
      "school_classes",
      "school_subjects",
      "school_teacher_assignments",
      "school_timetables",
      "timetable_teacher_duty",
      "school_combined_periods",
    ]));
  });
});

describe("Task 15 generator behavior", () => {
  it("includes deterministic generation and conflict guards", () => {
    expect(indexSource).toContain("function timetableGenerateSlots()");
    expect(indexSource).toContain("function timetableSlotConflict");
    expect(indexSource).toContain("class, teacher, or room clash");
    expect(indexSource).toContain("data-tt-drag-index");
    expect(indexSource).toContain("timetableMoveSlot");
  });

  it("provides admin setup and role-aware views", () => {
    expect(indexSource).toContain("timetableCanManage()");
    expect(indexSource).toContain("timetableViewFilter");
    expect(indexSource).toContain("timetablePublish");
    expect(indexSource).toContain("timetableExport('pdf')");
    expect(indexSource).toContain("timetableExport('excel')");
  });
});