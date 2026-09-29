-- Email-verified public signup challenges and Super Admin reviewed teacher applications.
CREATE TABLE IF NOT EXISTS signup_challenges (
  email TEXT PRIMARY KEY NOT NULL,
  uid TEXT NOT NULL,
  display_name TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('student', 'teacher_staff', 'teacher_independent')),
  organization_name TEXT,
  teaching_details TEXT,
  password_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  requested_at_ms INTEGER NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until_ms INTEGER NOT NULL DEFAULT 0,
  consumed_at_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_signup_challenges_expiry
  ON signup_challenges(expires_at_ms);

CREATE TABLE IF NOT EXISTS teacher_applications (
  id TEXT PRIMARY KEY NOT NULL,
  uid TEXT NOT NULL UNIQUE REFERENCES users(uid),
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
  ON teacher_applications(status, submitted_at);