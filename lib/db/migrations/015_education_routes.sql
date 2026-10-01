-- Additive PostgreSQL schema for the education platform routes.
-- Shared users, role_capabilities, audit, sector_records, parent_links,
-- education_lessons, and education_files are created by earlier migrations.

CREATE TABLE IF NOT EXISTS public.education_subscription_plans (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  amount_ugx INTEGER NOT NULL,
  duration_days INTEGER NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS public.education_platform_events (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  event_date TEXT NOT NULL,
  fee_ugx INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'published',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.education_platform_resources (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  class_name TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.education_video_mappings (
  id TEXT PRIMARY KEY NOT NULL,
  class_name TEXT NOT NULL,
  subject TEXT NOT NULL,
  youtube_url TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.education_platform_feedback (
  id TEXT PRIMARY KEY NOT NULL,
  institution_id TEXT,
  school_id TEXT,
  user_id TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.education_lesson_views (
  lesson_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  institution_id TEXT,
  school_id TEXT,
  view_day TEXT NOT NULL,
  viewed_at TEXT NOT NULL,
  PRIMARY KEY (lesson_id, user_id, view_day)
);

CREATE TABLE IF NOT EXISTS public.education_platform_settings (
  setting_key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.education_schools (
  school_id TEXT PRIMARY KEY NOT NULL,
  institution_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  contact TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  logo_url TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.education_live_lessons (
  id TEXT PRIMARY KEY NOT NULL,
  institution_id TEXT,
  school_id TEXT,
  title TEXT NOT NULL,
  class_name TEXT NOT NULL,
  subject TEXT NOT NULL,
  room_id TEXT NOT NULL UNIQUE,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  created_by TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_education_subscription_plans_active_order
  ON public.education_subscription_plans (active, display_order);
CREATE INDEX IF NOT EXISTS idx_education_platform_events_status_date
  ON public.education_platform_events (status, event_date);
CREATE INDEX IF NOT EXISTS idx_education_platform_resources_active_created
  ON public.education_platform_resources (active, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_education_video_mappings_active_class_subject
  ON public.education_video_mappings (active, class_name, subject);
CREATE INDEX IF NOT EXISTS idx_education_platform_feedback_scope
  ON public.education_platform_feedback (institution_id, school_id, created_at);
CREATE INDEX IF NOT EXISTS idx_education_lesson_views_user_day
  ON public.education_lesson_views (user_id, view_day);
CREATE INDEX IF NOT EXISTS idx_education_schools_created
  ON public.education_schools (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_education_live_lessons_scope
  ON public.education_live_lessons (institution_id, school_id, started_at DESC);