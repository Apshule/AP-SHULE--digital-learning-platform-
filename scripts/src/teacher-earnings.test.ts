import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const indexSource = readFileSync(resolve(root, "index.html"), "utf8");
const route = readFileSync(resolve(root, "artifacts/api-server/src/routes/yo-payments.ts"), "utf8");
const rules = readFileSync(resolve(root, "firestore.rules"), "utf8");
const indexes = JSON.parse(readFileSync(resolve(root, "firestore.indexes.json"), "utf8")) as {
  indexes: Array<{ collectionGroup: string }>;
};

describe("teacher earnings and payout contracts", () => {
  it("configures every agreement source and shows source-by-source totals", () => {
    for (const field of [
      "teacherRevenuePerView",
      "teacherPdfRevenuePerView",
      "teacherLiveRevenuePercent",
      "teacherReferralReward",
      "teacherAgreementSummary",
      "teacherAvailableToWithdraw",
    ]) {
      expect(indexSource).toContain(field);
    }
    for (const source of ["recorded_lesson", "teacher_pdf", "live_lesson", "teacher_referral"]) {
      expect(indexSource).toContain(`source:'${source}'`);
    }
  });

  it("keeps teacher payouts behind the authenticated server and settles only after Yo confirmation", () => {
    expect(route).toContain('router.post("/payments/teacher/withdraw"');
    expect(route).toContain("approvalRequired: false");
    expect(route).toContain("pending_validation");
    expect(route).toContain("profileMatches");
    expect(route).toContain('payoutStatus: "reserved"');
    expect(route).toContain('payoutStatus: "paid"');
    expect(route).toContain("completeTeacherEarnings");
    expect(route).toContain("/api/webhooks/yo/disbursement");
    expect(indexSource).toContain("/api/payments/teacher/withdraw");
  });

  it("scopes earnings and withdrawal history to the owning teacher", () => {
    expect(rules).toContain("match /teacherEarnings/{earningId}");
    expect(rules).toContain("match /teacherWithdrawals/{withdrawalId}");
    expect(rules).toContain("resource.data.teacherId == request.auth.uid");
    expect(rules).toContain("match /teacherPayoutLocks/{lockId}");
    expect(indexes.indexes.some((index) => index.collectionGroup === "teacherWithdrawals")).toBe(true);
  });
});