# Clinic, Farm, and MFI Cloudflare parity checklist

**Reviewed:** 2026-09-28  
**Sources:** Local legacy `index.html`, its sector regression contracts in `scripts/src/clinic.test.ts`, `scripts/src/task13-farm.test.ts`, and `scripts/src/mfi.test.ts`, Cloudflare `domain-routes.ts`, `sector.html`, and migration `0004_cloudflare_backend.sql`. No Google or Firebase requests were made.

## Current Cloudflare baseline

Clinic, Farm, and MFI now have sector-specific Cloudflare pages and route handlers at different levels of completeness. Unimplemented paths fail closed rather than falling through to unrestricted generic CRUD. No sector has full legacy parity; the checkboxes below describe verified slices and remaining gaps.

**Status legend:** `[x]` restored and verified; `[~]` partially restored; `[ ]` not yet restored. Clinic includes role-gated workspaces, patient registration, appointment scheduling/check-in, visits and vitals, prescribing/dispensing, stock adjustments, manual billing/payments, insurance-claim transitions, basic reports, and D1 guards for appointment slots, stock, and bill balances. Farm has a limited tenant-scoped registry/movement/attendance/egg/inventory slice; feed consumption is disabled until stock deductions can be atomic and idempotent. MFI has limited borrower/KYC validation, application/repayment preview, approval records, and tenant-scoped reads; repayment writes and payment gateways are disabled. No Google/Firebase calls or payment gateway calls are made. Items stay partial wherever legacy scope remains.

## Clinic

- [ ] **Facility setup:** license and facility type, operating hours, emergency contact, bed count, branches, service catalog, insurance providers, and tenant-scoped settings.
- [~] **Role-specific workspaces:** Clinic Admin, Doctor, Nurse, Receptionist, Pharmacist, and Patient get role-gated Phase 1 navigation; full legacy navigation and every permission remain to restore.
- [~] **Patient registry:** patient registration, phone duplicate prevention, optional linking to an existing in-tenant patient account, and institution scope; search and account creation are not yet restored.
- [~] **Appointments and reception:** schedule by patient, in-tenant doctor, date, and time; enforce doctor/time conflicts and check patients in. Branch scheduling, queue management, and the legacy offline queue remain.
- [~] **Triage and clinical records:** nurse/doctor visit entry, validated vitals, BMI calculation, doctor-only clinical notes, and patient history. Abnormal indicators and triage workflow remain.
- [~] **Prescriptions:** doctor-only prescribing, pharmacist dispense with stock decrement, prescription state, and patient read-only history. Full dispense/checkout lifecycle remains.
- [~] **Patient portal:** read-only visits/prescriptions, appointments, bills, and claims with ownership filtering; statements and receipts remain.
- [~] **Pharmacy:** inventory creation, stock adjustment, low-stock display, local name/barcode matching and supported-browser camera scan, and non-negative stock enforcement. Discontinuation retention, product scans, cart checkout, and sales history remain.
- [~] **Scanning and checkout:** local product matching plus supported-browser camera/manual barcode search; cart checkout, scan records, and exactly-once sales deductions remain.
- [~] **Billing:** create bills, record manual payments, partial/full balance states, and admin reversal; unpaid/recent/all-bills tabs, richer invoices, and daily reconciliation remain. Paid bills are immutable except for an explicit reversal.
- [~] **Insurance:** claim creation linked to an optional patient bill and status transitions through draft, submitted, under review, approved/partially approved/rejected, and paid; insurer communications and remittance matching remain.
- [~] **Reports and administration:** basic date-filtered appointment, visit, revenue, low-stock, claim, peak-hour, and doctor-count reports with CSV export and print; comprehensive financial/medical/compliance/custom reports, Excel/PDF export, alerts, staff, communications, templates, and access audit remain.
- [ ] **Offline behavior:** versioned local stores, queues and idempotent sync for appointments, visits, prescriptions, inventory, scans, dispensing, bills, payments, and claims; cached dashboard snapshots. Fresh reports remain online-only.

