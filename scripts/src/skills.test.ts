import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("vocational skills MVP contracts", () => {
  it("loads one shared Firebase configuration across vocational pages", () => {
    const config = read("skills/firebase-config.js");
    const apiConfig = read("skills/api-config.js");
    const pages = [
      "skills/index.html",
      "skills/provider.html",
      "skills/provider-register.html",
      "skills/skills-enroll.html",
      "skills/enroll.html",
    ];

    expect(config).toContain("global.APSHULE_FIREBASE_CONFIG");
    expect(config).toContain("apshule-app.firebaseapp.com");
    expect(config).toContain("AIzaSyBaO3Al6ubOcH3NxZBYmhjuOyihYc_q9kg");
    expect(apiConfig).toContain("global.APSHULE_API_BASE");
    expect(apiConfig).toContain(".replit.dev");
    expect(apiConfig).toContain("ap-shule-digital-learning-platform-3.onrender.com");
    for (const pagePath of pages) {
      const page = read(pagePath);
      expect(page, pagePath).toContain('<script src="./firebase-config.js"></script>');
      expect(page, pagePath).toContain('<script src="./api-config.js"></script>');
      expect(page, pagePath).toContain(
        "firebase.initializeApp(window.APSHULE_FIREBASE_CONFIG)",
      );
      expect(page, pagePath).toContain("apiBase=window.APSHULE_API_BASE");
      expect(page, pagePath).not.toContain("const firebaseConfig");
      expect(page, pagePath).not.toContain(
        "AIzaSyBaO3Al6ubOcH3NxZBYmhjuOyihYc_q9kg",
      );
      expect(page, pagePath).not.toContain(
        "ap-shule-digital-learning-platform-3.onrender.com",
      );
    }
  });

  it("ships the public directory, provider profile, and attributed registration flow", () => {
    const directory = read("skills/index.html");
    const provider = read("skills/provider.html");
    const enroll = read("skills/enroll.html");
    expect(directory).toContain("APSHULE Skills");
    expect(directory).toContain("Choose work");
    expect(directory).toContain("/api/skills/providers");
    expect(provider).toContain("Powered by APSHULE");
    expect(provider).toContain("Apply for this course");
    expect(enroll).toContain("referralCode");
    expect(enroll).toContain("/api/skills/enrollments");
  });

  it("keeps provider moderation and earnings surfaces behind the API", () => {
    const api = read("artifacts/api-server/src/routes/skills.ts");
    const app = read("artifacts/api-server/src/app.ts");
    const admin = read("skills-admin.html");
    expect(api).toContain('router.get("/skills/admin/providers"');
    expect(api).toContain('router.get("/skills/providers/mine"');
    expect(api).toContain('router.post("/skills/admin/provider-status"');
    expect(api).toContain("referralCode");
    expect(api).toContain('/skills/providers/:providerId/manifest.json');
    expect(app).toContain('app.get(["/obote", "/obote/"]');
    expect(api).toContain('provider.verificationStatus === "pending_topup"');
    expect(admin).toContain('provider.verificationStatus==="pending_topup"||provider.verificationStatus==="verified"');
    expect(admin).toContain("/api/skills/admin/providers");
    expect(admin).toContain("Recorded course value");
  });

  it("supports provider verification top-ups and the separate vocational admission flow", () => {
    const api = read("artifacts/api-server/src/routes/skills.ts");
    const providerRegister = read("skills/provider-register.html");
    const admission = read("skills/skills-enroll.html");
    const enroll = read("skills/enroll.html");
    expect(api).toContain('router.post("/skills/providers/register"');
    expect(api).toContain('router.post("/skills/provider/topup"');
    expect(api).toContain("skills_provider_payments");
    expect(api).toContain('status: "processing"');
    expect(api).toContain("settleVocationalPayment");
    expect(api).toContain('router.post("/skills/admissions/payment"');
    expect(api).toContain('router.post("/skills/admissions"');
    expect(api).toContain("verificationStatus");
    expect(providerRegister).toContain("/api/skills/providers/register");
    expect(providerRegister).toContain("/api/skills/provider/topup");
    expect(providerRegister).toContain("/api/skills/providers/mine");
    expect(providerRegister).toContain("Checking your institution profile");
    expect(providerRegister).toContain("Forgot password?");
    expect(providerRegister).toContain("sendPasswordResetEmail");
    expect(providerRegister).toContain("Password reset email sent");
    expect(providerRegister).toContain('id="providerManifestLink"');
    expect(providerRegister).toContain('id="installAppButton"');
    expect(providerRegister).toContain("beforeinstallprompt");
    expect(providerRegister).toContain('register("/sw.js?v=20260919-13"');
    expect(providerRegister).toContain("configureProviderPwa");
    expect(existsSync(resolve(root, "skills/assets/obote-auto-garage.jpg"))).toBe(true);
    expect(admission).toContain("Highest education level");
    expect(admission).toContain("UGX 20,000");
    expect(admission).not.toContain("simulated");
    expect(admission).toContain("paymentMethod");
    expect(admission).toContain("/api/skills/admissions");
    expect(admission).toContain("Signed in and ready to apply");
    expect(admission).toContain("Forgot password?");
    expect(admission).toContain("sendPasswordResetEmail");
    expect(enroll).toContain("Forgot password?");
    expect(enroll).toContain("sendPasswordResetEmail");
  });

  it("protects provider and enrollment collections with dedicated rules", () => {
    const rules = read("firestore.rules");
    const indexes = JSON.parse(read("firestore.indexes.json")) as {
      indexes: Array<{ collectionGroup: string }>;
    };
    expect(rules).toContain("match /providers/{providerId}");
    expect(rules).toContain("match /skills_enrollments/{enrollmentId}");
    expect(rules).toContain("match /skills_admission_payments/{paymentId}");
    expect(rules).toContain("match /skills_provider_payments/{paymentId}");
    expect(rules).toContain("get(/databases/$(database)/documents/providers/");
    expect(indexes.indexes.map((index) => index.collectionGroup)).toEqual(
      expect.arrayContaining(["providers", "skills_enrollments"]),
    );
  });
});