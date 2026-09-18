import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const appSource = readFileSync(resolve(root, "education/app.js"), "utf8");
const responsiveStyles = readFileSync(resolve(root, "education/secondary-responsive.css"), "utf8");

function sectionBetween(source: string, start: string, end: string) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("Secondary report-card preview contract", () => {
  it("keeps all three curriculum column structures visible", () => {
    const reportTableSection = sectionBetween(appSource, "function reportTable", "function secondaryReportDetailView");
    const requiredHeaders = [
      ["Subject", "A1", "U1", "Avg/3", "/100", "Grade", "Level"],
      ["Subject", "U1", "U2", "U3", "U4", "AVE", "Pts", "Total/20", "MT", "EOT", "Total 100%", "Grade", "Remark"],
      ["Code", "Subject", "A1", "A2", "A3", "AVG", "20%", "EOT", "80%", "100%", "Grade", "Comment", "TR"],
    ];

    for (const headers of requiredHeaders) {
      for (const header of headers) expect(reportTableSection).toContain(`<th>${header}</th>`);
    }
    expect((reportTableSection.match(/class="report-table-wrap"/g) ?? []).length).toBe(3);
  });

  it("keeps secondary navigation separate from primary and finance-only modules", () => {
    const secondaryNavSection = sectionBetween(appSource, "const secondaryNavItems", "const bursarNavItems");
    expect(secondaryNavSection).toContain('"report-cards"');
    expect(secondaryNavSection).toContain('"marks"');
    expect(secondaryNavSection).toContain('"print-settings"');
    expect(secondaryNavSection).not.toContain('"id-cards"');
    expect(secondaryNavSection).not.toContain("bursar");
    expect(appSource).toContain("Secondary-only access boundary");
    expect(appSource).toContain("× Finance and payroll");
  });

  it("keeps every print-settings step and validation guard", () => {
    expect(appSource).toContain('const steps = ["Template", "Positions", "Activities", "Details", "Review"]');
    expect(appSource).toContain("Choose report template");
    expect(appSource).toContain("Include student positions?");
    expect(appSource).toContain("Select activities to show");
    expect(appSource).toContain("Report details");
    expect(appSource).toContain("Ready to preview and print");
    expect(appSource).toContain("state.printSettings.activities.length === 0");
    expect(appSource).toContain("Add a report title and class-teacher initials.");
    expect(appSource).toContain("window.print()");
  });

  it("keeps wide report tables usable at mobile widths", () => {
    expect(responsiveStyles).toContain(".report-table-wrap");
    expect(responsiveStyles).toContain("overflow-x:auto");
    expect(appSource).toContain('<div class="report-table-wrap"><table class="report-table wide">');
  });
});