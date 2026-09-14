---
name: IndexedDB version migrations
description: Adding offline stores requires both a version bump and an explicit upgrade migration for existing databases.
---

When adding an IndexedDB store to APSHULE, bump the database version and create the store in a migration branch keyed to that new version; adding it only to the initial store list does not upgrade databases already created by users.

**Why:** The original bootstrap store creation only runs for very old databases, so existing offline users otherwise never receive newly declared stores.

**How to apply:** Pair every new offline queue with its key path, indexes, API methods, sync hooks, pending counts, and a version-specific `onupgradeneeded` branch.

For offline clinic records that depend on one another, keep the local identifier as the eventual Firestore document identifier during replay; this lets queued payments and dispensing records safely reference a bill or inventory item created earlier in the same sync.

**Why:** Offline replay does not automatically expose an ID translation table to later queue handlers, so random server IDs can leave dependent records pointing at nonexistent documents.

**How to apply:** Use stable local IDs for queued clinic inventory and bills, replay parent records before dependent records, and preserve the references when marking the queue records synced.