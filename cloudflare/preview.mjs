import { spawn } from "node:child_process";
import { neon } from "@neondatabase/serverless";
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

const localHealthArgs = [];
if (process.env.NEON_DEV_DATABASE_URL) {
  const sql = neon(process.env.NEON_DEV_DATABASE_URL);
  const rows = await sql`
    SELECT
      (SELECT COUNT(*)::integer FROM public.users) AS users,
      (
        SELECT COUNT(*)::integer
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ) AS tables
  `;
  const row = rows[0];
  const snapshot = {
    users: Number(row?.users),
    tables: Number(row?.tables),
    checkedAt: new Date().toISOString(),
  };
  if (!Number.isSafeInteger(snapshot.users) || !Number.isSafeInteger(snapshot.tables)) {
    throw new Error("Neon development health snapshot returned invalid counts");
  }
  localHealthArgs.push("--var", `NEON_HEALTH_SNAPSHOT_JSON:${JSON.stringify(snapshot)}`);
}

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
    ...localHealthArgs,
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