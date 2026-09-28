-- Store only a digest of each reset token and enforce one-time, expiring use.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token_hash TEXT PRIMARY KEY NOT NULL,
  uid TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT,
  claim_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_uid_expiry
  ON password_reset_tokens(uid, expires_at_ms);