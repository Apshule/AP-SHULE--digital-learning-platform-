-- D1-native education platform content and legacy screenshot features.
CREATE TABLE IF NOT EXISTS education_subscription_plans (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, amount_ugx INTEGER NOT NULL,
  duration_days INTEGER NOT NULL, display_order INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS education_platform_events (
  id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, event_date TEXT NOT NULL,
  fee_ugx INTEGER NOT NULL DEFAULT 0, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'published',
  created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS education_platform_resources (
  id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL, class_name TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS education_video_mappings (
  id TEXT PRIMARY KEY NOT NULL, class_name TEXT NOT NULL, subject TEXT NOT NULL, youtube_url TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS education_platform_feedback (
  id TEXT PRIMARY KEY NOT NULL, institution_id TEXT, school_id TEXT, user_id TEXT NOT NULL,
  message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS education_lesson_views (
  lesson_id TEXT NOT NULL, user_id TEXT NOT NULL, institution_id TEXT, school_id TEXT,
  view_day TEXT NOT NULL, viewed_at TEXT NOT NULL, PRIMARY KEY (lesson_id, user_id, view_day)
);
CREATE TABLE IF NOT EXISTS education_platform_settings (
  setting_key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, updated_by TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS education_schools (
  school_id TEXT PRIMARY KEY NOT NULL, institution_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  contact TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '', logo_url TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS education_live_lessons (
  id TEXT PRIMARY KEY NOT NULL, institution_id TEXT, school_id TEXT, title TEXT NOT NULL,
  class_name TEXT NOT NULL, subject TEXT NOT NULL, room_id TEXT NOT NULL UNIQUE, started_at TEXT NOT NULL,
  ended_at TEXT, created_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_platform_feedback_scope ON education_platform_feedback(institution_id, school_id, created_at);
CREATE INDEX IF NOT EXISTS idx_live_lessons_scope ON education_live_lessons(institution_id, school_id, started_at);
INSERT OR IGNORE INTO education_subscription_plans(id,name,amount_ugx,duration_days,display_order) VALUES
 ('daily','Daily',500,1,1),('weekly','Weekly',3000,7,2),('monthly','Monthly',10000,30,3),
 ('term','Term',50000,90,4),('half-year','Half-year',80000,182,5),('full-year','Full-year',150000,365,6);