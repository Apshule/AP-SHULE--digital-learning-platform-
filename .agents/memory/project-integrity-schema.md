---
name: Project integrity schema compatibility
description: Preserve legacy project column types when extending the PostgreSQL project model.
---

The project integrity schema is PostgreSQL-backed; legacy columns such as `previous_title_check` must keep their existing types and semantics. Drizzle can require an explicit development-side cast when a local schema was temporarily changed before the final compatible shape is applied.

**Why:** Replacing an existing boolean with a text field caused Drizzle push to reject the later compatibility correction and could have made production data migration destructive.

**How to apply:** Extend the existing PostgreSQL model with nullable/defaulted columns and indexes, keep legacy types unchanged, and let Replit’s Publish flow surface any production schema confirmation instead of adding runtime or deployment DDL.