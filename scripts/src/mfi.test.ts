import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const indexSource = readFileSync(resolve(root, "index.html"), "utf8");
const offlineSource = readFileSync(resolve(root, "offline-manager.js"), "utf8");
const rulesSource = readFileSync(resolve(root, "firestore.rules"), "utf8");
const indexes = JSON.parse(readFileSync(resolve(root, "firestore.indexes.json"), "utf8")) as {
  indexes: Array<{ collectionGroup: string; fields: Array<{ fieldPath: string; order?: string }> }>;
};

function loadScorer() {
  const match = indexSource.match(/function computeCollateralScore\([\s\S]*?\n    }\n    window\.computeCollateralScore/);
  if (!match) throw new Error("MFI scorer was not found");
  const source = match[0].replace(/\n    window\.computeCollateralScore[\s\S]*$/, "");
  const context = vm.createContext({});
  vm.runInContext(`
    function mfiNormalizeTypeName(value){return String(value||'').toLowerCase().replace(/&/g,'and').replace(/[^a-z0-9]+/g,' ').trim();}
    ${source}
    this.computeCollateralScore = computeCollateralScore;
  `, context);
  return context.computeCollateralScore as (data: Record<string, unknown>, customer: Record<string, unknown>, type: Record<string, unknown>) => Record<string, unknown>;
}

