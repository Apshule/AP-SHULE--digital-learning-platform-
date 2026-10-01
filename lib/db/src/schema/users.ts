import { boolean, integer, pgTable, text } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Authentication fields carried over from the existing Cloudflare D1 users
 * table. Timestamp values remain text so the migration preserves their source
 * representation exactly.
 */
export const usersTable = pgTable("users", {
  uid: text("uid").primaryKey(),
  email: text("email"),
  displayName: text("display_name"),
  role: text("role").notNull().default(""),
  disabled: boolean("disabled").notNull().default(false),
  emailVerified: boolean("email_verified").notNull().default(false),
  passwordHash: text("password_hash"),
  passwordSalt: text("password_salt"),
  hashAlgorithm: text("hash_algorithm"),
  customClaimsJson: text("custom_claims_json"),
  providerDataJson: text("provider_data_json"),
  rawJson: text("raw_json").notNull(),
  requiresPasswordReset: boolean("requires_password_reset").notNull().default(false),
  createdAt: text("created_at"),
  lastLoginAt: text("last_login_at"),
  importedAt: text("imported_at").notNull(),
  passwordHashV2: text("password_hash_v2"),
  passwordSaltV2: text("password_salt_v2"),
  active: boolean("active").notNull().default(true),
  sessionVersion: integer("session_version").notNull().default(1),
  schoolId: text("school_id"),
  institutionId: text("institution_id"),
});

export const insertUserSchema = createInsertSchema(usersTable);
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;