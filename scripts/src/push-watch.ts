import { execSync, execFileSync } from "node:child_process";
import { watch, watchFile, unlinkSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  ensureGitHubRemote,
  authenticatedGitEnv,
  authenticatedPushUrl,
  friendlyPushError,
} from "./github-remote.js";

const WORKSPACE_ROOT =
  process.env["PUSH_WATCH_ROOT"] ?? new URL("../../", import.meta.url).pathname;
const FILES = [
  "index.html",
  "CNAME",
  "firebase-messaging-sw.js",
  "sw.js",
  "offline-manager.js",
  "manifest.json",
  "robots.txt",
  "sitemap.xml",
  ".nojekyll",
  ".well-known/assetlinks.json",
  "PLAY_STORE_GUIDE.md",
  "icons/icon-192.png",
  "icons/icon-512-maskable.png",
];
const DEBOUNCE_MS = process.env["PUSH_WATCH_DEBOUNCE_MS"]
  ? Number(process.env["PUSH_WATCH_DEBOUNCE_MS"])
  : 5_000;
const POLL_MS = process.env["PUSH_WATCH_POLL_MS"]
  ? Number(process.env["PUSH_WATCH_POLL_MS"])
  : 2_000;
const NOTIFY_URL =
  process.env["PUSH_NOTIFY_URL"] ?? "http://localhost:8080/api/push-events";
const PUSH_SECRET = process.env["PUSH_SECRET"] ?? "";

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

