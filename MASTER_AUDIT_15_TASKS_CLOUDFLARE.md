# MASTER AUDIT V10 — 15 Tasks / Cloudflare + Neon

**Audit date:** 2026-10-01
**Scope:** Read-only source, build, public-route, and production database metadata/count checks. V10's **Neon PostgreSQL / no D1** specification supersedes the earlier eight-task prompt that required D1. No feature code, production data, or deployment was changed. The requested report file is the only new tracked deliverable.

## Executive result

**0/15 tasks are fully restored on the V10 stack.** The repository contains substantial legacy features and a newer Cloudflare Pages/Worker implementation, but they are separate generations:

- GitHub Pages publishes the newer `cloudflare/static/` app. Its staged bundle is 1.5 MB on disk and the Pages asset checks pass.
- The live Worker and its Wrangler configuration use **D1**, not Neon. The live `/api/healthz` response advertises D1; the requested `/api/health` returns 404.
- The configured `NEON_DATABASE_URL` connects to a database with six public tables. The five Task 1 feature tables exist but each is empty; `users` is absent, so the requested Neon user count of 131 is not available.
- The Worker has partial auth, clinic, farm, MFI, and manual-payment routes. It lacks the requested Education compliance/project/UNEB/curriculum/retooling/earnings/Gemini routes and the timetable route.
- Legacy root and Education interfaces still contain Firebase and Render usage. The Pages bundle excludes those legacy clients, but the repository as a whole is not Firebase/Render-free.
- Existing Worker features are generally D1-backed and are not evidence of a Neon migration.

Public route checks returned `200` for `/`, `/tech/`, and `/skills/`; `404` for `/learn/` and `/my-account/`. Health returned `404` at `/api/health` and `200` at `/api/healthz`, with production JSON declaring `cloudflare.d1 = apshule-skills-db` and `authentication = cloudflare-d1-kv`.

Production checks queried only table metadata and aggregate counts. No user rows, credentials, payment records, or other personal data were selected.

## 1. Golden commit and comparison

The largest repository tree in the requested 21–24 September history window is:

- **Selected max-file candidate:** `cbcef5356514480c4a12b10eb482624c7e74c2b5`, 2026-09-23 15:33:37 UTC, “Implement full Firebase migration scripts and configuration,” 443 tracked files.
- A second commit object, `3306349027629344a5999f179bec8f2853968f1d`, has the same tree hash (`395bd087621c2ad0ed3cc65b5fb59b76ec5c2f07`) and the same 443-file count.
- **Pre-migration UI reference:** `7b64cfe5eec4621f7531cf3216b58b0ee2ad1b5f`, 2026-09-23 10:37:03 UTC, 405 files. `cloudflare/RECOVERY_BASELINE.md:5-8,21` identifies this as the best-supported pre-migration UI baseline.
- The last 22 September evening candidate is `8ba0c49740426f61d1996df32ca6332a8908e244`, 2026-09-22 19:09:03 +03:00, 398 files. Its change is a one-line `tech/index.html` update; it is not evidence of a complete 15-task release.
- Current `HEAD` is `2a0425425477c9143e82ac33b95a924cab470aee`, 509 tracked files. `git diff cbcef... HEAD` reports 197 files changed, 25,961 insertions, and 27,226 deletions.

There is no commit titled “After all changes” in the inspected history. The max-file commit was selected to satisfy the requested tree-size criterion, but it is **not** a verified “all 15 tasks working” golden: it is itself a Firebase migration/configuration commit. The pre-migration baseline is more useful for comparing legacy UI. Neither Git history nor the recovery note proves that every detailed V10 subfeature was working on 22 September.

## 2. Stack verification

### GitHub Pages

| Check | Result |
|---|---|
| Pages workflow | **Present**, `.github/workflows/deploy-pages.yml:1-41`. It stages assets with `node cloudflare/stage-assets.mjs`, uploads `cloudflare/assets` using `upload-pages-artifact@v3`, and deploys with `deploy-pages@v4`. It does not use the requested `setup-node` / `pnpm install` / `pnpm build` / `dist/` sequence. |
| Root `dist/` | **Absent.** The root `pnpm run build` builds the Express API server; the frontend is staged separately by `pnpm run build:pages`. |
| CNAME | **Present:** `CNAME` and staged CNAME contain `appshule.com`. Public root and several routes respond, but repository CNAME alone does not prove GitHub Pages settings or DNS configuration. |
| Current staged site size | **1.5 MB**, 61 files under `cloudflare/assets`; Wrangler dry-run reported 289.84 KiB upload size. Both are below 30 MB. |
| Public routes checked | `/` 200, `/tech/` 200, `/skills/` 200; `/learn/` 404, `/my-account/` 404. |
| Runtime source | Pages tests confirm staged assets do not require Firebase or Render. The staging workflow intentionally publishes `cloudflare/static/`, not the legacy root `index.html`. |

