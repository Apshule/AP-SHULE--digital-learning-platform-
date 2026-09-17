---
name: Attached credential history
description: Prevent attached service-account files from reaching GitHub through local backup or agent refs.
---

Attached files that contain credentials can be added to local Git history by workspace backup or agent branches, even when they were not intentionally staged. GitHub push protection checks the complete set of commits being transferred, so removing the file from the working tree alone is not sufficient.

**Why:** A Firebase service-account attachment entered local history and caused an otherwise valid GitHub Pages push to be rejected by secret scanning.

**How to apply:** Before any authenticated GitHub push, inspect all refs for attached credential paths. If one is found, revoke or rotate the credential, remove the path from unpublished local history and reachable refs, expire temporary rewrite refs, and verify both history and reachable objects before pushing.