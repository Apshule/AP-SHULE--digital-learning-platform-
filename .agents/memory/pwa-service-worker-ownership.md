---
name: PWA service-worker ownership
description: Why the Cloudflare app shell and Web Push share one root service-worker registration.
---

Use one root-scope Cloudflare service worker for app-shell caching and Web Push. Do not import the Firebase messaging worker or register a second worker for the same scope.

**Why:** Browsers allow only one active service-worker registration per scope. A second root worker can replace the app-shell worker and silently break offline navigation or push delivery.

**How to apply:** Keep offline caching and Cloudflare push handlers in the same root worker. Update its cache name and registration revision together for each shell release.