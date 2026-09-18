---
name: Vocational public read boundary
description: Public vocational directory and provider pages use server-backed API reads instead of browser Firestore queries.
---

Public vocational provider reads should go through the API's server-side Firebase access; browser Firestore reads can fail when deployed rules differ between environments.

**Why:** Local preview exposed a permissions failure on the direct active-provider query even though the API could read the same approved records.

**How to apply:** Keep public provider and course pages on the `/api/skills/providers` endpoints, and keep owner, payment, and moderation writes behind authenticated API routes.