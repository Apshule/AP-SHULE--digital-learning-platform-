import { pgTable, text } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const curriculumLinksTable = pgTable("curriculum_links", {
  id: text("id").primaryKey(),
  subject: text("subject").notNull(),
  classLevel: text("class_level").notNull(),
  topic: text("topic").notNull(),
  syllabusRef: text("syllabus_ref").notNull(),
  learnerBookPage: text("learner_book_page"),
  teacherGuidePage: text("teacher_guide_page"),
  summaryText: text("summary_text").notNull(),
  activitySuggestion: text("activity_suggestion"),
});

export const insertCurriculumLinkSchema = createInsertSchema(curriculumLinksTable);
export type InsertCurriculumLink = z.infer<typeof insertCurriculumLinkSchema>;
export type CurriculumLink = typeof curriculumLinksTable.$inferSelect;