---
name: Education and Skills data separation
description: Separate D1 storage and access rules for the role-based school PWA and public Skills marketplace.
---

The root APSHULE PWA owns school admissions and academic marks in `school_admissions` and `marks`, scoped to the authenticated school or institution. The public `/skills/` marketing site is a separate product surface and owns `vocational_enrollments`, `vocational_marks`, `vocational_courses`, and `skills_providers`. Never reuse the school tables for Skills applications/results or expose vocational records in school workspaces.

For Education accounts without a source-backed school or institution scope, allow only role- and capability-gated reads. Students remain limited to their own records. Teachers need matching class/subject assignments with compatible school/institution scope; an institution-only assignment must not expose records explicitly scoped to another school. Secretary, headteacher, and bursar access may span schools only through their permitted read workspaces. Block non-superadmin Education writes until a valid scope is assigned; never infer a scope from record contents. Superadmins can access all schools, but updates must preserve each existing record's scope instead of replacing it with the superadmin's null scope.

**Why:** The root PWA manages institution users and private operations; `/skills/` is a public course and provider directory. Shared admissions/marks tables previously mixed those distinct trust boundaries. The Firestore mirror has incomplete account scopes, so guessing tenant IDs or matching teachers by class and subject names alone could disclose or alter another school's data.

**How to apply:** Scope normal root PWA reads and writes by the authenticated school/institution and role capabilities; apply the null-scope exception only to safe Education reads with ownership/assignment filters. Keep `/api/skills/enroll` public but validated and rate-limited, and write only to `vocational_enrollments`. Preserve legacy rows during table moves; never infer or rewrite user roles/scopes from domain data.

Parent access to Education records requires an explicit, active staff-managed parent-to-learner link. The link's institution and school IDs must match the learner and every lesson/file read; revocation must stop access immediately. Never infer guardianship from names, class membership, or shared contact details.

**Why:** A parent role or shared learner details do not prove guardianship. Explicit links provide auditable consent and prevent cross-school disclosure, including for PDFs attached to lessons.

**How to apply:** Enforce the active link and exact tenant match in parent dashboards, lesson lists, and file endpoints. Treat link creation and revocation as scoped staff actions.