describe("Task 10 Step 1 MFI foundation contracts", () => {
  it("scores the five required components and applies exact grade boundaries", () => {
    const score = loadScorer();
    const full = (score({
      typeId: "land",
      ownershipProofType: "title deed",
      estimatedValueUgx: 2_000_000,
      location: "Kampala",
    }, { requestedLoanAmount: 1_000_000 }, { id: "land", name: "Land & Property", baseScore: 25 })) as any;
    expect(full).toMatchObject({
      assetTypeScore: 25,
      ownershipProofScore: 25,
      marketValueScore: 20,
      locationScore: 15,
      liquidityScore: 15,
      totalScore: 100,
      grade: "Excellent",
      recommendation: "Approve",
    });
    expect(score({ typeId: "household", ownershipProofType: "", estimatedValueUgx: 0, location: "" }, {}, { id: "household", name: "Household Assets", baseScore: 5 })).toMatchObject({ totalScore: 8, grade: "Weak", recommendation: "Reject" });
    expect(indexSource).toContain("totalScore>=80?'Excellent':totalScore>=60?'Good':totalScore>=40?'Fair':'Weak'");
    expect(indexSource).toContain("totalScore>=60?'Approve':totalScore>=40?'Request Top-up':'Reject'");
  });

  it("declares MFI roles and guards MFI-only navigation", () => {
    for (const role of ["mfi_admin", "loan_officer", "loan_manager", "loan_director", "borrower"]) {
      expect(indexSource).toContain(role);
    }
    expect(indexSource).toContain("function isMfiRole");
    expect(indexSource).toContain("function mfiRequireAccess");
    expect(indexSource).toContain("setupMfiNavigation");
    expect(indexSource).toContain("if(isSuper) navigateSuperAdmin('dashboard'); else if(isMfi)");
  });

  it("includes customer, collateral, documents, branches, and seeded type surfaces", () => {
    for (const value of ["mfi_customers", "mfi_collateral", "mfi_collateral_scoring", "mfi_collateral_documents", "mfi_branches", "institution_branding"]) {
      expect(indexSource).toContain(value);
      expect(rulesSource).toContain(value);
    }
    expect(indexSource).toContain("seedMfiCollateralTypesBtn");
    for (const type of ["Land & Property", "Vehicle", "Guarantor", "Business Assets", "Bank Guarantee", "Household Assets"]) {
      expect(indexSource).toContain(type);
    }
  });

  it("adds all required composite indexes", () => {
    const required: Array<[string, string[]]> = [
      ["mfi_customers", ["institutionId", "createdAt"]],
      ["mfi_customers", ["institutionId", "status"]],
      ["mfi_collateral", ["customerId", "createdAt"]],
      ["mfi_collateral", ["institutionId", "status"]],
      ["mfi_collateral_scoring", ["status", "scoredAt"]],
    ];
    for (const [collectionGroup, fields] of required) {
      expect(indexes.indexes.some(index => index.collectionGroup === collectionGroup && fields.every(field => index.fields.some(item => item.fieldPath === field)))).toBe(true);
    }
  });

  it("keeps loan officers out of scoring decisions and scopes records by institution", () => {
    expect(rulesSource).toContain("role() in ['mfi_admin', 'loan_manager']");
    expect(rulesSource).toContain("sameMfiInstitution(resource.data.institutionId)");
    expect(rulesSource).toContain("sameMfiInstitution(request.resource.data.institutionId)");
    expect(indexSource).toContain("pushMfiCollateral");
    expect(indexSource).toContain("queueMfiCollateral");
    expect(offlineSource).toContain("offline_mfi_customers");
    expect(offlineSource).toContain("offline_mfi_collateral");
    expect(offlineSource).toContain("queueMfiCustomer");
    expect(offlineSource).toContain("queueMfiCollateral");
  });

  it("adds the manager review, decision, verification, registry, and audit surfaces", () => {
    for (const value of [
      "mfi_collateral_verification",
      "mfi_collateral_decisions",
      "mfi_valuers",
      "mfi_legal_officers",
      "mfiManagerHomePage",
      "managerReviewsListModal",
      "managerReviewModal",
      "scheduleVerificationModal",
      "verificationActivityModal",
      "mfiSettingsPage",
      "mfiPrintDecisionHistory",
    ]) {
      expect(indexSource).toContain(value);
    }
  });

  it("enforces manager decision comments, top-up details, and mandatory verification", () => {
    expect(indexSource).toContain("Comments are required for rejection or top-up");
    expect(indexSource).toContain("Top-up amount and collateral type are required");
    expect(indexSource).toContain("Complete required verification");
    expect(indexSource).toContain("estimatedValueUgx||0)>20000000");
    expect(indexSource).toContain("Legal Check");
    expect(indexSource).toContain("Valuer Report");
  });

  it("supports document validation and offline verification synchronization", () => {
    expect(indexSource).toContain("mfiValidateDocuments");
    expect(indexSource).toContain("up to 10 files");
    expect(indexSource).toContain("5*1024*1024");
    expect(indexSource).toContain("Offline.queueMfiVerification");
    expect(indexSource).toContain("pushMfiVerification");
    expect(offlineSource).toContain("offline_mfi_verification");
    expect(offlineSource).toContain("queueMfiVerification");
    expect(offlineSource).toContain("markMfiVerificationSynced");
  });

  it("keeps Step 2 collections institution-scoped and immutable where appropriate", () => {
    expect(rulesSource).toContain("match /mfi_collateral_verification/{verificationId}");
    expect(rulesSource).toContain("match /mfi_collateral_decisions/{decisionId}");
    expect(rulesSource).toContain("match /mfi_valuers/{valuerId}");
    expect(rulesSource).toContain("match /mfi_legal_officers/{officerId}");
    expect(rulesSource).toContain("allow update, delete: if isSuperAdmin();");
    expect(rulesSource).toContain("resource.data.assignedToId == request.auth.uid");
  });

  it("declares the five Step 2 verification and decision indexes", () => {
    const required: Array<[string, string[]]> = [
      ["mfi_collateral_verification", ["institutionId", "status", "dueAt"]],
      ["mfi_collateral_verification", ["institutionId", "assignedToId", "status"]],
      ["mfi_collateral_verification", ["collateralId", "scheduledAt"]],
      ["mfi_collateral_decisions", ["institutionId", "decision", "decidedAt"]],
      ["mfi_collateral_decisions", ["collateralId", "decidedAt"]],
    ];
    for (const [collectionGroup, fields] of required) {
      expect(indexes.indexes.some(index =>
        index.collectionGroup === collectionGroup &&
        fields.every(field => index.fields.some(item => item.fieldPath === field))
      )).toBe(true);
    }
  });

  it("implements Step 3 director, portfolio, risk, performance, and UMRA report surfaces", () => {
    for (const value of [
      "mfiDirectorHomePage",
      "setupMfiDirectorNavigation",
      "mfiOpenPortfolio",
      "mfiOpenRiskAnalytics",
      "mfiOpenPerformance",
      "generateUmraReport",
      "Collateral Register",
      "Collateral Valuation Report",
      "Collateral Coverage Summary",
      "Loan Register",
      "Overdue Report",
      "Branch Performance Report",
      "Quarterly Compliance Report",
      "mfiExportUmraReport",
    ]) {
      expect(indexSource).toContain(value);
    }
  });

  it("supports borrower read-only access, receipts, branches, and offline report caches", () => {
    for (const value of ["mfiBorrowerHomePage", "mfiDownloadBorrowerStatement", "mfi_receipts", "mfiSaveBranch", "cacheMfiPortfolio", "cacheMfiReport", "offline_mfi_portfolio", "offline_mfi_reports"]) {
      expect(indexSource + offlineSource + rulesSource).toContain(value);
    }
    expect(rulesSource).toContain("role() == 'borrower'");
    expect(rulesSource).toContain("request.resource.data.diff(resource.data).affectedKeys().hasOnly");
  });

  it("declares the Step 3 branch, expiry, decision, and receipt indexes", () => {
    const required: Array<[string, string[]]> = [
      ["mfi_collateral", ["institutionId", "branchId", "createdAt"]],
      ["mfi_collateral", ["institutionId", "typeId", "estimatedValueUgx"]],
      ["mfi_collateral", ["institutionId", "expiryDate"]],
      ["mfi_customers", ["institutionId", "branchId", "createdAt"]],
      ["mfi_collateral_decisions", ["institutionId", "decidedBy", "decidedAt"]],
      ["mfi_receipts", ["institutionId", "createdAt"]],
      ["mfi_receipts", ["customerId", "createdAt"]],
    ];
    for (const [collectionGroup, fields] of required) {
      expect(indexes.indexes.some(index =>
        index.collectionGroup === collectionGroup &&
        fields.every(field => index.fields.some(item => item.fieldPath === field))
      )).toBe(true);
    }
  });
});

