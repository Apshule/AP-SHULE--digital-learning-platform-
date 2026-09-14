import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const route = readFileSync(resolve(root, "artifacts/api-server/src/routes/yo-payments.ts"), "utf8");
const firebaseAdminToken = readFileSync(resolve(root, "artifacts/api-server/src/lib/firebase-admin-token.ts"), "utf8");
const rules = readFileSync(resolve(root, "firestore.rules"), "utf8");
const indexes = JSON.parse(readFileSync(resolve(root, "firestore.indexes.json"), "utf8")) as { indexes: Array<{ collectionGroup: string }> };

describe("Task 12 payment backend contracts", () => {
  it("exposes authenticated payment and public webhook routes", () => {
    for (const path of ["/payments/config/status", "/payments/config", "/payments/config/test", "/payments/beneficiaries/verify", "/payments/initiate", "/webhooks/yo/ipn", "/webhooks/yo/failure"]) expect(route).toContain(path);
    expect(route).toContain("NonBlocking");
    expect(route).toContain("RSA-SHA1");
    expect(route).toContain("duplicate");
    expect(route).toContain("recent.length >= 5");
  });
  it("keeps credentials server-side and protects payment collections", () => {
    for (const secret of ["YO_API_USERNAME", "YO_API_PASSWORD", "YO_API_PUBLIC_KEY"]) expect(route).toContain(secret);
    expect(firebaseAdminToken).toContain("FIREBASE_SERVICE_ACCOUNT_JSON");
    for (const collection of ["payment_transactions", "institution_beneficiaries", "payment_disbursements", "payment_notifications", "payment_settings", "yo_webhook_logs", "payment_audit_log"]) expect(rules).toContain(`match /${collection}/`);
  });
  it("declares payment query indexes", () => {
    expect(indexes.indexes.filter((index) => ["payment_transactions", "institution_beneficiaries", "payment_disbursements", "payment_notifications", "yo_webhook_logs"].includes(index.collectionGroup)).length).toBeGreaterThanOrEqual(8);
  });
});