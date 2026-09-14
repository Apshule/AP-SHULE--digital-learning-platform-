---
name: Preview build environment
description: Mockup preview builds require explicit PORT and BASE_PATH values in this workspace.
---

The workspace build can typecheck successfully but fail during the mockup preview bundle if PORT or BASE_PATH is absent.

**Why:** The mockup Vite configuration intentionally rejects missing runtime routing values, so a plain workspace build is not a reliable validation command.

**How to apply:** For full build verification, provide a valid preview port and the artifact base path while running the workspace build; do not change the Vite guard just to make local validation pass.