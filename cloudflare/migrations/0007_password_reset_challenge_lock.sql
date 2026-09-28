-- Failed reset-code attempts persist across code resends, but never disable
-- normal account login. Three failures trigger a temporary reset-only lock.
CREATE TABLE IF NOT EXISTS password_reset_challenge_locks (
  uid TEXT PRIMARY KEY NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  window_started_at_ms INTEGER NOT NULL,
  locked_until_ms INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_password_reset_challenge_locks_expiry
  ON password_reset_challenge_locks(locked_until_ms);