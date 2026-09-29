---
name: Wrangler preview isolation
description: Why managed Cloudflare previews must use isolated local bindings and noninteractive migrations.
---

Use local-only Wrangler bindings for Replit previews, apply D1 migrations with `--local`, and run migration commands noninteractively. Never let a preview inherit production routes, database IDs, or credentials.

**Why:** Wrangler's interactive D1 migration confirmation blocked the managed workflow before it opened its preview port. A local-only run confirmed the same Worker could start cleanly without contacting production.

**How to apply:** When a Worker preview fails before listening, check for an interactive migration prompt before diagnosing a port mismatch. Keep preview D1/KV/R2 resources and routes separate from production.