function loadLoanPreview() {
  const match = indexSource.match(/function mfiLoanPreview\([\s\S]*?\n    }\n    function mfiLoanPreviewHtml/);
  if (!match) throw new Error("MFI loan preview was not found");
  const source = match[0].replace(/\n    function mfiLoanPreviewHtml[\s\S]*$/, "");
  const context = vm.createContext({});
  vm.runInContext(`${source}\nthis.mfiLoanPreview = mfiLoanPreview;`, context);
  return context.mfiLoanPreview as (
    principal: number,
    rate: number,
    term: number,
    type: string,
    processing?: number,
    insurance?: number
  ) => Record<string, number>;
}

describe("Task 14 Step 1 full MFI loan lifecycle contracts", () => {
  it("declares the loan lifecycle collections and role-specific surfaces", () => {
    for (const value of [
      "mfi_loan_products",
      "microfinance_loans",
      "mfi_loan_repayment_schedule",
      "mfi_loan_payments",
      "mfi_loan_approvals",
      "mfiLoansPage",
      "loanApplicationModal",
      "loanReviewModal",
      "loanDisbursementModal",
      "recordLoanPaymentModal",
      "mfiBorrowerLoansList",
      "mfiSyncOfflineLoan",
      "mfiSyncOfflineLoanPayment",
    ]) {
      expect(indexSource).toContain(value);
    }
    expect(indexSource).toContain("mfiLoanCanApprove");
    expect(indexSource).toContain("mfiLoanCanDisburse");
    expect(indexSource).toContain("mfiLoanCanRecordPayment");
  });

  it("calculates flat and reducing-balance repayment amounts with fees", () => {
    const preview = loadLoanPreview();
    expect(preview(1_000_000, 5, 4, "Flat", 2, 1)).toMatchObject({
      installment: 302_500,
      totalInterest: 200_000,
      totalFees: 10_000,
      totalRepayment: 1_210_000,
      processingFee: 20_000,
      insuranceFee: 10_000,
    });
    const reducing = preview(1_000_000, 3, 4, "Reducing Balance", 2, 1);
    expect(reducing.totalInterest).toBeGreaterThan(0);
    expect(reducing.totalRepayment).toBeGreaterThan(1_000_000);
    expect(reducing.processingFee).toBe(20_000);
    expect(reducing.insuranceFee).toBe(10_000);
  });

  it("keeps borrower access read-only and institution scoped in Firestore rules", () => {
    expect(rulesSource).toContain("match /mfi_loan_products/{productId}");
    expect(rulesSource).toContain("match /microfinance_loans/{loanId}");
    expect(rulesSource).toContain("match /mfi_loan_repayment_schedule/{installmentId}");
    expect(rulesSource).toContain("match /mfi_loan_payments/{paymentId}");
    expect(rulesSource).toContain("match /mfi_loan_approvals/{approvalId}");
    expect(rulesSource).toContain("match /mfi_loan_documents/{documentId}");
    expect(rulesSource).toContain("role() == 'borrower' && resource.data.customerId == request.auth.uid");
    expect(rulesSource).toContain("allow delete: if false;");
    expect(rulesSource).toContain("sameMfiInstitution(request.resource.data.institutionId)");
  });

  it("declares all nine loan lifecycle composite indexes", () => {
    const required: Array<[string, string[]]> = [
      ["microfinance_loans", ["institutionId", "status"]],
      ["microfinance_loans", ["customerId", "createdAt"]],
      ["microfinance_loans", ["institutionId", "nextPaymentDueDate"]],
      ["microfinance_loans", ["status", "nextPaymentDueDate"]],
      ["mfi_loan_repayment_schedule", ["loanId", "installmentNumber"]],
      ["mfi_loan_repayment_schedule", ["dueDate", "status"]],
      ["mfi_loan_payments", ["loanId", "paymentDate"]],
      ["mfi_loan_payments", ["institutionId", "paymentDate"]],
      ["mfi_loan_products", ["institutionId", "isActive"]],
    ];
    for (const [collectionGroup, fields] of required) {
      expect(indexes.indexes.some(index =>
        index.collectionGroup === collectionGroup &&
        fields.every(field => index.fields.some(item => item.fieldPath === field))
      )).toBe(true);
    }
  });

  it("adds versioned offline loan draft and payment queues with sync hooks", () => {
    expect(offlineSource).toContain("var DB_VERSION = 23");
    expect(offlineSource).toContain("offline_mfi_loans");
    expect(offlineSource).toContain("offline_mfi_loan_payments");
    for (const value of [
      "queueMfiLoan",
      "listMfiLoans",
      "markMfiLoanSynced",
      "queueMfiLoanPayment",
      "listMfiLoanPayments",
      "markMfiLoanPaymentSynced",
      "pushMfiLoans",
      "pushMfiLoanPayments",
    ]) {
      expect(indexSource + offlineSource).toContain(value);
    }
  });

  it("guards against negative balances and exposes borrower progress, schedules, and history", () => {
    expect(indexSource).toContain("Math.max(0,Number(loan.balanceRemaining||0)-amount)");
    expect(indexSource).toContain("status:balance<=0?'fully_repaid':'repaying'");
    expect(indexSource).toContain("Payment history");
    expect(indexSource).toContain("Repayment schedule");
    expect(indexSource).toContain("Pay Now");
  });
});

