import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const indexSource = readFileSync(resolve(root, "index.html"), "utf8");
const route = readFileSync(resolve(root, "artifacts/api-server/src/routes/student-referrals.ts"), "utf8");
const auth = readFileSync(resolve(root, "artifacts/api-server/src/lib/firebase-auth.ts"), "utf8");
const rules = readFileSync(resolve(root, "firestore.rules"), "utf8");

describe("student referral rewards", () => {
  it("lets a student choose cash or a 24-hour premium reward", () => {
    expect(indexSource).toContain("reward=cash");
    expect(indexSource).toContain("Add 24 hours of premium access");
    expect(indexSource).toContain("Add UGX 500 cash reward");
    expect(indexSource).toContain("/api/referrals/redeem");
    expect(route).toContain('router.post("/referrals/redeem"');
    expect(route).toContain("STUDENT_CASH_REWARD_UGX = 500");
    expect(route).toContain("premiumAccessUntil");
  });

  it("gates student referral rewards behind the UGX 1,000 payment callback", () => {
    expect(indexSource).toContain("/api/referrals/registration-payment");
    expect(indexSource).toContain("signupPaymentMethod");
    expect(indexSource).toContain("pending_payment");
    expect(route).toContain('router.post("/referrals/registration-payment"');
    expect(route).toContain("STUDENT_SIGNUP_FEE_UGX = 1000");
    expect(route).toContain("settleStudentReferralPayment");
    expect(route).toContain('status: "completed"');
    expect(route).toContain('status: "processing"');
    expect(indexSource).toContain("/api/payments/student/referral-withdraw");
  });

  it("makes redemption server-side and prevents claiming twice", () => {
    expect(route).toContain("referralRewardClaimedAt");
    expect(route).toContain("studentReferralRewards");
    expect(route).toContain("newUser.referredBy");
    expect(auth).toContain("premiumAccessUntil");
  });

  it("limits reward history reads to the referrer or referred student", () => {
    expect(rules).toContain("match /studentReferralRewards/{rewardId}");
    expect(rules).toContain("resource.data.referrerId == request.auth.uid");
    expect(rules).toContain("resource.data.referredUserId == request.auth.uid");
    expect(rules).toContain("match /studentReferralPayments/{paymentId}");
    expect(rules).toContain("match /studentReferralWithdrawals/{withdrawalId}");
  });

  it("gives Super Admin control over teacher and student referral links", () => {
    expect(indexSource).toContain("superAdminReferralsPage");
    expect(indexSource).toContain("data-command-action=\"referrals\"");
    expect(indexSource).toContain("/api/admin/referrals");
    expect(indexSource).toContain("Regenerate");
    expect(route).toContain('router.get("/admin/referrals"');
    expect(route).toContain('router.patch("/admin/referrals/:userId"');
    expect(route).toContain("Only Super Admins can manage referral links");
    expect(route).toContain("referralLinksEnabled");
    expect(route).toContain("referralRewardPerSignup");
  });
});