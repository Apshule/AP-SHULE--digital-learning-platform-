---
name: PWA service-worker ownership
description: Why APSHULE offline caching and Firebase push share one root service-worker registration.
---

Use one service worker to control the root scope. The offline worker owns `/` and imports the existing Firebase messaging worker so its push and background-message handlers remain active.

**Why:** Browsers allow only one active service-worker registration per scope. Registering separate offline and messaging workers at `/` makes the later registration replace the earlier one and silently breaks either caching or notifications.

**How to apply:** Preserve the import relationship and register only the offline worker at root. Any future push-worker changes must remain compatible with being loaded through `importScripts`.