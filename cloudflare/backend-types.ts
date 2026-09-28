export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface D1BatchResult<T = Record<string, unknown>> {
  results?: T[];
  success?: boolean;
  meta?: { changes?: number };
}

export interface D1Database {
  prepare(query: string): D1Statement;
  batch(statements: D1Statement[]): Promise<D1BatchResult[]>;
}

export interface SessionsKV {
  get(key: string, type?: "text" | "json"): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Bindings used by the Cloudflare-native authentication module. */
export interface AuthEnv {
  DB: D1Database;
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