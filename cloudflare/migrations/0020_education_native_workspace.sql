-- Native education workspace relationships and lesson/file metadata.
CREATE TABLE IF NOT EXISTS parent_links (
  id TEXT PRIMARY KEY NOT NULL,
  institution_id TEXT,
  school_id TEXT,
  parent_uid TEXT NOT NULL REFERENCES users(uid),
  learner_id TEXT NOT NULL,
  relationship TEXT NOT NULL DEFAULT 'parent',
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_parent_links_active_unique
  ON parent_links(parent_uid, learner_id) WHERE active=1;
CREATE INDEX IF NOT EXISTS idx_parent_links_parent ON parent_links(parent_uid, active);
CREATE INDEX IF NOT EXISTS idx_parent_links_learner ON parent_links(learner_id, active);

CREATE TABLE IF NOT EXISTS education_lessons (
  id TEXT PRIMARY KEY NOT NULL,
  institution_id TEXT,
  school_id TEXT,
  owner_uid TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  class_name TEXT NOT NULL,
  subject TEXT NOT NULL,
  youtube_url TEXT NOT NULL DEFAULT '',
  published INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_education_lessons_scope
  ON education_lessons(institution_id, school_id, class_name, subject, published);

CREATE TABLE IF NOT EXISTS education_files (
  id TEXT PRIMARY KEY NOT NULL,
  lesson_id TEXT NOT NULL REFERENCES education_lessons(id) ON DELETE CASCADE,
  institution_id TEXT,
  school_id TEXT,
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/pdf',
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_education_files_lesson ON education_files(lesson_id);

INSERT OR IGNORE INTO role_capabilities(role,sector,capability,scope) VALUES
 ('student','education','lessons.read','tenant'),
 ('learner','education','lessons.read','tenant'),
 ('teacher','education','lessons.manage','tenant'),
 ('secretary','education','lessons.manage','tenant'),
 ('secretary','education','parent_links.manage','tenant'),
 ('headteacher','education','lessons.manage','tenant'),
 ('headteacher','education','parent_links.manage','tenant'),
 ('parent','education','lessons.read','tenant');