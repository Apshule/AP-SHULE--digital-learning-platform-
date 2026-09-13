import { execSync } from "node:child_process";

const REPO = "Apshule/AP-SHULE--digital-learning-platform-";
const ORIGIN_URL = `https://github.com/${REPO}.git`;

export function redactCredentials(value: unknown): string {
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

export function ensureGitHubRemote(): void {
  try {
    execSync("git remote get-url origin", { stdio: "pipe" });
    execSync(`git remote set-url origin ${ORIGIN_URL}`, { stdio: "pipe" });
  } catch {
    execSync(`git remote add origin ${ORIGIN_URL}`, { stdio: "pipe" });
  }
}

export function authenticatedPushUrl(): string {
  const token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      "GITHUB_PERSONAL_ACCESS_TOKEN is not set. Add it as a secret in Replit."
    );
  }
  return ORIGIN_URL;
}

export function authenticatedGitEnv(): NodeJS.ProcessEnv {
  const token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      "GITHUB_PERSONAL_ACCESS_TOKEN is not set. Add it as a secret in Replit."
    );
  }
  const authorization = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${authorization}`,
  };
}

/**
 * Translate a raw git / Node error into a plain-language message with a
 * specific next step the user can act on immediately.
 */
export function friendlyPushError(err: unknown): string {
  const raw = redactCredentials(
    err instanceof Error
      ? `${err.message}\n${(err as NodeJS.ErrnoException).code ?? ""}`
      : String(err)
  );

  const lower = raw.toLowerCase();

  if (lower.includes("github_personal_access_token is not set")) {
    return (
      "Push failed: GITHUB_PERSONAL_ACCESS_TOKEN is missing.\n" +
      "  → Open Replit Secrets, add a secret named GITHUB_PERSONAL_ACCESS_TOKEN,\n" +
      "    and paste a GitHub personal access token with 'repo' scope."
    );
  }

  if (
    lower.includes("authentication failed") ||
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("bad credentials") ||
    lower.includes("invalid username or token") ||
    lower.includes("could not read username") ||
    lower.includes("invalid username or password")
  ) {
    return (
      "Push failed: GitHub rejected the token (authentication error).\n" +
      "  → Check that GITHUB_PERSONAL_ACCESS_TOKEN in Replit Secrets is still valid.\n" +
      "    Tokens expire or can be revoked — generate a new one at\n" +
      "    https://github.com/settings/tokens and update the secret."
    );
  }

  if (
    lower.includes("repository not found") ||
    lower.includes("not found") ||
    lower.includes("404")
  ) {
    return (
      "Push failed: GitHub could not find the repository.\n" +
      "  → Confirm the repo exists and your token has 'repo' (or 'public_repo') scope.\n" +
      `    Expected repo: https://github.com/${REPO}`
    );
  }

  if (
    lower.includes("non-fast-forward") ||
    lower.includes("update was rejected") ||
    lower.includes("fetch first") ||
    lower.includes("would overwrite")
  ) {
    return (
      "Push failed: the remote has commits your local copy does not have.\n" +
      "  → Run `git pull --rebase` to bring in the remote changes, then try again."
    );
  }

  if (
    lower.includes("enotfound") ||
    lower.includes("getaddrinfo") ||
    lower.includes("network") ||
    lower.includes("could not resolve host") ||
    lower.includes("connection refused") ||
    lower.includes("etimedout") ||
    lower.includes("econnreset")
  ) {
    return (
      "Push failed: could not reach GitHub (network error).\n" +
      "  → Check your internet connection and try again.\n" +
      "    If you are behind a firewall, confirm that github.com:443 is reachable."
    );
  }

  if (lower.includes("permission denied")) {
    return (
      "Push failed: permission denied by GitHub.\n" +
      "  → Verify that your token has write access to this repository.\n" +
      "    If the repo is in an organization, the token may also need SSO authorization."
    );
  }

  return (
    `Push failed: ${raw.trim()}\n` +
    "  → Check the error above. Common causes: expired token, missing repo access,\n" +
    "    or a network issue. Update GITHUB_PERSONAL_ACCESS_TOKEN in Replit Secrets\n" +
    "    if you suspect an auth problem."
  );
}
