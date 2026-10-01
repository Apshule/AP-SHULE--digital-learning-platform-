-- Extend the Drizzle-created push_subscriptions table with its D1 ownership
-- fields and add the Neon push-event history table.
DO $$
BEGIN
  IF to_regclass('public.push_subscriptions') IS NULL THEN
    RAISE EXCEPTION 'Expected public.push_subscriptions table from the existing Neon schema';
  END IF;
END;
$$;

ALTER TABLE public.push_subscriptions
  ADD COLUMN IF NOT EXISTS user_id TEXT;

ALTER TABLE public.push_subscriptions
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

UPDATE public.push_subscriptions
   SET updated_at = created_at
 WHERE updated_at IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.push_subscriptions
     WHERE user_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Existing push subscriptions need an owner before Neon push routes can be enabled';
  END IF;
END;
$$;

ALTER TABLE public.push_subscriptions
  ALTER COLUMN user_id SET NOT NULL;

ALTER TABLE public.push_subscriptions
  ALTER COLUMN updated_at SET DEFAULT now();

ALTER TABLE public.push_subscriptions
  ALTER COLUMN updated_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS push_subscriptions_user_id_idx
  ON public.push_subscriptions (user_id);

CREATE TABLE IF NOT EXISTS public.push_events (
  id BIGSERIAL PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('success', 'error')),
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS push_events_created_at_idx
  ON public.push_events (created_at DESC);