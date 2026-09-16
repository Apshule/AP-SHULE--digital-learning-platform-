---
name: Command Center overlay guards
description: Super Admin Command Center interactions can be blocked by unrelated full-screen layers or uninitialized quick actions.
---

The Command Center must clear global search, AI drawer, payment/settings, and existing fullscreen modal layers when it boots, navigates, or opens a module. Any quick-action tile rendered in the Super Admin page must be bound during the Super Admin bootstrap itself; sector-specific initialization is not guaranteed to run for that role.

**Why:** The phone recording showed the Command Center visible while taps appeared dead. The underlying cause included a quick action whose listener was only initialized on MFI routes, while unrelated full-screen layers could also intercept taps.

**How to apply:** When adding Command Center actions, bind them from `initCommandCenter` or a helper it always calls, and use the shared blocking-layer cleanup before changing pages or opening modals.