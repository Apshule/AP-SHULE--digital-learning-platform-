import type { NeonClient } from "./neon-db";

export interface SessionsKV {
  get(key: string, type?: "text" | "json"): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Bindings used by the Cloudflare-native authentication module. */
export interface AuthEnv {
  NEON_DATABASE_URL?: string;
  PG?: NeonClient;
  SESSIONS?: SessionsKV;
  PUBLIC_SITE_URL: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
}

export interface AuthUser {
  uid: string;
  email: string;
  displayName: string;
  role: string;
  schoolId: string | null;
  institutionId: string | null;
  sessionVersion: number;
}

export type AuthenticationResult =
  | { authenticated: true; user: AuthUser; sessionToken: string }
  | { authenticated: false; reason: "missing" | "invalid" | "expired" | "disabled" | "unavailable"; status: number };