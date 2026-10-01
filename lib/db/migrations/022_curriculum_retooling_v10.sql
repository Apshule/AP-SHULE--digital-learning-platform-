-- Durable certificate identity and issue date for Neon-backed NCDC progress.
-- The certificate is only issued after the Worker verifies all ten modules.
ALTER TABLE public.teacher_retooling_progress
  ADD COLUMN IF NOT EXISTS certificate_id TEXT;

ALTER TABLE public.teacher_retooling_progress
  ADD COLUMN IF NOT EXISTS certificate_issued_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS teacher_retooling_certificate_id_unique
  ON public.teacher_retooling_progress (certificate_id)
  WHERE certificate_id IS NOT NULL;