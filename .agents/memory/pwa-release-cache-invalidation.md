---
name: PWA release cache invalidation
description: How APSHULE releases force installed clients to load the current app shell and service worker.
---

Version the offline shell cache and add a revision query to the service-worker registration URL for every shell release.

**Why:** The root worker cache can otherwise keep an older index and JavaScript bundle on an already-installed phone, making newly shipped role navigation appear broken even when the current source is correct.

**How to apply:** When publishing shell or routing changes, increment the worker cache version and the registration revision together, and keep the worker file in the authenticated GitHub push allowlist.