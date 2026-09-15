import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const indexSource = readFileSync(resolve(root, "index.html"), "utf8");
const offlineSource = readFileSync(resolve(root, "offline-manager.js"), "utf8");
const rulesSource = readFileSync(resolve(root, "firestore.rules"), "utf8");
const indexes = JSON.parse(readFileSync(resolve(root, "firestore.indexes.json"), "utf8")) as {
  indexes: Array<{ collectionGroup: string; fields: Array<{ fieldPath: string }> }>;
};

describe("Task 13 Step 1 farm foundation contracts", () => {
  it("adds farm institution fields and farm roles", () => {
    for (const value of [
      "commandFarmInstitutionFields",
      "commandFarmType",
      "commandFarmOwnerName",
      "commandFarmOwnerPhone",
      "commandFarmProducts",
      "commandFarmWorkerCount",
      "commandFarmHasCameras",
      "farm_admin",
      "farm_manager",
      "farm_worker",
      "farm_director",
    ]) {
      expect(indexSource).toContain(value);
    }
    expect(indexSource).toContain("doc(db,'farms'");
    expect(indexSource).toContain("institution_branding");
  });

  it("supports the seeded animal registry and farm operations", () => {
    for (const value of [
      "farmSeedAnimalTypes",
      "farm_animal_types",
      "farm_animal_movements",
      "farm_workers",
      "farm_cameras",
      "farm_daily_summaries",
      "farmGenerateSummary",
      "farmSaveMovement",
      "farmSaveWorker",
      "farmSaveCamera",
      "farmMarkAttendance",
    ]) {
      expect(indexSource).toContain(value);
    }
    for (const animal of ["Cow", "Goat", "Sheep", "Pig", "Chicken", "Cock", "Donkey"]) {
      expect(indexSource).toContain(animal);
    }
  });

  it("protects biometric enrollment and supports offline farm records", () => {
    expect(indexSource).toContain("faceEnrollmentConsent");
    expect(indexSource).toContain("faceEmbedding");
    expect(indexSource).toContain("OfflineManager.queueFarmMovement");
    expect(indexSource).toContain("OfflineManager.queueFarmAttendance");
    expect(offlineSource).toContain("var DB_VERSION = 23");
    for (const value of ["offline_farm_movements", "offline_farm_attendance", "offline_farm_reports"]) {
      expect(offlineSource).toContain(value);
    }
    expect(rulesSource).toContain("match /farm_workers/{workerId}");
    expect(rulesSource).toContain("match /farm_worker_attendance/{attendanceId}");
    expect(rulesSource).toContain("match /farm_lost_animals/{lostAnimalId}");
  });

  it("adds the required farm composite indexes", () => {
    const groups = indexes.indexes.map(index => index.collectionGroup);
    expect(groups).toEqual(expect.arrayContaining([
      "farm_workers",
      "farm_cameras",
      "farm_animal_movements",
      "farm_daily_summaries",
    ]));
    const movementIndexes = indexes.indexes.filter(index => index.collectionGroup === "farm_animal_movements");
    expect(movementIndexes.some(index => index.fields.some(field => field.fieldPath === "detectedAt"))).toBe(true);
    expect(movementIndexes.some(index => index.fields.some(field => field.fieldPath === "animalTypeId"))).toBe(true);
  });

  it("supports Step 2 egg, attendance, inventory, feed, produce, sales, and expenses", () => {
    for (const value of [
      "farm_egg_collections",
      "farm_worker_attendance",
      "farm_inventory",
      "farm_feed_consumption",
      "farm_produce",
      "farm_sales",
      "farm_expenses",
      "farmOpenEggCount",
      "farmEstimateEggs",
      "farmOpenAttendance",
      "farmOpenInventory",
      "farmOpenFeed",
      "farmOpenProduce",
      "farmOpenSale",
      "farmOpenExpense",
      "OfflineManager.queueFarmEggCollection",
      "OfflineManager.queueFarmFeedConsumption",
      "faceEmbedding",
      "farmGenerateSummary",
    ]) {
      expect(indexSource).toContain(value);
    }
    for (const collection of [
      "farm_egg_collections",
      "farm_inventory",
      "farm_feed_consumption",
      "farm_produce",
      "farm_sales",
      "farm_expenses",
    ]) {
      expect(rulesSource).toContain(`match /${collection}/`);
      expect(indexes.indexes.some(index => index.collectionGroup === collection)).toBe(true);
    }
  });

  it("keeps Step 2 safety boundaries explicit", () => {
    expect(indexSource).toContain("Sale quantity exceeds available produce");
    expect(indexSource).toContain("Inventory cannot go below zero");
    expect(indexSource).toContain("Manual review is required");
    expect(indexSource).toContain("Produce requires an internet connection");
    expect(rulesSource).toContain("request.resource.data.quantityInStock >= 0");
    expect(rulesSource).toContain("request.resource.data.amountPaid <= request.resource.data.totalAmount");
    expect(offlineSource).toContain("oldVersion < 21");
  });

  it("supports the Step 3 dashboard, reports, analytics, staff, settings, and worker boundaries", () => {
    for (const value of [
      "farmDashboardMetrics",
      "farmDetailedAlerts",
      "farmActivityTimeline",
      "farmWorkerMobileHtml",
      "generateFarmReport",
      "farmReportData",
      "farmDownloadReportFormat",
      "farmOpenReports",
      "farmOpenAnalytics",
      "farmDestroyAnalyticsCharts",
      "farmOpenWorkerDetail",
      "farmOpenSettings",
      "farm_report_templates",
      "farm_director",
      "Last updated:",
      "Month to date",
    ]) {
      expect(indexSource).toContain(value);
    }
    expect(indexSource).toContain("farmState.farmChartInstances");
    expect(indexSource).toContain("data-farm-action=\"worker-checkin\"");
    expect(indexSource).toContain("data-farm-action=\"worker-checkout\"");
    expect(rulesSource).toContain("function isFarmReader()");
    expect(rulesSource).toContain("farmId in get(/databases/$(database)/documents/users/$(request.auth.uid)).data.farmIds");
    expect(rulesSource).toContain("match /farm_report_templates/{templateId}");
  });

  it("adds Step 3 reporting indexes for scoped operational filters", () => {
    const required = [
      ["farm_egg_collections", "sessionType"],
      ["farm_produce", "produceType"],
      ["farm_sales", "paymentStatus"],
      ["farm_expenses", "category"],
      ["farm_worker_attendance", "workerId"],
      ["farm_feed_consumption", "fedBy"],
    ] as const;
    for (const [collectionGroup, fieldPath] of required) {
      expect(indexes.indexes.some(index =>
        index.collectionGroup === collectionGroup
        && index.fields.some(field => field.fieldPath === fieldPath)
      )).toBe(true);
    }
  });
});