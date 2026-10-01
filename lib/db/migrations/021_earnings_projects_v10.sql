-- V10 Worker persistence for offline-view earnings and project/CA workflows.
-- All evidence bytes live in R2; only object keys and queryable metadata are stored here.

CREATE TABLE IF NOT EXISTS public.projects (
  id TEXT PRIMARY KEY NOT NULL,
  learner_id TEXT NOT NULL,
  learner_name TEXT NOT NULL DEFAULT '',
  school_id TEXT NOT NULL,
  class_name TEXT NOT NULL,
  subject TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  term TEXT,
  title_normalized TEXT,
  lin TEXT,
  qr_code TEXT,
  qr_data_url TEXT,
  qr_storage_url TEXT,
  qr_payload TEXT,
  qr_generated_at TIMESTAMPTZ,
  milestone_1_date TIMESTAMPTZ,
  milestone_1_photo TEXT,
  milestone_1_status TEXT NOT NULL DEFAULT 'not_started',
  milestone_1_comment TEXT,
  milestone_1_uploaded_at TIMESTAMPTZ,
  milestone_1_approved_at TIMESTAMPTZ,
  milestone_1_rejected_at TIMESTAMPTZ,
  milestone_2_date TIMESTAMPTZ,
  milestone_2_photo TEXT,
  milestone_2_status TEXT NOT NULL DEFAULT 'not_started',
  milestone_2_comment TEXT,
  milestone_2_uploaded_at TIMESTAMPTZ,
  milestone_2_approved_at TIMESTAMPTZ,
  milestone_2_rejected_at TIMESTAMPTZ,
  final_date TIMESTAMPTZ,
  final_photo TEXT,
  final_status TEXT NOT NULL DEFAULT 'not_started',
  final_comment TEXT,
  final_uploaded_at TIMESTAMPTZ,
  final_approved_at TIMESTAMPTZ,
  final_rejected_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  teacher_observed_tick BOOLEAN NOT NULL DEFAULT FALSE,
  viva_audio_path TEXT,
  viva_audio_uploaded_at TIMESTAMPTZ,
  viva_audio_milestone TEXT,
  verified_by TEXT,
  verified_at TIMESTAMPTZ,
  similarity_flag BOOLEAN NOT NULL DEFAULT FALSE,
  similarity_match_id TEXT,
  similarity_reason TEXT,
  similarity_score DOUBLE PRECISION,
  previous_title_check BOOLEAN NOT NULL DEFAULT FALSE,
  previous_title_match BOOLEAN NOT NULL DEFAULT FALSE,
  previous_title TEXT,
  previous_term TEXT,
  improvement_note TEXT,
  previous_project_id TEXT,
  photo_hashes TEXT[] NOT NULL DEFAULT '{}',
  cleared_by TEXT,
  cleared_at TIMESTAMPTZ,
  school_gps_lat DOUBLE PRECISION,
  school_gps_lng DOUBLE PRECISION,
  device_type TEXT,
  uploaded_from_connection TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.ca_records (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT,
  milestone TEXT,
  learner_id TEXT NOT NULL,
  school_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  competency TEXT NOT NULL,
  evidence_1 TEXT NOT NULL,
  evidence_2 TEXT NOT NULL,
  evidence_3 TEXT NOT NULL,
  final_level TEXT NOT NULL,
  term TEXT NOT NULL,
  teacher_id TEXT NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Keep upgrades additive when an earlier deployment created a subset of either table.
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS learner_name TEXT NOT NULL DEFAULT '';
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS school_id TEXT;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS class_name TEXT;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS subject TEXT;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS term TEXT;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS title_normalized TEXT;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS lin TEXT;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS qr_code TEXT;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS qr_data_url TEXT;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS qr_storage_url TEXT;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS qr_payload TEXT;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS qr_generated_at TIMESTAMPTZ;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS milestone_1_date TIMESTAMPTZ;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS milestone_1_photo TEXT;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS milestone_1_status TEXT NOT NULL DEFAULT 'not_started';
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS milestone_1_comment TEXT;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS milestone_1_uploaded_at TIMESTAMPTZ;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS milestone_1_approved_at TIMESTAMPTZ;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS milestone_1_rejected_at TIMESTAMPTZ;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS milestone_2_date TIMESTAMPTZ;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS milestone_2_photo TEXT;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS milestone_2_status TEXT NOT NULL DEFAULT 'not_started';
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS milestone_2_comment TEXT;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS milestone_2_uploaded_at TIMESTAMPTZ;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS milestone_2_approved_at TIMESTAMPTZ;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS milestone_2_rejected_at TIMESTAMPTZ;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS final_date TIMESTAMPTZ;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS final_photo TEXT;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS final_status TEXT NOT NULL DEFAULT 'not_started';
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS final_comment TEXT;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS final_uploaded_at TIMESTAMPTZ;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS final_approved_at TIMESTAMPTZ;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS final_rejected_at TIMESTAMPTZ;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS teacher_observed_tick BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS viva_audio_path TEXT;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS viva_audio_uploaded_at TIMESTAMPTZ;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS viva_audio_milestone TEXT;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS verified_by TEXT;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS similarity_flag BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS similarity_match_id TEXT;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS similarity_reason TEXT;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS similarity_score DOUBLE PRECISION;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS previous_title_check BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS previous_title_match BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS previous_title TEXT;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS previous_term TEXT;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS improvement_note TEXT;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS previous_project_id TEXT;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS photo_hashes TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS cleared_by TEXT;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS cleared_at TIMESTAMPTZ;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS school_gps_lat DOUBLE PRECISION;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS school_gps_lng DOUBLE PRECISION;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS device_type TEXT;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS uploaded_from_connection TEXT;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE public.ca_records ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE public.ca_records ADD COLUMN IF NOT EXISTS milestone TEXT;
ALTER TABLE public.ca_records ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.ca_records ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS projects_learner_created_at_idx ON public.projects (learner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS projects_learner_term_idx ON public.projects (learner_id, term);
CREATE INDEX IF NOT EXISTS projects_school_class_subject_idx ON public.projects (school_id, class_name, subject);
CREATE INDEX IF NOT EXISTS projects_school_term_created_at_idx ON public.projects (school_id, term, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS projects_learner_title_term_unique
  ON public.projects (learner_id, title_normalized, term) WHERE title_normalized IS NOT NULL AND term IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ca_records_project_milestone_unique
  ON public.ca_records (project_id, milestone) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ca_records_school_term_idx ON public.ca_records (school_id, term, created_at DESC);
CREATE INDEX IF NOT EXISTS ca_records_learner_idx ON public.ca_records (learner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.offline_views (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  view_id TEXT NOT NULL UNIQUE,
  student_id TEXT NOT NULL,
  teacher_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  school_id TEXT,
  device_type TEXT NOT NULL DEFAULT 'unknown',
  connection_mode TEXT NOT NULL DEFAULT 'offline',
  watched_seconds INTEGER NOT NULL DEFAULT 0,
  completion_percent INTEGER NOT NULL,
  completed BOOLEAN NOT NULL DEFAULT TRUE,
  earnings_amount INTEGER NOT NULL DEFAULT 100 CHECK (earnings_amount = 100),
  watched_at TIMESTAMPTZ NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.teacher_earnings (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  view_id TEXT NOT NULL UNIQUE,
  teacher_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  school_id TEXT,
  amount_ugx INTEGER NOT NULL CHECK (amount_ugx = 100),
  paid BOOLEAN NOT NULL DEFAULT FALSE,
  earned_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS offline_views_teacher_watched_idx ON public.offline_views (teacher_id, watched_at DESC);
CREATE INDEX IF NOT EXISTS offline_views_school_watched_idx ON public.offline_views (school_id, watched_at DESC);
CREATE INDEX IF NOT EXISTS teacher_earnings_teacher_paid_idx ON public.teacher_earnings (teacher_id, paid, earned_at DESC);