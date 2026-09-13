import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.resolve(__dirname, "..", "..", "push.config.json");

interface PushConfig {
  pager?: string;
}

function readConfig(): PushConfig {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === "object") {
      return parsed as PushConfig;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Returns the preferred pager command string using the following priority:
 *   1. `pager` field in push.config.json (project-level setting)
 *   2. $PAGER environment variable
 *   3. "less -R" (built-in fallback — -R passes ANSI colours through)
 *
 * The returned string is executed verbatim; callers must not append extra flags.
 */
export function resolvePager(): string {
  const config = readConfig();
  if (config.pager && config.pager.trim()) {
    return config.pager.trim();
  }
  if (process.env["PAGER"] && process.env["PAGER"].trim()) {
    return process.env["PAGER"].trim();
  }
  return "less -R";
}
