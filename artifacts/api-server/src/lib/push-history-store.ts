import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface PushEvent {
  type: "success" | "error";
  message: string;
  timestamp: string;
}

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const HISTORY_FILE = join(DATA_DIR, "push-history.json");

export function sanitizePushMessage(value: unknown): string {
  return String(value)
    .replace(
      /(https?:\/\/)([^/\s:@]+):([^@\s/]+)@/gi,
      "$1[redacted]:[redacted]@"
    )
    .replace(/\b(?:ghp|github_pat|gho|ghu|ghs|ghr)_[A-Za-z0-9_]+\b/g, "[redacted-github-token]")
    .replace(
      /(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s,;]+/gi,
      "$1[redacted]"
    );
}

export function loadHistory(limit: number): PushEvent[] {
  try {
    const raw = readFileSync(HISTORY_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, limit).map((event) => ({
      ...event,
      message: sanitizePushMessage(event?.message),
    })) as PushEvent[];
  } catch {
    return [];
  }
}

export function saveHistory(history: PushEvent[]): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const sanitized = history.map((event) => ({
      ...event,
      message: sanitizePushMessage(event.message),
    }));
    writeFileSync(HISTORY_FILE, JSON.stringify(sanitized, null, 2), "utf-8");
  } catch {
    // non-fatal: in-memory ring buffer still works if the write fails
  }
}
