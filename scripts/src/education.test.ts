import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const educationSource = readFileSync(resolve(root, "education/index.html"), "utf8");
const educationScript = readFileSync(resolve(root, "education/app.js"), "utf8");
const educationMap = readFileSync(resolve(root, "education/PRIMARY_ACCOUNT_MAP.md"), "utf8");
const serverSource = readFileSync(resolve(root, "artifacts/api-server/src/app.ts"), "utf8");
const schoolRouteSource = readFileSync(resolve(root, "artifacts/api-server/src/routes/school.ts"), "utf8");
const landingSource = readFileSync(resolve(root, "index.html"), "utf8");

describe("Education workspace integration", () => {
  it("serves a standalone credential-free education workspace", () => {
    expect(educationSource).toContain("<title>APSHULE Education");
    expect(educationSource).toContain('href="../"');
    expect(educationSource).toContain('id="workspaceNav"');
    expect(educationSource).toContain('id="workspaceContent"');
    expect(educationSource).toContain('class="login-preview"');
    expect(educationSource).toContain('data-account="secondary"');
    expect(educationSource).toContain('id="printSettingsModal"');
    expect(educationSource).toContain('href="./secondary.css"');
    expect(educationSource).toContain("Install Orion App");
    expect(educationSource).toContain("firebase-auth-compat.js");
    expect(educationSource).toContain("APSHULE_API_BASE");
    expect(educationSource).not.toContain("secretary@apshule.com");
    expect(educationSource).not.toContain('value="password"');
    expect(educationScript).toContain("studentModal");
    expect(educationScript).toContain("Gender distribution");
    expect(educationScript).toContain("System status & performance");
    expect(educationScript).toContain("O-Level NCDC");
    expect(educationScript).toContain("O-Level old curriculum");
    expect(educationScript).toContain("A-Level UACE");
    expect(educationScript).toContain("Include student positions");
    expect(educationScript).toContain("Select activities to show");
    expect(educationScript).toContain("Print-ready preview prepared");
    expect(educationScript).toContain("Preview learner saved locally");
    expect(educationMap).toContain("# Primary Orion Account Map");
    expect(educationMap).toContain("Video Meetings");
    expect(educationMap).toContain("Install App");
  });

  it("connects live primary and secondary accounts through a protected read-only contract", () => {
    expect(educationScript).toContain("firebase.auth().onAuthStateChanged");
    expect(educationScript).toContain("/api/school/education-workspace");
    expect(educationScript).toContain("Live school workspace");
    expect(schoolRouteSource).toContain('router.get("/school/education-workspace"');
     expect(schoolRouteSource).toContain('["school", "school_admin", "headteacher", "bursar"]');
    expect(schoolRouteSource).toContain("safeRecord");
    expect(schoolRouteSource).toContain("attendanceEvents");
    expect(schoolRouteSource).toContain("const safeSchool");
    expect(schoolRouteSource).toContain("/password|secret|token|credential|privatekey|apiKey/i");
     expect(schoolRouteSource).toContain('firestoreList("school_fees"');
     expect(schoolRouteSource).toContain('firestoreList("school_bills"');
     expect(schoolRouteSource).toContain('firestoreList("payment_transactions"');
     expect(schoolRouteSource).toContain('router.post("/school/bursar/payments"');
     expect(schoolRouteSource).toContain('router.post("/school/bursar/reconciliation"');
      expect(schoolRouteSource).toContain('router.get("/school/bursar/receipts/:paymentId"');
      expect(schoolRouteSource).toContain('router.get("/school/bursar/statements"');
      expect(schoolRouteSource).toContain('router.post("/school/bursar/statements/close"');
      expect(schoolRouteSource).toContain("bursarMonthLocked");
      expect(schoolRouteSource).toContain("receiptHash");
     expect(educationScript).toContain('const bursarNavItems');
     expect(educationScript).toContain("Bursar dashboard");
     expect(educationScript).toContain('state.liveData?.workspace === "bursar"');
     expect(educationSource).toContain('id="bursarPaymentModal"');
     expect(educationSource).toContain('id="bursarReconciliationModal"');
      expect(educationSource).toContain('id="bursarReceiptModal"');
     expect(educationScript).toContain('bursarApi("/api/school/bursar/payments"');
     expect(educationScript).toContain('bursarApi("/api/school/bursar/reconciliation"');
      expect(educationScript).toContain("/api/school/bursar/receipts/");
      expect(educationScript).toContain("/api/school/bursar/statements?from=");
      expect(educationScript).toContain("/api/school/bursar/statements/close");
  });

  it("keeps the route and landing-page education entry connected", () => {
    expect(serverSource).toContain('app.get(["/education", "/education/"]');
    expect(serverSource).toContain('app.use("/education", express.static(educationPath))');
    expect(landingSource).toContain('<a href="education/">For Schools</a>');
    expect(landingSource).toContain('<a class="landing-link" href="education/">Explore education →</a>');
  });
});