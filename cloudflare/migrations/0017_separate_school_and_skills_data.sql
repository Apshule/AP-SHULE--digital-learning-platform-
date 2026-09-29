-- Separate the APSHULE school PWA from the public Skills directory.
CREATE TABLE IF NOT EXISTS school_admissions (
  id TEXT PRIMARY KEY NOT NULL,
  student_id TEXT NOT NULL DEFAULT '',
  full_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  education_level TEXT NOT NULL DEFAULT '',
  previous_experience TEXT NOT NULL DEFAULT '',
  institution_id TEXT,
  school_id TEXT,
  status TEXT NOT NULL DEFAULT 'submitted',
  record_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL DEFAULT '',
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vocational_enrollments (
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
  record_json TEXT NOT NULL DEFAULT '{}',
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE admissions RENAME TO legacy_admissions;
ALTER TABLE marks RENAME TO legacy_marks;
ALTER TABLE providers RENAME TO skills_providers;
ALTER TABLE courses RENAME TO vocational_courses;

CREATE TABLE IF NOT EXISTS marks (
  id TEXT PRIMARY KEY NOT NULL,
  admission_id TEXT NOT NULL DEFAULT '',
  provider_id TEXT NOT NULL DEFAULT '',
  student_id TEXT NOT NULL DEFAULT '',
  course_id TEXT NOT NULL DEFAULT '',
  course_title TEXT NOT NULL DEFAULT '',
  theory REAL NOT NULL DEFAULT 0,
  practical REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  grade TEXT NOT NULL DEFAULT '',
  passed INTEGER NOT NULL DEFAULT 0,
  entered_by TEXT NOT NULL DEFAULT '',
  institution_id TEXT,
  school_id TEXT,
  learner_id TEXT NOT NULL DEFAULT '',
  class_name TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  score REAL,
  term TEXT NOT NULL DEFAULT '',
  maximum_score REAL,
  remarks TEXT NOT NULL DEFAULT '',
  record_json TEXT NOT NULL DEFAULT '{}',
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vocational_marks (
  id TEXT PRIMARY KEY NOT NULL,
  admission_id TEXT NOT NULL DEFAULT '',
  provider_id TEXT NOT NULL,
  student_id TEXT NOT NULL DEFAULT '',
  course_id TEXT NOT NULL DEFAULT '',
  course_title TEXT NOT NULL DEFAULT '',
  theory REAL NOT NULL,
  practical REAL NOT NULL,
  total REAL NOT NULL,
  grade TEXT NOT NULL,
  passed INTEGER NOT NULL DEFAULT 0,
  entered_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO school_admissions
  (id,student_id,full_name,phone,email,education_level,previous_experience,institution_id,school_id,status,record_json,created_by,is_deleted,created_at,updated_at)
SELECT id,student_id,full_name,phone,email,education_level,previous_experience,institution_id,school_id,status,record_json,'migration',is_deleted,created_at,updated_at
FROM legacy_admissions
WHERE type='school';

INSERT OR IGNORE INTO vocational_enrollments
  (id,provider_id,course_id,referral_code,student_id,full_name,phone,email,education_level,previous_experience,amount_ugx,payment_reference,payment_status,status,record_json,is_deleted,created_at,updated_at)
SELECT id,provider_id,course_id,referral_code,student_id,full_name,phone,email,education_level,previous_experience,amount_ugx,payment_reference,payment_status,status,record_json,is_deleted,created_at,updated_at
FROM legacy_admissions
WHERE type='vocational';

INSERT OR IGNORE INTO marks
  (id,admission_id,provider_id,student_id,course_id,course_title,theory,practical,total,grade,passed,entered_by,institution_id,school_id,learner_id,class_name,subject,score,term,maximum_score,remarks,record_json,is_deleted,created_at,updated_at)
SELECT id,admission_id,provider_id,student_id,course_id,course_title,theory,practical,total,grade,passed,entered_by,institution_id,school_id,
       COALESCE(json_extract(record_json,'$.learnerId'), ''),
       COALESCE(json_extract(record_json,'$.className'), ''),
       COALESCE(json_extract(record_json,'$.subject'), ''),
       json_extract(record_json,'$.score'),
       COALESCE(json_extract(record_json,'$.term'), ''),
       json_extract(record_json,'$.maximumScore'),
       COALESCE(json_extract(record_json,'$.remarks'), ''),
       record_json,is_deleted,created_at,updated_at
FROM legacy_marks
WHERE type='school';

INSERT OR IGNORE INTO vocational_marks
  (id,admission_id,provider_id,student_id,course_id,course_title,theory,practical,total,grade,passed,entered_by,created_at,updated_at)
SELECT id,admission_id,provider_id,student_id,course_id,course_title,theory,practical,total,grade,passed,entered_by,created_at,updated_at
FROM legacy_marks
WHERE type='vocational';

CREATE INDEX IF NOT EXISTS idx_school_admissions_scope
  ON school_admissions(institution_id,school_id,is_deleted,updated_at);
CREATE INDEX IF NOT EXISTS idx_school_marks_scope
  ON marks(institution_id,school_id,is_deleted,updated_at);
CREATE INDEX IF NOT EXISTS idx_vocational_enrollments_provider
  ON vocational_enrollments(provider_id,course_id,status,created_at);
CREATE INDEX IF NOT EXISTS idx_vocational_marks_enrollment
  ON vocational_marks(admission_id);