import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const caRecordsTable = pgTable("ca_records", {
  id: text("id").primaryKey(),
  projectId: text("project_id"),
  milestone: text("milestone"),
  learnerId: text("learner_id").notNull(),
  schoolId: text("school_id").notNull(),
  subject: text("subject").notNull(),
  competency: text("competency").notNull(),
  evidence1: text("evidence_1").notNull(),
  evidence2: text("evidence_2").notNull(),
  evidence3: text("evidence_3").notNull(),
  finalLevel: text("final_level").notNull(),
  term: text("term").notNull(),
  teacherId: text("teacher_id").notNull(),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertCaRecordSchema = createInsertSchema(caRecordsTable).omit({
  syncedAt: true,
  createdAt: true,
});
export type InsertCaRecord = z.infer<typeof insertCaRecordSchema>;
export type CaRecord = typeof caRecordsTable.$inferSelect;