## Farm

- [~] **Farm setup and roles:** tenant-scoped Admin/Director/Manager/Worker API workspaces; farm settings, owner/contact, products, worker count, and full navigation remain.
- [~] **Animal registry and husbandry:** tenant-scoped animals, assigned-worker views, and validated movement records; seeded animal types, daily summaries, and lost-animal alerts remain.
- [~] **Workers and attendance:** worker-owned attendance records and animal assignment checks; worker registry/assignment management, check-in/out lifecycle, review, and worker mobile view remain.
- [ ] **Biometric attendance:** the legacy workflow includes face enrollment/embedding and an explicit consent field. Do not enable collection or matching by default; require an approved privacy/security design and recorded consent before restoring biometric processing.
- [ ] **Cameras:** camera configuration, heartbeat/connection status, detection modes, and operational reporting.
- [~] **Egg production:** validated manual egg collection records; camera estimates and review remain.
- [~] **Inventory and feed:** tenant-scoped inventory with non-negative D1 guards; feed consumption is intentionally disabled until atomic, idempotent stock deduction is implemented.
- [ ] **Produce and finances:** produce storage, sales with quantity limits, expenses, payment status, and reports are not enabled yet. When restored, legacy rules require these records to be online-only.
- [~] **Management:** basic operational counts report; dashboard metrics, alerts, activity timeline, settings, exports, analytics, and report templates remain.
- [ ] **Offline behavior:** versioned queues and idempotent synchronization for animal movements, attendance, egg collections, feed and other permitted offline records; cached report snapshots.

## MFI

- [~] **Role-specific workspaces:** tenant-scoped Admin, Officer, Manager, Director, and Borrower endpoints with initial role checks; complete permission matrix, branch isolation, audit history, and role-specific navigation remain.
- [~] **Borrower onboarding/KYC:** basic required name, next-of-kin, and married-spouse validation with tenant-scoped borrower reads; full A0 fields, guarantors, documents, KYC/compliance status, and field-limited edits remain.
- [ ] **Collateral operations:** collateral types and scoring, documents/photos, valuation, verification assignments and visits, missing-document checks, decision history, and audit trail.
- [~] **Products and applications:** tenant-scoped product reads, basic application validation, and Flat/Reducing Balance previews that preserve legacy fee treatment; product setup/limits and collateral/guarantor eligibility remain.
- [~] **Approval and disbursement:** role-checked approval records and required comments for rejection/top-up; loan state transitions, verification, disbursement, and generated schedules remain disabled.
- [ ] **Repayments:** manual repayment recording is disabled; schedule updates, partial payments, cascading allocation, credit notes, receipts, and balance enforcement are not yet implemented. No gateway is called.
- [ ] **Collections and risk:** configurable grace period/late fees/caps, overdue scans, notice/warning/final/legal escalation, field visits, officer/manager alerts, and audit logs.
- [ ] **Restructures and write-offs:** manager then director approval for restructuring; director approval before write-off; regenerate schedules and update balances only after the final authorized decision.
- [ ] **Credit notes and refunds:** borrower-visible credit balances, expiry and refund requests; keep these operations online-only.
- [~] **Borrower portal:** tenant/owner-scoped loan, schedule, and repayment reads; full progress, balance statements, receipts, credit notes, and payment initiation remain disabled.
- [~] **Reports and analytics:** tenant-scoped read-only report records; portfolio, disbursement/repayment, arrears, PAR, product/branch/officer, cash flow, compliance, director dashboard, and cached snapshots remain.
- [ ] **Offline behavior:** versioned loan-draft, schedule, and repayment queues with idempotent sync. Approval, restructure, write-off, KYC edits, and credit-note/refund operations stay online-only.
- [x] **Payments hold:** Yo initiation, callbacks, borrower payment initiation, and gateway settlement remain disabled. This checklist does not authorize or implement Yo payment processing.