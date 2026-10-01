-- Additive PostgreSQL schema for vocational provider and learner routes.
-- Production rows are copied from D1 by the reviewed data migration, not seeded here.
CREATE TABLE IF NOT EXISTS public.skills_providers (
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

CREATE TABLE IF NOT EXISTS public.vocational_courses (
  id TEXT NOT NULL,
  provider_id TEXT NOT NULL REFERENCES public.skills_providers(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  duration TEXT NOT NULL DEFAULT '',
  fee_ugx INTEGER NOT NULL DEFAULT 0,
  category TEXT NOT NULL DEFAULT 'Vocational',
  featured INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (provider_id, id)
);

CREATE TABLE IF NOT EXISTS public.videos (
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

CREATE TABLE IF NOT EXISTS public.vocational_enrollments (
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

CREATE TABLE IF NOT EXISTS public.vocational_marks (
  id TEXT PRIMARY KEY NOT NULL,
  admission_id TEXT NOT NULL DEFAULT '',
  provider_id TEXT NOT NULL,
  student_id TEXT NOT NULL DEFAULT '',
  course_id TEXT NOT NULL DEFAULT '',
  course_title TEXT NOT NULL DEFAULT '',
  theory DOUBLE PRECISION NOT NULL,
  practical DOUBLE PRECISION NOT NULL,
  total DOUBLE PRECISION NOT NULL,
  grade TEXT NOT NULL,
  passed INTEGER NOT NULL DEFAULT 0,
  entered_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.certificates (
  id TEXT PRIMARY KEY NOT NULL,
  certificate_number TEXT NOT NULL UNIQUE,
  marks_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  student_id TEXT NOT NULL DEFAULT '',
  student_name TEXT NOT NULL,
  course_id TEXT NOT NULL DEFAULT '',
  course_title TEXT NOT NULL DEFAULT '',
  theory DOUBLE PRECISION NOT NULL,
  practical DOUBLE PRECISION NOT NULL,
  total DOUBLE PRECISION NOT NULL,
  grade TEXT NOT NULL,
  border_style TEXT NOT NULL DEFAULT 'double',
  border_color TEXT NOT NULL DEFAULT '#FF7A1A',
  issued_by TEXT NOT NULL DEFAULT '',
  issued_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_v10_skills_providers_status
  ON public.skills_providers (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_v10_vocational_courses_provider
  ON public.vocational_courses (provider_id, active, title);
CREATE INDEX IF NOT EXISTS idx_v10_videos_course
  ON public.videos (provider_id, course_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_v10_vocational_enrollments_provider
  ON public.vocational_enrollments (provider_id, course_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_v10_vocational_marks_enrollment
  ON public.vocational_marks (admission_id);
CREATE INDEX IF NOT EXISTS idx_v10_certificates_student
  ON public.certificates (student_id);