async function notify(type: "success" | "error", message: string): Promise<void> {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (PUSH_SECRET) {
      headers["Authorization"] = `Bearer ${PUSH_SECRET}`;
    }
    const res = await fetch(NOTIFY_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ type, message }),
    });
    if (!res.ok) {
      console.warn(`[${timestamp()}] Browser notify: non-OK response ${res.status} from ${NOTIFY_URL}`);
    }
  } catch (err) {
    console.warn(`[${timestamp()}] Browser notify: could not reach ${NOTIFY_URL} — ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function push(): Promise<void> {
  // Ensure git identity is set (required in some sandbox environments)
  try {
    execSync("git config user.email 2>/dev/null || git config --global user.email 'apshule-bot@apshule.app'", { cwd: WORKSPACE_ROOT });
    execSync("git config user.name 2>/dev/null || git config --global user.name 'APSHULE Bot'", { cwd: WORKSPACE_ROOT });
  } catch {}
  try {
    execSync("git config user.email 'apshule-bot@apshule.app'", { cwd: WORKSPACE_ROOT });
    execSync("git config user.name 'APSHULE Bot'", { cwd: WORKSPACE_ROOT });
  } catch {}

  ensureGitHubRemote();

  // Remove any stale git index.lock left by a previously-killed git process.
  const lockPath = resolve(WORKSPACE_ROOT, ".git", "index.lock");
  try {
    if (existsSync(lockPath)) {
      unlinkSync(lockPath);
      console.log(`[${timestamp()}] Removed stale .git/index.lock`);
    }
  } catch { /* non-fatal */ }

  // Always sync to remote HEAD first so local and remote never diverge.
  // This handles the case where another process (e.g. direct GitHub API push)
  // has added commits to remote that the local clone doesn't have yet.
  const pushUrl = authenticatedPushUrl();
  const gitAuthEnv = authenticatedGitEnv();
  try {
    execFileSync(
      "git",
      ["fetch", pushUrl, "main:refs/remotes/origin/main", "--no-tags"],
      { cwd: WORKSPACE_ROOT, env: gitAuthEnv, stdio: "ignore" }
    );
    execSync("git reset --mixed origin/main 2>/dev/null || true", { cwd: WORKSPACE_ROOT });
  } catch { /* non-fatal — local history may already be in sync */ }

  run(`git add ${FILES.join(" ")}`);

  if (!hasChanges()) {
    console.log(`[${timestamp()}] No changes — nothing to push.`);
    return;
  }

  const message = `chore: sync site files [${timestamp()}]`;
  console.log(`[${timestamp()}] Committing: ${message}`);
  execFileSync("git", ["commit", "-m", message], GIT_OPTS);
  // Force-push: safe because this repo only contains site files we fully control.
  execFileSync("git", ["push", "--force", pushUrl], {
    ...GIT_OPTS,
    env: gitAuthEnv,
  });
  console.log(`[${timestamp()}] Pushed to GitHub ✓`);
  await notify("success", `Pushed to GitHub ✓ (${timestamp()})`);
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
    push().catch(async (err) => {
      const friendly = friendlyPushError(err);
      console.error(`[${timestamp()}] ${friendly}`);
      await notify("error", friendly);
    });
  }, DEBOUNCE_MS);
}

// Keep the event loop alive indefinitely so the process never exits even
// when none of the watched files exist yet.
const keepalive = setInterval(() => {}, 60_000);
keepalive.unref(); // Don't prevent clean exit on SIGTERM — just keeps the loop non-empty

// Track which files are already being watched with fs.watch (efficient inode watcher).
const fsWatched = new Set<string>();

function startFsWatch(file: string, absPath: string): void {
  if (fsWatched.has(file)) return;
  try {
    watch(absPath, { persistent: true }, (_event, filename) => {
      schedulePush(filename ?? file);
    });
    fsWatched.add(file);
  } catch {
    // File disappeared between the existence check and watch call — handled by watchFile polling
  }
}

for (const file of FILES) {
  const absPath = resolve(WORKSPACE_ROOT, file);

  // Try efficient fs.watch first (works for existing files).
  startFsWatch(file, absPath);

  // Always set up a polling watcher (fs.watchFile) as a safety net:
  //   • For missing files: detects creation and starts the efficient watcher.
  //   • For existing files: catches any changes that inode-based watch might miss.
  watchFile(absPath, { persistent: true, interval: POLL_MS }, (curr, prev) => {
    const wasAbsent = prev.nlink === 0;
    const nowExists = curr.nlink > 0;
    const changed = nowExists && curr.mtimeMs !== prev.mtimeMs;

    if (wasAbsent && nowExists) {
      startFsWatch(file, absPath);
      const pending = FILES.filter((f) => !fsWatched.has(f));
      if (pending.length === 0) {
        console.log(`[${timestamp()}] ${file} created — now watching all ${FILES.length} files ✓`);
      } else {
        console.log(
          `[${timestamp()}] ${file} created — watching ${fsWatched.size}/${FILES.length} files — still pending: ${pending.join(", ")}`
        );
      }
      schedulePush(file);
    } else if (changed && !fsWatched.has(file)) {
      // fs.watch not running for this file — handle change via polling
      schedulePush(file);
    }
  });
}

// Some Linux/filesystem combinations do not emit fs.watchFile callbacks for a
// path that did not exist when the watcher was registered. Keep a small
// existence poll for those paths so a newly created site file is detected
// without restarting the watcher.
const missingFilePoll = setInterval(() => {
  for (const file of FILES) {
    if (fsWatched.has(file)) continue;
    const absPath = resolve(WORKSPACE_ROOT, file);
    if (!existsSync(absPath)) continue;
    startFsWatch(file, absPath);
    console.log(`[${timestamp()}] ${file} created — now watching it ✓`);
    schedulePush(file);
  }
}, POLL_MS);
missingFilePoll.unref();

// Print a single startup summary showing watched vs pending files.
const pendingAtStart = FILES.filter((f) => !fsWatched.has(f));
if (pendingAtStart.length === 0) {
  console.log(`[${timestamp()}] Watching all ${FILES.length} files — watcher fully active ✓`);
} else {
  const watchedList = FILES.filter((f) => fsWatched.has(f));
  const watchedStr = watchedList.length > 0 ? ` (${watchedList.join(", ")})` : "";
  console.log(
    `[${timestamp()}] Watching ${fsWatched.size}/${FILES.length} files${watchedStr} — pending: ${pendingAtStart.join(", ")}`
  );
}
