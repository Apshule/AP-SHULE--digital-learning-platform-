---
name: GitHub Pages push allowlist
description: Which repository files the authenticated GitHub Pages push helper stages and why non-site contracts need explicit inclusion.
---

The authenticated GitHub Pages push helper uses an explicit file allowlist rather than staging the whole working tree. Repository-side contracts such as Firestore rules, indexes, and source tests must be added to that allowlist when a feature changes them, or they remain only in the local checkout.

**Why:** The project publishes the browser site through GitHub Pages, but the same repository also carries the Firebase and test contracts. A successful site push can otherwise leave those supporting files uncommitted.

**How to apply:** When a feature changes non-site repository files that must be shared on `main`, update the push helper allowlist before running the authenticated push path, then verify `git status` is clean.