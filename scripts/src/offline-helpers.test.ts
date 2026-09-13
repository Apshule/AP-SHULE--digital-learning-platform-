import { describe, expect, it } from "vitest";
import { detectConnectionMode, isCacheEligibleUrl } from "./offline-helpers";

describe("offline connection mode", () => {
  it("prioritizes offline state", () => {
    expect(detectConnectionMode(false, { type: "wifi" })).toBe("offline");
  });
  it("detects mobile and wifi network hints", () => {
    expect(detectConnectionMode(true, { type: "cellular" })).toBe("mobile");
    expect(detectConnectionMode(true, { effectiveType: "3g" })).toBe("mobile");
    expect(detectConnectionMode(true, { type: "wifi" })).toBe("wifi");
    expect(detectConnectionMode(true, { effectiveType: "4g" })).toBe("wifi");
  });
  it("uses the saved fallback when the browser has no network API", () => {
    expect(detectConnectionMode(true, undefined, "mobile")).toBe("mobile");
  });
});

describe("offline URL eligibility", () => {
  it("allows the app origin and the Firebase Storage allowlist", () => {
    expect(isCacheEligibleUrl("/assets/app.js", "https://appshule.com/")).toBe(true);
    expect(isCacheEligibleUrl("https://firebasestorage.googleapis.com/v0/b/app/o/x", "https://appshule.com/")).toBe(true);
  });
  it("never allows YouTube media or Googlevideo CDN URLs", () => {
    expect(isCacheEligibleUrl("https://www.youtube.com/watch?v=x", "https://appshule.com/")).toBe(false);
    expect(isCacheEligibleUrl("https://r1---sn.googlevideo.com/videoplayback", "https://appshule.com/")).toBe(false);
  });
});