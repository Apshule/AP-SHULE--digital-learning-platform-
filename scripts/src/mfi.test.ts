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