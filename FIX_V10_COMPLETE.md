# V10 Migration Status

**Status:** VERIFIED — migrations 020–024 and the analytics schema were verified against Neon development; the production Worker health endpoint was verified against Neon with 132 users. No production database migration or data write was performed.

## Implemented

- Added Neon-backed settings, timetable, institution, and analytics routes with tenant-scoped R2 operations.
- Added migration 024 for the settings, timetable, and institution schema.
- Kept global NCDC catalogue rows tenant-neutral with SQL `NULL`; restricted institution logo references to their own R2 prefix.
- Storage estimates return aggregate usage only; they do not expose R2 object keys.
- Corrected Neon query usage in the education and MFI workflow routes and updated the MFI test fixture to use a Neon mock.
- Added a development-only, read-only Neon health snapshot for local Wrangler previews; the Worker response identifies the snapshot source and check time. Production health continues to query Neon directly.

## Verification (2026-10-01)

- `pnpm run test:cloudflare:assets` passed: 8 tests.
- Cloudflare Vitest suites passed: 103 tests across 13 files. The separate Node test-runner suites passed: 27 tests. Node-based files are run separately from Vitest.
- `PORT=8787 node cloudflare/preview.mjs` started Wrangler in local mode. `/api/health` returned HTTP 200 with `environment: development`, 132 users, 69 public tables, and `healthSource: read-only-development-startup-snapshot`.
- The API Server workflow was restarted with local D1/KV/R2 bindings and its `/api/health` also returned HTTP 200 using the development snapshot.
- Migrations 020–024 were applied to the Neon development database only. Read-only checks confirmed 132 users and 69 public tables.
- Development schema validation found all 22 expected migration tables and no missing required analytics/V10 columns. Read-only 90-day samples of `offline_views` and `teacher_earnings` returned zero rows, so schema compatibility passed but there is no recent development activity to validate populated analytics.
- These are the only 020–024 migrations present locally; 025–034 are not present.
- No production database migration or data write was performed. The production Worker was deployed after explicit approval; see the live health checks below. The GitHub Pages workflow stages static assets and does not deploy Wrangler Workers.

## Production read-only checks (2026-10-01)

- The last read-only production check found 132 users in both D1 and Neon (`rows_written: 0`, `changed_db: false`).
- The last production analytics check passed 9 of 10 probe groups. The offline-view query failed because `public.offline_views` was absent in production at that time; migration 021 has only been applied to development in this remediation.
- R2 verification was intentionally skipped as requested. `wrangler.toml` configures the `FILES` binding to `apshule-storage`; this confirms the configured name, not remote bucket existence or contents. Do not report the bucket as verified or expose object keys.
- Live URL checks: `https://appshule.com` returned 200; `/tech/` and `/skills/` returned 200; `/learn/`, `/my-account/`, and `/api/health` returned 404. `https://apshule.com/` returned 503.
- The sanitized release is published on `origin/main`; the original local `main` history was left unchanged. GitHub Pages publication and Cloudflare Worker deployment are separate.

## Production Worker deployment (2026-10-02)

- Deployed `apshule-skills-production` with `pnpm exec wrangler deploy --env production`; Cloudflare version ID: `dedcc0ff-307b-4f88-9561-9217844cde13`.
- Worker URL: `https://apshule-skills-production.apshule-migration.workers.dev/`.
- Health URL: `https://apshule-skills-production.apshule-migration.workers.dev/api/health` returned HTTP 200 with `status: ok`, `env: production`, `db: neon`, and `users: 132` (49 public tables).
- Custom health URLs also returned HTTP 200 with the same required fields: `https://appshule.com/api/health` and `https://www.appshule.com/api/health`.
- Configured the existing `NEON_DATABASE_URL` as a Cloudflare Worker secret. Its value is not recorded here. The health check performs read-only queries.
- No production database migrations or data writes were run. R2 verification remains intentionally skipped.

## Production checks still pending

- If later authorized, obtain read-only R2 listing access and verify aggregate object metadata without displaying object keys.
- Apply Neon migrations 020–024 to production only after explicit approval, then rerun the analytics probes and user-count checks.
- Recheck the earlier `/learn/` and `/my-account/` 404s and `https://apshule.com/` 503. The production Worker health URLs were verified HTTP 200 after the deployment above.
- Do not remove the D1 binding or change Worker storage bindings as part of this verification; the current Wrangler configuration consistently maps `FILES` to `apshule-storage`.

## GitHub Pages incident

The supplied commit `af2a618` and Actions run `3693437609` were not found. The actual Auto Push Watcher commit was `ef2eb10b979db8668121f1d601453c29d8dc9adb`; it contained only the PWA/site files `.nojekyll`, `_nojekyll`, `index.html`, `pwa-push-handlers.js`, and `sw.js`, not the V10 Worker changes. GitHub Pages run `36904370509` completed successfully. The watcher was stopped and no rollback was attempted; the later sanitized release is documented above.

Do not push, deploy, apply migrations to production, or make production writes without the user's explicit approval. Obtain approval before any remote execution needed for a future production R2 audit.