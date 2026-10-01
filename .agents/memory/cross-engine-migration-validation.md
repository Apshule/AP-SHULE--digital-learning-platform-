---
name: Cross-engine migration validation
description: Semantic schema checks and checksums for moving D1 data into PostgreSQL.
---

When validating D1-to-PostgreSQL migrations:

- SQLite `PRAGMA table_info` can report `notnull = 0` for a primary-key column. Accept its primary-key constraint as non-null for schema validation, and still reject actual null row values.
- PostgreSQL `ALTER TABLE ... ADD COLUMN` appends columns, so compatible source and target tables may have different column order. Compare expected and actual column names and types as maps, not ordinal positions.
- Verify migrated rows with deterministic checksums over selected columns. Exclude generated identifiers when natural keys define identity, and normalize timestamp values to the same ISO representation.

**Why:** A production D1-to-Neon preflight rejected a valid subscription table because SQLite's PK nullability metadata and PostgreSQL's appended-column order differed despite matching semantics.

**How to apply:** Validate all source rows before writes; perform the transfer transactionally, then verify aggregate counts and canonical checksums before commit.