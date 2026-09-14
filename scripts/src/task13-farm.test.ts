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
    expect(offlineSource).toContain("var DB_VERSION = 19");
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
});