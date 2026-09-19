---
name: Authenticated greeting boundary
description: Shared time-of-day greetings across APSHULE account surfaces and the public Education preview boundary.
---

The public Education landing preview must remain clearly non-authenticated; personalized, localized time-of-day greetings belong only to authenticated workspaces and should use the shared greeting contract.

**Why:** The preview is marketing content and must not imply that a visitor is signed in or expose an invented account identity.

**How to apply:** Reuse the root greeting helper for authenticated main-app and Education surfaces, and explicitly serve it from the API when a nested static app loads it.