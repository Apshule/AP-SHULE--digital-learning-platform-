---
name: Video Studio secure AI boundary
description: The consent and credential boundary for Digital Teacher Twin and AI video generation.
---

Digital Teacher Twin is a UI-only flow until a secure server integration is explicitly configured. Never call ElevenLabs or D-ID directly from the browser, and never persist raw API keys in Firestore; the browser may store only masked configuration metadata and consent/job status.

**Why:** The project brief requires consent-first Twin creation, no live provider calls before explicit configuration, and no client-side credential exposure.

**How to apply:** Future work that enables Twin processing must add server-side secret handling, provider calls, consent/sample validation, budgets, and audit logging before enabling the create/test controls.