The Pages bundle is a valid, small static build, but its current route inventory and feature set do not satisfy all requested pages or product features.

### Cloudflare Worker and required routes

`wrangler.toml:1-16,39-57` configures production Worker `apshule-skills-production`, entry `cloudflare/worker.ts`, and D1 binding `DB` to `apshule-skills-db`. The Worker also binds KV and R2 (`wrangler.toml:18-37,59-78`). D1 configuration is a **V10 failure**, not a required component. `wrangler.preview.toml` also uses local D1.

The source has an equivalent or partial route for **6 of the 20 requested route families**: auth; health under `/api/healthz` rather than `/api/health`; MFI; clinic; farm; and payments. This is not 6 fully satisfied features:

- `/api/health` returns 404; `/api/healthz` returns D1-backed health.
- Clinic/Farm/MFI endpoints are partial and D1-backed.
- `/api/payments/*` is manual D1 payment record/status functionality, not Yo initiation, signed IPN, or settlement. `/api/pay` returns 503.
- The following 14 requested families are missing from the Worker: `/api/compliance`, `/api/ca_records`, `/api/ca_records/export`, `/api/projects`, `/api/uneb`, `/api/uneb/random`, `/api/curriculum/*`, `/api/gemini/*`, `/api/retooling/*`, `/api/earnings/*`, `/api/sample_videos`, `/api/upload/r2`, `/api/settings`, and `/api/timetable/*`.

Relevant routing evidence: `cloudflare/worker.ts:305-367,463-469`; `cloudflare/auth.ts:231-258,390-473`; `cloudflare/domain-routes.ts:1173-1225`; `cloudflare/clinic-workflows.ts:231-258`; `cloudflare/farm-workflows.ts:138-183`; `cloudflare/mfi-workflows.ts:112-118,164-218`.

### Neon PostgreSQL

The audit connected read-only using the configured `NEON_DATABASE_URL` and queried `information_schema` plus `COUNT(*)` only.

**All non-system Neon tables:**

```text
public.ca_records
public.curriculum_links
public.projects
public.push_subscriptions
public.teacher_retooling_progress
public.uneb_items
```

**Counts:** `uneb_items=0`, `ca_records=0`, `projects=0`, `curriculum_links=0`, `teacher_retooling_progress=0`, `push_subscriptions=0`. There is no `users` table in Neon, so `SELECT COUNT(*) FROM users` cannot return the requested 131. The production D1 database was read-only checked earlier in this audit thread: it contains 51 tables and **132 users**, not 131.

The five education schemas exist in Neon, but they do not prove that the Worker or Pages application uses them. The Worker types and queries use D1. The app database package uses PostgreSQL/Drizzle but directly reads `process.env.DATABASE_URL` (`lib/db/src/index.ts:1-14`); `NEON_DATABASE_URL` appears only in the operating note (`replit.md:18`), not in the connection implementation. No Neon adapter is used by the Worker.

| Neon table | Present | Production rows | Notable columns |
|---|---:|---:|---|
| `uneb_items` | Yes | 0 | subject, class_level, topic, scenario_text, competency, marking_grid, source_year |
| `ca_records` | Yes | 0 | learner_id, school_id, evidence_1–3, final_level, term, teacher_id |
| `projects` | Yes | 0 | LIN/QR, milestone dates/photos/statuses, teacher observation, viva path, similarity/repeat-title flags, school GPS |
| `curriculum_links` | Yes | 0 | subject, class_level, topic, syllabus/book/guide refs, summary, activity suggestion |
| `teacher_retooling_progress` | Yes | 0 | teacher_id, school_id, module_id, completion, quiz score, practical path, certificate |

These schemas are PostgreSQL/Drizzle evidence, not evidence of populated Neon tables, successful end-to-end Neon writes, or Worker adoption. The requested module, video, MFI, clinic, farm, offline, and timetable tables are absent from Neon.

