---
name: Yo payment boundaries
description: Durable security and consistency rules for mobile-money payment flows.
---

Yo! payment credentials, provider XML, webhook signature verification, transaction idempotency, and bill-balance mutations belong on the API server. The browser may submit a scoped payment request and display a reference or status, but must not receive credentials or decide a payment is complete.

**Why:** Mobile-money callbacks are asynchronous and can be duplicated, malformed, or forged. Treating the browser as authoritative can create false receipts or bypass institution-scoped accounting.

**How to apply:** Keep payment initiation authenticated and rate-limited, store a pending transaction before calling Yo!, accept only verified callbacks, make callback processing idempotent, and record audit/notification events server-side.

Step 2 queues in-app, SMS, and email delivery metadata in `payment_notifications`; delivery must remain pending until an approved provider worker is configured.

**Why:** Yo! credentials do not provide SMS/email delivery, and silently marking queued messages as sent would mislead clients and institutions.

**How to apply:** Treat the queue as the source event, preserve channel/status fields, and add provider delivery as a separate authenticated worker.