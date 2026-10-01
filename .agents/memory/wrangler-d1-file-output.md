---
name: Wrangler D1 file output
description: Safely interpret output from remote Wrangler D1 SQL files, especially when the script contains credential-derived data.
---

For remote `wrangler d1 execute --file ... --json`, do not assume stdout is parseable JSON. A command can exit successfully while emitting progress or other non-JSON text. Verify production writes with a separate read-only query before deciding whether to retry. When a SQL file contains a password-derived hash, capture and suppress raw command output; report only sanitized status and returned non-secret fields.

**Why:** A successful D1 update returned a zero Wrangler exit code but the wrapper could not parse its stdout as JSON. A read-back query confirmed the write had succeeded, so blindly retrying could have repeated a privileged account change.

**How to apply:** After any remote D1 file mutation, inspect the command exit code and then query the affected rows using a separate read-only command. Do not include the SQL file contents or derived credential values in logs.