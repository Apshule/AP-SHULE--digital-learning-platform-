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

describe("Secondary report-card live contract", () => {
  it("does not render hard-coded curriculum rows or fake report details", () => {
    expect(appSource).not.toContain("function reportTable");
    expect(appSource).not.toContain("Preview Learner");
    expect(appSource).not.toContain("Division 2");
    expect(appSource).toContain('function secondaryReportsView');
    expect(appSource).toContain("function reportPreviewView");
    expect(appSource).toContain("Download CSV");
  });

  it("keeps secondary navigation separate from primary and finance-only modules", () => {
    const secondaryNavSection = sectionBetween(appSource, "const secondaryNavItems", "const bursarNavItems");
    expect(secondaryNavSection).toContain('"report-cards"');
    expect(secondaryNavSection).toContain('"marks"');
    expect(secondaryNavSection).toContain('"print-settings"');
    expect(secondaryNavSection).not.toContain('"id-cards"');
    expect(secondaryNavSection).not.toContain("bursar");
    expect(appSource).not.toContain("Secondary-only access boundary");
    expect(appSource).not.toContain("× Finance and payroll");
  });

  it("keeps every print-settings step and validation guard", () => {
    expect(appSource).toContain('const steps = ["Template", "Positions", "Activities", "Details", "Review"]');
    expect(appSource).toContain("Choose report template");
    expect(appSource).toContain("Include student positions?");
    expect(appSource).toContain("Select activities to show");
    expect(appSource).toContain("Report details");
    expect(appSource).toContain("Ready to print");
    expect(appSource).toContain("state.printSettings.activities.length === 0");
    expect(appSource).toContain("Add a report title and class-teacher initials.");
    expect(appSource).toContain("window.print()");
    expect(appSource).toContain('id="markEntryForm"');
    expect(appSource).toContain('id="reportBuilderForm"');
    expect(appSource).toContain("/api/school/academic/marks");
  });

  it("keeps the live records table responsive at mobile widths", () => {
    expect(responsiveStyles).toContain(".report-table-wrap");
    expect(responsiveStyles).toContain("overflow-x:auto");
    expect(appSource).toContain('function secondaryMarksView');
    expect(appSource).toContain('function secondaryReportsView');
  });
});