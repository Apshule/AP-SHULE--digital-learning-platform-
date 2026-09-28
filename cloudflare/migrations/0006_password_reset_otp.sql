-- Store password reset OTP verifiers, resend cooldowns, and short-lived
-- post-verification tickets separately from the retired link-token table.
CREATE TABLE IF NOT EXISTS password_reset_codes (
  uid TEXT PRIMARY KEY NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  claim_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_password_reset_codes_expiry
  ON password_reset_codes(expires_at_ms);

CREATE TABLE IF NOT EXISTS password_reset_request_cooldowns (
  uid TEXT PRIMARY KEY NOT NULL,
  requested_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS password_reset_tickets (
  ticket_hash TEXT PRIMARY KEY NOT NULL,
  uid TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  claim_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tickets_uid_expiry
  ON password_reset_tickets(uid, expires_at_ms);