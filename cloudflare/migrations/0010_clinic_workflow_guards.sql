-- Guard key Clinic invariants even when a write bypasses the Clinic-specific API.
CREATE TABLE IF NOT EXISTS clinic_stock_adjustments (
  id TEXT PRIMARY KEY NOT NULL,
  institution_id TEXT NOT NULL,
  inventory_record_id TEXT NOT NULL,
  delta INTEGER NOT NULL CHECK (delta <> 0),
  idempotency_key TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (institution_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_clinic_stock_adjustments_item
  ON clinic_stock_adjustments(institution_id, inventory_record_id, created_at);

CREATE TABLE IF NOT EXISTS clinic_manual_payments (
  id TEXT PRIMARY KEY NOT NULL,
  institution_id TEXT NOT NULL,
  bill_record_id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  owner_uid TEXT,
  amount INTEGER NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL CHECK (method IN ('cash', 'mobile_money', 'bank_transfer', 'insurance')),
  reference TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (institution_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_clinic_manual_payments_bill
  ON clinic_manual_payments(institution_id, bill_record_id, created_at);
CREATE INDEX IF NOT EXISTS idx_clinic_manual_payments_owner
  ON clinic_manual_payments(institution_id, owner_uid, created_at);

CREATE TRIGGER IF NOT EXISTS clinic_stock_adjustment_apply
AFTER INSERT ON clinic_stock_adjustments
BEGIN
  UPDATE sector_records
  SET record_json = json_set(
        record_json,
        '$.quantityInStock', CAST(json_extract(record_json, '$.quantityInStock') AS REAL) + NEW.delta,
        '$.lastAdjustedAt', NEW.created_at,
        '$.lastAdjustmentReason', NEW.reason
      ),
      updated_at = NEW.created_at
  WHERE id = NEW.inventory_record_id
    AND sector = 'clinic'
    AND institution_id = NEW.institution_id
    AND record_type IN ('pharmacy_inventory', 'clinic_pharmacy_inventory')
    AND is_deleted = 0
    AND COALESCE(json_extract(record_json, '$.status'), 'active') <> 'discontinued'
    AND CAST(json_extract(record_json, '$.quantityInStock') AS REAL) + NEW.delta >= 0;

  SELECT RAISE(ABORT, 'CLINIC_STOCK_ADJUSTMENT_REJECTED') WHERE changes() = 0;
END;

CREATE TRIGGER IF NOT EXISTS clinic_manual_payment_apply
AFTER INSERT ON clinic_manual_payments
BEGIN
  UPDATE sector_records
  SET record_json = json_set(
        record_json,
        '$.amountPaid',
          COALESCE(CAST(json_extract(record_json, '$.amountPaid') AS INTEGER),
                   CAST(json_extract(record_json, '$.paidAmount') AS INTEGER), 0) + NEW.amount,
        '$.balanceRemaining',
          MAX(0, COALESCE(CAST(json_extract(record_json, '$.totalAmount') AS INTEGER),
                          CAST(json_extract(record_json, '$.total') AS INTEGER), 0)
                 - COALESCE(CAST(json_extract(record_json, '$.amountPaid') AS INTEGER),
                            CAST(json_extract(record_json, '$.paidAmount') AS INTEGER), 0) - NEW.amount),
        '$.status',
          CASE WHEN COALESCE(CAST(json_extract(record_json, '$.amountPaid') AS INTEGER),
                             CAST(json_extract(record_json, '$.paidAmount') AS INTEGER), 0) + NEW.amount
                    >= COALESCE(CAST(json_extract(record_json, '$.totalAmount') AS INTEGER),
                                CAST(json_extract(record_json, '$.total') AS INTEGER), 0)
               THEN 'paid' ELSE 'partial' END,
        '$.lastPaymentAt', NEW.created_at,
        '$.updatedAt', NEW.created_at
      ),
      updated_at = NEW.created_at
  WHERE id = NEW.bill_record_id
    AND sector = 'clinic'
    AND institution_id = NEW.institution_id
    AND record_type IN ('billing', 'clinic_billing')
    AND is_deleted = 0
    AND lower(COALESCE(json_extract(record_json, '$.status'), 'unpaid')) NOT IN ('paid', 'reversed')
    AND COALESCE(CAST(json_extract(record_json, '$.amountPaid') AS INTEGER),
                 CAST(json_extract(record_json, '$.paidAmount') AS INTEGER), 0) + NEW.amount
      <= COALESCE(CAST(json_extract(record_json, '$.totalAmount') AS INTEGER),
                  CAST(json_extract(record_json, '$.total') AS INTEGER), 0);

  SELECT RAISE(ABORT, 'CLINIC_BILL_PAYMENT_REJECTED') WHERE changes() = 0;
END;

CREATE TRIGGER IF NOT EXISTS clinic_paid_bill_immutable
BEFORE UPDATE OF record_json ON sector_records
WHEN OLD.sector = 'clinic'
  AND OLD.record_type IN ('billing', 'clinic_billing')
  AND lower(COALESCE(json_extract(OLD.record_json, '$.status'), '')) = 'paid'
  AND NEW.record_json <> OLD.record_json
  AND lower(COALESCE(json_extract(NEW.record_json, '$.status'), '')) <> 'reversed'
BEGIN
  SELECT RAISE(ABORT, 'CLINIC_PAID_BILL_IMMUTABLE');
END;
CREATE TRIGGER IF NOT EXISTS clinic_appointment_slot_insert
BEFORE INSERT ON sector_records
WHEN NEW.sector = 'clinic'
  AND NEW.record_type IN ('appointment', 'clinic_appointments')
  AND NEW.is_deleted = 0
  AND COALESCE(json_extract(NEW.record_json, '$.status'), 'scheduled') NOT IN ('cancelled', 'no_show')
  AND EXISTS (
    SELECT 1 FROM sector_records AS existing
    WHERE existing.sector = 'clinic'
      AND existing.institution_id = NEW.institution_id
      AND existing.record_type IN ('appointment', 'clinic_appointments')
      AND existing.is_deleted = 0
      AND COALESCE(json_extract(existing.record_json, '$.status'), 'scheduled') NOT IN ('cancelled', 'no_show')
      AND json_extract(existing.record_json, '$.doctorId') = json_extract(NEW.record_json, '$.doctorId')
      AND json_extract(existing.record_json, '$.appointmentDate') = json_extract(NEW.record_json, '$.appointmentDate')
      AND json_extract(existing.record_json, '$.appointmentTime') = json_extract(NEW.record_json, '$.appointmentTime')
  )
BEGIN
  SELECT RAISE(ABORT, 'CLINIC_APPOINTMENT_CONFLICT');
END;

CREATE TRIGGER IF NOT EXISTS clinic_appointment_slot_update
BEFORE UPDATE OF record_json, is_deleted ON sector_records
WHEN NEW.sector = 'clinic'
  AND NEW.record_type IN ('appointment', 'clinic_appointments')
  AND NEW.is_deleted = 0
  AND COALESCE(json_extract(NEW.record_json, '$.status'), 'scheduled') NOT IN ('cancelled', 'no_show')
  AND EXISTS (
    SELECT 1 FROM sector_records AS existing
    WHERE existing.id <> NEW.id
      AND existing.sector = 'clinic'
      AND existing.institution_id = NEW.institution_id
      AND existing.record_type IN ('appointment', 'clinic_appointments')
      AND existing.is_deleted = 0
      AND COALESCE(json_extract(existing.record_json, '$.status'), 'scheduled') NOT IN ('cancelled', 'no_show')
      AND json_extract(existing.record_json, '$.doctorId') = json_extract(NEW.record_json, '$.doctorId')
      AND json_extract(existing.record_json, '$.appointmentDate') = json_extract(NEW.record_json, '$.appointmentDate')
      AND json_extract(existing.record_json, '$.appointmentTime') = json_extract(NEW.record_json, '$.appointmentTime')
  )
BEGIN
  SELECT RAISE(ABORT, 'CLINIC_APPOINTMENT_CONFLICT');
END;

CREATE TRIGGER IF NOT EXISTS clinic_inventory_nonnegative_insert
BEFORE INSERT ON sector_records
WHEN NEW.sector = 'clinic'
  AND NEW.record_type IN ('pharmacy_inventory', 'clinic_pharmacy_inventory')
  AND json_extract(NEW.record_json, '$.quantityInStock') IS NOT NULL
  AND CAST(json_extract(NEW.record_json, '$.quantityInStock') AS REAL) < 0
BEGIN
  SELECT RAISE(ABORT, 'CLINIC_STOCK_CANNOT_BE_NEGATIVE');
END;

CREATE TRIGGER IF NOT EXISTS clinic_inventory_nonnegative_update
BEFORE UPDATE OF record_json ON sector_records
WHEN NEW.sector = 'clinic'
  AND NEW.record_type IN ('pharmacy_inventory', 'clinic_pharmacy_inventory')
  AND json_extract(NEW.record_json, '$.quantityInStock') IS NOT NULL
  AND CAST(json_extract(NEW.record_json, '$.quantityInStock') AS REAL) < 0
BEGIN
  SELECT RAISE(ABORT, 'CLINIC_STOCK_CANNOT_BE_NEGATIVE');
END;

CREATE TRIGGER IF NOT EXISTS clinic_prescription_dispense_stock
BEFORE UPDATE OF record_json ON sector_records
WHEN OLD.sector = 'clinic'
  AND OLD.record_type IN ('prescription', 'clinic_prescriptions')
  AND NEW.record_type IN ('prescription', 'clinic_prescriptions')
  AND OLD.is_deleted = 0
  AND COALESCE(json_extract(OLD.record_json, '$.status'), 'ready') <> 'dispensed'
  AND json_extract(NEW.record_json, '$.status') = 'dispensed'
BEGIN
  UPDATE sector_records
  SET record_json = json_set(
        record_json,
        '$.quantityInStock',
        CAST(json_extract(record_json, '$.quantityInStock') AS REAL)
          - COALESCE(CAST(json_extract(NEW.record_json, '$.quantity') AS REAL), 1)
      ),
      updated_at = NEW.updated_at
  WHERE id = (
      SELECT item.id
      FROM sector_records AS item
      WHERE item.sector = 'clinic'
        AND item.institution_id = NEW.institution_id
        AND item.record_type IN ('pharmacy_inventory', 'clinic_pharmacy_inventory')
        AND item.is_deleted = 0
        AND (
          lower(json_extract(item.record_json, '$.name')) = lower(json_extract(NEW.record_json, '$.medicineName'))
          OR lower(json_extract(item.record_json, '$.genericName')) = lower(json_extract(NEW.record_json, '$.medicineName'))
        )
        AND CAST(json_extract(item.record_json, '$.quantityInStock') AS REAL)
          >= COALESCE(CAST(json_extract(NEW.record_json, '$.quantity') AS REAL), 1)
      ORDER BY item.created_at
      LIMIT 1
    )
    AND CAST(json_extract(record_json, '$.quantityInStock') AS REAL)
      >= COALESCE(CAST(json_extract(NEW.record_json, '$.quantity') AS REAL), 1);

  SELECT RAISE(ABORT, 'CLINIC_STOCK_UNAVAILABLE') WHERE changes() = 0;
END;