### Firebase, Firestore, and Render

**Repository-wide zero requirement: FAIL.** A source/config text search returned **301 Firebase line matches in 40 files** and **6 Render-host matches in 5 files**. This is a text-match count, not a count of unique live API calls: it includes test assertions and negative `firebase:false` status fields. Active Firebase clients/API calls remain in the legacy root, Education, skills enrollment/admin, and Express API sources.

- `firebase.json` and `.firebaserc` are absent.
- `firestore.rules` and `firestore.indexes.json` are present.
- The root `package.json` has no Firebase library dependency; its Firebase matches are migration/audit scripts. The active legacy UI still loads Firebase SDKs from the browser, so a clean dependency list does not establish Firebase removal.
- The staged Pages asset tests pass their “no Firebase/Render runtime” check. That is an app-bundle boundary, not repository-wide removal.
- Render hosts remain in the root AI client and Education/upgrade/video-sync files; one additional occurrence is in an assertion test.

### R2, Resend, Gemini, PWA

- **R2: partial.** Production Worker has `FILES` and `VIDEOS` R2 bindings. Worker routes upload profile photos, school files, and brand logos. Current limits include 5 MiB profile images, 8 MiB school PDFs, and 2 MiB logos, above the requested 500 KB; no browser image-compression stage was found. The exact `/api/upload/r2` route is absent. Evidence: `cloudflare/profile-files.ts:15,74-109`; `cloudflare/education-files.ts:11,160-180`; `cloudflare/education-platform.ts:258-275`; browser uploads in `cloudflare/static/profile.html:10-20` and `cloudflare/static/role-workspace.js:433-437`.
- **Resend: partial/pass for Worker OTP path only.** Cloudflare auth has Resend-backed signup/login OTP logic (`cloudflare/auth.ts:191-219,390-454`) and the live Pages login uses it. OTP state remains D1-backed. Prior release testing confirmed a live verification email was delivered; this does not demonstrate that all legacy Firebase Auth paths were removed.
- **Gemini: legacy only, not Worker.** Sector-specific guidance is implemented in the Express API (`artifacts/api-server/src/routes/ai-assistant.ts:8-48,63-73,91-113,185-218`), but its caller uses a Render endpoint (`index.html:13670-13777`). The Worker has no Gemini route.
- **PWA: split and partial.** Current Pages uses a hand-written service worker and manifest (`cloudflare/static/sw.js:1-12,50-65`; `cloudflare/static/index.html:8,529`; staged `manifest.json` exists). It does not use Workbox or IndexedDB offline data stores. Legacy `offline-manager.js` has a custom IndexedDB-based implementation, but that manager is not staged by Pages. The requested offline records/login/sync are not available in the Pages workspace.

## 3. Task-by-task restoration table

“Legacy” means the root/Firebase-era source or Express/PostgreSQL API. “Pages/Worker” means the currently staged GitHub Pages app and routed Cloudflare Worker. Authenticated role behavior was not manually exercised in production; public routes and health were checked.

