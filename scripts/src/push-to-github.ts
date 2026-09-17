import { execSync, execFileSync } from "node:child_process";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureGitHubRemote,
  authenticatedGitEnv,
  authenticatedPushUrl,
  friendlyPushError,
} from "./github-remote.js";
import { resolvePager } from "./push-config.js";
import { runPrompt } from "./push-prompt.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
process.chdir(REPO_ROOT);
const LAST_MESSAGE_FILE = path.join(__dirname, "..", ".last-push-message");

function readLastMessage(): string | null {
  try {
    const msg = fs.readFileSync(LAST_MESSAGE_FILE, "utf8").trim();
    return msg || null;
  } catch {
    return null;
  }
}

function saveLastMessage(msg: string): void {
  try {
    fs.writeFileSync(LAST_MESSAGE_FILE, msg, "utf8");
  } catch {
    // non-fatal
  }
}

const FILES = [
  "package.json",
  "package-lock.json",
  "scripts/render-build.mjs",
  "index.html",
  "offline-manager.js",
  "scripts/src/ncdc-course.test.ts",
  "scripts/src/video-studio.test.ts",
  "scripts/src/clinic.test.ts",
  "scripts/src/task13-farm.test.ts",
  "scripts/src/settings.test.ts",
  "scripts/src/command-center.test.ts",
  "scripts/src/task12-payments.test.ts",
  "scripts/src/mfi.test.ts",
  "scripts/src/timetable.test.ts",
  "scripts/src/push-to-github.ts",
  "scripts/src/ai-assistant.test.ts",
  "scripts/src/phase2-yopay.test.ts",
  "artifacts/api-server/src/app.ts",
  "artifacts/api-server/src/lib/ai-usage.ts",
  "artifacts/api-server/src/lib/firebase-auth.ts",
  "artifacts/api-server/src/routes/ai-assistant.ts",
  "artifacts/api-server/src/routes/index.ts",
  "artifacts/api-server/src/routes/school.ts",
  "artifacts/api-server/src/routes/yopay-subscriptions.ts",
  "artifacts/api-server/src/routes/compliance.ts",
  "firestore.rules",
  "firestore.indexes.json",
  "upgrade.html",
  ".agents/memory/MEMORY.md",
  ".agents/memory/github-pages-push-allowlist.md",
  ".agents/memory/pwa-release-cache-invalidation.md",
  "CNAME",
  "sw.js",
  "firebase-messaging-sw.js",
  "manifest.json",
  "robots.txt",
  "sitemap.xml",
  ".nojekyll",
  ".well-known/assetlinks.json",
  "PLAY_STORE_GUIDE.md",
  "icons/icon-192.png",
  "icons/icon-512-maskable.png",
];

function run(cmd: string): void {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}

function hasChanges(): boolean {
  try {
    const out = execSync(`git status --porcelain ${FILES.join(" ")}`, {
      encoding: "utf8",
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

run(`git add ${FILES.join(" ")}`);

if (!hasChanges()) {
  console.log("Nothing to push — all files are up to date on GitHub.");
  process.exit(0);
}

// Show diff summary before asking the user to confirm
const diffStat = execSync("git diff --cached --stat", { encoding: "utf8" }).trim();
console.log("\nChanges staged for push:");
console.log(diffStat);

const isTTY =
  process.env["NO_COLOR"] !== undefined
    ? false
    : process.env["FORCE_COLOR"] !== undefined
    ? true
    : process.stdout.isTTY === true;

function colorLine(line: string): string {
  if (!isTTY) return line;
  if (line.startsWith("+++") || line.startsWith("---")) {
    return `\x1b[36m${line}\x1b[0m`; // cyan for diff file headers
  }
  if (line.startsWith("@@")) {
    return `\x1b[36;1m${line}\x1b[0m`; // bold cyan for hunk headers
  }
  if (line.startsWith("+")) {
    return `\x1b[32m${line}\x1b[0m`; // green for additions
  }
  if (line.startsWith("-")) {
    return `\x1b[31m${line}\x1b[0m`; // red for deletions
  }
  return line;
}

const MAX_DIFF_LINES = 100;
const fullDiff = execSync("git diff --cached", { encoding: "utf8" });
const diffLines = fullDiff.split("\n");
const visibleLines = diffLines.length > MAX_DIFF_LINES
  ? diffLines.slice(0, MAX_DIFF_LINES)
  : diffLines;
console.log("\n" + visibleLines.map(colorLine).join("\n").trimEnd());
if (diffLines.length > MAX_DIFF_LINES) {
  console.log(`\n… (${diffLines.length - MAX_DIFF_LINES} more lines — run \`git diff --cached\` to see the rest)`);
}

function suggestMessage(): string | null {
  try {
    const out = execSync("git diff --cached --name-only", {
      encoding: "utf8",
    }).trim();
    if (!out) return null;
    const files = out
      .split("\n")
      .map((f) => path.basename(f.trim()))
      .filter(Boolean);
    if (files.length === 0) return null;
    return `updated ${files.join(", ")}`;
  } catch {
    return null;
  }
}

const lastMessage = readLastMessage();
const suggested = suggestMessage();
const nonInteractivePush = process.env["PUSH_CONFIRM"]?.trim().toLowerCase() === "y";

function openDiffInPager(): void {
  const pager = resolvePager();
  try {
    // Try to pipe git diff --cached through the pager
    execSync(`git diff --cached | ${pager}`, { stdio: "inherit" });
  } catch {
    // Pager may not be available or user quit with non-zero exit — fall through silently
    try {
      // Fallback: just print the full diff without a pager
      const diff = execSync("git diff --cached", { encoding: "utf8" });
      process.stdout.write(diff);
    } catch {
      // non-fatal
    }
  }
}

const rl = readline.createInterface({ input: stdin, output: stdout });
let answer = "";
try {
  if (!nonInteractivePush) {
    const result = await runPrompt(
      (p) => rl.question(p),
      () => {
        rl.pause();
        openDiffInPager();
        rl.resume();
      }
    );

    if (result === "aborted") {
      console.log("Push aborted.");
      execSync(`git restore --staged ${FILES.join(" ")}`);
      rl.close();
      process.exit(0);
    }
  }

  let prompt: string;
  if (suggested) {
    prompt = `Describe your changes (Enter to use: "${suggested}"`;
    if (lastMessage && lastMessage !== suggested) {
      prompt += `, or type to use last: "${lastMessage}"`;
    }
    prompt += `): `;
  } else if (lastMessage) {
    prompt = `Describe your changes (Enter to reuse: "${lastMessage}"): `;
  } else {
    prompt = "Describe your changes (or press Enter to skip): ";
  }

  answer = nonInteractivePush
    ? process.env["PUSH_MESSAGE"]?.trim() ?? ""
    : await rl.question(prompt);
} finally {
  rl.close();
}

const timestamp = new Date().toISOString().replace("T", " ").slice(0, 16);
const message =
  answer.trim() ||
  suggested ||
  lastMessage ||
  `chore: sync site files [${timestamp}]`;

try {
  ensureGitHubRemote();

  console.log(`> git commit -m <message>`);
  execFileSync("git", ["commit", "-m", message], { stdio: "inherit" });
  console.log("> git push");
  execFileSync("git", ["push", authenticatedPushUrl()], {
    stdio: "inherit",
    env: authenticatedGitEnv(),
  });

  saveLastMessage(message);
  console.log("\nDone! Changes are live on GitHub.");
} catch (err) {
  console.error("\n" + friendlyPushError(err));
  process.exit(1);
}
