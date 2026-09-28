-- Clinic pharmacy checkout records each sale and decrements stock atomically.
CREATE TABLE IF NOT EXISTS clinic_pharmacy_sales (
  id TEXT PRIMARY KEY NOT NULL,
  institution_id TEXT NOT NULL,
  bill_record_id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  patient_name TEXT NOT NULL,
  owner_uid TEXT,
  idempotency_key TEXT NOT NULL,
  request_json TEXT NOT NULL,
  total_amount INTEGER NOT NULL CHECK (total_amount > 0 AND total_amount = CAST(total_amount AS INTEGER)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (institution_id, idempotency_key),
  UNIQUE (id, institution_id)
);

CREATE INDEX IF NOT EXISTS idx_clinic_pharmacy_sales_history
  ON clinic_pharmacy_sales(institution_id, created_at);

CREATE TABLE IF NOT EXISTS clinic_pharmacy_sale_items (
  id TEXT PRIMARY KEY NOT NULL,
  sale_id TEXT NOT NULL,
  institution_id TEXT NOT NULL,
  inventory_record_id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0 AND quantity = CAST(quantity AS INTEGER)),
  unit_price INTEGER NOT NULL CHECK (unit_price > 0 AND unit_price = CAST(unit_price AS INTEGER)),
  line_total INTEGER NOT NULL CHECK (line_total > 0 AND line_total = CAST(line_total AS INTEGER)),
  created_at TEXT NOT NULL,
  UNIQUE (sale_id, inventory_record_id),
  FOREIGN KEY (sale_id, institution_id)
    REFERENCES clinic_pharmacy_sales(id, institution_id)
);

CREATE INDEX IF NOT EXISTS idx_clinic_pharmacy_sale_items_inventory
  ON clinic_pharmacy_sale_items(institution_id, inventory_record_id, created_at);

CREATE TRIGGER IF NOT EXISTS clinic_pharmacy_sale_item_validate
BEFORE INSERT ON clinic_pharmacy_sale_items
BEGIN
  SELECT RAISE(ABORT, 'CLINIC_PHARMACY_SALE_ITEM_INVALID')
  WHERE NEW.quantity <= 0
     OR NEW.quantity <> CAST(NEW.quantity AS INTEGER)
     OR NEW.unit_price <= 0
     OR NEW.unit_price <> CAST(NEW.unit_price AS INTEGER)
     OR NEW.line_total <> CAST(round(NEW.quantity * NEW.unit_price) AS INTEGER)
     OR NOT EXISTS (
       SELECT 1
       FROM sector_records AS item
       WHERE item.id = NEW.inventory_record_id
         AND item.sector = 'clinic'
         AND item.institution_id = NEW.institution_id
         AND item.record_type IN ('pharmacy_inventory', 'clinic_pharmacy_inventory')
         AND item.is_deleted = 0
         AND coalesce(json_extract(item.record_json, '$.status'), 'active') <> 'discontinued'
         AND CAST(json_extract(item.record_json, '$.unitPrice') AS REAL) = NEW.unit_price
         AND CAST(json_extract(item.record_json, '$.quantityInStock') AS REAL) >= NEW.quantity
     );
END;

CREATE TRIGGER IF NOT EXISTS clinic_pharmacy_sale_item_deduct_stock
AFTER INSERT ON clinic_pharmacy_sale_items
BEGIN
  UPDATE sector_records
  SET record_json = json_set(
        record_json,
        '$.quantityInStock',
        CAST(json_extract(record_json, '$.quantityInStock') AS REAL) - NEW.quantity,
        '$.lastSoldAt',
        NEW.created_at
      ),
      updated_at = NEW.created_at
  WHERE id = NEW.inventory_record_id
    AND sector = 'clinic'
    AND institution_id = NEW.institution_id
    AND record_type IN ('pharmacy_inventory', 'clinic_pharmacy_inventory')
    AND is_deleted = 0
    AND coalesce(json_extract(record_json, '$.status'), 'active') <> 'discontinued'
    AND CAST(json_extract(record_json, '$.unitPrice') AS REAL) = NEW.unit_price
    AND CAST(json_extract(record_json, '$.quantityInStock') AS REAL) >= NEW.quantity;

  SELECT RAISE(ABORT, 'CLINIC_PHARMACY_SALE_STOCK_UNAVAILABLE')
  WHERE changes() = 0;
END;