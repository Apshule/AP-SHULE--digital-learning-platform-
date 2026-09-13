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

export function loadHistory(limit: number): PushEvent[] {
  try {
    const raw = readFileSync(HISTORY_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, limit) as PushEvent[];
  } catch {
    return [];
  }
}

export function saveHistory(history: PushEvent[]): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), "utf-8");
  } catch {
    // non-fatal: in-memory ring buffer still works if the write fails
  }
}
