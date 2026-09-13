---
name: PWA preview asset routing
description: Why the API artifact needs explicit routes for the standalone PWA files.
---

The API artifact serves the standalone app shell from the repository root, so it must also explicitly serve the root PWA assets used by that shell: the offline manager, root service worker, Firebase messaging worker, manifest, and icons.

**Why:** Serving only `/` causes these files to return the HTML 404 response. Browsers then reject the offline manager because its MIME type is HTML, and service-worker registration fails before IndexedDB queueing can initialize.

**How to apply:** When changing the API preview/static setup, verify the PWA asset URLs return their real JavaScript, JSON, or image content and restart the API workflow before checking offline behavior.