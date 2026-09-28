-- Additive migration only. Firebase remains the source of truth during shadow mode.
CREATE TABLE IF NOT EXISTS firestore_documents (
  document_path TEXT PRIMARY KEY NOT NULL,
  collection_path TEXT NOT NULL,
  firestore_name TEXT NOT NULL,
  data_json TEXT NOT NULL,
  update_time TEXT,
  create_time TEXT,
  imported_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_firestore_documents_collection
  ON firestore_documents (collection_path);

CREATE TABLE IF NOT EXISTS migration_runs (
  run_id TEXT PRIMARY KEY NOT NULL,
  source_project TEXT NOT NULL,
  source_backup TEXT NOT NULL,
  document_count INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS storage_migration_manifest (
  object_key TEXT PRIMARY KEY NOT NULL,
  source_path TEXT NOT NULL,
  content_type TEXT,
  size_bytes INTEGER,
  sha256 TEXT,
  status TEXT NOT NULL,
  imported_at TEXT
);