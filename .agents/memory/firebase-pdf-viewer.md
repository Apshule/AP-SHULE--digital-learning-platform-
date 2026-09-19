---
name: Firebase PDF viewer behavior
description: Browser handling for Firebase Storage PDFs in the APSHULE student resource viewer.
---

Firebase Storage download URLs should be fetched by the signed-in browser and rendered into a canvas-based view-only surface. Do not route them through Google Docs Viewer, because Google fetches the URL server-side and can return 403 even when the signed-in browser is authorized.

**Why:** Mobile students saw a Google 403 page when opening otherwise readable Firebase-hosted PDFs.

**How to apply:** Use the authenticated browser URL with PDF.js, remove native iframe download/print controls, and show an actionable error for private or non-CORS external links. This deters casual downloading but cannot technically prevent OS screenshots or determined copying in a browser.