---
name: IndexedDB version migrations
description: Adding offline stores requires both a version bump and an explicit upgrade migration for existing databases.
---

When adding an IndexedDB store to APSHULE, bump the database version and create the store in a migration branch keyed to that new version; adding it only to the initial store list does not upgrade databases already created by users.

**Why:** The original bootstrap store creation only runs for very old databases, so existing offline users otherwise never receive newly declared stores.

**How to apply:** Pair every new offline queue with its key path, indexes, API methods, sync hooks, pending counts, and a version-specific `onupgradeneeded` branch.