---
name: Farm Step 2 offline safety
description: Durable rules for farm egg/feed offline records and inventory synchronization.
---

Farm feed records are online-only. A feed-event insert and its inventory deduction run in one D1-triggered statement; operation IDs are unique, and a retry is accepted only when its item and quantity match. Feed writes must fail closed unless both stock-protection triggers are present. Do not add offline feed replay until a versioned IndexedDB migration, cached inventory snapshot, deterministic operation IDs, and server idempotency are designed together.

**Why:** A client can lose the response after the server commits, so non-transactional stock updates can deduct twice. The current Farm feature is intentionally online-only and does not include an offline feed queue.

**How to apply:** Keep feed submission online-only unless the full local queue and recovery path are added together. For any future offline Farm collection, include the IndexedDB migration, queue method, sync hook, and server idempotency guard. Financial produce, sales, and expense records remain online-only.