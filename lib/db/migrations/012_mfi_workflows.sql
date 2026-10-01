-- Additive PostgreSQL storage for the MFI workflow and its imported legacy records.
CREATE TABLE IF NOT EXISTS public.role_capabilities (
  id BIGSERIAL PRIMARY KEY,
  role TEXT NOT NULL,
  sector TEXT NOT NULL,
  capability TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'tenant',
  UNIQUE (role, sector, capability, scope)
);

CREATE TABLE IF NOT EXISTS public.sector_records (
  id TEXT PRIMARY KEY NOT NULL,
  sector TEXT NOT NULL,
  institution_id TEXT,
  school_id TEXT,
  owner_uid TEXT,
  record_type TEXT NOT NULL,
  record_json TEXT NOT NULL,
  created_by TEXT,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.firestore_documents (
  document_path TEXT PRIMARY KEY NOT NULL,
  collection_path TEXT NOT NULL,
  firestore_name TEXT NOT NULL,
  data_json TEXT NOT NULL,
  update_time TEXT,
  create_time TEXT,
  imported_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_role_capabilities_lookup
  ON public.role_capabilities (lower(role), sector);
CREATE INDEX IF NOT EXISTS idx_sector_records_tenant
  ON public.sector_records (institution_id, school_id);
CREATE INDEX IF NOT EXISTS idx_sector_records_owner
  ON public.sector_records (owner_uid, sector, record_type);
CREATE INDEX IF NOT EXISTS idx_sector_records_mfi_lookup
  ON public.sector_records (institution_id, record_type, updated_at DESC)
  WHERE sector = 'mfi' AND is_deleted = 0;
CREATE INDEX IF NOT EXISTS idx_firestore_documents_collection
  ON public.firestore_documents (collection_path);

INSERT INTO public.role_capabilities (role, sector, capability, scope) VALUES
  ('mfi_admin', 'mfi', 'records.read', 'tenant'),
  ('mfi_admin', 'mfi', 'records.manage', 'tenant'),
  ('loan_officer', 'mfi', 'records.read', 'tenant'),
  ('loan_officer', 'mfi', 'loans.create', 'tenant'),
  ('loan_manager', 'mfi', 'records.read', 'tenant'),
  ('loan_manager', 'mfi', 'loans.approve', 'tenant'),
  ('loan_director', 'mfi', 'records.read', 'tenant'),
  ('loan_director', 'mfi', 'loans.approve', 'tenant'),
  ('borrower', 'mfi', 'records.own.read', 'tenant'),
  ('borrower', 'mfi', 'loans.create', 'tenant')
ON CONFLICT (role, sector, capability, scope) DO NOTHING;