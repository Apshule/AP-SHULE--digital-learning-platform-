---
name: Firebase PDF viewer behavior
description: Browser handling for Firebase Storage PDFs in the APSHULE student resource viewer.
---

Firebase Storage download URLs should be opened directly in the browser PDF viewer. Do not route them through Google Docs Viewer, because Google fetches the URL server-side and can return 403 even when the signed-in browser is authorized.

**Why:** Mobile students saw a Google 403 page when opening otherwise readable Firebase-hosted PDFs.

**How to apply:** Detect Firebase Storage hosts in the inline PDF viewer and assign the download URL directly; reserve Google Docs Viewer for non-Firebase external URLs.