| Task | Status live? | Neon tables | Worker/API and frontend location | Firebase? | V10 Cloudflare + Neon + R2 + Pages? | Main gap / bug | Compared with golden |
|---|---|---|---|---|---|---|---|
| **1 NCDC/UNEB** | Legacy feature fragments exist; broken through Pages/Worker | Five requested tables exist, all empty | Legacy `index.html`, Express `artifacts/api-server/src/routes/compliance.ts`; Worker has no compliance route | Yes, in legacy sources | **No — broken on Pages/Worker** | School functions are partial; browser print replaces PDF; student UNEB Start is a placeholder; no Worker data path. Teacher card has four buttons, not six. Project Verification exists as a separate card; the other missing button is UNEB scenario-item creation. Super Admin NCDC CRUD/import is not restored on Worker. | Legacy screens exist around the recovery baseline; no verified Neon/Worker parity. |
| **2 Offline PWA triple mode** | Legacy custom offline features; current Pages shell only | No requested offline tables | `offline-manager.js`; Pages `cloudflare/static/sw.js`, `role-workspace.js` | Yes in legacy/offline push remnants | **No** | No Workbox or IndexedDB offline domain stores in Pages; Pages workspace says offline changes are not queued. Legacy sync omits some queued stores. | Legacy had broad offline UI; current Pages is shell caching, not parity. |
| **3 Offline earnings** | Legacy partial; Pages equivalent missing | `offline_views` absent | Legacy `index.html:5240-5319,5504-5537,6103-6118`; no Worker earnings route | Yes, Firestore writes | **No** | Offline payload loses `studentId`, allowing collisions/unknown identity; pending earnings default to zero. No Pages `earnings/sync` path. | Legacy flow existed, but no migrated Worker/Neon implementation. |
| **4 Project integrity** | Legacy API partial; Pages route broken | `projects` and `ca_records` exist, empty | Express compliance route; Neon Drizzle schemas; no Worker compliance route | Yes, including legacy evidence storage | **No** | Worker has only generic D1 school records; not the integrity API, R2-viva flow, or school evidence folder. | Legacy workflow present in source; V10 stack path missing. |
| **5 Curriculum linker** | Legacy UI exists; Pages version absent | `curriculum_links` exists, 0 rows | `index.html:2211-2248,6612-6689,7173-7251`; no Worker curriculum route | Yes, reads/writes Firestore | **No** | Neon has no 800-topic dataset; no Worker search/import/offline/favorites route. | Legacy linker exists; Pages/Worker port not found. |
| **6 Ten-module retooling** | Legacy UI/flow partial; Pages version absent | `teacher_retooling_progress` exists, 0 rows; module/lesson tables absent | `index.html:7324-7405,7444-7460,7524-7567`; no Worker retooling route | Yes, progress/seed data in Firestore | **No** | Seeded video URLs/PDFs are placeholders; generic/reused quiz content; offline completion does not demonstrably sync earnings/CPD award. | Legacy 10-module interface is present; no V10 course-content/data path. |
| **7 Video Studio 3 modes** | Legacy prototype/UI only; absent from Pages/Worker | `sample_videos`, `cartoon_assets` absent | `index.html:2281-2475,7912-8141,8470-8673`; no Worker Video Studio routes | Yes, Firestore persistence | **No** | Cartoon assets are placeholder SVG; browser speech synthesis does not save requested audio; Twin explicitly waits for secure APIs. | Legacy UI retained; no V10 API/schema migration. |
| **8 Connection Settings** | Legacy settings UI; absent from Pages workspace | `offline_settings` absent | `index.html:3935-4038,5036-5117,5200-5217`; no Worker settings route | Yes, settings mirror to Firestore | **No** | Local IndexedDB settings/sync UI is not cross-device Neon sync; full settings page is not staged in Pages. | Legacy settings present; no V10 port. |
| **9 Super Admin Command Center + branding** | Legacy console partial; Worker admin subset | No V10 branding/security schema in Neon | Legacy `index.html:2736-2835,14408-14463,14728-14745`; Worker admin routes and logo upload in D1/R2 | Yes, Firestore/Storage in legacy | **No** | Legacy permissions matrix says future server enforcement; “impersonation” is a support preview that does not change auth. Worker admin is a subset; no full analytics/security/branding parity. | Legacy Command Center exists; Worker has a partial, different admin portal. |
| **10 MFI collateral** | Legacy UI; current Worker parity missing | All requested MFI collateral tables absent | Legacy `index.html:14814-15072`; current `cloudflare/static/mfi/index.html:22-58,98-109`; no Worker collateral operation | Yes, legacy Firestore | **No** | No Neon collateral scoring/documents/valuers/verification; current Worker MFI page omits collateral. | Legacy implementation exists; current Worker checklist marks collateral missing. |
| **11 Clinic pharmacy** | Partial Worker path | All requested clinic tables absent from Neon | Worker `cloudflare/clinic-workflows.ts`; UI `cloudflare/static/clinic/index.html`; D1 migrations | No Firebase in Pages clinic path; legacy code remains elsewhere | **No — D1 instead of Neon** | Role-gated clinic core exists, including patients, appointments, visits, stock, bills, claims, basic reports. Full pharmacy checkout/scan, broader reports, and offline clinic workflows remain partial/missing. | One of the stronger Cloudflare slices, but not full parity or Neon-backed. |
| **12 Yo payments** | Legacy Express integration; Worker gateway not restored | Yo/payment Neon tables absent | Express `artifacts/api-server/src/routes/yo-payments.ts`; Worker `cloudflare/domain-routes.ts:1173-1206` | Yes, legacy Firebase auth/Firestore | **No** | Worker manual payment records remain pending; `/api/pay` returns 503. No Worker Yo IPN, signature verification, disbursement, or Neon settlement. | Legacy provider integration exists; migration to Worker/Neon not done. |
| **13 Farming** | Partial Worker path | All requested Farm tables absent from Neon | Worker `cloudflare/farm-workflows.ts`; UI `cloudflare/static/farm/index.html`; D1 | No Firebase in Pages Farm path; legacy code remains elsewhere | **No — D1 instead of Neon** | Tenant-scoped registry/movement/attendance/egg/inventory slices exist. Camera detection, biometrics, financials/analytics, full worker tools, and offline sync remain missing/partial. Feed use is intentionally online-only. | New Worker slice is partial; parity checklist marks major features incomplete. |
| **14 Full MFI loan lifecycle** | Legacy UI/code fragments; current Worker slice partial | All requested lifecycle tables absent from Neon | Legacy root `index.html:4535-4542,16049-16051`; Worker `cloudflare/mfi-workflows.ts:164-218` | Yes, legacy flows | **No — D1/generic records** | Worker approval stores a decision but does not advance loan state; repayment returns 410. Schedules, repayments, collections, fees, credit notes, restructuring, write-offs, and customer document workflow are not complete. | Legacy UI exists; current Cloudflare checklist explicitly marks lifecycle operations disabled/missing. |
| **15 Landing page + timetable** | Pages landing partial; timetable legacy only | All requested timetable tables absent from Neon | Pages `cloudflare/static/index.html`; legacy `index.html:17260-17288,17379-17400`; only minimal D1 timetable table | Yes, legacy timetable uses Firestore | **No** | Pages root has six `<section>` elements, not evidence of all 12 requested landing sections. Legacy timetable has Firestore UI/logic; Worker has no timetable route or full schema. | Legacy timetable/UI existed in source; current Pages/Worker does not restore it. |

