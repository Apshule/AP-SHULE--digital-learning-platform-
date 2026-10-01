-- Additive landing tables for D1 metadata and legacy admissions that have no
-- current Worker-facing PostgreSQL equivalent. Source field types and
-- nullability are retained so the D1 snapshot can be transferred losslessly.
CREATE TABLE IF NOT EXISTS public.firebase_collection_inventory (
  collection_path TEXT PRIMARY KEY NOT NULL,
  source_project TEXT NOT NULL,
  document_count INTEGER NOT NULL,
  source_file TEXT NOT NULL,
  imported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.storage_migration_manifest (
  object_key TEXT PRIMARY KEY NOT NULL,
  source_path TEXT NOT NULL,
  content_type TEXT,
  size_bytes INTEGER,
  sha256 TEXT,
  status TEXT NOT NULL,
  imported_at TEXT,
  placeholder_bytes INTEGER,
  placeholder_sha256 TEXT,
  is_placeholder INTEGER NOT NULL DEFAULT 0,
  placeholder_content_type TEXT,
  placeholder_created_at TEXT
);

CREATE TABLE IF NOT EXISTS public.legacy_admissions (
  id TEXT PRIMARY KEY NOT NULL,
  provider_id TEXT NOT NULL,
  course_id TEXT NOT NULL DEFAULT '',
  referral_code TEXT NOT NULL DEFAULT '',
  student_id TEXT NOT NULL DEFAULT '',
  full_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  education_level TEXT NOT NULL DEFAULT '',
  previous_experience TEXT NOT NULL DEFAULT '',
  amount_ugx INTEGER NOT NULL DEFAULT 20000,
  payment_reference TEXT NOT NULL DEFAULT '',
  payment_status TEXT NOT NULL DEFAULT 'pending',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'vocational',
  institution_id TEXT,
  school_id TEXT,
  record_json TEXT NOT NULL DEFAULT '{}',
  is_deleted INTEGER NOT NULL DEFAULT 0
);