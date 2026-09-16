---
name: Single-file script bootstrap order
description: Cross-script timing constraints for the single-file APSHULE app
---

In the single-file app, separate classic script blocks are evaluated independently. Authentication callbacks can run before a later block has defined a helper, even when that helper appears later in the same HTML file. Helpers used by authenticated routing must be defined in the earlier routing block, or their invocation must be deferred through a safe `window` lookup until the later block has loaded.

**Why:** Live authentication exposed several bootstrap-time ReferenceErrors that left the app shell visible while every sector page remained hidden.

**How to apply:** When adding a role helper, listener initializer, or optional navigation handler, check the script-block order. Prefer an early definition for routing-critical helpers and guarded deferred calls for later optional helpers. Add a source-order regression test for each such dependency.