### Per-task evidence and detail

1. **NCDC/UNEB:** `lib/db/src/schema/index.ts:20-25` exports the five PG models. `uneb_items.ts:5-16`, `ca-records.ts:5-21`, `projects.ts:6-76`, `curriculum-links.ts:5-20`, and `teacher-retooling-progress.ts:5-24` define them. Live Neon counts are zero. Legacy Express compliance routes are in `artifacts/api-server/src/routes/compliance.ts:257-283,630-728,807-850,929-937`; the Worker routes only generic school records and do not dispatch `/api/compliance/*` (`cloudflare/domain-routes.ts:669-689,1209-1225`). Teacher buttons are exactly NCDC Modules, Lesson Plan Generator, Triangulation Assessment, Curriculum Linker (`index.html:3752-3761`). A separate Project Verification Queue is at `index.html:3793-3800`; there is no teacher UNEB scenario-item button. The Pages role workspace provides generic student/marks/attendance/fees (`cloudflare/static/role-workspace.js:257-330`), not the UNEB/CA flows.
2. **Offline PWA:** the legacy manager has mode selection (`offline-manager.js:1180-1195`) and local queues. Its sync implementation does not include every store counted in the pending summary (`offline-manager.js:856-889,945-999,1106-1127`). Pages caches shell/navigation requests only and bypasses API writes (`cloudflare/static/sw.js:1-12,50-65`); its role workspace reports no offline write queue (`cloudflare/static/role-workspace.js:874-880,893-913`). No Workbox package or Pages IndexedDB domain-store implementation was found.
3. **Offline earnings:** legacy offline view payload carries `userId`, while offline normalization expects `studentId` (`index.html:6103-6108`; `offline-manager.js:107-141`). New offline rows can have zero earning amount (`offline-manager.js:141`); the legacy teacher dashboard totals that field (`index.html:5510-5515`). Firestore sync exists in the root app but no `/api/earnings/*` Worker route exists.
4. **Project integrity:** the Express compliance route has create/review/duplicate/repeat-title handling. The Worker router lacks `/api/compliance/*`, and legacy upload paths accept Firebase Storage URLs (`artifacts/api-server/src/routes/compliance.ts:539-540,597-615`). The Neon `projects` model includes LIN/QR, milestone, viva, similarity, prior-title and GPS-related fields, but no rows exist.
5. **Curriculum:** legacy UI has search, favorites, activities, requests, and import tools (`index.html:2211-2248,6612-6689,7173-7251`). Its primary collection remains Firestore, while a separate Express endpoint uses PostgreSQL; Worker linker routes are absent.
6. **Retooling:** root includes ten module labels and seed logic for 10 modules/40 lessons (`index.html:7324-7338,7444-7460`). Seeded video URLs and PDFs are placeholders (`index.html:7379-7397`). A separate Worker module/course API was not found.
7. **Video Studio:** five legacy tabs include the three requested modes plus library/stats (`index.html:2281-2475`). Cartoon rendering uses placeholder SVG and browser speech synthesis; audio is not saved (`index.html:7912-7925,8083-8141`). Twin UI explicitly says live API calls are disabled pending secure integration (`index.html:2443-2459,8640-8673`). No Worker API or Neon sample-video tables exist.
8. **Connection Settings:** legacy settings have mode, sync, language, cache, history, and help controls (`index.html:3935-4038`). Persistence is browser Offline/IndexedDB with optional Firestore preference mirror (`index.html:5036-5117`), not cross-device Neon preference sync.
9. **Command Center:** legacy dashboard and security surfaces use Firestore reads/writes (`index.html:14015-14048,14300-14327,14408-14463`). Branding reads/writes Firestore and uploads to Firebase Storage (`index.html:14728-14745`). The Worker has admin roles/users/audit and a separate platform admin/R2 logo subset (`cloudflare/domain-routes.ts:1039-1045,1127-1169`; `cloudflare/education-platform.ts:178-205,257-275`).
10. **MFI collateral:** current parity checklist marks collateral operations missing (`cloudflare/SECTOR_PARITY_CHECKLIST.md:41-48`). Current MFI Worker handler and UI do borrower/application/approval slices, not collateral (`cloudflare/mfi-workflows.ts:110-118,199-220`; `cloudflare/static/mfi/index.html:22-58`).
11. **Clinic:** current D1 Worker offers tenant-scoped role workspaces and patient/appointment/visit/prescription/inventory/billing/claims/report routes (`cloudflare/clinic-workflows.ts:231-258,440-482,536-596,715-720,820-879`). The parity checklist describes reports, offline, full pharmacy checkout, and broad admin flows as incomplete (`cloudflare/SECTOR_PARITY_CHECKLIST.md:14-26`).
12. **Yo payments:** legacy route stores pending transactions and calls Yo through Express; callbacks update Firestore (`artifacts/api-server/src/routes/yo-payments.ts:387-452,894-920`). Worker payment routes are manual-only and explicitly say no gateway is configured (`cloudflare/domain-routes.ts:1173-1206`).
13. **Farm:** Worker has a limited tenant-scoped registry/movement/attendance/egg/inventory slice and atomic online-only feed deduction (`cloudflare/farm-workflows.ts:136-213,306-349`). Reports call themselves partial (`:158-169`); cameras, biometrics, full finance, analytics and offline sync are missing (`cloudflare/SECTOR_PARITY_CHECKLIST.md:28-39`).
14. **MFI lifecycle:** Worker supports basic borrower/application/preview/approval records; repayments return 410 and state transitions are disabled (`cloudflare/mfi-workflows.ts:164-218`; `cloudflare/SECTOR_PARITY_CHECKLIST.md:47-55`). No requested MFI lifecycle tables were found in Neon.
15. **Landing/timetable:** Pages workflow stages `cloudflare/static/` (`cloudflare/stage-assets.mjs:72-88`). The active marketing source is separate from the legacy root. The legacy timetable generator uses Firestore (`index.html:17260-17288,17379-17400`); D1 migration `cloudflare/migrations/0018_education_timetables.sql:1-9` is minimal, and the Worker has no timetable route. Neon contains none of the requested timetable tables.

