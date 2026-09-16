---
name: Role dashboard realtime guards
description: Defensive rendering for role-specific Firestore listeners
---

Role dashboards can authenticate and route correctly while a realtime listener fires before or without one of the dashboard's optional widgets. Listener callbacks must treat those DOM targets as optional and continue safely when a target is absent.

**Why:** The live teacher account reached its dashboard, but the earnings listener threw a null-target TypeError and polluted the session even though the role route was correct.

**How to apply:** Guard each role-specific dashboard element before writing `textContent` or `innerHTML`. Keep the data listener alive and avoid turning a missing presentation widget into an account-wide bootstrap failure.