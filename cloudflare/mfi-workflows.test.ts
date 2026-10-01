import { describe, expect, it } from "vitest";
import { allocateManualRepayment, handleMfiWorkflowRoute, normalizeInstallment, preview } from "./mfi-workflows";
import type { AuthEnv, AuthUser } from "./backend-types";

const user = (role: string, institutionId = "tenant-a", uid = "u1"): AuthUser => ({
  uid, email: `${uid}@example.test`, displayName: uid, role, schoolId: null, institutionId, sessionVersion: 1,
});
function env(
  rows: Record<string, unknown>[] = [],
  roleCapabilities: Record<string, unknown>[] = [],
): AuthEnv {
  const statement = (sql: string, args: unknown[]) => ({
    bind(...values: unknown[]) { args.push(...values); return this; },
    async all<T>() {
      if (sql.includes("role_capabilities")) return { results: roleCapabilities as T[] };
      if (sql.includes("sector_records")) return { results: rows as T[] };
      return { results: [] as T[] };
    },
    async run() { return {}; },
  });
  const pg = {
    async query<T = Record<string, unknown>>(sql: string): Promise<{ rows: T[] }> {
      if (sql.includes("role_capabilities")) return { rows: roleCapabilities as T[] };
      if (sql.includes("sector_records") && sql.trimStart().toLowerCase().startsWith("select")) {
        return { rows: rows as T[] };
      }
      return { rows: [] as T[] };
    },
  };
  return {
    DB: { prepare(sql: string) { return statement(sql, []); }, async batch() { return []; } },
    PG: pg as AuthEnv["PG"],
    PUBLIC_SITE_URL: "",
  };
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
  it("blocks borrower payment initiation and roles without the approval capability", async () => {
    const payment = await handleMfiWorkflowRoute(new Request("https://x/api/mfi/repayments", { method: "POST", body: JSON.stringify({ amount: 5, loanId: "l" }) }), env(), user("borrower"));
    const officerApproval = await handleMfiWorkflowRoute(new Request("https://x/api/mfi/approvals", { method: "POST", body: "{}" }), env([], [{ capability: "records.read", sector: "mfi", scope: "tenant" }]), user("loan_officer"));
    const adminApproval = await handleMfiWorkflowRoute(new Request("https://x/api/mfi/approvals", { method: "POST", body: "{}" }), env([], [{ capability: "records.manage", sector: "mfi", scope: "tenant" }]), user("mfi_admin"));
    expect(payment?.status).toBe(410);
    expect(officerApproval?.status).toBe(403);
    expect(adminApproval?.status).toBe(403);
  });
  it("uses the MFI capability grants for report and approval access", async () => {
    const read = [{ capability: "records.read", sector: "mfi", scope: "tenant" }];
    const approve = [{ capability: "loans.approve", sector: "mfi", scope: "tenant" }];

    const reports = await handleMfiWorkflowRoute(new Request("https://x/api/mfi/reports"), env([], read), user("loan_director"));
    expect(reports?.status).toBe(200);
    expect(await reports?.json()).toMatchObject({ ok: true, reports: [] });

    const borrowerReports = await handleMfiWorkflowRoute(new Request("https://x/api/mfi/reports"), env([], [{ capability: "records.own.read", sector: "mfi", scope: "tenant" }]), user("borrower"));
    expect(borrowerReports?.status).toBe(403);

    const reportWrite = await handleMfiWorkflowRoute(new Request("https://x/api/mfi/reports", {
      method: "POST", body: "{}",
    }), env([], read), user("loan_director"));
    expect(reportWrite?.status).toBe(405);

    for (const role of ["loan_manager", "loan_director"]) {
      const approvalRead = await handleMfiWorkflowRoute(new Request("https://x/api/mfi/approvals"), env([], approve), user(role));
      expect(approvalRead?.status).toBe(200);
      expect(await approvalRead?.json()).toMatchObject({ ok: true, records: [] });

      const approvalWrite = await handleMfiWorkflowRoute(new Request("https://x/api/mfi/approvals", {
        method: "POST", body: "{}",
      }), env([], approve), user(role));
      expect(approvalWrite?.status).toBe(400);
    }
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