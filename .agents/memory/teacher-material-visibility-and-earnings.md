---
name: Teacher material visibility and earnings
description: Teacher-uploaded study materials use a separate collection and need shared-feed merging plus rate-snapshot earnings.
---

Teacher uploads are stored separately from Super Admin resources, so every signed-in learning surface must merge both collections into its shared Resources feed. View payouts must use the agreement rate snapshot stored on the material, not require students to read the teacher's private profile.

**Why:** Students and schools previously could not see teacher uploads, and a student view could not safely read the teacher profile needed to calculate earnings.

**How to apply:** Keep signed-in read access for both material collections, restrict writes by owner/admin role, and record eligible student views against the stored per-view rate while excluding teacher/admin previews from payouts.