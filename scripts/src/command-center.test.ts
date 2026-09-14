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

describe("Task 9 Step 1 command center contracts", () => {
  it("adds the superadmin-only five-tab command center", () => {
    expect(indexSource).toContain('id="superAdminCommandCenterPage"');
    expect(indexSource).toContain('data-command-section="dashboard"');
    expect(indexSource).toContain('data-command-section="users"');
    expect(indexSource).toContain('data-command-section="institutions"');
    expect(indexSource).toContain('data-command-section="analytics"');
    expect(indexSource).toContain('data-command-section="settings"');
    expect(indexSource).toContain("navigateSuperAdmin");
  });

  it("provides user and institution management surfaces", () => {
    for (const value of ["commandUsersList", "commandUserForm", "commandUserCsvInput", "commandInstitutionsList", "commandInstitutionForm"]) {
      expect(indexSource).toContain(`id="${value}"`);
    }
    expect(indexSource).toContain("createManagedAuthUser");
    expect(indexSource).toContain("sendPasswordResetEmail");
    expect(indexSource).toContain("institutionId");
  });

  it("provides institution branding editing, header integration, and offline cache", () => {
    expect(indexSource).toContain('id="institutionBrandingModal"');
    expect(indexSource).toContain("institution_branding");
    expect(indexSource).toContain("applyInstitutionBranding");
    expect(indexSource).toContain('id="headerInstitutionName"');
    expect(offlineSource).toContain("var DB_VERSION = 12");
    expect(offlineSource).toContain("offline_branding");
    expect(offlineSource).toContain("cacheInstitutionBranding");
    expect(offlineSource).toContain("offline_command_stats");
    expect(offlineSource).toContain("cacheCommandStats");
  });

  it("adds the requested command center indexes and scoped collections", () => {
    const groups = indexes.indexes.map(index => index.collectionGroup);
    expect(groups).toEqual(expect.arrayContaining(["users", "institutions", "institution_branding"]));
    expect(rulesSource).toContain("match /institution_branding/{brandingId}");
    expect(rulesSource).toContain("match /institutions/{institutionId}");
  });
});