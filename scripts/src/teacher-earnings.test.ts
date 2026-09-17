import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const indexSource = readFileSync(resolve(root, "index.html"), "utf8");
const route = readFileSync(resolve(root, "artifacts/api-server/src/routes/yo-payments.ts"), "utf8");
const referralRoute = readFileSync(resolve(root, "artifacts/api-server/src/routes/student-referrals.ts"), "utf8");
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
    for (const source of ["recorded_lesson", "teacher_pdf", "live_lesson"]) {
      expect(indexSource).toMatch(new RegExp(`source:\\s*['"]${source}['"]`));
    }
    expect(indexSource).toContain("teacher_referral:'Teacher referrals'");
    expect(referralRoute).toContain('source: "teacher_referral"');
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

  it("rebinds authenticated PDF listeners and merges both material collections", () => {
    expect(indexSource).toContain("let _sharedPdfMaterialsUnsubscribe = null;");
    expect(indexSource).toContain("let _teacherPdfMaterialsUnsubscribe = null;");
    expect(indexSource).toContain("stopPdfListeners();");
    expect(indexSource).toContain("if(!currentUser) return;");
    expect(indexSource).toContain("listenToPDFs();");
    expect(indexSource).toContain("pdfMaterials = [..._sharedPdfMaterials, ..._teacherPdfMaterials]");
    expect(indexSource).toContain('collection(db,"teacherPdfs")');
    expect(indexSource).toContain('accept="application/pdf,.pdf"');
    expect(indexSource).toContain("Please select a PDF file");
    expect(indexes.indexes.some((index) => index.collectionGroup === "teacherPdfs")).toBe(true);
  });

  it("keeps both upload paths and shared reads within the intended roles", () => {
    expect(rules).toContain("match /pdfs/{pdfId}");
    expect(rules).toContain("allow create, update, delete: if isSuperAdmin();");
    expect(rules).toContain("match /teacherPdfs/{pdfId}");
    expect(rules).toContain("role() == 'teacher'");
    expect(rules).toContain("request.resource.data.teacherId == request.auth.uid");
    expect(rules).toContain("allow read: if signedIn();");
    expect(indexSource).toContain('id="pdfFileInput"');
    expect(indexSource).toContain('id="accPdfFile"');
    expect(indexSource).toContain('id="teacherPdfFile"');
    expect(indexSource).toContain('id="teacherPdfCategory"');
    expect(indexSource).toContain("category, url: downloadURL");
  });

  it("gives the Command Center a direct, source-aware PDF uploader", () => {
    for (const value of [
      "commandPdfUploadForm",
      "commandPdfTitle",
      "commandPdfCategory",
      "commandPdfFile",
      "commandPdfUrl",
      "submitCommandPdfUpload",
      "commandLoadPdfMaterials",
      "data-pdf-source",
      "teacherPdfs"
    ]) {
      expect(indexSource).toContain(value);
    }
    expect(indexSource).toContain("button.dataset.pdfSource==='teacherPdfs'?'teacherPdfs':'pdfs'");
    expect(indexSource).toContain("uploadPdfFileToStorage");
    expect(indexSource).toContain("logSuperAdminAction('delete_pdf'");
  });
});