-- Keep vocational and school records in the shared Skills tables while
-- separating their tenant and payload ownership.
ALTER TABLE admissions ADD COLUMN type TEXT NOT NULL DEFAULT 'vocational';
ALTER TABLE admissions ADD COLUMN institution_id TEXT;
ALTER TABLE admissions ADD COLUMN school_id TEXT;
ALTER TABLE admissions ADD COLUMN record_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE admissions ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;

ALTER TABLE marks ADD COLUMN type TEXT NOT NULL DEFAULT 'vocational';
ALTER TABLE marks ADD COLUMN institution_id TEXT;
ALTER TABLE marks ADD COLUMN school_id TEXT;
ALTER TABLE marks ADD COLUMN record_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE marks ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_admissions_school_scope
  ON admissions(type, institution_id, school_id, is_deleted, updated_at);
CREATE INDEX IF NOT EXISTS idx_marks_school_scope
  ON marks(type, institution_id, school_id, is_deleted, updated_at);