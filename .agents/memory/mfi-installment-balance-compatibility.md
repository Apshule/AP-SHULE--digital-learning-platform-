---
name: MFI installment balance compatibility
description: Step 2 payment allocation must understand schedule records created by the Step 1 loan generator.
---

MFI installment application must normalize both legacy aggregate payment fields and Step 2 component fields before calculating remaining principal, interest, and late-fee balances.

**Why:** Step 1 schedules may already contain `paidAmount` and `paidPrincipal`, while Step 2 writes separate component balances. Ignoring the legacy fields can apply a later payment twice.

**How to apply:** Treat explicit Step 2 component values as authoritative when present; otherwise derive interest paid from the legacy aggregate minus principal and fees, then write the normalized component fields back during payment application.