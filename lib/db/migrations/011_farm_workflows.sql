-- Additive Neon schema for the Farm workflow handler.
-- public.users is created by the earlier users migration; no rows are seeded.

DO $$
BEGIN
  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'Apply the Neon users migration before Farm workflows';
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.sector_records (
  id TEXT PRIMARY KEY NOT NULL,
  sector TEXT NOT NULL,
  institution_id TEXT,
  school_id TEXT,
  owner_uid TEXT,
  record_type TEXT NOT NULL,
  record_json TEXT NOT NULL,
  created_by TEXT,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sector_records_tenant
  ON public.sector_records (institution_id, school_id);

CREATE INDEX IF NOT EXISTS idx_sector_records_owner
  ON public.sector_records (owner_uid, sector, record_type);

CREATE INDEX IF NOT EXISTS idx_farm_sector_records_tenant
  ON public.sector_records (institution_id, school_id, record_type, updated_at DESC)
  WHERE sector = 'farm' AND is_deleted = 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_farm_operation_ids
  ON public.sector_records (
    institution_id,
    record_type,
    ((record_json::jsonb) ->> 'operationId')
  )
  WHERE sector = 'farm'
    AND is_deleted = 0
    AND ((record_json::jsonb) ->> 'operationId') IS NOT NULL;

CREATE OR REPLACE FUNCTION public.apshule_farm_inventory_nonnegative_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $farm_inventory_guard$
DECLARE
  inventory_json JSONB;
  inventory_quantity NUMERIC;
BEGIN
  IF NEW.sector = 'farm' AND NEW.record_type = 'inventory' THEN
    BEGIN
      inventory_json := NEW.record_json::jsonb;
      inventory_quantity := COALESCE(NULLIF(inventory_json ->> 'quantityInStock', '')::numeric, 0);
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Farm inventory quantity is invalid' USING ERRCODE = '23514';
    END;

    IF inventory_quantity < 0 THEN
      RAISE EXCEPTION 'Farm inventory cannot go below zero' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$farm_inventory_guard$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = to_regclass('public.sector_records')
      AND tgname = 'farm_inventory_nonnegative_insert'
      AND NOT tgisinternal
  ) THEN
    EXECUTE 'CREATE TRIGGER farm_inventory_nonnegative_insert
      BEFORE INSERT ON public.sector_records
      FOR EACH ROW
      EXECUTE FUNCTION public.apshule_farm_inventory_nonnegative_guard()';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = to_regclass('public.sector_records')
      AND tgname = 'farm_inventory_nonnegative_update'
      AND NOT tgisinternal
  ) THEN
    EXECUTE 'CREATE TRIGGER farm_inventory_nonnegative_update
      BEFORE UPDATE OF record_json ON public.sector_records
      FOR EACH ROW
      EXECUTE FUNCTION public.apshule_farm_inventory_nonnegative_guard()';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.apshule_farm_feed_consumption_validate()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $farm_feed_validate$
DECLARE
  feed_json JSONB;
  feed_quantity NUMERIC;
BEGIN
  IF NEW.sector = 'farm' AND NEW.record_type = 'feed_consumption' AND NEW.is_deleted = 0 THEN
    BEGIN
      feed_json := NEW.record_json::jsonb;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'FARM_FEED_INVALID' USING ERRCODE = 'P0001';
    END;

    IF jsonb_typeof(feed_json) IS DISTINCT FROM 'object'
      OR length(btrim(COALESCE(feed_json ->> 'operationId', ''))) = 0
      OR length(btrim(COALESCE(feed_json ->> 'itemId', ''))) = 0
      OR jsonb_typeof(feed_json -> 'quantity') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'FARM_FEED_INVALID' USING ERRCODE = 'P0001';
    END IF;

    feed_quantity := (feed_json ->> 'quantity')::numeric;
    IF feed_quantity <= 0
      OR feed_quantity > 1000000
      OR abs(feed_quantity - round(feed_quantity, 3)) > 0.000000001 THEN
      RAISE EXCEPTION 'FARM_FEED_INVALID' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$farm_feed_validate$;

CREATE OR REPLACE FUNCTION public.apshule_farm_feed_consumption_deduct_stock()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $farm_feed_deduct$
DECLARE
  feed_json JSONB;
  feed_quantity NUMERIC;
  feed_item_id TEXT;
BEGIN
  IF NEW.sector = 'farm' AND NEW.record_type = 'feed_consumption' AND NEW.is_deleted = 0 THEN
    feed_json := NEW.record_json::jsonb;
    feed_quantity := (feed_json ->> 'quantity')::numeric;
    feed_item_id := feed_json ->> 'itemId';

    UPDATE public.sector_records AS inventory
    SET record_json = jsonb_set(
          jsonb_set(
            inventory.record_json::jsonb,
            '{quantityInStock}',
            to_jsonb(round(
              (inventory.record_json::jsonb ->> 'quantityInStock')::numeric - feed_quantity,
              3
            )),
            TRUE
          ),
          '{updatedAt}',
          to_jsonb(NEW.updated_at),
          TRUE
        )::text,
        updated_at = NEW.updated_at
    WHERE inventory.id = feed_item_id
      AND inventory.sector = 'farm'
      AND inventory.record_type = 'inventory'
      AND inventory.institution_id = NEW.institution_id
      AND (inventory.school_id IS NULL OR inventory.school_id = NEW.school_id)
      AND inventory.is_deleted = 0
      AND (inventory.record_json::jsonb ->> 'quantityInStock')::numeric >= feed_quantity;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'FARM_STOCK_UNAVAILABLE' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$farm_feed_deduct$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = to_regclass('public.sector_records')
      AND tgname = 'farm_feed_consumption_validate'
      AND NOT tgisinternal
  ) THEN
    EXECUTE 'CREATE TRIGGER farm_feed_consumption_validate
      BEFORE INSERT ON public.sector_records
      FOR EACH ROW
      EXECUTE FUNCTION public.apshule_farm_feed_consumption_validate()';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = to_regclass('public.sector_records')
      AND tgname = 'farm_feed_consumption_deduct_stock'
      AND NOT tgisinternal
  ) THEN
    EXECUTE 'CREATE TRIGGER farm_feed_consumption_deduct_stock
      AFTER INSERT ON public.sector_records
      FOR EACH ROW
      EXECUTE FUNCTION public.apshule_farm_feed_consumption_deduct_stock()';
  END IF;
END;
$$;