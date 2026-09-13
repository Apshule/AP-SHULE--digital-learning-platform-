# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- `pnpm run push` — stage `index.html`, `CNAME`, and `firebase-messaging-sw.js` and push them to GitHub in one step
- `pnpm run push:watch` — watch those same files and auto-push to GitHub on change (debounced 5 s); logs "Pushed to GitHub ✓" with a timestamp on each successful push
- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

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

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

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
