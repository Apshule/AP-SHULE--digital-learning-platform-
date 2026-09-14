import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const projectRoot = new URL("../../", import.meta.url);
const indexHtml = readFileSync(new URL("index.html", projectRoot), "utf8");
const startMarker = "// ===== CURRICULUM LINKS DATA FOUNDATION =====";
const endMarker = "// ===== NCDC / UNEB PHASE 1 TOOLS =====";
const start = indexHtml.indexOf(startMarker);
const end = indexHtml.indexOf(endMarker, start);

if (start < 0 || end < 0) {
  throw new Error("Curriculum Linker helpers could not be located in index.html");
}

function loadCurriculumHelpers() {
  const context: { window: Record<string, unknown> } = { window: {} };
  const escaper = `
    function escHtml(value) {
      return String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/'/g,'&#39;').replace(/"/g,'&quot;');
    }
  `;
  runInNewContext(`${escaper}\n${indexHtml.slice(start, end)}`, context);
  return context.window;
}

describe("curriculum keyword generation", () => {
  it("generates the documented Photosynthesis keywords", () => {
    const helpers = loadCurriculumHelpers();
    expect((helpers.generateSearchKeywords as (...args: string[]) => string[])(
      "Photosynthesis",
      "Biology",
      "S2",
    )).toEqual(["photosynthesis", "biology", "s2", "photo", "synthesis"]);
  });

  it("removes stop words and duplicate keywords", () => {
    const helpers = loadCurriculumHelpers();
    const keywords = (helpers.generateSearchKeywords as (...args: string[]) => string[])(
      "The Parts and Parts",
      "Science",
      "P5",
    );
    expect(keywords).toEqual(["parts", "science", "p5"]);
  });
});

describe("curriculum record validation", () => {
  it("accepts a complete record and returns the required result shape", () => {
    const helpers = loadCurriculumHelpers();
    const validate = helpers.validateCurriculumRecord as (record: object) => { valid: boolean; errors: string[] };
    expect(validate({
      subject: "Mathematics",
      classLevel: "P5",
      topic: "Fractions",
      syllabusRef: "",
      learnerBookPage: "",
      teacherGuidePage: "",
      summaryText: "Parts of a whole.",
      activitySuggestion: "Use paper circles.",
    })).toEqual({ valid: true, errors: [] });
  });

  it("reports missing fields, invalid class levels, and length limits", () => {
    const helpers = loadCurriculumHelpers();
    const validate = helpers.validateCurriculumRecord as (record: object) => { valid: boolean; errors: string[] };
    const result = validate({
      subject: "",
      classLevel: "P8",
      topic: "",
      summaryText: "x".repeat(2001),
      activitySuggestion: "x".repeat(1001),
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      "subject is required",
      "topic is required",
      "syllabusRef field is required",
      "summaryText must be 2000 characters or less",
      "activitySuggestion must be 1000 characters or less",
      "classLevel must match P1-P7 or S1-S6",
    ]));
  });
});

describe("curriculum import fixtures", () => {
  it("parses quoted CSV values containing commas", () => {
    const helpers = loadCurriculumHelpers();
    const parse = helpers.parseCurriculumCsv as (text: string) => Array<Record<string, string>>;
    const rows = parse([
      "subject,classLevel,topic,syllabusRef,learnerBookPage,teacherGuidePage,summaryText,activitySuggestion",
      'Mathematics,P5,Fractions,"Syllabus, page 34",Book 56,Guide 42,"Parts of a whole.","Use paper circles."',
    ].join("\n"));
    expect(rows).toHaveLength(1);
    expect(rows[0].syllabusRef).toBe("Syllabus, page 34");
    expect(rows[0].topic).toBe("Fractions");
  });

  it("keeps exactly the ten required sample topics valid", () => {
    const helpers = loadCurriculumHelpers();
    const samples = helpers.curriculumSampleTopics as Array<Record<string, unknown>>;
    const validate = helpers.validateCurriculumRecord as (record: object) => { valid: boolean; errors: string[] };
    expect(samples).toHaveLength(10);
    expect(samples.every((sample) => validate(sample).valid)).toBe(true);
    expect(samples.map((sample) => sample.topic)).toContain("Newton’s Laws");
  });
});

describe("offline curriculum cache contract", () => {
  it("declares the bounded IndexedDB store and cache API", () => {
    const source = readFileSync(new URL("offline-manager.js", projectRoot), "utf8");
    expect(source).toContain("offline_curriculum_links");
    expect(source).toContain("if (links.length > 2000)");
    expect(source).toContain("listCurriculumLinks");
  });
});