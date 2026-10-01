-- Authentication challenge storage for the Cloudflare Worker.
-- User accounts are defined and migrated by 0001_users.sql.
DO $auth$
BEGIN
  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'Apply the Neon users migration before authentication tables';
  END IF;
END;
$auth$;

CREATE TABLE IF NOT EXISTS public.signup_challenges (
  email TEXT PRIMARY KEY NOT NULL,
  uid TEXT NOT NULL,
  display_name TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('student', 'teacher_staff', 'teacher_independent')),
  organization_name TEXT,
  teaching_details TEXT,
  password_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at_ms BIGINT NOT NULL,
  requested_at_ms BIGINT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until_ms BIGINT NOT NULL DEFAULT 0,
  consumed_at_ms BIGINT
);

CREATE INDEX IF NOT EXISTS idx_signup_challenges_expiry
  ON public.signup_challenges (expires_at_ms);

CREATE TABLE IF NOT EXISTS public.teacher_applications (
  id TEXT PRIMARY KEY NOT NULL,
  uid TEXT NOT NULL UNIQUE REFERENCES public.users(uid),
  application_type TEXT NOT NULL CHECK (application_type IN ('teacher_staff', 'teacher_independent')),
  organization_name TEXT,
  teaching_details TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  submitted_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT,
  review_note TEXT,
  review_claim TEXT
);

CREATE INDEX IF NOT EXISTS idx_teacher_applications_status_submitted
  ON public.teacher_applications (status, submitted_at);

CREATE TABLE IF NOT EXISTS public.login_otp_challenges (
  uid TEXT PRIMARY KEY NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at_ms BIGINT NOT NULL,
  requested_at_ms BIGINT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until_ms BIGINT NOT NULL DEFAULT 0,
  consumed_at_ms BIGINT
);

CREATE INDEX IF NOT EXISTS idx_login_otp_challenges_expiry
  ON public.login_otp_challenges (expires_at_ms);

CREATE TABLE IF NOT EXISTS public.password_reset_codes (
  uid TEXT PRIMARY KEY NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at_ms BIGINT NOT NULL,
  created_at TEXT NOT NULL,
  claim_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_password_reset_codes_expiry
  ON public.password_reset_codes (expires_at_ms);

CREATE TABLE IF NOT EXISTS public.password_reset_request_cooldowns (
  uid TEXT PRIMARY KEY NOT NULL,
  requested_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.password_reset_tickets (
  ticket_hash TEXT PRIMARY KEY NOT NULL,
  uid TEXT NOT NULL,
  expires_at_ms BIGINT NOT NULL,
  created_at TEXT NOT NULL,
  claim_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tickets_uid_expiry
  ON public.password_reset_tickets (uid, expires_at_ms);

CREATE TABLE IF NOT EXISTS public.password_reset_challenge_locks (
  uid TEXT PRIMARY KEY NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  window_started_at_ms BIGINT NOT NULL,
  locked_until_ms BIGINT NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_password_reset_challenge_locks_expiry
  ON public.password_reset_challenge_locks (locked_until_ms);