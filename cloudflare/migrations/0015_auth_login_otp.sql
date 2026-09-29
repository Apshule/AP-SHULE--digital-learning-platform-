-- One-time email login challenges. Store only a verifier, never the OTP itself.
CREATE TABLE IF NOT EXISTS login_otp_challenges (
  uid TEXT PRIMARY KEY NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  requested_at_ms INTEGER NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until_ms INTEGER NOT NULL DEFAULT 0,
  consumed_at_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_login_otp_challenges_expiry
  ON login_otp_challenges(expires_at_ms);