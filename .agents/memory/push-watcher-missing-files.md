---
name: Push watcher missing-file fallback
description: Why the site push watcher needs an existence poll in addition to filesystem callbacks.
---

The site push watcher must poll paths that do not exist at startup. On some Linux/filesystem combinations, `fs.watchFile` does not reliably emit the transition when a previously missing file is created, so relying on that callback alone can miss a new site file.

**Why:** The watcher regression test exposed that a fresh repository with no watched files could remain unaware of a newly created `index.html`.

**How to apply:** Keep a low-frequency existence poll for paths not already covered by `fs.watch`; once a file appears, register the efficient watcher and schedule the normal debounced push.