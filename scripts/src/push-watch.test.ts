import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./push-watch.ts", import.meta.url));
const SCRIPTS_DIR = fileURLToPath(new URL("../", import.meta.url));
const TSX = resolve(SCRIPTS_DIR, "node_modules/.bin/tsx");

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "push-watch-test-"));
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email 'test@test.com'", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name 'Test'", { cwd: dir, stdio: "pipe" });
  return dir;
}

function spawnWatcher(root: string): ChildProcess {
  return spawn(TSX, [SCRIPT], {
    env: {
      ...process.env,
      PUSH_WATCH_ROOT: root,
      PUSH_WATCH_DEBOUNCE_MS: "30000",
      PUSH_WATCH_POLL_MS: "100",
      PUSH_NOTIFY_URL: "http://127.0.0.1:1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForLine(proc: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Timed out waiting for watcher startup")), timeoutMs);
    proc.stdout?.on("data", () => { clearTimeout(t); resolve(); });
  });
}

function collectStdout(proc: ChildProcess): string[] {
  const lines: string[] = [];
  proc.stdout?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) lines.push(line.trim());
    }
  });
  return lines;
}

describe("push-watch process reliability", () => {
  const procs: ChildProcess[] = [];
  const dirs: string[] = [];

  afterEach(() => {
    for (const p of procs) {
      try { p.kill("SIGKILL"); } catch {}
    }
    procs.length = 0;
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
    dirs.length = 0;
  });

  it("stays alive when none of the watched files exist", { timeout: 3_000 }, async () => {
    const root = makeTempRepo();
    dirs.push(root);

    const proc = spawnWatcher(root);
    procs.push(proc);

    let exited = false;
    proc.on("exit", () => { exited = true; });

    await waitMs(300);

    expect(exited, "process should still be running").toBe(false);
    expect(proc.exitCode, "exitCode should be null while running").toBeNull();
  });

  it("picks up a newly created watched file without a restart", { timeout: 5_000 }, async () => {
    const root = makeTempRepo();
    dirs.push(root);

    const proc = spawnWatcher(root);
    procs.push(proc);
    const lines = collectStdout(proc);

    await waitForLine(proc, 4_000);

    writeFileSync(join(root, "index.html"), "<html></html>");

    await waitMs(400);

    const detected = lines.some(
      (l) =>
        l.includes("index.html") &&
        (l.includes("created") || l.includes("Now watching") || l.includes("Change detected"))
    );
    expect(
      detected,
      `Expected watcher to detect index.html. Output:\n${lines.join("\n")}`
    ).toBe(true);
  });
});
