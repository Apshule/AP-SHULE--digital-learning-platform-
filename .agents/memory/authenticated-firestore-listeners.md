---
name: Authenticated Firestore listeners
description: Lifecycle rule for Firestore listeners whose rules require an authenticated user.
---

Firestore listeners guarded by `request.auth != null` must be created after the authenticated user profile is loaded, not only during anonymous page bootstrap. Keep their unsubscribe functions and stop them on logout before clearing session state.

**Why:** A listener started before authentication can receive `permission-denied` and remain stopped after the user signs in, leaving the UI stale without an obvious application error.

**How to apply:** For shared user data, make the listener function a no-op when there is no current user, rebind it from the authenticated-session setup, and unsubscribe old listeners before rebinding or clearing the session.