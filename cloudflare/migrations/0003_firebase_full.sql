-- Full Firebase migration storage. Firebase remains the source of truth until
-- endpoint parity and reconciliation are complete.
CREATE TABLE IF NOT EXISTS firebase_collection_inventory (
  collection_path TEXT PRIMARY KEY NOT NULL,
  source_project TEXT NOT NULL,
  document_count INTEGER NOT NULL,
  source_file TEXT NOT NULL,
  imported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  uid TEXT PRIMARY KEY NOT NULL,
  email TEXT,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT '',
  disabled INTEGER NOT NULL DEFAULT 0,
  email_verified INTEGER NOT NULL DEFAULT 0,
  password_hash TEXT,
  password_salt TEXT,
  hash_algorithm TEXT,
  custom_claims_json TEXT,
  provider_data_json TEXT,
  raw_json TEXT NOT NULL,
  requires_password_reset INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  last_login_at TEXT,
  imported_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_disabled ON users(disabled);