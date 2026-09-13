import { describe, it, expect } from "vitest";
import { friendlyPushError, redactCredentials } from "./github-remote.js";

describe("redactCredentials", () => {
  it("removes credentials embedded in a GitHub URL", () => {
    const secret = "ghp_" + "A".repeat(36);
    const result = redactCredentials(
      `Command failed: git push https://x-access-token:${secret}@github.com/example/repo.git`
    );
    expect(result).not.toContain(secret);
    expect(result).toContain("[redacted]");
  });

  it("removes standalone GitHub token formats", () => {
    const classic = "ghp_" + "B".repeat(36);
    const fineGrained = "github_pat_" + "C".repeat(60);
    const result = redactCredentials(`${classic} ${fineGrained}`);
    expect(result).not.toContain(classic);
    expect(result).not.toContain(fineGrained);
  });

  it("removes authorization header values", () => {
    const result = redactCredentials("Authorization: Bearer secret-value");
    expect(result).toBe("Authorization: Bearer [redacted]");
  });
});

describe("friendlyPushError", () => {
  it("returns missing-token message when GITHUB_PERSONAL_ACCESS_TOKEN is not set", () => {
    const err = new Error(
      "GITHUB_PERSONAL_ACCESS_TOKEN is not set. Add it as a secret in Replit."
    );
    const result = friendlyPushError(err);
    expect(result).toContain("GITHUB_PERSONAL_ACCESS_TOKEN is missing");
    expect(result).toContain("Replit Secrets");
  });

  it("returns auth error message for 'authentication failed'", () => {
    const result = friendlyPushError(new Error("Authentication failed"));
    expect(result).toContain("GitHub rejected the token");
    expect(result).toContain("GITHUB_PERSONAL_ACCESS_TOKEN");
  });

  it("returns auth error message for 401 in error text", () => {
    const result = friendlyPushError(new Error("remote: HTTP 401 Unauthorized"));
    expect(result).toContain("GitHub rejected the token");
  });

  it("returns auth error message for 403 in error text", () => {
    const result = friendlyPushError(new Error("remote: HTTP 403 Forbidden"));
    expect(result).toContain("GitHub rejected the token");
  });

  it("returns auth error message for 'bad credentials'", () => {
    const result = friendlyPushError(new Error("bad credentials"));
    expect(result).toContain("GitHub rejected the token");
  });

  it("returns auth error message for 'could not read username'", () => {
    const result = friendlyPushError(
      new Error("could not read Username for 'https://github.com'")
    );
    expect(result).toContain("GitHub rejected the token");
  });

  it("returns auth error message for 'invalid username or password'", () => {
    const result = friendlyPushError(
      new Error("Invalid username or password.")
    );
    expect(result).toContain("GitHub rejected the token");
  });

  it("returns 404 message for 'repository not found'", () => {
    const result = friendlyPushError(
      new Error("ERROR: Repository not found.")
    );
    expect(result).toContain("could not find the repository");
    expect(result).toContain("repo");
  });

  it("returns 404 message for 'not found' in error text", () => {
    const result = friendlyPushError(new Error("fatal: remote: not found"));
    expect(result).toContain("could not find the repository");
  });

  it("returns 404 message for '404' in error text", () => {
    const result = friendlyPushError(new Error("HTTP 404: Not Found"));
    expect(result).toContain("could not find the repository");
  });

  it("returns non-fast-forward message for 'non-fast-forward'", () => {
    const result = friendlyPushError(
      new Error("Updates were rejected because the tip of your current branch is behind (non-fast-forward)")
    );
    expect(result).toContain("remote has commits your local copy does not have");
    expect(result).toContain("git pull --rebase");
  });

  it("returns non-fast-forward message for 'update was rejected'", () => {
    const result = friendlyPushError(
      new Error("! [rejected] main -> main (update was rejected)")
    );
    expect(result).toContain("git pull --rebase");
  });

  it("returns non-fast-forward message for 'fetch first'", () => {
    const result = friendlyPushError(
      new Error("Updates were rejected because the remote contains work that you do not. Integrate the remote changes (e.g. 'git pull ...') before pushing again. See the 'Note about fast-forwards' in 'git push --help' for details. fetch first")
    );
    expect(result).toContain("git pull --rebase");
  });

  it("returns non-fast-forward message for 'would overwrite'", () => {
    const result = friendlyPushError(
      new Error("push would overwrite existing refs")
    );
    expect(result).toContain("git pull --rebase");
  });

  it("returns network error message for 'enotfound'", () => {
    const err = new Error("getaddrinfo ENOTFOUND github.com");
    const result = friendlyPushError(err);
    expect(result).toContain("could not reach GitHub");
    expect(result).toContain("internet connection");
  });

  it("returns network error message for 'getaddrinfo'", () => {
    const result = friendlyPushError(
      new Error("getaddrinfo EAI_AGAIN github.com")
    );
    expect(result).toContain("could not reach GitHub");
  });

  it("returns network error message for 'could not resolve host'", () => {
    const result = friendlyPushError(
      new Error("fatal: unable to access 'https://github.com/': Could not resolve host: github.com")
    );
    expect(result).toContain("could not reach GitHub");
  });

  it("returns network error message for 'connection refused'", () => {
    const result = friendlyPushError(
      new Error("connect ECONNREFUSED 140.82.113.4:443 (connection refused)")
    );
    expect(result).toContain("could not reach GitHub");
  });

  it("returns network error message for 'etimedout'", () => {
    const result = friendlyPushError(new Error("connect ETIMEDOUT"));
    expect(result).toContain("could not reach GitHub");
  });

  it("returns network error message for 'econnreset'", () => {
    const result = friendlyPushError(new Error("read ECONNRESET"));
    expect(result).toContain("could not reach GitHub");
  });

  it("returns network error message for 'network' in error text", () => {
    const result = friendlyPushError(new Error("network error occurred"));
    expect(result).toContain("could not reach GitHub");
  });

  it("returns permission denied message for 'permission denied'", () => {
    const result = friendlyPushError(
      new Error("remote: Permission denied to some-org/repo.git")
    );
    expect(result).toContain("permission denied by GitHub");
    expect(result).toContain("write access");
  });

  it("returns fallback message for unrecognised errors", () => {
    const result = friendlyPushError(
      new Error("some completely unexpected error we have never seen")
    );
    expect(result).toContain("Push failed:");
    expect(result).toContain("some completely unexpected error we have never seen");
    expect(result).toContain("GITHUB_PERSONAL_ACCESS_TOKEN");
  });

  it("handles non-Error values (plain strings)", () => {
    const result = friendlyPushError("a plain string error");
    expect(result).toContain("Push failed:");
    expect(result).toContain("a plain string error");
  });

  it("handles non-Error values (objects)", () => {
    const result = friendlyPushError({ code: "ERR_UNKNOWN" });
    expect(result).toContain("Push failed:");
  });

  it("missing-token check takes priority over auth check", () => {
    const err = new Error(
      "GITHUB_PERSONAL_ACCESS_TOKEN is not set. Authentication failed."
    );
    const result = friendlyPushError(err);
    expect(result).toContain("GITHUB_PERSONAL_ACCESS_TOKEN is missing");
  });

  it("never returns a token from an unrecognised push error", () => {
    const secret = "ghp_" + "D".repeat(36);
    const result = friendlyPushError(
      new Error(
        `Command failed: git push https://x-access-token:${secret}@github.com/example/repo.git`
      )
    );
    expect(result).not.toContain(secret);
    expect(result).toContain("[redacted]");
  });
});
