-- Cloudflare-native auth, authorization, and operational records. Additive only.
ALTER TABLE users ADD COLUMN password_hash_v2 TEXT;
ALTER TABLE users ADD COLUMN password_salt_v2 TEXT;
ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN school_id TEXT;
ALTER TABLE users ADD COLUMN institution_id TEXT;

ALTER TABLE storage_migration_manifest ADD COLUMN placeholder_bytes INTEGER;
ALTER TABLE storage_migration_manifest ADD COLUMN placeholder_sha256 TEXT;
ALTER TABLE storage_migration_manifest ADD COLUMN is_placeholder INTEGER NOT NULL DEFAULT 0;
ALTER TABLE storage_migration_manifest ADD COLUMN placeholder_content_type TEXT;
ALTER TABLE storage_migration_manifest ADD COLUMN placeholder_created_at TEXT;

UPDATE users
SET requires_password_reset = 1
WHERE password_hash_v2 IS NULL
  AND (hash_algorithm IS NULL OR upper(hash_algorithm) = 'SCRYPT');

CREATE TABLE IF NOT EXISTS role_capabilities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  sector TEXT NOT NULL,
  capability TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'tenant',
  UNIQUE(role, sector, capability, scope)
);

CREATE TABLE IF NOT EXISTS sector_records (
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

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY NOT NULL,
  institution_id TEXT,
  school_id TEXT,
  payer_id TEXT,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'UGX',
  status TEXT NOT NULL DEFAULT 'pending',
  provider TEXT,
  provider_reference TEXT,
  idempotency_key TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY NOT NULL,
  institution_id TEXT,
  school_id TEXT,
  actor_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_role_capabilities_lookup ON role_capabilities(role, sector, scope);
CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users(lower(email));
CREATE INDEX IF NOT EXISTS idx_sector_records_tenant ON sector_records(institution_id, school_id);
CREATE INDEX IF NOT EXISTS idx_sector_records_owner ON sector_records(owner_uid, sector, record_type);
CREATE INDEX IF NOT EXISTS idx_payments_tenant ON payments(institution_id, school_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_idempotency ON payments(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_tenant_time ON audit(institution_id, school_id, created_at);

INSERT OR IGNORE INTO role_capabilities (role, sector, capability, scope) VALUES
  ('secretary', 'education', 'students.read', 'tenant'),
  ('secretary', 'education', 'students.manage', 'tenant'),
  ('secretary', 'education', 'attendance.manage', 'tenant'),
  ('secretary', 'education', 'admissions.manage', 'tenant'),
  ('secretary', 'education', 'reports.primary.read', 'tenant'),
  ('secretary', 'education', 'id_cards.manage', 'tenant'),
  ('secretary', 'education', 'communications.manage', 'tenant'),
  ('secretary', 'education', 'timetable.manage', 'tenant'),
  ('headteacher', 'education', 'students.read', 'tenant'),
  ('headteacher', 'education', 'students.secondary.manage', 'tenant'),
  ('headteacher', 'education', 'classes.manage', 'tenant'),
  ('headteacher', 'education', 'subjects.manage', 'tenant'),
  ('headteacher', 'education', 'marks.manage', 'tenant'),
  ('headteacher', 'education', 'grading.manage', 'tenant'),
  ('headteacher', 'education', 'teacher_assignments.manage', 'tenant'),
  ('headteacher', 'education', 'attendance.manage', 'tenant'),
  ('headteacher', 'education', 'reports.secondary.read', 'tenant'),
  ('headteacher', 'education', 'signatures.manage', 'tenant'),
  ('headteacher', 'education', 'communications.manage', 'tenant'),
  ('bursar', 'education', 'payments.manage', 'tenant'),
  ('bursar', 'education', 'fees.manage', 'tenant'),
  ('bursar', 'education', 'financial_reports.read', 'tenant'),
  ('bursar', 'education', 'reconciliation.manage', 'tenant'),
  ('bursar', 'education', 'statements.read', 'tenant'),
  ('bursar', 'education', 'statements.manage', 'tenant'),
  ('bursar', 'education', 'month_close.manage', 'tenant'),
  ('clinic_admin', 'clinic', 'records.read', 'tenant'),
  ('clinic_admin', 'clinic', 'records.manage', 'tenant'),
  ('doctor', 'clinic', 'records.read', 'tenant'),
  ('doctor', 'clinic', 'records.manage', 'tenant'),
  ('nurse', 'clinic', 'records.read', 'tenant'),
  ('nurse', 'clinic', 'records.manage', 'tenant'),
  ('receptionist', 'clinic', 'appointments.manage', 'tenant'),
  ('receptionist', 'clinic', 'patients.read', 'tenant'),
  ('pharmacist', 'clinic', 'pharmacy.manage', 'tenant'),
  ('pharmacist', 'clinic', 'patients.read', 'tenant'),
  ('patient', 'clinic', 'own.read', 'tenant'),
  ('patient', 'clinic', 'appointments.create', 'tenant'),
  ('farm_admin', 'farm', 'records.read', 'tenant'),
  ('farm_admin', 'farm', 'records.manage', 'tenant'),
  ('farm_director', 'farm', 'records.read', 'tenant'),
  ('farm_director', 'farm', 'records.manage', 'tenant'),
  ('farm_manager', 'farm', 'records.read', 'tenant'),
  ('farm_manager', 'farm', 'records.manage', 'tenant'),
  ('farm_worker', 'farm', 'records.own.read', 'tenant'),
  ('farm_worker', 'farm', 'records.own.manage', 'tenant'),
  ('mfi_admin', 'mfi', 'records.read', 'tenant'),
  ('mfi_admin', 'mfi', 'records.manage', 'tenant'),
  ('loan_officer', 'mfi', 'records.read', 'tenant'),
  ('loan_officer', 'mfi', 'loans.create', 'tenant'),
  ('loan_manager', 'mfi', 'records.read', 'tenant'),
  ('loan_manager', 'mfi', 'loans.approve', 'tenant'),
  ('loan_director', 'mfi', 'records.read', 'tenant'),
  ('loan_director', 'mfi', 'loans.approve', 'tenant'),
  ('borrower', 'mfi', 'records.own.read', 'tenant'),
  ('borrower', 'mfi', 'loans.create', 'tenant'),
  ('bursar', 'payments', 'payments.read', 'tenant'),
  ('bursar', 'payments', 'payments.create', 'tenant'),
  ('clinic_admin', 'payments', 'payments.read', 'tenant'),
  ('clinic_admin', 'payments', 'payments.create', 'tenant'),
  ('mfi_admin', 'payments', 'payments.read', 'tenant'),
  ('mfi_admin', 'payments', 'payments.create', 'tenant'),
  ('loan_officer', 'payments', 'payments.read', 'tenant'),
  ('loan_officer', 'payments', 'payments.create', 'tenant'),
  ('loan_manager', 'payments', 'payments.read', 'tenant'),
  ('loan_manager', 'payments', 'payments.create', 'tenant'),
  ('loan_director', 'payments', 'payments.read', 'tenant'),
  ('loan_director', 'payments', 'payments.create', 'tenant'),
  ('superadmin', '*', '*', 'tenant');