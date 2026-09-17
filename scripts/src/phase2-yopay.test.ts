import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const route = readFileSync(
  resolve(root, "artifacts/api-server/src/routes/yopay-subscriptions.ts"),
  "utf8",
);
const auth = readFileSync(
  resolve(root, "artifacts/api-server/src/lib/firebase-auth.ts"),
  "utf8",
);
const usage = readFileSync(
  resolve(root, "artifacts/api-server/src/lib/ai-usage.ts"),
  "utf8",
);
const aiRoute = readFileSync(
  resolve(root, "artifacts/api-server/src/routes/ai-assistant.ts"),
  "utf8",
);
const upgrade = readFileSync(resolve(root, "upgrade.html"), "utf8");
const rules = readFileSync(resolve(root, "firestore.rules"), "utf8");

describe("Phase 2 Yo! mock subscription contracts", () => {
  it("keeps the mock Yo! flow server-owned", () => {
    expect(route).toContain('router.post("/payment/initiate-yopay"');
    expect(route).toContain('router.post("/payment/webhook/yopay"');
    for (const field of [
      "userId",
      "amount",
      "currency",
      "status",
      "yopayReference",
      "createdAt",
    ]) {
      expect(route).toContain(field);
    }
    expect(route).toContain('subscriptionTier: "premium"');
    expect(route).toContain("aiRequestsLimit: 500");
    expect(route).toContain("currentStatus === \"paid\"");
  });

  it("uses free and premium profile limits in the AI middleware", () => {
    expect(auth).toContain("DEFAULT_FREE_AI_LIMIT = 10");
    expect(auth).toContain("PREMIUM_AI_LIMIT = 500");
    expect(usage).toContain("PREMIUM_DAILY_AI_LIMIT = 500");
    expect(aiRoute).toContain("caller.aiRequestsLimit");
  });

  it("provides the signed-in mock upgrade page and callback button", () => {
    expect(upgrade).toContain('id="phoneNumber"');
    expect(upgrade).toContain('id="initiateButton"');
    expect(upgrade).toContain('id="simulateButton"');
    expect(upgrade).toContain("/api/payment/webhook/yopay");
    expect(upgrade).toContain("status: 'SUCCESS'");
  });

  it("protects invoices from direct client completion", () => {
    expect(rules).toContain("match /invoices/{invoiceId}");
    expect(rules).toContain("allow update, delete: if false;");
    expect(rules).toContain("users|user_usage|invoices");
  });
});