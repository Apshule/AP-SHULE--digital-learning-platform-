---
name: Education live-account boundary
description: The secure boundary used by the standalone Education workspace for live school records.
---

The standalone Education page must reuse the existing Firebase Auth session and load institutional data through the protected API, not query private school records directly from the browser. Unauthenticated visitors stay in the credential-free preview. Academic marks and reports are discovered only from existing Firestore collections whose records carry the authorized school or institution scope. Bursar payment and reconciliation writes use separate role-protected API endpoints.

**Why:** The Education page is also published as a static GitHub Pages surface, while school records require server-side institution resolution and must not expose legacy school credentials or cross-school users.

**How to apply:** Keep academic API responses read-only and sanitized, accept only school-oriented roles, resolve both school and institution identifiers, and treat primary/secondary as views over the same authorized boundary. For bursar actions, require the bursar role, validate the bill against the scoped school, write the transaction pending-first, update the bill, and audit the result.