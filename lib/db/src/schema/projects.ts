import { desc } from "drizzle-orm";
import { boolean, doublePrecision, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const projectsTable = pgTable("projects", {
  id: text("id").primaryKey(),
  learnerId: text("learner_id").notNull(),
  learnerName: text("learner_name").notNull().default(""),
  schoolId: text("school_id").notNull(),
  className: text("class_name").notNull(),
  subject: text("subject").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  term: text("term"),
  titleNormalized: text("title_normalized"),
  lin: text("lin"),
  qrCode: text("qr_code"),
  qrDataUrl: text("qr_data_url"),
  qrStorageUrl: text("qr_storage_url"),
  qrPayload: text("qr_payload"),
  qrGeneratedAt: timestamp("qr_generated_at", { withTimezone: true }),
  milestone1Date: timestamp("milestone_1_date", { withTimezone: true }),
  milestone1Photo: text("milestone_1_photo"),
  milestone1Status: text("milestone_1_status").notNull().default("not_started"),
  milestone1Comment: text("milestone_1_comment"),
  milestone1UploadedAt: timestamp("milestone_1_uploaded_at", { withTimezone: true }),
  milestone1ApprovedAt: timestamp("milestone_1_approved_at", { withTimezone: true }),
  milestone1RejectedAt: timestamp("milestone_1_rejected_at", { withTimezone: true }),
  milestone2Date: timestamp("milestone_2_date", { withTimezone: true }),
  milestone2Photo: text("milestone_2_photo"),
  milestone2Status: text("milestone_2_status").notNull().default("not_started"),
  milestone2Comment: text("milestone_2_comment"),
  milestone2UploadedAt: timestamp("milestone_2_uploaded_at", { withTimezone: true }),
  milestone2ApprovedAt: timestamp("milestone_2_approved_at", { withTimezone: true }),
  milestone2RejectedAt: timestamp("milestone_2_rejected_at", { withTimezone: true }),
  finalDate: timestamp("final_date", { withTimezone: true }),
  finalPhoto: text("final_photo"),
  finalStatus: text("final_status").notNull().default("not_started"),
  finalComment: text("final_comment"),
  finalUploadedAt: timestamp("final_uploaded_at", { withTimezone: true }),
  finalApprovedAt: timestamp("final_approved_at", { withTimezone: true }),
  finalRejectedAt: timestamp("final_rejected_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  teacherObservedTick: boolean("teacher_observed_tick").notNull().default(false),
  vivaAudioPath: text("viva_audio_path"),
  vivaAudioUploadedAt: timestamp("viva_audio_uploaded_at", { withTimezone: true }),
  vivaAudioMilestone: text("viva_audio_milestone"),
  verifiedBy: text("verified_by"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  similarityFlag: boolean("similarity_flag").notNull().default(false),
  similarityMatchId: text("similarity_match_id"),
  similarityReason: text("similarity_reason"),
  similarityScore: doublePrecision("similarity_score"),
  previousTitleCheck: boolean("previous_title_check").notNull().default(false),
  previousTitleMatch: boolean("previous_title_match").notNull().default(false),
  previousTitle: text("previous_title"),
  previousTerm: text("previous_term"),
  improvementNote: text("improvement_note"),
  previousProjectId: text("previous_project_id"),
  photoHashes: text("photo_hashes").array().notNull().default([]),
  clearedBy: text("cleared_by"),
  clearedAt: timestamp("cleared_at", { withTimezone: true }),
  schoolGpsLat: doublePrecision("school_gps_lat"),
  schoolGpsLng: doublePrecision("school_gps_lng"),
  deviceType: text("device_type"),
  uploadedFromConnection: text("uploaded_from_connection"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
   index("projects_learner_created_at_idx").on(table.learnerId, desc(table.createdAt)),
   index("projects_learner_term_idx").on(table.learnerId, table.term),
  index("projects_school_class_subject_idx").on(table.schoolId, table.className, table.subject),
   index("projects_school_term_created_at_idx").on(table.schoolId, table.term, desc(table.createdAt)),
  index("projects_school_similarity_flag_idx").on(table.schoolId, table.similarityFlag),
]);

export const insertProjectSchema = createInsertSchema(projectsTable).omit({
  createdAt: true,
  updatedAt: true,
});
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Project = typeof projectsTable.$inferSelect;

export function getCurrentTermLabel(date = new Date()): string {
  const month = date.getMonth() + 1;
  const term = month <= 4 ? "T1" : month <= 8 ? "T2" : "T3";
  return `${date.getFullYear()}-${term}`;
}

export function normalizeProjectTitle(value: string): string {
  return value.toLowerCase().trim().replace(/\s+/g, " ");
}

export function computeTextSimilarity(text1: string, text2: string): number {
  const tokenize = (value: string) => normalizeProjectTitle(value)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  const vector = (value: string) => tokenize(value).reduce<Record<string, number>>((map, word) => {
    map[word] = (map[word] ?? 0) + 1;
    return map;
  }, {});
  const left = vector(text1);
  const right = vector(text2);
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (const key of keys) {
    const a = left[key] ?? 0;
    const b = right[key] ?? 0;
    dot += a * b;
    leftMagnitude += a * a;
    rightMagnitude += b * b;
  }
  if (!leftMagnitude || !rightMagnitude) return 0;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

export function generateProjectLin(
  schoolId: string,
  learnerId: string,
  year = new Date().getUTCFullYear(),
): string {
  const schoolCode = schoolId.replace(/[^a-z0-9]/gi, "").slice(0, 6).toUpperCase() || "SCHOOL";
  const learnerCode = learnerId.slice(-6).toUpperCase() || "STUDENT";
  return `APSH-${schoolCode}-${year}-${learnerCode}`;
}

export function getProjectMilestoneUploadError(
  project: Pick<Project, "milestone1Status" | "milestone1Photo" | "milestone2Status" | "milestone2Photo" | "finalStatus" | "finalPhoto">,
  milestone: string,
): string | null {
  const status = milestone === "1"
    ? project.milestone1Status
    : milestone === "2"
      ? project.milestone2Status
      : project.finalStatus;
  const photo = milestone === "1"
    ? project.milestone1Photo
    : milestone === "2"
      ? project.milestone2Photo
      : project.finalPhoto;
  if (status === "approved") return "Approved milestones are read-only";
  if (status === "pending" && photo) return "This milestone is awaiting teacher approval";
  if (milestone === "2" && project.milestone1Status !== "approved") return "Complete Milestone 1 first";
  if ((milestone === "3" || milestone === "final") && project.milestone2Status !== "approved") return "Complete Milestone 2 first";
  return null;
}

export type CreateProjectRecordInput = Pick<
  Project,
  "id" | "learnerId" | "schoolId" | "className" | "subject" | "title" | "lin" | "qrCode"
> & {
  learnerName?: string | null;
  description?: string | null;
  term?: string | null;
  titleNormalized?: string | null;
  qrDataUrl?: string | null;
  qrStorageUrl?: string | null;
  qrPayload?: string | null;
  qrGeneratedAt?: Date | null;
  previousTitleCheck?: boolean;
  previousTitleMatch?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
};

export function createProjectRecord(input: CreateProjectRecordInput): Project {
  const createdAt = input.createdAt ?? new Date();
  return {
    id: input.id,
    learnerId: input.learnerId,
    learnerName: input.learnerName?.trim() || input.learnerId,
    schoolId: input.schoolId,
    className: input.className,
    subject: input.subject,
    title: input.title,
    description: input.description ?? null,
    term: input.term ?? getCurrentTermLabel(createdAt),
    titleNormalized: input.titleNormalized ?? normalizeProjectTitle(input.title),
    lin: input.lin,
    qrCode: input.qrCode,
    qrDataUrl: input.qrDataUrl ?? null,
    qrStorageUrl: input.qrStorageUrl ?? null,
    qrPayload: input.qrPayload ?? null,
    qrGeneratedAt: input.qrGeneratedAt ?? null,
    milestone1Date: null,
    milestone1Photo: null,
    milestone1Status: "not_started",
    milestone1Comment: null,
    milestone1UploadedAt: null,
    milestone1ApprovedAt: null,
    milestone1RejectedAt: null,
    milestone2Date: null,
    milestone2Photo: null,
    milestone2Status: "not_started",
    milestone2Comment: null,
    milestone2UploadedAt: null,
    milestone2ApprovedAt: null,
    milestone2RejectedAt: null,
    finalDate: null,
    finalPhoto: null,
    finalStatus: "not_started",
    finalComment: null,
    finalUploadedAt: null,
    finalApprovedAt: null,
    finalRejectedAt: null,
    completedAt: null,
    teacherObservedTick: false,
    vivaAudioPath: null,
    vivaAudioUploadedAt: null,
    vivaAudioMilestone: null,
    verifiedBy: null,
    verifiedAt: null,
    similarityFlag: false,
    similarityMatchId: null,
    similarityReason: null,
    similarityScore: null,
    previousTitleCheck: input.previousTitleCheck ?? false,
    previousTitleMatch: input.previousTitleMatch ?? false,
    previousTitle: null,
    previousTerm: null,
    improvementNote: null,
    previousProjectId: null,
    photoHashes: [],
    clearedBy: null,
    clearedAt: null,
    schoolGpsLat: null,
    schoolGpsLng: null,
    deviceType: null,
    uploadedFromConnection: null,
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
  };
}

export const PROJECT_REQUIRED_FIELDS = [
  "learnerId",
  "learnerName",
  "schoolId",
  "className",
  "subject",
  "title",
  "lin",
  "qrCode",
  "createdAt",
  "updatedAt",
] as const;

export function validateProjectFields(project: Partial<Project> | Record<string, unknown>): string[] {
  return PROJECT_REQUIRED_FIELDS.filter((field) => {
    const value = (project as Record<string, unknown>)[field];
    return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
  });
}