---
name: GitHub Pages push allowlist
description: Which repository files the authenticated GitHub Pages push helper stages and why non-site contracts need explicit inclusion.
---

The authenticated GitHub Pages push helper uses an explicit file allowlist rather than staging the whole working tree. Repository-side contracts such as Firestore rules, indexes, and source tests must be added to that allowlist when a feature changes them, or they remain only in the local checkout.

**Why:** The project publishes the browser site through GitHub Pages, but the same repository also carries the Firebase and test contracts. A successful site push can otherwise leave those supporting files uncommitted.

**How to apply:** When a feature changes non-site repository files that must be shared on `main`, update the push helper allowlist before running the authenticated push path, then verify `git status` is clean.

For non-interactive release runs, set `PUSH_CONFIRM=y` and provide `PUSH_MESSAGE` so the helper skips both the diff confirmation and commit-message prompts.

**Why:** Piping stdin is not reliable for the helper's top-level readline prompts under `tsx`; the explicit environment path completes the authenticated push consistently.

**How to apply:** Use those two environment variables only for an intentional verified release, then confirm the pushed commit and a clean working tree.

The helper only invokes `git push` after it finds allowlisted working-tree changes and creates its own release commit. If all release changes are already committed locally, it can exit with "Nothing to push" while `main` is still ahead of GitHub; push the existing commits through the same authenticated Git configuration instead.

**Why:** Education changes were committed before the helper ran, so the helper staged nothing and skipped its push even though the remote was behind.

**How to apply:** After a manual commit, compare local `HEAD` with `origin/main`; if local is ahead, use the helper's authenticated push environment to send `HEAD:main`, then confirm both hashes match.