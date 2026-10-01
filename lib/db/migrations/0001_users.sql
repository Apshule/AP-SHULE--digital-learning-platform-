CREATE TABLE IF NOT EXISTS public.users (
  uid TEXT PRIMARY KEY NOT NULL,
  email TEXT,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT '',
  disabled BOOLEAN NOT NULL DEFAULT FALSE,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  password_hash TEXT,
  password_salt TEXT,
  hash_algorithm TEXT,
  custom_claims_json TEXT,
  provider_data_json TEXT,
  raw_json TEXT NOT NULL,
  requires_password_reset BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TEXT,
  last_login_at TEXT,
  imported_at TEXT NOT NULL,
  password_hash_v2 TEXT,
  password_salt_v2 TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  session_version INTEGER NOT NULL DEFAULT 1,
  school_id TEXT,
  institution_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_email ON public.users (email);
CREATE INDEX IF NOT EXISTS idx_users_role ON public.users (role);
CREATE INDEX IF NOT EXISTS idx_users_disabled ON public.users (disabled);
CREATE INDEX IF NOT EXISTS idx_users_email_lower ON public.users (lower(email));