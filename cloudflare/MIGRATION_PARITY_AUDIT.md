# Cloudflare migration parity audit

**Audit date:** 2026-09-28  
**Scope:** Repository routes and user interfaces, plus Cloudflare D1 counts and storage-manifest metadata. No Firebase/Google services were used. The closeout later applied two additive D1 migrations and deployed the Worker on 2026-09-28.

## Summary

The Cloudflare Worker is not yet a full replacement for the Firebase-backed APSHULE application. It provides Cloudflare-native authentication, selected Education and Admin APIs, generic Clinic/Farm/MFI record APIs, Skills directory routes, and manual pending-payment records. Several major user workflows still depend on the legacy application or are not implemented in the Worker.

The production D1 metadata showed 131 user records, 130 active and enabled. The R2 migration manifest contains nine placeholder objects: seven JPEGs and two PDFs. The seven JPEG placeholders share the same 516-byte placeholder content hash, so they can safely serve as a generic avatar until a user uploads a replacement. The manifest does not establish ownership of all nine files: matching manifest paths against D1 user IDs finds only one possible match, which is not enough to infer owners or file purposes.

## Capability status

| Area | Cloudflare status | Remaining parity gap |
| --- | --- | --- |
| Authentication | D1-backed users and KV sessions; reset-code flow uses email OTP. | The legacy main and Education pages still initialize Firebase Auth. Accounts not active in D1 cannot use the new workspaces. |
| Education | Role- and tenant-scoped APIs for learners, classes, subjects, attendance, admissions, marks/grading, teacher assignments, ID cards, communications, bursar fees, statements, and reconciliation. A role-specific workspace aggregate is available. | The legacy Education page still uses Firebase and a Render API base. The Cloudflare API/UI does not reproduce all of the older teaching, lesson, offline-sync, and operational workflows. |
| Clinic | Authenticated tenant-scoped generic records for the supported Clinic record types. | The new page is a generic record browser, not a replacement for the older appointment, visit, pharmacy, billing, insurance, reporting, and scanner workflows. |
| Farm | Authenticated tenant-scoped generic records for the supported Farm record types. | The new page does not reproduce the older analytics, camera, inventory/feed, attendance, produce, and management flows. |
| MFI | Authenticated tenant-scoped generic records and read-only report records. | Generic CRUD is not the full loan lifecycle, approvals, repayments, restructures, write-offs, collateral, offline sync, or director reporting experience. |
| Payments | D1 can store manual pending payment records and supports idempotency. | The legacy Render API contains server-side Yo initiation and callback routes, but they persist through Firestore and are not migrated to the Worker. The Worker explicitly reports manual/pending behavior; no Yo requests were made or verified. |
| Admin | D1 APIs cover users, roles, sessions, and audit records. | This is not parity with the older operational command center and its sector-specific administration tools. |
| AI | No equivalent Worker AI route is present for the legacy assistant call. | The legacy UI still targets the Render API for AI requests. |
| Media, notifications, and live learning | R2 bindings and Skills media routes exist. Worker D1 now stores push-event history and per-user Web Push subscriptions; the existing service worker displays status and targeted notifications. | Firebase Storage, live lessons/access, and other media flows still have legacy callers. Push delivery now uses the Cloudflare Worker and Cloudflare-authenticated sessions rather than FCM. |

Relevant implementations are in `cloudflare/worker.ts`, `cloudflare/domain-routes.ts`, and `cloudflare/static/`. The older app in `index.html` and `education/index.html` still contains direct Firebase/Firestore use, and the root app also contains a Render AI fallback. A Worker health response reporting `firebase: false` describes only that Worker; it does not mean the entire product has stopped using Firebase.

## Existing Yo scaffolding and operational caveat

The API Server already contains server-side Yo initiation and callback code for Skills, admissions, and payment operations. Those routes are gated on Yo environment credentials, but their persistence and callbacks still use Firestore; they are not a Cloudflare D1 implementation. The Worker `/api/pay` route remains disabled with HTTP 503. No Yo requests were sent, no Yo credentials are listed in the current workspace secret inventory, and provider documentation has not yet been supplied for a safe migration.

