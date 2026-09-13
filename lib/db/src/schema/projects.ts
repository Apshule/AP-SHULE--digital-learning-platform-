import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const projectsTable = pgTable("projects", {
  id: text("id").primaryKey(),
  learnerId: text("learner_id").notNull(),
  schoolId: text("school_id").notNull(),
  className: text("class_name").notNull(),
  subject: text("subject").notNull(),
  title: text("title").notNull(),
  lin: text("lin"),
  qrCode: text("qr_code"),
  milestone1Date: timestamp("milestone_1_date", { withTimezone: true }),
  milestone1Photo: text("milestone_1_photo"),
  milestone1Status: text("milestone_1_status").notNull().default("pending"),
  milestone2Date: timestamp("milestone_2_date", { withTimezone: true }),
  milestone2Photo: text("milestone_2_photo"),
  milestone2Status: text("milestone_2_status").notNull().default("pending"),
  finalDate: timestamp("final_date", { withTimezone: true }),
  finalPhoto: text("final_photo"),
  finalStatus: text("final_status").notNull().default("pending"),
  teacherObservedTick: boolean("teacher_observed_tick").notNull().default(false),
  vivaAudioPath: text("viva_audio_path"),
  similarityFlag: boolean("similarity_flag").notNull().default(false),
  previousTitleCheck: boolean("previous_title_check").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertProjectSchema = createInsertSchema(projectsTable).omit({
  createdAt: true,
});
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Project = typeof projectsTable.$inferSelect;