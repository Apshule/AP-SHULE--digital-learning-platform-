---
name: Teacher material visibility and earnings
description: Teacher-uploaded study materials use a separate collection and need shared-feed merging plus rate-snapshot earnings.
---

Teacher uploads are stored separately from Super Admin resources, so every signed-in learning surface must merge both collections into its shared Resources feed. View payouts must use the agreement rate snapshot stored on the material, not require students to read the teacher's private profile.

**Why:** Students and schools previously could not see teacher uploads, and a student view could not safely read the teacher profile needed to calculate earnings.

**How to apply:** Keep signed-in read access for both material collections, restrict writes by owner/admin role, and record eligible student views against the stored per-view rate while excluding teacher/admin previews from payouts.

Administrative management views should query both material collections directly and carry the source collection with each row; do not rely only on the asynchronous shared-feed listener for initial loading or deletion.

**Why:** The shared Resources listener is intentionally bound after authentication and may not have populated when a Super Admin opens Command Center. A delete action also needs the original collection to avoid targeting `pdfs` for a teacher-owned record.

**How to apply:** Merge direct `pdfs` and `teacherPdfs` reads for admin libraries, label the source, and use the row's source when deleting the Firestore record and optional Storage object.