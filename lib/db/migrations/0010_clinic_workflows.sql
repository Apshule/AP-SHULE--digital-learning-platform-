-- PostgreSQL storage and invariants for Clinic workflows.
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

CREATE TABLE IF NOT EXISTS public.audit (
  id TEXT PRIMARY KEY NOT NULL,
  institution_id TEXT,
  school_id TEXT,
  actor_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sector_records_tenant
  ON public.sector_records(institution_id, school_id);
CREATE INDEX IF NOT EXISTS idx_sector_records_owner
  ON public.sector_records(owner_uid, sector, record_type);
CREATE INDEX IF NOT EXISTS idx_clinic_workflow_record_lookup
  ON public.sector_records(sector, institution_id, record_type, is_deleted, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_time
  ON public.audit(institution_id, school_id, created_at);

CREATE TABLE IF NOT EXISTS public.clinic_stock_adjustments (
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
  ON public.clinic_stock_adjustments(institution_id, inventory_record_id, created_at);

CREATE TABLE IF NOT EXISTS public.clinic_manual_payments (
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
  ON public.clinic_manual_payments(institution_id, bill_record_id, created_at);
CREATE INDEX IF NOT EXISTS idx_clinic_manual_payments_owner
  ON public.clinic_manual_payments(institution_id, owner_uid, created_at);

CREATE TABLE IF NOT EXISTS public.clinic_pharmacy_sales (
  id TEXT PRIMARY KEY NOT NULL,
  institution_id TEXT NOT NULL,
  bill_record_id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  patient_name TEXT NOT NULL,
  owner_uid TEXT,
  idempotency_key TEXT NOT NULL,
  request_json TEXT NOT NULL,
  total_amount INTEGER NOT NULL CHECK (total_amount > 0),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (institution_id, idempotency_key),
  UNIQUE (id, institution_id)
);

CREATE INDEX IF NOT EXISTS idx_clinic_pharmacy_sales_history
  ON public.clinic_pharmacy_sales(institution_id, created_at);

CREATE TABLE IF NOT EXISTS public.clinic_pharmacy_sale_items (
  id TEXT PRIMARY KEY NOT NULL,
  sale_id TEXT NOT NULL,
  institution_id TEXT NOT NULL,
  inventory_record_id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price INTEGER NOT NULL CHECK (unit_price > 0),
  line_total INTEGER NOT NULL CHECK (line_total > 0),
  created_at TEXT NOT NULL,
  UNIQUE (sale_id, inventory_record_id),
  FOREIGN KEY (sale_id, institution_id)
    REFERENCES public.clinic_pharmacy_sales(id, institution_id)
);

CREATE INDEX IF NOT EXISTS idx_clinic_pharmacy_sale_items_inventory
  ON public.clinic_pharmacy_sale_items(institution_id, inventory_record_id, created_at);

CREATE OR REPLACE FUNCTION public.clinic_stock_adjustment_apply()
RETURNS trigger LANGUAGE plpgsql AS $clinic$
DECLARE
  changed_rows INTEGER;
BEGIN
  UPDATE public.sector_records
     SET record_json = (
           record_json::jsonb || jsonb_build_object(
             'quantityInStock', (record_json::jsonb->>'quantityInStock')::numeric + NEW.delta,
             'lastAdjustedAt', NEW.created_at,
             'lastAdjustmentReason', NEW.reason
           )
         )::text,
         updated_at = NEW.created_at
   WHERE id = NEW.inventory_record_id
     AND sector = 'clinic'
     AND institution_id = NEW.institution_id
     AND record_type IN ('pharmacy_inventory', 'clinic_pharmacy_inventory')
     AND is_deleted = 0
     AND COALESCE(record_json::jsonb->>'status', 'active') <> 'discontinued'
     AND (record_json::jsonb->>'quantityInStock')::numeric + NEW.delta >= 0;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows = 0 THEN
    RAISE EXCEPTION 'CLINIC_STOCK_ADJUSTMENT_REJECTED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$clinic$;

CREATE OR REPLACE FUNCTION public.clinic_manual_payment_apply()
RETURNS trigger LANGUAGE plpgsql AS $clinic$
DECLARE
  changed_rows INTEGER;
BEGIN
  UPDATE public.sector_records
     SET record_json = (
           record_json::jsonb || jsonb_build_object(
             'amountPaid',
               COALESCE((record_json::jsonb->>'amountPaid')::numeric,
                        (record_json::jsonb->>'paidAmount')::numeric, 0) + NEW.amount,
             'balanceRemaining',
               GREATEST(0,
                 COALESCE((record_json::jsonb->>'totalAmount')::numeric,
                          (record_json::jsonb->>'total')::numeric, 0)
                 - COALESCE((record_json::jsonb->>'amountPaid')::numeric,
                            (record_json::jsonb->>'paidAmount')::numeric, 0)
                 - NEW.amount
               ),
             'status',
               CASE
                 WHEN COALESCE((record_json::jsonb->>'amountPaid')::numeric,
                               (record_json::jsonb->>'paidAmount')::numeric, 0) + NEW.amount
                      >= COALESCE((record_json::jsonb->>'totalAmount')::numeric,
                                  (record_json::jsonb->>'total')::numeric, 0)
                 THEN 'paid' ELSE 'partial'
               END,
             'lastPaymentAt', NEW.created_at,
             'updatedAt', NEW.created_at
           )
         )::text,
         updated_at = NEW.created_at
   WHERE id = NEW.bill_record_id
     AND sector = 'clinic'
     AND institution_id = NEW.institution_id
     AND record_type IN ('billing', 'clinic_billing')
     AND is_deleted = 0
     AND lower(COALESCE(record_json::jsonb->>'status', 'unpaid')) NOT IN ('paid', 'reversed')
     AND COALESCE((record_json::jsonb->>'amountPaid')::numeric,
                  (record_json::jsonb->>'paidAmount')::numeric, 0) + NEW.amount
         <= COALESCE((record_json::jsonb->>'totalAmount')::numeric,
                     (record_json::jsonb->>'total')::numeric, 0);
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows = 0 THEN
    RAISE EXCEPTION 'CLINIC_BILL_PAYMENT_REJECTED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$clinic$;

CREATE OR REPLACE FUNCTION public.clinic_paid_bill_immutable()
RETURNS trigger LANGUAGE plpgsql AS $clinic$
BEGIN
  IF OLD.sector = 'clinic'
     AND OLD.record_type IN ('billing', 'clinic_billing')
     AND lower(COALESCE(OLD.record_json::jsonb->>'status', '')) = 'paid'
     AND NEW.record_json::jsonb IS DISTINCT FROM OLD.record_json::jsonb
     AND lower(COALESCE(NEW.record_json::jsonb->>'status', '')) <> 'reversed' THEN
    RAISE EXCEPTION 'CLINIC_PAID_BILL_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$clinic$;

CREATE OR REPLACE FUNCTION public.clinic_inventory_nonnegative()
RETURNS trigger LANGUAGE plpgsql AS $clinic$
DECLARE
  quantity_text TEXT;
BEGIN
  IF NEW.sector = 'clinic'
     AND NEW.record_type IN ('pharmacy_inventory', 'clinic_pharmacy_inventory') THEN
    quantity_text := NEW.record_json::jsonb->>'quantityInStock';
    IF quantity_text IS NOT NULL AND quantity_text::numeric < 0 THEN
      RAISE EXCEPTION 'CLINIC_STOCK_CANNOT_BE_NEGATIVE' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$clinic$;

CREATE OR REPLACE FUNCTION public.clinic_prescription_dispense_stock()
RETURNS trigger LANGUAGE plpgsql AS $clinic$
DECLARE
  item_id TEXT;
  requested_quantity NUMERIC;
BEGIN
  IF OLD.sector = 'clinic'
     AND OLD.record_type IN ('prescription', 'clinic_prescriptions')
     AND NEW.record_type IN ('prescription', 'clinic_prescriptions')
     AND OLD.is_deleted = 0
     AND COALESCE(OLD.record_json::jsonb->>'status', 'ready') <> 'dispensed'
     AND NEW.record_json::jsonb->>'status' = 'dispensed' THEN
    requested_quantity := COALESCE((NEW.record_json::jsonb->>'quantity')::numeric, 1);
    SELECT item.id
      INTO item_id
      FROM public.sector_records AS item
     WHERE item.sector = 'clinic'
       AND item.institution_id = NEW.institution_id
       AND item.record_type IN ('pharmacy_inventory', 'clinic_pharmacy_inventory')
       AND item.is_deleted = 0
       AND (lower(item.record_json::jsonb->>'name') = lower(NEW.record_json::jsonb->>'medicineName')
         OR lower(item.record_json::jsonb->>'genericName') = lower(NEW.record_json::jsonb->>'medicineName'))
       AND (item.record_json::jsonb->>'quantityInStock')::numeric >= requested_quantity
     ORDER BY item.created_at
     LIMIT 1
     FOR UPDATE;
    IF item_id IS NULL THEN
      RAISE EXCEPTION 'CLINIC_STOCK_UNAVAILABLE' USING ERRCODE = '23514';
    END IF;
    UPDATE public.sector_records
       SET record_json = (
             record_json::jsonb || jsonb_build_object(
               'quantityInStock', (record_json::jsonb->>'quantityInStock')::numeric - requested_quantity
             )
           )::text,
           updated_at = NEW.updated_at
     WHERE id = item_id
       AND sector = 'clinic'
       AND institution_id = NEW.institution_id
       AND record_type IN ('pharmacy_inventory', 'clinic_pharmacy_inventory')
       AND is_deleted = 0
       AND (record_json::jsonb->>'quantityInStock')::numeric >= requested_quantity;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CLINIC_STOCK_UNAVAILABLE' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$clinic$;

CREATE OR REPLACE FUNCTION public.clinic_pharmacy_sale_item_validate()
RETURNS trigger LANGUAGE plpgsql AS $clinic$
DECLARE
  inventory_json JSONB;
BEGIN
  SELECT item.record_json::jsonb
    INTO inventory_json
    FROM public.sector_records AS item
   WHERE item.id = NEW.inventory_record_id
     AND item.sector = 'clinic'
     AND item.institution_id = NEW.institution_id
     AND item.record_type IN ('pharmacy_inventory', 'clinic_pharmacy_inventory')
     AND item.is_deleted = 0
     AND COALESCE(item.record_json::jsonb->>'status', 'active') <> 'discontinued'
     AND (item.record_json::jsonb->>'unitPrice')::numeric = NEW.unit_price
     AND (item.record_json::jsonb->>'quantityInStock')::numeric >= NEW.quantity
   FOR UPDATE;
  IF NEW.quantity <= 0 OR NEW.unit_price <= 0 OR NEW.line_total <> NEW.quantity * NEW.unit_price
     OR inventory_json IS NULL THEN
    RAISE EXCEPTION 'CLINIC_PHARMACY_SALE_ITEM_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$clinic$;

CREATE OR REPLACE FUNCTION public.clinic_pharmacy_sale_item_deduct_stock()
RETURNS trigger LANGUAGE plpgsql AS $clinic$
BEGIN
  UPDATE public.sector_records
     SET record_json = (
           record_json::jsonb || jsonb_build_object(
             'quantityInStock', (record_json::jsonb->>'quantityInStock')::numeric - NEW.quantity,
             'lastSoldAt', NEW.created_at
           )
         )::text,
         updated_at = NEW.created_at
   WHERE id = NEW.inventory_record_id
     AND sector = 'clinic'
     AND institution_id = NEW.institution_id
     AND record_type IN ('pharmacy_inventory', 'clinic_pharmacy_inventory')
     AND is_deleted = 0
     AND COALESCE(record_json::jsonb->>'status', 'active') <> 'discontinued'
     AND (record_json::jsonb->>'unitPrice')::numeric = NEW.unit_price
     AND (record_json::jsonb->>'quantityInStock')::numeric >= NEW.quantity;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CLINIC_PHARMACY_SALE_STOCK_UNAVAILABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$clinic$;

DO $clinic$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'clinic_stock_adjustment_apply' AND NOT tgisinternal) THEN
    CREATE TRIGGER clinic_stock_adjustment_apply
      AFTER INSERT ON public.clinic_stock_adjustments
      FOR EACH ROW EXECUTE FUNCTION public.clinic_stock_adjustment_apply();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'clinic_manual_payment_apply' AND NOT tgisinternal) THEN
    CREATE TRIGGER clinic_manual_payment_apply
      AFTER INSERT ON public.clinic_manual_payments
      FOR EACH ROW EXECUTE FUNCTION public.clinic_manual_payment_apply();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'clinic_paid_bill_immutable' AND NOT tgisinternal) THEN
    CREATE TRIGGER clinic_paid_bill_immutable
      BEFORE UPDATE OF record_json ON public.sector_records
      FOR EACH ROW EXECUTE FUNCTION public.clinic_paid_bill_immutable();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'clinic_inventory_nonnegative_insert' AND NOT tgisinternal) THEN
    CREATE TRIGGER clinic_inventory_nonnegative_insert
      BEFORE INSERT ON public.sector_records
      FOR EACH ROW EXECUTE FUNCTION public.clinic_inventory_nonnegative();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'clinic_inventory_nonnegative_update' AND NOT tgisinternal) THEN
    CREATE TRIGGER clinic_inventory_nonnegative_update
      BEFORE UPDATE OF record_json ON public.sector_records
      FOR EACH ROW EXECUTE FUNCTION public.clinic_inventory_nonnegative();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'clinic_prescription_dispense_stock' AND NOT tgisinternal) THEN
    CREATE TRIGGER clinic_prescription_dispense_stock
      BEFORE UPDATE OF record_json ON public.sector_records
      FOR EACH ROW EXECUTE FUNCTION public.clinic_prescription_dispense_stock();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'clinic_pharmacy_sale_item_validate' AND NOT tgisinternal) THEN
    CREATE TRIGGER clinic_pharmacy_sale_item_validate
      BEFORE INSERT ON public.clinic_pharmacy_sale_items
      FOR EACH ROW EXECUTE FUNCTION public.clinic_pharmacy_sale_item_validate();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'clinic_pharmacy_sale_item_deduct_stock' AND NOT tgisinternal) THEN
    CREATE TRIGGER clinic_pharmacy_sale_item_deduct_stock
      AFTER INSERT ON public.clinic_pharmacy_sale_items
      FOR EACH ROW EXECUTE FUNCTION public.clinic_pharmacy_sale_item_deduct_stock();
  END IF;
END;
$clinic$;

CREATE UNIQUE INDEX IF NOT EXISTS clinic_appointment_slot_unique
  ON public.sector_records (
    institution_id,
    (record_json::jsonb->>'doctorId'),
    (record_json::jsonb->>'appointmentDate'),
    (record_json::jsonb->>'appointmentTime')
  )
  WHERE sector = 'clinic'
    AND record_type IN ('appointment', 'clinic_appointments')
    AND is_deleted = 0
    AND COALESCE(record_json::jsonb->>'status', 'scheduled') NOT IN ('cancelled', 'no_show');