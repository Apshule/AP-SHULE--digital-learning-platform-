import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const indexSource = readFileSync(resolve(root, "index.html"), "utf8");

describe("sector isolation contracts", () => {
  it("maps every Farm role to an explicit display label", () => {
    expect(indexSource).toContain("function appRoleLabel(role)");
    for (const role of ["farm_admin:'Farm Admin'", "farm_manager:'Farm Manager'", "farm_worker:'Farm Worker'", "farm_director:'Farm Director'"]) {
      expect(indexSource).toContain(role);
    }
    expect(indexSource).toContain("${escHtml(appRoleLabel(currentUser.role))}");
  });

  it("keeps the standard education surface behind an education-sector guard", () => {
    expect(indexSource).toContain("function isEducationRole(role=currentUser?.role)");
    expect(indexSource).toContain("const showEducationUi = isEducation || isSuper;");
    for (const selector of [
      ".education-level",
      "#studentVideoTutorialsSection",
      "#studentCbcSection",
      ".payment-plans-section",
      "#videoDownloadsSection",
    ]) {
      expect(indexSource).toContain(selector);
    }
    expect(indexSource).toContain("if(currentUser && !isEducationRole() && ['home','resources','timetable','teacher','live','admission'].includes(pageId))");
  });

  it("does not show admission or lesson Q&A cards to non-Education users", () => {
    expect(indexSource).toContain("const isStudent = currentUser.role === 'individual';");
    expect(indexSource).toContain("if(questionsCard) questionsCard.style.display = showEducationUi ? '' : 'none';");
    expect(indexSource).toContain("if(admShortcut) admShortcut.style.display = isStudent ? \"block\" : \"none\";");
  });

  it("filters notifications by role, institution, and sector before rendering", () => {
    expect(indexSource).toContain("function notificationMatchesCurrentUser(notification)");
    expect(indexSource).toContain("const targetInstitutionId=notification?.targetInstitutionId || notification?.institutionId;");
    expect(indexSource).toContain(".filter(notificationMatchesCurrentUser)");
    expect(indexSource).toContain("const sector=notificationSector(notification);");
  });

  it("writes sector metadata for announcements and operational notifications", () => {
    for (const value of [
      "id=\"commandAnnouncementSector\"",
      "id=\"announcementSector\"",
      "sector:'mfi'",
      "sector:'clinic'",
      "sector:'education'",
      "function notificationWriteSector(type, options={})",
      "s.sector && s.sector!=='all'",
      "legacyEducationText",
      "data-mfi-section=\"notifications\"",
      "data-farm-page=\"${page}\"",
    ]) {
      expect(indexSource).toContain(value);
    }
  });
});