# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- Current production is still served by the Cloudflare Worker at `https://appshule.com`; GitHub Pages is not enabled. This recovery does not change live routes, DNS, or deployment settings.
- The selected release target is a GitHub Pages frontend on `appshule.com` with the Cloudflare Worker handling `/api/*`; use only after a separately approved release and route cutover.
- `pnpm run build:cloudflare` or `pnpm run build:pages` — stage the Firebase/Render-free frontend, Pages route aliases, and static assets in ignored `cloudflare/assets/`.
- `pnpm run preview:cloudflare` — run Wrangler with `wrangler.preview.toml`, local-only D1/KV/R2, and staged static assets. The API Server artifact uses this command for the Replit preview.
- `pnpm exec wrangler deploy --env production` — deploy the Cloudflare Worker when a production deployment is explicitly requested.
- `pnpm run push` and `pnpm run push:watch` are legacy site-sync tools. Do not use them for releases: the watcher force-pushes only a partial file list.
- `pnpm --filter @workspace/api-server run dev` — run the legacy Node API server directly; do not use it as the APSHULE app preview.
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Database connection: `NEON_DATABASE_URL` overrides the runtime-managed `DATABASE_URL`; use Replit Secrets for external database credentials.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

- `cloudflare/static/` is the Pages/Worker frontend source; browser API requests use same-origin `/api/...` paths.
- `cloudflare/stage-assets.mjs` stages that source for Pages and the local Worker preview. The legacy root `index.html` remains Firebase-era and is not used by the Cloudflare preview.
- Do not add Firebase/Google or Render API calls to the Cloudflare frontend. Keep payment-provider initiation on hold until credentials and approval are provided.

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Configuration

`push.config.json` (project root) holds project-level settings for the push script:

| Field   | Default | Description |
|---------|---------|-------------|
| `pager` | `""`    | Preferred pager for viewing diffs (e.g. `"delta"`, `"bat -l diff"`, `"diff-so-fancy \| less -R"`). The command is run verbatim. Empty string means the script falls back to `$PAGER`, then `less -R`. |

Example — use `delta` as your diff pager:

```json
{
  "pager": "delta"
}
```

Priority order when opening a full diff (`d` at the push prompt):
1. `pager` in `push.config.json`
2. `$PAGER` environment variable
3. `less -R` (built-in fallback — `-R` passes ANSI colours through)

The resolved command is always run verbatim, so include any flags you need directly in the `pager` value (e.g. `"bat --paging always -l diff"`).

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
