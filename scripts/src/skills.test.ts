import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("vocational skills MVP contracts", () => {
  it("ships the public directory, provider profile, and attributed registration flow", () => {
    const directory = read("skills/index.html");
    const provider = read("skills/provider.html");
    const enroll = read("skills/enroll.html");
    expect(directory).toContain("APSHULE VOCATIONAL TRAINING CENTRE");
    expect(directory).toContain("Where Dreams Come true");
    expect(directory).toContain('where("status","==","active")');
    expect(provider).toContain("Course directory");
    expect(provider).toContain("Register for Course");
    expect(enroll).toContain("referralCode");
    expect(enroll).toContain("/api/skills/enrollments");
  });

  it("keeps provider moderation and earnings surfaces behind the API", () => {
    const api = read("artifacts/api-server/src/routes/skills.ts");
    const admin = read("skills-admin.html");
    expect(api).toContain('router.get("/skills/admin/providers"');
    expect(api).toContain('router.post("/skills/admin/provider-status"');
    expect(api).toContain("referralCode");
    expect(admin).toContain("/api/skills/admin/providers");
    expect(admin).toContain("Recorded course value");
  });

  it("protects provider and enrollment collections with dedicated rules", () => {
    const rules = read("firestore.rules");
    const indexes = JSON.parse(read("firestore.indexes.json")) as {
      indexes: Array<{ collectionGroup: string }>;
    };
    expect(rules).toContain("match /providers/{providerId}");
    expect(rules).toContain("match /skills_enrollments/{enrollmentId}");
    expect(rules).toContain("get(/databases/$(database)/documents/providers/");
    expect(indexes.indexes.map((index) => index.collectionGroup)).toEqual(
      expect.arrayContaining(["providers", "skills_enrollments"]),
    );
  });
});