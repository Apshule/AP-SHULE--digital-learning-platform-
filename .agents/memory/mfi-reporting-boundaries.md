---
name: MFI reporting boundaries
description: Durable access-control and offline-cache rules for MFI analytics, reports, and borrower views.
---

MFI portfolio analytics and generated-report caches must remain read-only snapshots. They may summarize institution-scoped customers, collateral, branches, decisions, and verification records, but they must not become an offline write path for approvals, borrower edits, or cross-institution data.

**Why:** Loan Director, MFI Admin, manager, officer, and borrower workflows have different mutation rights. Keeping reporting separate from mutation reduces the chance that offline synchronization bypasses Firestore rules.

**How to apply:** Add new MFI analytics or report views by extending institution-scoped reads and cache records. Keep approvals, blacklist changes, branch administration, receipts, and collateral updates on explicit online operations with field-level rules where a director has a narrow action.