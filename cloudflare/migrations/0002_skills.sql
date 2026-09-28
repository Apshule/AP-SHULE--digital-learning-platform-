CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  logo_url TEXT NOT NULL DEFAULT '',
  badge_url TEXT NOT NULL DEFAULT '',
  physical_address TEXT NOT NULL DEFAULT '',
  contact_email TEXT NOT NULL DEFAULT '',
  contact_phone TEXT NOT NULL DEFAULT '',
  referral_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  owner_id TEXT NOT NULL DEFAULT '',
  admission_fee_ugx INTEGER NOT NULL DEFAULT 20000,
  admission_split_apshule INTEGER NOT NULL DEFAULT 40,
  admission_split_company INTEGER NOT NULL DEFAULT 60,
  course_split_apshule INTEGER NOT NULL DEFAULT 30,
  course_split_company INTEGER NOT NULL DEFAULT 70,
  agreement_note TEXT NOT NULL DEFAULT '',
  agreement_doc_url TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS courses (
  id TEXT NOT NULL,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  duration TEXT NOT NULL DEFAULT '',
  fee_ugx INTEGER NOT NULL DEFAULT 0,
  category TEXT NOT NULL DEFAULT 'Vocational',
  featured INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (provider_id, id)
);

CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY NOT NULL,
  provider_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  youtube_url TEXT NOT NULL DEFAULT '',
  youtube_id TEXT NOT NULL DEFAULT '',
  thumbnail_url TEXT NOT NULL DEFAULT '',
  raw_object_key TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'vocational',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admissions (
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
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS marks (
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

CREATE TABLE IF NOT EXISTS certificates (
  id TEXT PRIMARY KEY NOT NULL,
  certificate_number TEXT NOT NULL UNIQUE,
  marks_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  student_id TEXT NOT NULL DEFAULT '',
  student_name TEXT NOT NULL,
  course_id TEXT NOT NULL DEFAULT '',
  course_title TEXT NOT NULL DEFAULT '',
  theory REAL NOT NULL,
  practical REAL NOT NULL,
  total REAL NOT NULL,
  grade TEXT NOT NULL,
  border_style TEXT NOT NULL DEFAULT 'double',
  border_color TEXT NOT NULL DEFAULT '#FF7A1A',
  issued_by TEXT NOT NULL DEFAULT '',
  issued_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payouts (
  id TEXT PRIMARY KEY NOT NULL,
  provider_id TEXT NOT NULL,
  amount_ugx INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unpaid',
  payment_reference TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  paid_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_providers_status ON providers(status);
CREATE INDEX IF NOT EXISTS idx_courses_provider ON courses(provider_id);
CREATE INDEX IF NOT EXISTS idx_videos_course ON videos(provider_id, course_id);
CREATE INDEX IF NOT EXISTS idx_admissions_provider ON admissions(provider_id);
CREATE INDEX IF NOT EXISTS idx_marks_admission ON marks(admission_id);
CREATE INDEX IF NOT EXISTS idx_certificates_student ON certificates(student_id);

INSERT OR IGNORE INTO providers
  (id, name, description, logo_url, physical_address, contact_email, contact_phone, referral_code, status, created_at, updated_at)
VALUES
  ('provider-obote-auto-garage', 'OBOTE AUTO GARAGE',
   'A practical vehicle-repair and automotive maintenance garage in Wakiso.',
   '/skills/assets/obote-auto-garage.jpg', 'Wakiso, behind the former Centenary',
   'Ssenyonjonelson1@gmail.com', '0704 736 649', 'OBOTE-AUTO-GARAGE-WAKISO', 'active',
   '2026-09-18T01:55:46.638Z', '2026-09-18T01:55:46.638Z'),
  ('provider-bakery-kampala-42', 'BAKERY KAMPALA 42',
   'Vocational baking and pastry skills training in Kampala.',
   '', 'Kampala, Uganda', '', '', 'BAKERY-KAMPALA-42', 'active',
   '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z'),
  ('provider-tailor-wakiso-15', 'TAILOR WAKISO 15',
   'Practical tailoring and garment construction skills in Wakiso.',
   '', 'Wakiso, Uganda', '', '', 'TAILOR-WAKISO-15', 'active',
   '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z');

INSERT OR IGNORE INTO courses
  (id, provider_id, title, description, duration, fee_ugx, category, featured)
VALUES
  ('course-1', 'provider-obote-auto-garage', 'Motor Vehicle Mechanics',
   'Hands-on fundamentals of vehicle servicing, repair, workshop safety, and maintenance.',
   '6 months', 0, 'Automotive Mechanics', 0),
  ('course-2', 'provider-obote-auto-garage', 'Automotive Electrical Systems',
   'Diagnose and repair vehicle wiring, batteries, charging systems, starting systems, and lighting.',
   '3 months', 0, 'Auto Electrical', 0),
  ('course-1', 'provider-bakery-kampala-42', 'Baking and Pastry Skills',
   'Practical baking, pastry preparation, food safety, and small bakery operations.',
   '3 months', 150000, 'Bakery', 1),
  ('course-1', 'provider-tailor-wakiso-15', 'Tailoring and Garment Construction',
   'Practical garment construction, measurements, machine handling, and finishing.',
   '4 months', 180000, 'Tailoring', 1);