-- Partial Farm Phase 1 guards: no produce, sales, expenses, cameras, or biometrics.
CREATE UNIQUE INDEX IF NOT EXISTS idx_farm_operation_ids
  ON sector_records(institution_id, record_type, json_extract(record_json, '$.operationId'))
  WHERE sector='farm' AND is_deleted=0 AND json_extract(record_json, '$.operationId') IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS farm_inventory_nonnegative_insert
BEFORE INSERT ON sector_records
WHEN NEW.sector='farm' AND NEW.record_type='inventory'
  AND COALESCE(json_extract(NEW.record_json,'$.quantityInStock'), 0) < 0
BEGIN SELECT RAISE(ABORT, 'Farm inventory cannot go below zero'); END;

CREATE TRIGGER IF NOT EXISTS farm_inventory_nonnegative_update
BEFORE UPDATE OF record_json ON sector_records
WHEN NEW.sector='farm' AND NEW.record_type='inventory'
  AND COALESCE(json_extract(NEW.record_json,'$.quantityInStock'), 0) < 0
BEGIN SELECT RAISE(ABORT, 'Farm inventory cannot go below zero'); END;