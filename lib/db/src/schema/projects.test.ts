import assert from "node:assert/strict";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  PROJECT_REQUIRED_FIELDS,
  createProjectRecord,
  computeTextSimilarity,
  generateProjectLin,
  getCurrentTermLabel,
  getProjectMilestoneUploadError,
  normalizeProjectTitle,
  projectsTable,
  validateProjectFields,
} from "./projects";

const completeProject = {
  learnerId: "learner-1",
  learnerName: "Learner One",
  schoolId: "school-1",
  className: "S2A",
  subject: "Mathematics",
  title: "Water conservation",
  lin: "APSHULE-school-1",
  qrCode: "APSHULE-PROJECT-project-1",
  createdAt: new Date(),
  updatedAt: new Date(),
};

assert.deepEqual(validateProjectFields({}), [...PROJECT_REQUIRED_FIELDS]);
assert.deepEqual(validateProjectFields({ ...completeProject, title: "   " }), ["title"]);
assert.deepEqual(validateProjectFields(completeProject), []);

const createdProject = createProjectRecord({
  id: "project-1",
  learnerId: "learner-1",
  learnerName: " ",
  schoolId: "school-1",
  className: "S2A",
  subject: "Mathematics",
  title: "Water conservation",
  lin: "APSHULE-school-1",
  qrCode: "APSHULE-PROJECT-project-1",
  previousTitleCheck: true,
});
assert.equal(createdProject.learnerName, "learner-1");
assert.equal(createdProject.milestone1Status, "not_started");
assert.equal(createdProject.finalStatus, "not_started");
assert.equal(generateProjectLin("school 12", "learner-abcdef", 2026), "APSH-SCHOOL-2026-ABCDEF");
assert.equal(getProjectMilestoneUploadError(createdProject, "2"), "Complete Milestone 1 first");
assert.equal(getProjectMilestoneUploadError({
  ...createdProject,
  milestone1Status: "approved",
  milestone1Photo: "photo",
  milestone2Status: "pending",
  milestone2Photo: "photo",
}, "2"), "This milestone is awaiting teacher approval");
assert.equal(getProjectMilestoneUploadError({
  ...createdProject,
  milestone1Status: "approved",
  milestone1Photo: "photo",
  milestone2Status: "approved",
  milestone2Photo: "photo",
}, "2"), "Approved milestones are read-only");
assert.equal(createdProject.previousTitleCheck, true);
assert.deepEqual(createdProject.photoHashes, []);
assert.equal(createdProject.createdAt, createdProject.updatedAt);
assert.equal(createdProject.term, getCurrentTermLabel(createdProject.createdAt));
assert.equal(createdProject.titleNormalized, "water conservation");
assert.equal(normalizeProjectTitle("  Water   Conservation "), "water conservation");
assert.ok(computeTextSimilarity("Solar cooker for school", "solar cooker for a school") > 0.7);
assert.equal(computeTextSimilarity("Maths", "Agriculture"), 0);

const table = getTableConfig(projectsTable);
const columns = new Set(table.columns.map((column) => column.name));
const indexes = new Set(table.indexes.map((index) => index.config.name));

for (const column of [
  "learner_name",
  "description",
  "term",
  "title_normalized",
  "qr_data_url",
  "qr_storage_url",
  "qr_payload",
  "qr_generated_at",
  "milestone_1_comment",
  "milestone_1_uploaded_at",
  "milestone_1_approved_at",
  "milestone_1_rejected_at",
  "milestone_2_comment",
  "milestone_2_uploaded_at",
  "milestone_2_approved_at",
  "milestone_2_rejected_at",
  "final_comment",
  "final_uploaded_at",
  "final_approved_at",
  "final_rejected_at",
  "completed_at",
  "viva_audio_uploaded_at",
  "viva_audio_milestone",
  "verified_by",
  "verified_at",
  "similarity_match_id",
  "similarity_reason",
  "similarity_score",
  "previous_title_match",
  "previous_title",
  "previous_term",
  "improvement_note",
  "previous_project_id",
  "photo_hashes",
  "school_gps_lat",
  "school_gps_lng",
  "device_type",
  "uploaded_from_connection",
  "cleared_by",
  "cleared_at",
  "updated_at",
]) {
  assert.ok(columns.has(column), `Missing project column: ${column}`);
}

for (const index of [
  "projects_learner_created_at_idx",
  "projects_learner_term_idx",
  "projects_school_class_subject_idx",
  "projects_school_term_created_at_idx",
  "projects_school_similarity_flag_idx",
]) {
  assert.ok(indexes.has(index), `Missing project index: ${index}`);
}

console.log("Project integrity schema checks passed");