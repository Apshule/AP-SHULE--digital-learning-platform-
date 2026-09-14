---
name: NCDC inline script test compatibility
description: Browser-facing NCDC helpers are evaluated in lightweight VM tests as well as in the browser.
---

Keep top-level side effects in the inline NCDC script guarded when they depend on browser-only globals such as timers, DOM APIs, or Firebase. The course seed tests evaluate a slice of index.html in a minimal VM context, so an unguarded startup call can break unrelated data-foundation tests before any helper is exercised.

**Why:** The NCDC foundation tests intentionally isolate inline helpers from the browser; an unguarded certificate-verification timer caused the entire helper fixture to fail even though the course data logic was correct.

**How to apply:** Prefer function declarations for NCDC behavior and register browser startup work from the normal app initialization path. If a top-level registration is necessary, guard the required global with `typeof` before calling it.