## 4. Explicit bug checks

| Bug / requested verification | Finding |
|---|---|
| Sync popup close button | Legacy root control, outside-click, and Escape handlers exist (`index.html:1943-1950,4938-4942,5180-5190`); contract test exists in `scripts/src/timetable.test.ts:66-72`. The Pages app is a different shell and does not stage this legacy popup. |
| Farm Admin shown as Teacher | Legacy role label maps `farm_admin` to “Farm Admin” (`index.html:16630-16678`) with a regression contract (`scripts/src/sector-isolation.test.ts:8-15`). Not reproduced in that mapping. Pages Farm displays the API role as provided (`cloudflare/static/farm/index.html:81-82`), so its presentation is less polished but no Teacher substitution was found. |
| Admission form leaking into Farm | No leakage found in inspected legacy navigation/role guards (`index.html:16546-16553,16848-16854`; `scripts/src/sector-isolation.test.ts:17-36`). Cloudflare separates school admissions and vocational enrollment (`cloudflare/migrations/0017_separate_school_and_skills_data.sql:2-39,91-101`; `cloudflare/domain-routes.ts:369-409`). |
| Clinic Q&A cross-sector leakage | No current Worker Clinic Q&A endpoint/UI was found. Legacy AI role/sector checks exist (`artifacts/api-server/src/routes/ai-assistant.ts:8-48,63-73`). No live authenticated Q&A scenario was run, so this is “not found in inspected paths,” not proof of runtime absence. |
| Sector-aware Gemini | Implemented in the legacy Express AI route, absent from the Worker. Legacy client calls Render (`index.html:13670-13777`; `ai-assistant.ts:91-113,202-218`). |
| Contextual notification placement | Legacy `showContextualMessage` inserts beside a target and its callers pass UI elements (`index.html:4858-4872,6265,6344,6387,7682-7690,10206-10210`); contract test at `scripts/src/timetable.test.ts:82-89`. Not present in the current Pages UI. |
| 7/7 workspaces | Pages tests confirm role aliases resolve to distinct static pages, and routing tests pass. This is route-level restoration only; it does not establish full feature parity for seven workspaces. |
| Dual institution/app branding | Legacy Firestore branding editor exists; Worker has R2 logo upload/admin settings subset. Dynamic two-logo headers and per-sector brand/contact substitution are not established in Pages. |