function loadStep2Allocator() {
  const match = indexSource.match(/function mfiStep2Today[\s\S]*?window\.mfiApplyPaymentToLoan=mfiApplyPaymentToLoan;/);
  if (!match) throw new Error("MFI Step 2 payment engine was not found");
  const source = match[0].replace(/\n    window\.mfiApplyPaymentToLoan=mfiApplyPaymentToLoan;$/, "");
  const context = vm.createContext({});
  vm.runInContext(`${source}\nthis.mfiApplyPaymentToLoan = mfiApplyPaymentToLoan; this.mfiStep2EscalationLevel = mfiStep2EscalationLevel;`, context);
  return {
    apply: context.mfiApplyPaymentToLoan as (amount: number, rows: Array<Record<string, unknown>>, options?: Record<string, unknown>) => any,
    level: context.mfiStep2EscalationLevel as (days: number) => number,
  };
}

describe("Task 14 Step 2 — partial payments, risk controls, and portals", () => {
  it("A. marks an installment partially_paid and applies interest before principal", () => {
    const { apply } = loadStep2Allocator();
    const result = apply(100_000, [{
      id: "installment-1",
      loanId: "loan-1",
      installmentNumber: 1,
      dueDate: "2099-11-15",
      principalDue: 125_558,
      interestDue: 100_000,
      totalDue: 225_558,
      status: "pending",
    }], { loanId: "loan-1" });
    expect(result.overpayment).toBe(0);
    expect(result.applications[0]).toMatchObject({ amountToInterest: 100_000, amountToPrincipal: 0, amountToLateFee: 0 });
    expect(result.updatedSchedule[0]).toMatchObject({ status: "partially_paid", interestPaid: 100_000, principalPaid: 0, remainingBalance: 125_558 });
  });

  it("B. cascades across installments and creates an overpayment balance", () => {
    const { apply } = loadStep2Allocator();
    const result = apply(250, [
      { id: "one", installmentNumber: 1, dueDate: "2099-01-01", principalDue: 50, interestDue: 50, totalDue: 100, status: "pending" },
      { id: "two", installmentNumber: 2, dueDate: "2099-02-01", principalDue: 50, interestDue: 50, totalDue: 100, status: "pending" },
    ], { loanId: "loan-1" });
    expect(result.applications.map((row: any) => row.installmentId)).toEqual(["one", "two"]);
    expect(result.updatedSchedule.every((row: any) => row.status === "paid")).toBe(true);
    expect(result.overpayment).toBe(50);
    expect(result.remainingLoanBalance).toBe(0);
  });

  it("C. applies late fees before interest and principal", () => {
    const { apply } = loadStep2Allocator();
    const result = apply(5_000, [{
      id: "late",
      installmentNumber: 1,
      dueDate: "2026-01-01",
      principalDue: 10_000,
      interestDue: 5_000,
      lateFeeApplied: 5_000,
      status: "overdue",
    }]);
    expect(result.applications[0]).toMatchObject({ amountToLateFee: 5_000, amountToInterest: 0, amountToPrincipal: 0 });
    expect(result.updatedSchedule[0].lateFeeDue).toBe(0);
    expect(result.updatedSchedule[0].interestBalance).toBe(5_000);
  });

  it("D. progresses overdue escalation from notice to warning, final, and legal", () => {
    const { level } = loadStep2Allocator();
    expect([level(1), level(8), level(15), level(61)]).toEqual([1, 2, 3, 4]);
    expect(indexSource).toContain("mfiStep2RunOverdueScan");
    expect(indexSource).toContain("mfi_loan_overdue_log");
    expect(indexSource).toContain("field_visit");
  });

  it("E. creates and presents credit notes for overpayments", () => {
    for (const value of ["mfi_credit_notes", "balanceRemaining", "expiryDate", "mfiStep2CreateCreditNote", "Request refund"]) {
      expect(indexSource).toContain(value);
    }
    expect(indexSource).toContain("overpayment");
  });

  it("F. requires manager then director approval before restructuring", () => {
    expect(indexSource).toContain("pending_manager");
    expect(indexSource).toContain("manager_approved");
    expect(indexSource).toContain("loan_director");
    expect(indexSource).toContain("mfi_loan_restructures");
    expect(indexSource).toContain("status!=='manager_approved'");
    expect(rulesSource).toContain("match /mfi_loan_restructures/{restructureId}");
  });

  it("G. requires director approval before a loan becomes written_off", () => {
    expect(indexSource).toContain("mfi_loan_writeoffs");
    expect(indexSource).toContain("status:'written_off'");
    expect(indexSource).toContain("Only a Director can approve write-offs");
    expect(rulesSource).toContain("match /mfi_loan_writeoffs/{writeoffId}");
  });

  it("H. exposes borrower progress, partial balances, credit notes, and history", () => {
    for (const value of ["mfiStep2RenderBorrower", "mfiStep2BorrowerLoanDetails", "mfiStep2CreditNotes", "Pay remaining", "Payment history", "Request restructure"]) {
      expect(indexSource).toContain(value);
    }
  });

  it("I. exposes portfolio health metrics and overdue officer/manager views", () => {
    for (const value of ["Repayment rate", "Portfolio at risk", "Loans in arrears", "Overdue Monitoring", "Manager approve", "Director approve"]) {
      expect(indexSource).toContain(value);
    }
  });

  it("J. preserves offline schedule and payment records, while keeping restructures online-only", () => {
    for (const value of ["DB_VERSION = 23", "offline_mfi_loan_schedules", "cacheMfiLoanSchedule", "queueMfiLoanPayment", "scheduleAfter", "Restructure requests require internet", "Credit note operations require internet"]) {
      expect(indexSource + offlineSource).toContain(value);
    }
    expect(offlineSource).toContain("if (oldVersion < 23");
  });

  it("K. keeps Step 1 lifecycle surfaces and all nine Step 2 indexes intact", () => {
    for (const [collectionGroup, fields] of [
      ["mfi_loan_installment_applications", ["loanId", "appliedAt"]],
      ["mfi_loan_overdue_log", ["institutionId", "currentStatus"]],
      ["mfi_loan_overdue_log", ["loanId", "daysOverdue"]],
      ["mfi_credit_notes", ["customerId", "status"]],
      ["mfi_credit_notes", ["institutionId", "createdAt"]],
      ["mfi_loan_restructures", ["loanId", "createdAt"]],
      ["mfi_loan_restructures", ["institutionId", "approvedAt"]],
      ["mfi_loan_writeoffs", ["institutionId", "status"]],
      ["mfi_late_fee_config", ["institutionId"]],
    ] as Array<[string, string[]]>) {
      expect(indexes.indexes.some(index =>
        index.collectionGroup === collectionGroup &&
        fields.every(field => index.fields.some(item => item.fieldPath === field))
      )).toBe(true);
    }
    expect(indexSource).toContain("mfiLoanCanDisburse");
    expect(indexSource).toContain("mfiGenerateLoanSchedule");
    expect(rulesSource).toContain("match /mfi_late_fee_config/{configId}");
  });
});