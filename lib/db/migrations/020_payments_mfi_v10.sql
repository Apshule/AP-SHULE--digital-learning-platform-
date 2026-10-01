-- Additive persistence for verified Yo IPNs and idempotent MFI repayments.
-- Existing payments and MFI operational records remain in their Neon tables.
CREATE TABLE IF NOT EXISTS public.yo_ipn_events (
  event_key TEXT PRIMARY KEY NOT NULL,
  provider_reference TEXT NOT NULL,
  network_reference TEXT,
  payment_id TEXT REFERENCES public.payments(id),
  status TEXT NOT NULL,
  result_json TEXT NOT NULL DEFAULT '{}',
  received_at TEXT NOT NULL,
  processed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_yo_ipn_events_payment
  ON public.yo_ipn_events (payment_id, received_at DESC);

CREATE TABLE IF NOT EXISTS public.mfi_v10_operation_keys (
  institution_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (institution_id, operation_key)
);

CREATE INDEX IF NOT EXISTS idx_mfi_v10_operation_resource
  ON public.mfi_v10_operation_keys (resource_id);

INSERT INTO public.role_capabilities (role, sector, capability, scope) VALUES
  ('mfi_admin', 'mfi', 'collateral.score.manage', 'tenant'),
  ('mfi_admin', 'mfi', 'loans.schedule.manage', 'tenant'),
  ('mfi_admin', 'mfi', 'loans.disburse', 'tenant'),
  ('mfi_admin', 'mfi', 'loans.overdue.manage', 'tenant'),
  ('mfi_admin', 'mfi', 'loans.late_fees.manage', 'tenant'),
  ('mfi_admin', 'mfi', 'repayments.manage', 'tenant'),
  ('loan_officer', 'mfi', 'collateral.score.manage', 'tenant'),
  ('loan_officer', 'mfi', 'loans.schedule.manage', 'tenant'),
  ('loan_officer', 'mfi', 'loans.overdue.manage', 'tenant'),
  ('loan_officer', 'mfi', 'loans.late_fees.manage', 'tenant'),
  ('loan_officer', 'mfi', 'repayments.manage', 'tenant'),
  ('loan_manager', 'mfi', 'loans.disburse', 'tenant'),
  ('loan_manager', 'mfi', 'loans.schedule.manage', 'tenant'),
  ('loan_manager', 'mfi', 'loans.overdue.manage', 'tenant'),
  ('loan_manager', 'mfi', 'loans.late_fees.manage', 'tenant'),
  ('loan_manager', 'mfi', 'repayments.manage', 'tenant'),
  ('borrower', 'mfi', 'repayments.create', 'tenant')
ON CONFLICT (role, sector, capability, scope) DO NOTHING;