## 5. Build and verification results

- `pnpm run typecheck`: **PASS** (libraries, API server, mockup sandbox, scripts).
- `pnpm run build`: **PASS**, but builds `artifacts/api-server/dist/`, not the Pages frontend. Main server bundle 2.5 MB plus source maps.
- `pnpm run test:cloudflare:assets`: **PASS, 7/7**. This rebuilds Pages staging and checks role aliases, workspace pages, and Firebase/Render-free runtime assets.
- `pnpm run test:cloudflare:routes`: **PASS, 9/9**. Tests explicitly exercise D1-backed auth and provider registration.
- Focused source-contract tests for Farm, Clinic, MFI, timetable, sector isolation, and Task 12 payments: **PASS, 84/84**. These are source/regression tests; they do not prove production database or gateway behavior.
- `pnpm exec wrangler deploy --dry-run --env production`: **PASS**, no deployment performed. Output explicitly lists `env.DB D1 Database apshule-skills-db`, plus KV/R2/static bindings.
- Root `dist/`: **absent**. Actual Pages build output is `cloudflare/assets/`.
- `pnpm install` was not run; no package installation was needed for this audit.
- No production writes or deployments were made. The audit rebuilt ignored staged assets as part of the requested Pages build check; Git-tracked application source remains unchanged.

## 6. Prioritized gaps for a later implementation phase

These are audit priorities only; **no fixes were started**.

1. Decide and implement one database boundary: V10 requires Worker-to-Neon, but current Worker, preview, live health, and production data use D1. Wire the application’s `NEON_DATABASE_URL` intentionally; current DB code reads `DATABASE_URL`.
2. Restore the shared Education API path (`compliance`, CA records/export, projects, UNEB, curriculum, retooling, earnings, Gemini) and connect it to populated Neon tables. Add the required `/api/health` alias if V10 requires that exact endpoint.
3. Migrate or explicitly scope the remaining 13 task families: Clinic, Farm, MFI collateral/loan lifecycle, Yo payments, Video Studio, settings, landing/timetable, offline PWA, earnings, and Command Center.
4. Replace oversized raw uploads with browser compression and enforced file limits; add R2 URL persistence through the selected database.
5. Add deployment-level checks for `/learn/`, `/my-account/`, Worker route coverage, Neon schema/data, and authenticated role-specific flows; current source-contract tests do not prove production feature availability.

## Console summary

