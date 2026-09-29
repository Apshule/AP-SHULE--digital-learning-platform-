# APSHULE September 23 recovery baseline

## Compared checkpoints

- **Pre-migration:** `7b64cfe5eec4621f7531cf3216b58b0ee2ad1b5f`, September 23, 2026 at 10:37 UTC.
- **End of September 23:** `cbcef5356514480c4a12b10eb482624c7e74c2b5`, September 23, 2026 at 15:33 UTC.

The root application and Education files are materially the same at both checkpoints: the root shell was about 19,834 lines, and the Education entry files were 231 and 1,033 lines. Both contain the broad landing/app shell, student and teacher workspaces, Command Center, live lessons, resources, curriculum and project tools, plus MFI, clinic, and farm sections. The education page also has role-aware school and bursar paths.

The meaningful change was the service boundary, not the screen inventory:

| Area | Before the migration | End of September 23 |
| --- | --- | --- |
| Frontend | Broad, Firebase-backed root and Education interfaces | Same interfaces; Firebase SDKs remain in the root |
| Worker | Read-only Firebase shadow/migration endpoints | Static routing and vocational provider, course, admission, mark, and certificate endpoints |
| Data migration | D1 shadow setup | D1 inventory/import tables and migration scripts, but no demonstrated full application-data parity |
| Payments and writes | Legacy integrations | `/api/pay` returns 503; selected skill writes require a configured application token |

## Recommendation

Use the **pre-migration UI as the recovery baseline** because it is the best-supported record of the requested complete experience. Use the later Cloudflare work as a reference for the intended D1/Worker boundary, not as proof that the full Firebase migration was finished.

For a Firebase/Render-free preview, this recovery serves the current `cloudflare/static/` workspace pages through the local Cloudflare Worker and local D1 schema. The Pages build uses that same static source, same-origin `/api/*` calls, generated role aliases, and `.nojekyll`; it does not publish the legacy root `index.html`.

## Historical evidence

- `screenshots/task-146-root.jpg` shows the four-sector landing page; `screenshots/task-146-education.jpg` shows the separate Education workspace and secure-login entry.
- June 2 task records include the live-lesson approval/notification work, Super Admin submissions/profile work, and DPO sandbox integration.
- September 13–19 task records include project-integrity work, Video Studio foundation, education/Bursar checks, and sector role/security verification requests.
- September 23 task records proposed a traffic switch, storage transfer, data reconciliation, and moving remaining APIs off Firebase; these were not completed in the end-of-day migration commit.
- The September 23 vocational archive preserves its own source and restore notes; it does not establish that the other sectors were migrated.

## Verified recovery boundaries

- The preview and Pages bundle use Cloudflare static source and local Worker bindings; local D1 migrations apply to `.wrangler/state`, not the configured production D1.
- Clinic, farm, MFI, education-role, authentication, push, profile, and domain APIs have existing focused tests. A new Worker-router test covers static/API precedence, role aliases, redirects, preflight, health, and unknown paths.
- **Not verified or not available:** historical production record counts, authenticated email/OTP delivery, provider writes without the local application token, and payment initiation. The current payment route intentionally returns 503 until separately configured.
- Legacy live lesson/video studio, curriculum, and project workflows remain in the historical Firebase-backed application and do not have complete Cloudflare/D1 parity in this recovery.
- GitHub Pages deployment, the `appshule.com` custom-domain setting, DNS, and production Worker route changes remain untouched. The existing production route configuration still sends all paths to the Worker; a separately approved release must switch the frontend origin to Pages and narrow Worker routing to API paths.