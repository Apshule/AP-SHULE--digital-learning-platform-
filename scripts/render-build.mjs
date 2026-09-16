import { spawnSync } from "node:child_process";

const PNPM_VERSION = "10.26.1";
const buildEnv = {
  ...process.env,
  APSHULE_RENDER_BUILD: "1",
};

function runPnpm(args) {
  const result = spawnSync(
    "npx",
    ["--yes", `pnpm@${PNPM_VERSION}`, ...args],
    { stdio: "inherit", env: buildEnv },
  );

  if (result.error) {
    console.error(`Unable to run pnpm: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (process.env.APSHULE_RENDER_BUILD === "1") {
  process.exit(0);
}

console.log(`Installing the APSHULE workspace with pnpm ${PNPM_VERSION} for the Render build...`);
runPnpm(["install", "--lockfile=false"]);
console.log("Building the API server bundle for npm start...");
runPnpm(["--filter", "@workspace/api-server", "run", "build"]);