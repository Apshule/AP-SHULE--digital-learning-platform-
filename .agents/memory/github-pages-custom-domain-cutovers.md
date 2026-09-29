---
name: GitHub Pages custom-domain cutovers
description: Deployment and DNS checks when GitHub Pages sits behind Cloudflare alongside Worker API routes.
---

Verify more than the Actions deployment: check the Pages custom-domain setting, request the GitHub Pages origin directly, and then test the public apex and `www` hosts plus `/api/healthz`. A successful workflow and working direct origin do not prove that the proxied custom domain serves the new site.

Keep Cloudflare proxying enabled on production hostnames when Cloudflare Worker routes must serve `/api/*`. Static paths should stay outside those Worker routes. Do not switch the DNS records to DNS-only without planning for the API routes to stop working during that period.

**Why:** After a successful Pages deployment, direct origin requests served the new UI while Cloudflare continued returning a cached GitHub Pages “Site not found” response. The API routes were still healthy, so further DNS or Worker changes would have risked a working part of the cutover.

**How to apply:** During a Pages cutover, compare origin and proxied responses, inspect cache age and request identifiers when they differ, and verify both domains and API routes before calling the release complete. If the edge is stale, a repeat Pages deployment can refresh it; preserve proxying for the Worker routes.