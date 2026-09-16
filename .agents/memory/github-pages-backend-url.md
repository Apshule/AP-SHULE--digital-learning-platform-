---
name: GitHub Pages backend URL
description: Static GitHub Pages cannot reach a local Replit workflow; secure browser-to-API features need a stable public backend URL.
---

GitHub Pages must call a stable, externally reachable HTTPS backend endpoint for authenticated server features. A running Replit development workflow is not a production API URL, and the GitHub Pages custom domain cannot transparently serve backend routes.

**Why:** The static site host returned `405 Not Allowed` for the AI route, while the API workflow was healthy only inside the Replit workspace.

**How to apply:** Before changing a client API base or claiming a live integration works, obtain the existing backend's public URL from deployment metadata or the user. Never guess a `.replit.app` URL.