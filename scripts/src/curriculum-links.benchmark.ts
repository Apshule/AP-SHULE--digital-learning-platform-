import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { performance } from "node:perf_hooks";

const projectRoot = new URL("../../", import.meta.url);
const indexHtml = readFileSync(new URL("index.html", projectRoot), "utf8");
const startMarker = "// ===== CURRICULUM LINKS DATA FOUNDATION =====";
const endMarker = "// ===== NCDC / UNEB PHASE 1 TOOLS =====";
const start = indexHtml.indexOf(startMarker);
const end = indexHtml.indexOf(endMarker, start);

if (start < 0 || end < 0) throw new Error("Curriculum Linker helpers could not be located");

const context: { window: Record<string, unknown>; currentUser: null } = {
  window: {},
  currentUser: null,
};
runInNewContext(indexHtml.slice(start, end), context);
const helpers = Object.assign({}, context, context.window) as {
  rankCurriculumLinks: (
    records: Array<Record<string, unknown>>,
    query: string,
    options?: Record<string, string>,
  ) => Array<Record<string, unknown>>;
};

const records = Array.from({ length: 2_000 }, (_, index) => ({
  id: `topic-${index}`,
  topic: index % 7 === 0 ? `Photosynthesis ${index}` : `Topic ${index}`,
  subject: index % 2 === 0 ? "Biology" : "Science",
  classLevel: index % 3 === 0 ? "S2" : "S3",
  summaryText: "A locally relevant curriculum topic for performance testing.",
}));

const rank = helpers.rankCurriculumLinks;
const measure = (fn: () => unknown, iterations = 1) => {
  const startTime = performance.now();
  let value: unknown;
  for (let index = 0; index < iterations; index += 1) value = fn();
  return { milliseconds: (performance.now() - startTime) / iterations, value };
};

const cold = measure(() => {
  const loaded = JSON.parse(JSON.stringify(records)) as Array<Record<string, unknown>>;
  return rank(loaded, "photosynthesis", { subject: "Biology", classLevel: "S2" });
});
const warm = measure(
  () => rank(records, "photosynthesis", { subject: "Biology", classLevel: "S2" }),
  50,
);
const offline = measure(
  () => rank(records, "photosynthesis", { subject: "Biology", classLevel: "S2" }),
  50,
);

const result = {
  dataset: records.length,
  coldSearchMs: Number(cold.milliseconds.toFixed(2)),
  warmSearchMeanMs: Number(warm.milliseconds.toFixed(2)),
  offlineSearchMeanMs: Number(offline.milliseconds.toFixed(2)),
  matchingTopics: Array.isArray(cold.value) ? cold.value.length : 0,
  thresholds: {
    coldSearchMs: "< 2000",
    warmSearchMeanMs: "< 300",
    offlineSearchMeanMs: "< 500",
  },
  passed:
    cold.milliseconds < 2_000 &&
    warm.milliseconds < 300 &&
    offline.milliseconds < 500,
};

console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;