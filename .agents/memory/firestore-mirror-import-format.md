---
name: Firestore mirror import format
description: Data shape and safe import rules for the production Firestore document mirror.
---

The D1 `firestore_documents.data_json` mirror retains Firestore typed-value wrappers such as `stringValue`, `integerValue`, `timestampValue`, `arrayValue`, and `mapValue`. Importers must recursively decode those values before assigning D1 columns or building operational `record_json`.

**Why:** SQLite JSON extraction returns wrapper objects, so copying them directly silently creates unusable operational fields and tenant scope IDs.

**How to apply:** Decode each document recursively, remove secrets and signature fields, derive tenant scope explicitly, and leave the raw mirror and user rows unchanged.