Push event creation is handled by the Cloudflare Worker at `POST /api/push-events`. It returns 401 when `PUSH_SECRET` is missing, too short, or incorrect, and accepts a matching bearer or `X-Push-Secret` credential. Event history and polling use D1. Browser subscriptions and targeted notifications use Cloudflare Auth sessions; private targeted messages are not added to the global event feed. The old API Server/Render FCM notification routes have been removed.

## Closeout work in this change

- Added an authenticated Cloudflare profile page for self-service profile-photo uploads. Ownership is derived from the Cloudflare session, uploads are limited to JPEG/PNG/WebP and 5 MiB, and new R2 keys are server-derived and content-addressed. A shared R2 JPEG placeholder remains visible until the user replaces it. Existing migration objects are not overwritten or deleted.
- Added a persistent reset-attempt counter across resends. Three incorrect codes within the attempt window invalidate the reset challenge and pause password-reset verification and code issuance for 15 minutes. Normal account login is not locked, and existing IP/email rate limits remain in place.
- Disabled the legacy API Server's static UI preview. The Replit artifact now routes only `/api`, and the Express root returns HTTP 410 as a backstop; its API router remains intact because the Render-backed API still has callers.

Migrations `0007_password_reset_challenge_lock.sql` and `0008_profile_photos.sql` were applied to the production D1 database. The `apshule-skills-production` Worker and updated static assets were deployed. After replacing the Cloudflare token through Replit Secrets, Wrangler successfully deployed the production Worker and configured both `appshule.com/*` and `www.appshule.com/*` route triggers. Live `/health` checks on both domains returned 200 and identified the production Worker. The profile page resolved, and the profile-photo API returned the expected unauthenticated 401. The Worker was not deleted.

Cloudflare Worker push migration: the Worker owns `POST /api/push-events`, D1 event history/polling, Cloudflare-authenticated subscription management, and targeted Web Push. D1 migration `0009` is applied in production and the Worker is deployed. Production checks confirm event POSTs with missing or incorrect secrets return 401, the history poll and VAPID key endpoints respond, and the static app shell and root service worker load. Web Push protocol tests use generated keys and mocked fetches. Actual device delivery remains unverified; do not send an authorized global event POST as a smoke test because it can notify every active subscription.

## Unified public routes and live verification

The production Worker serves the Cloudflare PWA shell at `/`, the public Skills directory at `/skills/`, and the restored Shule-Tech site at `/tech/` on both `appshule.com` and `www.appshule.com`. The root shell links to both sub-sites and uses `/manifest.json`; its root service worker owns shell caching and Web Push together. Staged Skills and Tech assets use same-origin Worker APIs and contain no Firebase, Render, or Web3Forms API references.

The Skills provider detail endpoint (`GET /api/skills/providers/:id`) reads active public provider/course data from D1. The Tech contact endpoint (`POST /api/tech/contact`) validates inquiries, rejects automated honeypot submissions without sending, rate-limits by hashed client IP using KV, and sends valid inquiries through the configured Resend service. No production inquiry was sent during verification.

Production verification on 2026-09-28 returned HTTP 200 for the root, `/skills/`, `/tech/`, manifest, service worker, and Tech assets on both hostnames. The public provider list returned three active providers and a provider detail lookup returned 200. The safe honeypot probe returned 202 without email delivery. The VAPID public-key endpoint returned 200, and anonymous requests to Education, Clinic, Farm, MFI, Payments, and Admin API samples returned 401. No D1 schema migration was required for this integration.

This deployment does not complete legacy workflow parity. The Cloudflare PWA shell remains the selected production root; it does not replace the larger Firebase/Render application. The existing sector-specific gaps listed above remain.

## Safe completion gates

1. Do not claim that the nine original Storage files were recovered: their source bytes were blocked by Google billing. Keep their R2 placeholders intact until replacements or a verified owner/type mapping are available. The new profile flow addresses profile photos, not the two unidentified PDF slots.
2. Move the remaining Firebase-backed UI callers and role workflows to Cloudflare, then test each role and tenant boundary before retiring those callers or Firebase client code.
3. Migrate the existing server-side Yo initiation/callback contract from Firestore to D1 only after the official provider documentation and credentials are available through the secrets flow. Keep all initiation, callback verification, idempotency, and balance changes server-side; do not treat the Worker payment endpoint as live.
4. Only after those gates pass should Firebase configuration, historical migration tooling, or recovery backups be considered for removal.