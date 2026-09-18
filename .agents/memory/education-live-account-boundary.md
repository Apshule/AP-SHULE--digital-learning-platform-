---
name: Education live-account boundary
description: The secure boundary used by the standalone Education workspace for live school records.
---

The standalone Education page must reuse the existing Firebase Auth session and load institutional data through the protected API, not query private school records directly from the browser. Unauthenticated visitors stay in the credential-free preview.

**Why:** The Education page is also published as a static GitHub Pages surface, while school records require server-side institution resolution and must not expose legacy school credentials or cross-school users.

**How to apply:** Keep the API response read-only and sanitized, accept only school-oriented roles, resolve both school and institution identifiers, and treat primary/secondary as views over the same authorized boundary. Keep bursar and finance controls out of this workspace.