import { boolean, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const teacherRetoolingProgressTable = pgTable("teacher_retooling_progress", {
  id: text("id").primaryKey(),
  teacherId: text("teacher_id").notNull(),
  schoolId: text("school_id"),
  moduleId: text("module_id").notNull(),
  completed: boolean("completed").notNull().default(false),
  quizScore: integer("quiz_score"),
  certificateIssued: boolean("certificate_issued").notNull().default(false),
  practicalUploadPath: text("practical_upload_path"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertTeacherRetoolingProgressSchema = createInsertSchema(
  teacherRetoolingProgressTable,
).omit({ updatedAt: true });
export type InsertTeacherRetoolingProgress = z.infer<
  typeof insertTeacherRetoolingProgressSchema
>;
export type TeacherRetoolingProgress = typeof teacherRetoolingProgressTable.$inferSelect;