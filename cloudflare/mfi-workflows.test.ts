import { describe, expect, it } from "vitest";
import { allocateManualRepayment, handleMfiWorkflowRoute, normalizeInstallment, preview } from "./mfi-workflows";
import type { AuthEnv, AuthUser } from "./backend-types";

const user = (role: string, institutionId = "tenant-a", uid = "u1"): AuthUser => ({
  uid, email: `${uid}@example.test`, displayName: uid, role, schoolId: null, institutionId, sessionVersion: 1,
});
function env(rows: Record<string, unknown>[] = []): AuthEnv {
  const statement = (sql: string, args: unknown[]) => ({
    bind(...values: unknown[]) { args.push(...values); return this; },
    async all<T>() {
      if (sql.includes("sector_records")) return { results: rows as T[] };
      return { results: [] as T[] };
    },
    async run() { return {}; },
  });
  return { DB: { prepare(sql: string) { return statement(sql, []); }, async batch() { return []; } }, PUBLIC_SITE_URL: "" };
}

describe("safe first MFI workflow slice", () => {
  it("normalizes legacy paidAmount and paidPrincipal without double applying", () => {
    expect(normalizeInstallment({ principalDue: 100, interestDue: 20, paidAmount: 60, paidPrincipal: 50 }))
      .toMatchObject({ principalPaid: 50, interestPaid: 10, principalBalance: 50, interestBalance: 10 });
  });
  it("matches the legacy flat-loan preview and reducing-balance calculation", () => {
    expect(preview(1_000_000, 5, 4, "Flat", 2, 1)).toMatchObject({
      installment: 302_500, totalInterest: 200_000, totalFees: 10_000,
      totalRepayment: 1_210_000, processingFee: 20_000, insuranceFee: 10_000,
    });
    const reducing = preview(1_000_000, 3, 4, "Reducing Balance", 2, 1);
    expect(reducing.totalInterest).toBeGreaterThan(0);
    expect(reducing.totalRepayment).toBeGreaterThan(1_000_000);
    expect(reducing.processingFee).toBe(20_000);
    expect(reducing.insuranceFee).toBe(10_000);
  });
  it("allocates late fee, interest, then principal and keeps overpayment separate", () => {
    const result = allocateManualRepayment(200, [{ id: "i1", installmentNumber: 1, principalDue: 100, interestDue: 50, lateFeeDue: 25 }]);
    expect(result.applications[0]).toMatchObject({ amountToLateFee: 25, amountToInterest: 50, amountToPrincipal: 100 });
    expect(result.overpayment).toBe(25);
  });
  it("blocks borrower payment initiation and officer approvals", async () => {
    const payment = await handleMfiWorkflowRoute(new Request("https://x/api/mfi/repayments", { method: "POST", body: JSON.stringify({ amount: 5, loanId: "l" }) }), env(), user("borrower"));
    const approval = await handleMfiWorkflowRoute(new Request("https://x/api/mfi/approvals", { method: "POST", body: JSON.stringify({ loanId: "l", decision: "approved" }) }), env(), user("loan_officer"));
    const directorApproval = await handleMfiWorkflowRoute(new Request("https://x/api/mfi/approvals", { method: "POST", body: JSON.stringify({ loanId: "l", decision: "approved" }) }), env(), user("loan_director"));
    expect(payment?.status).toBe(410); expect(approval?.status).toBe(403); expect(directorApproval?.status).toBe(403);
  });
  it("requires authentication and tenant scope", async () => {
    expect((await handleMfiWorkflowRoute(new Request("https://x/api/mfi/workspace"), env(), null))?.status).toBe(401);
    expect((await handleMfiWorkflowRoute(new Request("https://x/api/mfi/workspace"), env(), user("mfi_admin", "")))?.status).toBe(403);
    expect((await handleMfiWorkflowRoute(new Request("https://x/api/mfi/workspace"), env(), user("superadmin", "")))?.status).toBe(403);
  });
  it("rejects KYC links to accounts outside the active MFI tenant", async () => {
    const response = await handleMfiWorkflowRoute(new Request("https://x/api/mfi/borrowers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fullName: "Borrower", nextOfKinName: "Contact", nextOfKinPhone: "0700000000",
        userId: "other-user",
      }),
    }), env(), user("mfi_admin"));
    expect(response?.status).toBe(400);
  });
  it("does not trust client-supplied KYC ownership fields", async () => {
    const response = await handleMfiWorkflowRoute(new Request("https://x/api/mfi/borrowers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fullName: "Borrower", nextOfKinName: "Contact", nextOfKinPhone: "0700000000",
        ownerUid: "other-user", borrowerUid: "other-user",
      }),
    }), env(), user("mfi_admin"));
    expect(response?.status).toBe(201);
    const data = await response?.json() as { borrower: Record<string, unknown> };
    expect(data.borrower).toMatchObject({ userId: null, ownerUid: null, borrowerUid: null, institutionId: "tenant-a" });
  });
});