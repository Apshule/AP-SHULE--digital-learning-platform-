---
name: Cloudflare clean URL normalization
description: Production URL normalization for HTML assets served through the Cloudflare Worker.
---

The live `appshule.com` edge redirects requests such as `/skills/provider.html?id=...` to `/skills/provider?id=...`, preserving the query string. The extensionless route resolves to the staged HTML asset, so the provider page continues to work without a Worker rewrite.

**Why:** The production clean-URL behavior is applied at the edge and is not visible in the Worker source or local static route configuration. It initially looks like the `.html` page may be missing.

**How to apply:** When adding links to staged HTML pages, verify both the `.html` URL and the extensionless canonical URL in production. Keep query parameters intact and avoid adding route aliases unless the extensionless URL actually fails.