---
name: Wrangler preview isolation
description: Why managed Cloudflare previews must use isolated local bindings and noninteractive migrations.
---

Use local-only Wrangler bindings for Replit previews, apply D1 migrations with `--local`, and run migration commands noninteractively. Never let a preview inherit production routes, database IDs, or credentials.

For local health checks in this environment, query Neon from the Node preview runner and pass only the aggregate counts plus a check timestamp to the development Worker. Keep this snapshot path development-only; production health must continue to perform its live database query.

**Why:** Wrangler's interactive D1 migration confirmation blocked the managed workflow before it opened its preview port. In addition, workerd outbound fetches to Neon and localhost returned opaque internal errors while the same development query succeeded from Node. A local-only run confirmed the Worker starts without contacting production, and the timestamp makes snapshot age visible.

**How to apply:** When a Worker preview fails before listening, check for an interactive migration prompt before diagnosing a port mismatch. Keep preview D1/KV/R2 resources and routes separate from production. If local health needs Neon counts, generate a fresh read-only snapshot in Node and expose its source/time; never silently use it in production.