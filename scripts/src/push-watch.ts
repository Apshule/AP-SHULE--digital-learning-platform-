import { execSync, execFileSync } from "node:child_process";
import { watch } from "node:fs";
import { resolve } from "node:path";
import { ensureGitHubRemote, authenticatedPushUrl } from "./github-remote.js";

const WORKSPACE_ROOT = new URL("../../", import.meta.url).pathname;
const FILES = ["index.html", "CNAME", "firebase-messaging-sw.js"];
const DEBOUNCE_MS = 5_000;

const GIT_OPTS = { stdio: "inherit" as const, cwd: WORKSPACE_ROOT };

function run(cmd: string): void {
  execSync(cmd, { ...GIT_OPTS });
}

function hasChanges(): boolean {
  try {
    const out = execSync(`git status --porcelain ${FILES.join(" ")}`, {
      encoding: "utf8",
      cwd: WORKSPACE_ROOT,
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function push(): void {
  // Ensure git identity is set (required in some sandbox environments)
  try {
    execSync("git config user.email 2>/dev/null || git config --global user.email 'apshule-bot@apshule.app'", { cwd: WORKSPACE_ROOT });
    execSync("git config user.name 2>/dev/null || git config --global user.name 'APSHULE Bot'", { cwd: WORKSPACE_ROOT });
  } catch {}
  try {
    execSync("git config user.email 'apshule-bot@apshule.app'", { cwd: WORKSPACE_ROOT });
    execSync("git config user.name 'APSHULE Bot'", { cwd: WORKSPACE_ROOT });
  } catch {}

  run(`git add ${FILES.join(" ")}`);

  if (!hasChanges()) {
    console.log(`[${timestamp()}] No changes — nothing to push.`);
    return;
  }

  ensureGitHubRemote();

  const message = `chore: sync site files [${timestamp()}]`;
  console.log(`[${timestamp()}] Committing: ${message}`);
  execFileSync("git", ["commit", "-m", message], GIT_OPTS);
  execFileSync("git", ["push", authenticatedPushUrl()], GIT_OPTS);
  console.log(`[${timestamp()}] Pushed to GitHub ✓`);
}

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

let timer: ReturnType<typeof setTimeout> | null = null;

function schedulePush(filename: string): void {
  if (timer) {
    clearTimeout(timer);
  }
  console.log(`[${timestamp()}] Change detected in ${filename} — pushing in ${DEBOUNCE_MS / 1000}s…`);
  timer = setTimeout(() => {
    timer = null;
    try {
      push();
    } catch (err) {
      console.error(`[${timestamp()}] Push failed:`, err);
    }
  }, DEBOUNCE_MS);
}

console.log(`[${timestamp()}] Watching for changes in: ${FILES.join(", ")}`);

for (const file of FILES) {
  const absPath = resolve(WORKSPACE_ROOT, file);
  try {
    watch(absPath, { persistent: true }, (_event, filename) => {
      schedulePush(filename ?? file);
    });
  } catch {
    console.warn(`[${timestamp()}] Warning: could not watch ${file} (file may not exist yet)`);
  }
}
