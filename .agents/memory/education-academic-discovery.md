---
name: Education academic discovery
description: Rules for loading live school marks and report cards when the Firestore schema is not uniform.
---

Do not invent a new academic collection or write path when the live marks/report-card schema is unknown. Discover existing Firestore collection IDs server-side, inspect only mark/report-shaped candidates, require direct school or institution scope on each document, and return sanitized normalized fields.

**Why:** The repository did not define one authoritative collection name for primary marks, secondary NCDC/O-Level marks, A-Level marks, or report cards. Guessing could expose or mix records across schools.

**How to apply:** Keep discovery read-only and bounded, keep fallback preview data separate from live data, and leave the live arrays empty when no directly scoped authoritative records exist.