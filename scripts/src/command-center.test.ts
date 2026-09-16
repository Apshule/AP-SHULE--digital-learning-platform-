import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const indexSource = readFileSync(resolve(root, "index.html"), "utf8");
const serviceWorkerSource = readFileSync(resolve(root, "sw.js"), "utf8");
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
    expect(offlineSource).toContain("var DB_VERSION = 24");
    expect(offlineSource).toContain("offline_branding");
    expect(offlineSource).toContain("cacheInstitutionBranding");
    expect(offlineSource).toContain("offline_command_stats");
    expect(offlineSource).toContain("cacheCommandStats");
  });

  it("adds the requested command center indexes and scoped collections", () => {
    const groups = indexes.indexes.map(index => index.collectionGroup);
    expect(groups).toEqual(expect.arrayContaining([
      "users",
      "institutions",
      "institution_branding",
      "transactions",
      "subscriptions",
      "notifications",
      "liveLessons",
      "ca_exports",
      "cpd_certificates",
    ]));
    expect(rulesSource).toContain("match /institution_branding/{brandingId}");
    expect(rulesSource).toContain("match /institutions/{institutionId}");
    expect(rulesSource).toContain("match /transactions/{transactionId}");
    expect(rulesSource).toContain("match /ca_exports/{exportId}");
  });

  it("adds Step 2 quick actions and management modules", () => {
    for (const action of ["ncdc", "live", "announce", "reports"]) {
      expect(indexSource).toContain(`data-command-action="${action}"`);
    }
    for (const module of ["Video Library", "PDF Library", "UNEB Items", "Curriculum Links", "Subjects & Classes", "Payments & Subscriptions", "NCDC / UNEB Control", "Live Lesson Control", "Communication"]) {
      expect(indexSource).toContain(module);
    }
    for (const contract of ["renderCommandContentTab", "renderCommandPaymentsTab", "renderCommandNcdcTab", "renderCommandLiveTab", "renderCommandCommunicationTab", "commandOfflineMessage", "Step 3 reports"]) {
      expect(indexSource).toContain(contract);
    }
  });

  it("keeps Command Center taps from being intercepted by stale overlays", () => {
    expect(indexSource).toContain("function closeCommandBlockingLayers");
    expect(indexSource).toContain("document.getElementById('globalSearchOverlay')?.classList.remove('show')");
    expect(indexSource).toContain("document.getElementById('drawerOverlay')?.classList.remove('show')");
    expect(indexSource).toContain("document.querySelectorAll('.command-fullscreen-modal.show')");
    expect(indexSource).toContain("seedMfiLoanProductsBtn')?.addEventListener('click',mfiSeedLoanProducts");
  });

  it("keeps Command Center metrics backed by current and legacy records", () => {
    for (const value of ["payment_transactions", "transactions", "clinic_payments", "audit_logs", "commandAlerts", "commandUniqueRows", "commandLoad"]) {
      expect(indexSource).toContain(value);
    }
    expect(indexSource).toContain("New platform events will appear here.");
    expect(indexSource).toContain("No critical platform alerts.");
  });

  it("forces installed phones to refresh the released app shell", () => {
    expect(serviceWorkerSource).toContain("appshule-offline-v6");
    expect(indexSource).toContain('register("/sw.js?v=20260915-6"');
    expect(indexSource).toContain("scope: \"/\"");
  });

  it("routes normalized role profiles to their sector bootstrap", () => {
    for (const role of ["super_admin", "school_admin", "student", "mfi admin", "clinic admin", "farm admin"]) {
      expect(indexSource).toContain(`'${role}'`);
    }
    for (const contract of ["function normalizeAppRole", "function profileRole", "function routeAuthenticatedUser", "isClinicRole()", "isFarmRole()", "document.getElementById('adminMenuItem')?.click()"]) {
      expect(indexSource).toContain(contract);
    }
    expect(indexSource).toContain("role==='teacher'?'teacher':'home'");
    expect(indexSource.indexOf("function isFarmRole")).toBeLessThan(indexSource.indexOf("function routeAuthenticatedUser"));
  });

  it("adds Step 3 analytics, settings, security, and hidden support tools", () => {
    for (const value of [
      "commandAnalyticsRange",
      "commandAnalyticsSummary",
      "commandPlatformSettingsBody",
      "settings','platform",
      "securityModal",
      "securityTabs",
      "audit_logs",
      "support_preview",
      "debugPanelModal",
      "commandAnnouncementPreview",
      "aggregateCommandAnalytics",
      "exportCommandReport",
      "logSuperAdminAction",
    ]) {
      expect(indexSource).toContain(value);
    }
    expect(indexSource).toContain("cached for 5 minutes");
    expect(indexSource).toContain("Secret values are never requested");
  });

  it("adds the Step 3 security indexes and superadmin rules", () => {
    const requiredIndexes: Array<[string, string[]]> = [
      ["audit_logs", ["userId", "createdAt"]],
      ["audit_logs", ["action", "createdAt"]],
      ["failed_logins", ["email", "timestamp"]],
      ["active_sessions", ["userId", "lastActivityAt"]],
      ["data_subject_requests", ["type", "createdAt"]],
    ];
    for (const [collectionGroup, fields] of requiredIndexes) {
      expect(indexes.indexes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          collectionGroup,
          fields: fields.map((fieldPath, index) => ({
            fieldPath,
            order: index === fields.length - 1 ? "DESCENDING" : "ASCENDING",
          })),
        }),
      ]));
    }
    for (const collection of ["audit_logs", "failed_logins", "active_sessions", "data_subject_requests"]) {
      expect(rulesSource).toContain(`match /${collection}/`);
    }
    expect(rulesSource).toContain("settingId == 'about'");
  });
});