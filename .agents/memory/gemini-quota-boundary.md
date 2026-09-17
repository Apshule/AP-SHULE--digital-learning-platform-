---
name: Gemini quota boundary
description: Shared provider quota can make every sector AI request fail even when authentication and role mapping are correct.
---

The AI smoke test must distinguish Firebase authentication and sector authorization from provider availability. The configured Gemini key has a shared request quota across all APSHULE accounts, so a multi-account QA batch can exhaust it and make every sector return a provider error.

**Why:** A five-account QA run authenticated successfully and representative safety responses worked, but a larger batch exhausted the shared generation quota; later requests from every sector failed even though their roles were valid.

**How to apply:** Keep sector smoke tests low-volume, report quota failures separately from role failures, and treat the AI assistant as advisory unless explicit server-side action tools and approval checks are implemented.