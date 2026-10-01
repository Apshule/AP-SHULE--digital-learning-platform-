-- Additive schema for Video Studio metadata, R2 object metadata, and education referrals.
-- Uploaded bytes are stored in R2 only; these tables retain metadata and object keys.
CREATE TABLE IF NOT EXISTS public.sample_videos (
  id TEXT PRIMARY KEY NOT NULL,
  institution_id TEXT,
  school_id TEXT,
  title TEXT NOT NULL,
  topic TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  class_level TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL CHECK (mode IN ('cartoon','auto_ai','teacher_twin')),
  language TEXT NOT NULL CHECK (language IN ('english','luganda','lusoga','runyankore','runyoro','acholi','swahili')),
  script_text TEXT NOT NULL DEFAULT '',
  translated_script TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','generating','ready','published','failed')),
  object_key TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.sample_video_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  video_id TEXT NOT NULL REFERENCES public.sample_videos(id),
  mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','failed')),
  current_step TEXT NOT NULL DEFAULT 'queued',
  error_message TEXT NOT NULL DEFAULT '',
  requested_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sample_video_jobs_open
  ON public.sample_video_jobs(video_id) WHERE status IN ('pending','in_progress');

CREATE TABLE IF NOT EXISTS public.cartoon_assets (
  id TEXT PRIMARY KEY NOT NULL,
  institution_id TEXT,
  school_id TEXT,
  character_type TEXT NOT NULL CHECK (character_type IN ('boy','girl','teacher_mama','teacher_mzee')),
  pose TEXT NOT NULL CHECK (pose IN ('standing','pointing','writing','smiling','talking')),
  object_key TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.media_uploads (
  object_key TEXT PRIMARY KEY NOT NULL,
  institution_id TEXT,
  school_id TEXT,
  owner_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('cartoon_asset','sample_video')),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/png','image/jpeg','image/webp','video/mp4','video/webm')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 8388608),
  sha256 TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.media_referral_codes (
  code TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('school','student','teacher')),
  institution_id TEXT,
  school_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS public.media_referral_rewards (
  id TEXT PRIMARY KEY NOT NULL,
  referral_code TEXT NOT NULL REFERENCES public.media_referral_codes(code),
  referrer_id TEXT NOT NULL,
  referred_user_id TEXT NOT NULL,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('school','student','teacher')),
  reward_type TEXT NOT NULL,
  amount_ugx INTEGER NOT NULL DEFAULT 0 CHECK (amount_ugx >= 0),
  currency TEXT NOT NULL DEFAULT 'UGX',
  status TEXT NOT NULL CHECK (status IN ('pending','tracked')),
  payment_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(referral_code,referred_user_id)
);
CREATE TABLE IF NOT EXISTS public.media_referral_balances (
  owner_id TEXT PRIMARY KEY NOT NULL,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('school','student','teacher')),
  institution_id TEXT,
  school_id TEXT,
  balance_ugx BIGINT NOT NULL DEFAULT 0 CHECK (balance_ugx >= 0),
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sample_videos_scope_status
  ON public.sample_videos(institution_id,school_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cartoon_assets_scope
  ON public.cartoon_assets(institution_id,school_id,character_type,pose);
CREATE INDEX IF NOT EXISTS idx_media_uploads_owner
  ON public.media_uploads(owner_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_referral_codes_owner
  ON public.media_referral_codes(owner_id,active);
CREATE INDEX IF NOT EXISTS idx_media_referral_rewards_owner
  ON public.media_referral_rewards(referrer_id,created_at DESC);

INSERT INTO public.role_capabilities(role,sector,capability,scope) VALUES
  ('superadmin','education','video_studio.manage','tenant'),
  ('teacher','education','video_studio.read','tenant'),
  ('teacher','education','video_studio.manage','tenant'),
  ('headteacher','education','video_studio.read','tenant'),
  ('headteacher','education','video_studio.manage','tenant'),
  ('secretary','education','video_studio.read','tenant'),
  ('secretary','education','video_studio.manage','tenant'),
  ('student','education','video_studio.read','tenant'),
  ('learner','education','video_studio.read','tenant'),
  ('teacher','education','referrals.manage','tenant'),
  ('student','education','referrals.manage','tenant'),
  ('headteacher','education','referrals.manage','tenant'),
  ('secretary','education','referrals.manage','tenant'),
  ('student','education','referrals.redeem','tenant'),
  ('teacher','education','referrals.redeem','tenant')
ON CONFLICT(role,sector,capability,scope) DO NOTHING;