import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const indexSource = readFileSync(resolve(root, "index.html"), "utf8");
const route = readFileSync(resolve(root, "artifacts/api-server/src/routes/yo-payments.ts"), "utf8");
const firebaseAdminToken = readFileSync(resolve(root, "artifacts/api-server/src/lib/firebase-admin-token.ts"), "utf8");
const rules = readFileSync(resolve(root, "firestore.rules"), "utf8");
const indexes = JSON.parse(readFileSync(resolve(root, "firestore.indexes.json"), "utf8")) as { indexes: Array<{ collectionGroup: string }> };

describe("Task 12 payment backend contracts", () => {
  it("keeps the education subscription modal on the authenticated payment boundary", () => {
    expect(indexSource).toContain("window.task12Api = api");
    expect(indexSource).toContain("window.openYoPayment = openClientPayment");
    expect(indexSource).toContain("const paymentApi=window.task12Api");
    expect(indexSource).toContain("Payment provider not yet configured. Please contact support.");
    for (const plan of ["Daily", "Weekly", "Monthly", "Term Plan", "Half Year", "Full Year"]) {
      expect(indexSource).toContain(`name:'${plan}'`);
    }
  });
  it("exposes authenticated payment and public webhook routes", () => {
    for (const path of ["/payments/config/status", "/payments/config", "/payments/config/test", "/payments/beneficiaries/verify", "/payments/initiate", "/payments/summary", "/payments/credits/apply", "/payments/reminders/run", "/payments/disbursements", "/webhooks/yo/ipn", "/webhooks/yo/failure", "/webhooks/yo/disbursement"]) expect(route).toContain(path);
    expect(route).toContain("NonBlocking");
    expect(route).toContain("RSA-SHA1");
    expect(route).toContain("duplicate");
    expect(route).toContain("recent.length >= 5");
  });
  it("keeps credentials server-side and protects payment collections", () => {
    for (const secret of ["YO_API_USERNAME", "YO_API_PASSWORD", "YO_API_PUBLIC_KEY"]) expect(route).toContain(secret);
    expect(firebaseAdminToken).toContain("FIREBASE_SERVICE_ACCOUNT_JSON");
    for (const collection of ["payment_transactions", "institution_beneficiaries", "payment_disbursements", "payment_notifications", "payment_settings", "yo_webhook_logs", "payment_audit_log", "credit_notes", "sector_balances", "payment_reminders"]) expect(rules).toContain(`match /${collection}/`);
    expect(route).toContain("item.isActive === true");
    expect(route).toContain("maxAttempts: 3");
    expect(route).toContain("retryDelaysSeconds: [30, 120, 600]");
    expect(route).toContain("beneficiaryType");
    expect(route).toContain("beneficiaryAccount");
    expect(route).toContain("transaction.amountPaid");
    expect(route).toContain("reminderTypeFor");
    expect(route).toContain("amountSource: stored ? \"server_bill_record\"");
    expect(route).toContain("repaymentSchedule");
  });
  it("declares payment query indexes", () => {
    const required = ["credit_notes", "sector_balances", "payment_reminders"];
    for (const collection of required) expect(indexes.indexes.some((index) => index.collectionGroup === collection)).toBe(true);
    expect(indexes.indexes.filter((index) => ["payment_transactions", "institution_beneficiaries", "payment_disbursements", "payment_notifications", "yo_webhook_logs"].includes(index.collectionGroup)).length).toBeGreaterThanOrEqual(8);
  });
});