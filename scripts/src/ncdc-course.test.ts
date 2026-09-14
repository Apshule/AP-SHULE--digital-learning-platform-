import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const projectRoot = new URL("../../", import.meta.url);
const indexHtml = readFileSync(new URL("index.html", projectRoot), "utf8");
const startMarker = "const NCDC_MODULE_DEFINITIONS = [";
const endMarker = "const DEFAULT_SUBSCRIPTION_PLANS = [";
const start = indexHtml.indexOf(startMarker);
const end = indexHtml.indexOf(endMarker, start);

function loadNcdcHelpers() {
  if (start < 0 || end < 0) throw new Error("NCDC course helpers could not be located");
  const context = {
    window: {} as Record<string, unknown>,
    serverTimestamp: () => "SERVER_TIMESTAMP",
    navigator: { onLine: true },
    currentUser: null,
    db: null,
    Offline: null,
  };
  runInNewContext(`\n${indexHtml.slice(start, end)}`, context);
  return Object.assign({}, context, context.window) as Record<string, unknown>;
}

describe("NCDC course seed foundation", () => {
  it("creates ten module records and forty lesson records", () => {
    const helpers = loadNcdcHelpers();
    const records = (helpers.ncdcCourseSeedRecords as () => Array<Record<string, any>>)();
    expect(records).toHaveLength(50);
    expect(records.filter(record => record.kind === "module")).toHaveLength(10);
    expect(records.filter(record => record.kind === "lesson")).toHaveLength(40);
    expect(new Set(records.filter(record => record.kind === "module").map(record => record.data.moduleNumber)).size).toBe(10);
  });

  it("creates the required four lesson types and five-question quizzes per module", () => {
    const helpers = loadNcdcHelpers();
    const records = (helpers.ncdcCourseSeedRecords as () => Array<Record<string, any>>)();
    for (let moduleNumber = 1; moduleNumber <= 10; moduleNumber += 1) {
      const lessons = records
        .filter(record => record.kind === "lesson" && record.data.moduleNumber === moduleNumber)
        .map(record => record.data);
      expect(lessons.map(lesson => lesson.lessonType)).toEqual(["video", "pdf", "quiz", "practical"]);
      const quiz = lessons.find(lesson => lesson.lessonType === "quiz");
      expect(quiz?.contentData.questions).toHaveLength(5);
      expect(quiz?.contentData.passingScore).toBe(3);
    }
  });

  it("validates module and lesson boundaries", () => {
    const helpers = loadNcdcHelpers();
    const validateModule = helpers.validateNcdcModule as (value: object) => { valid: boolean; errors: string[] };
    const validateLesson = helpers.validateNcdcLesson as (value: object) => { valid: boolean; errors: string[] };
    expect(validateModule({ moduleNumber: 1, title: "Module", description: "Description", durationMinutes: 30 })).toEqual({ valid: true, errors: [] });
    expect(validateLesson({ moduleNumber: 1, lessonOrder: 3, lessonType: "quiz", title: "Quiz" })).toEqual({ valid: true, errors: [] });
    expect(validateModule({ moduleNumber: 11, title: "", description: "", durationMinutes: 0 }).valid).toBe(false);
    expect(validateLesson({ moduleNumber: 1, lessonOrder: 5, lessonType: "audio", title: "" }).valid).toBe(false);
  });
});

describe("NCDC course storage contracts", () => {
  it("declares the admin seed controls, Firestore collections, and indexes", () => {
    expect(indexHtml).toContain('id="superNcdcCourseSection"');
    expect(indexHtml).toContain('id="seedNcdcCourseBtn"');
    expect(indexHtml).toContain("ncdc_course_modules");
    expect(indexHtml).toContain("ncdc_module_lessons");
    expect(indexHtml).toContain("teacher_retooling_progress");
    expect(indexHtml).toContain("ncdc_cpd_certificates");
    const indexes = JSON.parse(readFileSync(new URL("firestore.indexes.json", projectRoot), "utf8"));
    const collections = indexes.indexes.map((index: { collectionGroup: string }) => index.collectionGroup);
    expect(collections).toEqual(expect.arrayContaining([
      "ncdc_course_modules",
      "ncdc_module_lessons",
      "teacher_retooling_progress",
      "ncdc_cpd_certificates",
    ]));
  });

  it("declares offline module and progress stores with sync APIs", () => {
    const source = readFileSync(new URL("offline-manager.js", projectRoot), "utf8");
    expect(source).toContain("var DB_VERSION = 21");
    expect(source).toContain("offline_ncdc_modules");
    expect(source).toContain("offline_teacher_progress");
    expect(source).toContain("cacheNcdcModules");
    expect(source).toContain("queueTeacherProgress");
    expect(source).toContain("markTeacherProgressSynced");
  });
});