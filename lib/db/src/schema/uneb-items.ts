import { pgTable, integer, text } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const unebItemsTable = pgTable("uneb_items", {
  id: text("id").primaryKey(),
  subject: text("subject").notNull(),
  classLevel: text("class_level").notNull(),
  topic: text("topic").notNull(),
  scenarioText: text("scenario_text").notNull(),
  competency: text("competency").notNull(),
  markingGrid: text("marking_grid").notNull(),
  sourceYear: integer("source_year"),
});

export const insertUnebItemSchema = createInsertSchema(unebItemsTable);
export type InsertUnebItem = z.infer<typeof insertUnebItemSchema>;
export type UnebItem = typeof unebItemsTable.$inferSelect;