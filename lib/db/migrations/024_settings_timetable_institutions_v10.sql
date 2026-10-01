-- Additive Neon storage for offline settings, school timetables, and institution branding.
CREATE TABLE IF NOT EXISTS public.offline_settings (
  user_id TEXT PRIMARY KEY NOT NULL,
  hd_only_wifi BOOLEAN NOT NULL DEFAULT TRUE,
  auto_sync_wifi BOOLEAN NOT NULL DEFAULT TRUE,
  auto_sync_mobile BOOLEAN NOT NULL DEFAULT FALSE,
  language TEXT NOT NULL DEFAULT 'english',
  data_used_mb INTEGER NOT NULL DEFAULT 0,
  total_mb INTEGER NOT NULL DEFAULT 45,
  last_sync TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT offline_settings_language_check CHECK (
    language IN ('english','luganda','lusoga','runyankore','runyoro','acholi','swahili')
  )
);

CREATE TABLE IF NOT EXISTS public.school_timetable_config (
  school_id TEXT PRIMARY KEY NOT NULL,
  periods_per_day INTEGER NOT NULL DEFAULT 8 CHECK (periods_per_day BETWEEN 1 AND 16),
  days_per_week INTEGER NOT NULL DEFAULT 5 CHECK (days_per_week BETWEEN 1 AND 6),
  start_time TIME NOT NULL DEFAULT '08:00',
  period_minutes INTEGER NOT NULL DEFAULT 40 CHECK (period_minutes BETWEEN 20 AND 120),
  break_after_period INTEGER,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.school_classes (
  id TEXT PRIMARY KEY NOT NULL,
  school_id TEXT NOT NULL,
  class_name TEXT NOT NULL,
  class_level TEXT NOT NULL,
  stream TEXT NOT NULL DEFAULT '',
  room TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (school_id, class_name)
);

CREATE TABLE IF NOT EXISTS public.school_subjects (
  id TEXT PRIMARY KEY NOT NULL,
  school_id TEXT,
  subject_code TEXT NOT NULL DEFAULT '',
  subject_name TEXT NOT NULL,
  class_level TEXT NOT NULL,
  periods_per_week INTEGER NOT NULL DEFAULT 3 CHECK (periods_per_week BETWEEN 1 AND 30),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.timetable_teacher_duty (
  id TEXT PRIMARY KEY NOT NULL,
  school_id TEXT NOT NULL,
  class_id TEXT,
  class_level TEXT,
  subject_id TEXT NOT NULL,
  teacher_id TEXT NOT NULL,
  periods_per_week INTEGER NOT NULL DEFAULT 3 CHECK (periods_per_week BETWEEN 1 AND 30),
  room TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.school_timetables (
  id TEXT PRIMARY KEY NOT NULL,
  school_id TEXT NOT NULL,
  class_id TEXT NOT NULL,
  class_name TEXT NOT NULL,
  day TEXT NOT NULL,
  period INTEGER NOT NULL,
  subject_id TEXT NOT NULL,
  subject_name TEXT NOT NULL,
  teacher_id TEXT NOT NULL,
  teacher_name TEXT NOT NULL DEFAULT '',
  room TEXT NOT NULL DEFAULT '',
  term TEXT NOT NULL,
  start_time TIME,
  end_time TIME,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (school_id, class_id, day, period, term)
);

CREATE TABLE IF NOT EXISTS public.school_combined_periods (
  id TEXT PRIMARY KEY NOT NULL,
  school_id TEXT NOT NULL,
  class_id TEXT NOT NULL,
  day TEXT NOT NULL,
  period INTEGER NOT NULL,
  subject_id TEXT NOT NULL,
  teacher_id TEXT NOT NULL,
  room TEXT NOT NULL DEFAULT '',
  term TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.school_timetable_expected_outcomes (
  id TEXT PRIMARY KEY NOT NULL,
  school_id TEXT,
  subject_id TEXT NOT NULL,
  class_level TEXT NOT NULL,
  outcome_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.institutions (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('school','mfi','clinic','farm')),
  logo_url TEXT NOT NULL DEFAULT '',
  logo_object_key TEXT NOT NULL DEFAULT '',
  subdomain TEXT NOT NULL DEFAULT '',
  contact_phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  district TEXT NOT NULL DEFAULT '',
  branding_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS offline_settings_updated_idx
  ON public.offline_settings (updated_at DESC);
CREATE INDEX IF NOT EXISTS school_classes_school_level_idx
  ON public.school_classes (school_id, class_level, class_name);
CREATE INDEX IF NOT EXISTS school_subjects_scope_level_idx
  ON public.school_subjects (school_id, class_level, subject_name);
CREATE INDEX IF NOT EXISTS timetable_teacher_duty_scope_idx
  ON public.timetable_teacher_duty (school_id, class_level, subject_id, active);
CREATE INDEX IF NOT EXISTS school_timetables_scope_term_idx
  ON public.school_timetables (school_id, term, class_id, day, period);
CREATE INDEX IF NOT EXISTS school_timetables_teacher_idx
  ON public.school_timetables (school_id, term, teacher_id, day, period);
CREATE INDEX IF NOT EXISTS school_timetable_outcomes_subject_idx
  ON public.school_timetable_expected_outcomes (subject_id, class_level);
CREATE INDEX IF NOT EXISTS institutions_type_name_idx
  ON public.institutions (type, name);

INSERT INTO public.school_subjects
  (id, school_id, subject_code, subject_name, class_level, periods_per_week)
VALUES
  ('ncdc-p1-literacy',NULL, 'LIT','Literacy','P1',5),
  ('ncdc-p1-mathematics',NULL, 'MATH','Mathematics','P1',5),
  ('ncdc-p1-english',NULL, 'ENG','English','P1',3),
  ('ncdc-p1-integrated-science',NULL, 'SCI','Integrated Science','P1',3),
  ('ncdc-p1-social-studies',NULL, 'SST','Social Studies','P1',3),
  ('ncdc-p2-literacy',NULL, 'LIT','Literacy','P2',5),
  ('ncdc-p2-mathematics',NULL, 'MATH','Mathematics','P2',5),
  ('ncdc-p2-english',NULL, 'ENG','English','P2',3),
  ('ncdc-p2-integrated-science',NULL, 'SCI','Integrated Science','P2',3),
  ('ncdc-p2-social-studies',NULL, 'SST','Social Studies','P2',3),
  ('ncdc-p3-literacy',NULL, 'LIT','Literacy','P3',5),
  ('ncdc-p3-mathematics',NULL, 'MATH','Mathematics','P3',5),
  ('ncdc-p3-english',NULL, 'ENG','English','P3',3),
  ('ncdc-p3-integrated-science',NULL, 'SCI','Integrated Science','P3',3),
  ('ncdc-p3-social-studies',NULL, 'SST','Social Studies','P3',3),
  ('ncdc-p4-english',NULL, 'ENG','English','P4',5),
  ('ncdc-p4-mathematics',NULL, 'MATH','Mathematics','P4',5),
  ('ncdc-p4-science',NULL, 'SCI','Science','P4',4),
  ('ncdc-p4-social-studies',NULL, 'SST','Social Studies','P4',4),
  ('ncdc-p5-english',NULL, 'ENG','English','P5',5),
  ('ncdc-p5-mathematics',NULL, 'MATH','Mathematics','P5',5),
  ('ncdc-p5-science',NULL, 'SCI','Science','P5',4),
  ('ncdc-p5-social-studies',NULL, 'SST','Social Studies','P5',4),
  ('ncdc-p6-english',NULL, 'ENG','English','P6',5),
  ('ncdc-p6-mathematics',NULL, 'MATH','Mathematics','P6',5),
  ('ncdc-p6-science',NULL, 'SCI','Science','P6',4),
  ('ncdc-p6-social-studies',NULL, 'SST','Social Studies','P6',4),
  ('ncdc-p7-english',NULL, 'ENG','English','P7',5),
  ('ncdc-p7-mathematics',NULL, 'MATH','Mathematics','P7',5),
  ('ncdc-p7-science',NULL, 'SCI','Science','P7',4),
  ('ncdc-p7-social-studies',NULL, 'SST','Social Studies','P7',4),
  ('ncdc-s1-english',NULL, 'ENG','English','S1',5),
  ('ncdc-s1-mathematics',NULL, 'MATH','Mathematics','S1',5),
  ('ncdc-s1-biology',NULL, 'BIO','Biology','S1',4),
  ('ncdc-s1-chemistry',NULL, 'CHEM','Chemistry','S1',4),
  ('ncdc-s1-physics',NULL, 'PHY','Physics','S1',4),
  ('ncdc-s1-geography',NULL, 'GEO','Geography','S1',3),
  ('ncdc-s1-history',NULL, 'HIST','History','S1',3),
  ('ncdc-s1-ict',NULL, 'ICT','ICT','S1',2),
  ('ncdc-s2-english',NULL, 'ENG','English','S2',5),
  ('ncdc-s2-mathematics',NULL, 'MATH','Mathematics','S2',5),
  ('ncdc-s2-biology',NULL, 'BIO','Biology','S2',4),
  ('ncdc-s2-chemistry',NULL, 'CHEM','Chemistry','S2',4),
  ('ncdc-s2-physics',NULL, 'PHY','Physics','S2',4),
  ('ncdc-s2-geography',NULL, 'GEO','Geography','S2',3),
  ('ncdc-s2-history',NULL, 'HIST','History','S2',3),
  ('ncdc-s2-ict',NULL, 'ICT','ICT','S2',2),
  ('ncdc-s3-english',NULL, 'ENG','English','S3',5),
  ('ncdc-s3-mathematics',NULL, 'MATH','Mathematics','S3',5),
  ('ncdc-s3-biology',NULL, 'BIO','Biology','S3',4),
  ('ncdc-s3-chemistry',NULL, 'CHEM','Chemistry','S3',4),
  ('ncdc-s3-physics',NULL, 'PHY','Physics','S3',4),
  ('ncdc-s3-geography',NULL, 'GEO','Geography','S3',3),
  ('ncdc-s3-history',NULL, 'HIST','History','S3',3),
  ('ncdc-s3-entrepreneurship',NULL, 'ENT','Entrepreneurship','S3',2),
  ('ncdc-s4-english',NULL, 'ENG','English','S4',5),
  ('ncdc-s4-mathematics',NULL, 'MATH','Mathematics','S4',5),
  ('ncdc-s4-biology',NULL, 'BIO','Biology','S4',4),
  ('ncdc-s4-chemistry',NULL, 'CHEM','Chemistry','S4',4),
  ('ncdc-s4-physics',NULL, 'PHY','Physics','S4',4),
  ('ncdc-s4-geography',NULL, 'GEO','Geography','S4',3),
  ('ncdc-s4-history',NULL, 'HIST','History','S4',3),
  ('ncdc-s4-entrepreneurship',NULL, 'ENT','Entrepreneurship','S4',2),
  ('ncdc-s5-english',NULL, 'ENG','English','S5',5),
  ('ncdc-s5-mathematics',NULL, 'MATH','Mathematics','S5',5),
  ('ncdc-s5-biology',NULL, 'BIO','Biology','S5',4),
  ('ncdc-s5-chemistry',NULL, 'CHEM','Chemistry','S5',4),
  ('ncdc-s5-physics',NULL, 'PHY','Physics','S5',4),
  ('ncdc-s5-geography',NULL, 'GEO','Geography','S5',3),
  ('ncdc-s5-history',NULL, 'HIST','History','S5',3),
  ('ncdc-s5-literature',NULL, 'LIT','Literature','S5',3),
  ('ncdc-s6-english',NULL, 'ENG','English','S6',5),
  ('ncdc-s6-mathematics',NULL, 'MATH','Mathematics','S6',5),
  ('ncdc-s6-biology',NULL, 'BIO','Biology','S6',4),
  ('ncdc-s6-chemistry',NULL, 'CHEM','Chemistry','S6',4),
  ('ncdc-s6-physics',NULL, 'PHY','Physics','S6',4),
  ('ncdc-s6-geography',NULL, 'GEO','Geography','S6',3),
  ('ncdc-s6-history',NULL, 'HIST','History','S6',3),
  ('ncdc-s6-literature',NULL, 'LIT','Literature','S6',3)
ON CONFLICT (id) DO NOTHING;

-- NULL school_id marks shared catalogue content.
INSERT INTO public.school_timetable_expected_outcomes
  (id, school_id, subject_id, class_level, outcome_text)
SELECT
  'ncdc-outcome-' || id,
  NULL,
  id,
  class_level,
  'Apply age-appropriate ' || subject_name || ' knowledge and skills to practical activities and related problems.'
FROM public.school_subjects
WHERE school_id IS NULL
ON CONFLICT (id) DO NOTHING;