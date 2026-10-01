-- Additive PostgreSQL metadata for authenticated profile photos.
-- Replaced R2 objects remain untouched, matching the existing retention behavior.
CREATE TABLE IF NOT EXISTS public.profile_photos (
  uid TEXT PRIMARY KEY NOT NULL,
  active_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (size_bytes BETWEEN 1 AND 5242880),
  CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (
    (content_type = 'image/jpeg' AND active_key ~ '^profile/[a-f0-9]{64}/[a-f0-9]{64}\.jpg$')
    OR (content_type = 'image/png' AND active_key ~ '^profile/[a-f0-9]{64}/[a-f0-9]{64}\.png$')
    OR (content_type = 'image/webp' AND active_key ~ '^profile/[a-f0-9]{64}/[a-f0-9]{64}\.webp$')
  )
);

CREATE INDEX IF NOT EXISTS idx_profile_photos_updated_at
  ON public.profile_photos (updated_at);