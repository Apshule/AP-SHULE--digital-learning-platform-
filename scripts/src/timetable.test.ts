import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd(), "..");
const indexSource = readFileSync(resolve(root, "index.html"), "utf8");
const offlineSource = readFileSync(resolve(root, "offline-manager.js"), "utf8");
const manifestSource = readFileSync(resolve(root, "manifest.json"), "utf8");
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

describe("Task 15 bug fixes", () => {
  it("keeps one balanced hero logo and responsive sizing rules", () => {
    expect((indexSource.match(/class="landing-hero-image"/g) ?? [])).toHaveLength(1);
    expect(indexSource).toContain("object-fit:contain");
    expect(indexSource).toContain("transform:none");
    expect(indexSource).toContain("@media(max-width:499px)");
  });

  it("auto-hides the responsive demo notice once per session", () => {
    expect(indexSource).toContain('id="responsiveDemoNotice"');
    expect(indexSource).toContain("apshuleResponsiveDemoNoticeSeen");
    expect(indexSource).toContain("}, 10000);");
    expect(indexSource).toContain("responsiveNotice.style.display = 'none'");
    expect(indexSource).not.toContain("54000");
  });

  it("uses browser history for pages, modals, and back-button restoration", () => {
    expect(indexSource).toContain("window.appHistory");
    expect(indexSource).toContain("history.pushState");
    expect(indexSource).toContain("addEventListener('popstate'");
    expect(indexSource).toContain("apshulehistorychange");
    expect(indexSource).toContain("_appHistoryRestoring");
  });

  it("supports closing the sync popover by control, backdrop, escape, and back", () => {
    expect(indexSource).toContain('id="globalSyncPopoverCloseBtn"');
    expect(indexSource).toContain("closeGlobalSyncPopover");
    expect(indexSource).toContain("!popover.contains(event.target)");
    expect(indexSource).toContain("element.id === 'globalSyncPopover'");
    expect(indexSource).toContain('aria-expanded="false"');
  });

  it("keeps online and pending indicators distinct", () => {
    expect(indexSource).toContain('data-online="false"');
    expect(indexSource).toContain("title=navigator.onLine ? 'Online' : 'Offline'");
    expect(indexSource).toContain("Pending items: ${pending}");
    expect(indexSource).toContain("data-syncing");
    expect(indexSource).toContain("@keyframes syncOnlinePulse");
  });

  it("renders contextual availability messages beside the tapped item", () => {
    expect(indexSource).toContain("function showContextualMessage");
    expect(indexSource).toContain("apshule-contextual-message");
    expect(indexSource).toContain("No video for");
    expect(indexSource).toContain("Video unavailable offline");
    expect(indexSource).toContain("PDF not available");
    expect(indexSource).toContain("Meeting link not available yet");
  });

  it("opens every subscription plan in the Yo payment flow", () => {
    expect(indexSource).toContain('id="subscriptionPayModal"');
    expect(indexSource).toContain("data-plan-cycle");
    for (const plan of ["Daily", "Weekly", "Monthly", "Term Plan", "Half Year", "Full Year"]) {
      expect(indexSource).toContain(plan);
    }
    expect(indexSource).toContain("function submitSubscriptionPayment");
    expect(indexSource).toContain("api('/api/payments/initiate'");
    expect(indexSource).toContain("Please contact your school admin to subscribe");
    expect(indexSource).not.toContain("Online payment is coming soon");
  });
});

describe("APSHULE branding consistency", () => {
  it("uses the approved brand metadata and PWA name", () => {
    expect(indexSource).toContain("<title>APSHULE - Digital Learning Platform</title>");
    expect(indexSource).toContain('meta property="og:title"       content="APSHULE"');
    expect(indexSource).toContain('meta name="description" content="APSHULE is a multi-sector platform for education, microfinance, clinic, and farming management in Uganda."');
    expect(manifestSource).toContain('"name": "APSHULE"');
    expect(manifestSource).toContain('"short_name": "APSHULE"');
    expect(indexSource).toContain('content="https://appshule.com/"');
  });

  it("removes spaced and mixed-case user-facing brand variants", () => {
    expect(indexSource).not.toMatch(/\bAP SHULE\b/);
    expect(indexSource).not.toMatch(/\b(?:Apshule|ApShule)\b/);
    expect(indexSource).toContain("APSHULE Digital Learning Platform");
    expect(indexSource).toContain('id="appTagline"');
    expect(indexSource).toContain("Let's Learn With Ease From Anywhere at Anytime");
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