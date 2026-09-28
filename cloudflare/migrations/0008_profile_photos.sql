-- Cloudflare-native profile photo metadata. R2 objects are intentionally
-- retained when replaced so old media can be reconciled or garbage-collected
-- separately.
CREATE TABLE IF NOT EXISTS profile_photos (
  uid TEXT PRIMARY KEY NOT NULL,
  active_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_profile_photos_updated_at
  ON profile_photos(updated_at);