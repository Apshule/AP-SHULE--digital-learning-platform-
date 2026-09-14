---
name: Farm Step 2 offline safety
description: Durable rules for farm egg/feed offline records and inventory synchronization.
---

Farm offline features need explicit IndexedDB migrations, a cached inventory snapshot, and deterministic record IDs. Feed synchronization must check whether the server record already exists before reducing inventory, so a retry after a partial sync cannot deduct stock twice.

**Why:** Farm workers may operate with intermittent connectivity, and the sync process can be retried after the remote write succeeds but before local pending state is cleared.

**How to apply:** Any future farm offline collection should add a versioned migration, queue method, sync hook, and idempotency guard together. Financial produce, sales, and expense records remain online-only.