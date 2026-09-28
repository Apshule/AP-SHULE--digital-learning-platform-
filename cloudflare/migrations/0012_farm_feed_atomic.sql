-- Farm feed events and inventory deductions must succeed or fail together.
CREATE TRIGGER IF NOT EXISTS farm_feed_consumption_validate
BEFORE INSERT ON sector_records
WHEN NEW.sector = 'farm'
  AND NEW.record_type = 'feed_consumption'
  AND NEW.is_deleted = 0
BEGIN
  SELECT RAISE(ABORT, 'FARM_FEED_INVALID')
  WHERE length(trim(coalesce(json_extract(NEW.record_json, '$.operationId'), ''))) = 0
     OR length(trim(coalesce(json_extract(NEW.record_json, '$.itemId'), ''))) = 0
     OR coalesce(json_type(NEW.record_json, '$.quantity'), '') NOT IN ('integer', 'real')
     OR CAST(json_extract(NEW.record_json, '$.quantity') AS REAL) <= 0
     OR CAST(json_extract(NEW.record_json, '$.quantity') AS REAL) > 1000000
     OR abs(
          CAST(json_extract(NEW.record_json, '$.quantity') AS REAL)
          - round(CAST(json_extract(NEW.record_json, '$.quantity') AS REAL), 3)
        ) > 0.000000001;
END;

CREATE TRIGGER IF NOT EXISTS farm_feed_consumption_deduct_stock
AFTER INSERT ON sector_records
WHEN NEW.sector = 'farm'
  AND NEW.record_type = 'feed_consumption'
  AND NEW.is_deleted = 0
BEGIN
  UPDATE sector_records
  SET record_json = json_set(
        record_json,
        '$.quantityInStock',
        round(
          CAST(json_extract(record_json, '$.quantityInStock') AS REAL)
          - CAST(json_extract(NEW.record_json, '$.quantity') AS REAL),
          3
        ),
        '$.updatedAt',
        NEW.updated_at
      ),
      updated_at = NEW.updated_at
  WHERE id = json_extract(NEW.record_json, '$.itemId')
    AND sector = 'farm'
    AND record_type = 'inventory'
    AND institution_id = NEW.institution_id
    AND (school_id IS NULL OR school_id = NEW.school_id)
    AND is_deleted = 0
    AND CAST(json_extract(record_json, '$.quantityInStock') AS REAL)
      >= CAST(json_extract(NEW.record_json, '$.quantity') AS REAL);

  SELECT RAISE(ABORT, 'FARM_STOCK_UNAVAILABLE') WHERE changes() = 0;
END;