```text
MASTER AUDIT 15 TASKS COMPLETE: Firebase removed? NO, Neon OK? NO, Worker route families with an equivalent or partial endpoint 6/20, Task1-15 statuses [PARTIAL, PARTIAL, PARTIAL, PARTIAL, PARTIAL, PARTIAL, PARTIAL, PARTIAL, PARTIAL, PARTIAL, PARTIAL, PARTIAL, PARTIAL, PARTIAL, PARTIAL], Overall 0% fully restored on Cloudflare+GitHub+Neon+R2, See MASTER_AUDIT_15_TASKS_CLOUDFLARE.md
```

## Appendix A — Firebase text-match locations

Command scope: source/config extensions `ts,tsx,js,html,sql,toml,yml,yaml,json`, excluding `pnpm-lock.yaml`. 301 matching lines in 40 files; matches include tests and status assertions as well as active legacy calls.

```text
artifacts/api-server/src/lib/ai-usage.ts:2,4,5,41
artifacts/api-server/src/lib/firebase-admin-token.ts:7,8,10,13,14,28,38,40
artifacts/api-server/src/lib/firebase-auth.ts:2,4,12,19,26,36,56,84,91,93,112,114,119,120,124,128,135,140,146,148,157,158,163,170
artifacts/api-server/src/routes/ai-assistant.ts:2,136,186
artifacts/api-server/src/routes/compliance.ts:22,51,52,57,115,117,129,131,540,602,604,611,615
artifacts/api-server/src/routes/notifications.ts:7,9,16,22,23,37,38,41,44,59,69,110,115,135,138,143,144,166,167,168,187
artifacts/api-server/src/routes/push-events.ts:9,32
artifacts/api-server/src/routes/school.ts:5,9,18,30,31,41,135,147,158,195,219,241,591,604,715,782,859,914,978,1030,1097,1203,1357,1416,1473,1510,1571,1574,1611,1617,1621,1641,1647,1655
artifacts/api-server/src/routes/skills.ts:3,4,7,105,106,291,292,304,305,392
artifacts/api-server/src/routes/student-referrals.ts:3,4,7,115,117,263,488,626
artifacts/api-server/src/routes/yo-payments.ts:3,4,9,78,79,99,100,117,118,134,144
artifacts/api-server/src/routes/yopay-subscriptions.ts:3,4,7,66,68,126,224,228
artifacts/api-server/src/routes/youtube.ts:3,4,7,8,104,105,155,156,177
cloudflare/migrations/0001_initial.sql:1
cloudflare/migrations/0003_firebase_full.sql:1,3
cloudflare/worker-routing.test.ts:115
cloudflare/worker.ts:323
education/app.js:84,358,378,979,985
education/index.html:207,208,215,216,218,220,226
index.html:63,68,69,70,71,72,1519,1632,1713,1724,1725,1741,1745,1749,1750,3285,4569,4570,4571,4572,4573,4574,4579,4582,4584,4586,4590,4591,4592,4596,4598,4600,4601,4608,4615,4697,4698,6276,7394,8018,8095,8562,10510,10994,11032,11214,11248,12194,14158,14194,14196,14197,14370,14440,16377,17623,17665,17956,17985,18330,18407,18408,19763
offline-manager.js:3,690,692,694,703,1918
package.json:17,18,19
scripts/src/ai-assistant.test.ts:30
scripts/src/cloudflare-education.test.ts:94,98
scripts/src/education.test.ts:24,48
scripts/src/offline-helpers.test.ts:20,22
scripts/src/offline-helpers.ts:20,21,23,40
scripts/src/phase2-yopay.test.ts:11
scripts/src/push-to-github.ts:70,84,93
scripts/src/push-watch.ts:16
scripts/src/skills.test.ts:9,10,12,19,52,54
scripts/src/student-referrals.test.ts:8
scripts/src/task12-payments.test.ts:8,31
scripts/src/youtube-integration.test.ts:35
scripts/src/youtube-sync-ui.test.ts:17,18
skills-admin.html:7,8,9,30
skills/skills-enroll.html:3,8
sw.js:5,8,14,118
upgrade.html:8,9,59,66,68,70,74,75
youtube-sync.html:152,153,154,157,159,161,178,321,322,323,331
```

## Appendix B — Render host locations

Six host matches in five files:

```text
index.html:13670,13677
youtube-sync.html:168
upgrade.html:65
education/index.html:212
scripts/src/ai-assistant.test.ts:18
```