import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT || 8080);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid preview port: ${process.env.PORT}`);
}

function runPnpm(args, extraEnv = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("pnpm", args, {
      cwd: workspaceRoot,
      env: { ...process.env, ...extraEnv },
      stdio: "inherit",
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`pnpm ${args.join(" ")} failed (${signal || code})`));
    });
  });
}

await runPnpm(["run", "build:cloudflare"]);
await runPnpm([
  "exec",
  "wrangler",
  "d1",
  "migrations",
  "apply",
  "apshule-preview-local",
  "--config",
  "wrangler.preview.toml",
  "--local",
], { CI: "1" });

const server = spawn(
  "pnpm",
  [
    "exec",
    "wrangler",
    "dev",
    "--config",
    "wrangler.preview.toml",
    "--local",
    "--ip",
    "0.0.0.0",
    "--port",
    String(port),
  ],
  { cwd: workspaceRoot, env: process.env, stdio: "inherit" },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.kill(signal));
}

await new Promise((resolvePromise, rejectPromise) => {
  server.once("error", rejectPromise);
  server.once("exit", (code, signal) => {
    if (signal) process.exitCode = signal === "SIGTERM" ? 0 : 1;
    else process.exitCode = code ?? 1;
    resolvePromise();
  });
});