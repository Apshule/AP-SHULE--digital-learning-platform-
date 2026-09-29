---
name: Education and Skills data separation
description: Separate D1 storage and access rules for the role-based school PWA and public Skills marketplace.
---

The root APSHULE PWA owns school admissions and academic marks in `school_admissions` and `marks`, scoped to the authenticated school or institution. The public `/skills/` marketing site is a separate product surface and owns `vocational_enrollments`, `vocational_marks`, `vocational_courses`, and `skills_providers`. Never reuse the school tables for Skills applications/results or expose vocational records in school workspaces.

**Why:** The root PWA manages institution users and private operations; `/skills/` is a public course and provider directory. Shared admissions/marks tables previously mixed those distinct trust boundaries.

**How to apply:** Scope root PWA reads and writes by the authenticated school/institution and role capabilities. Keep `/api/skills/enroll` public but validated and rate-limited, and write only to `vocational_enrollments`. Preserve legacy rows during table moves; never infer or rewrite user roles/scopes from domain data.