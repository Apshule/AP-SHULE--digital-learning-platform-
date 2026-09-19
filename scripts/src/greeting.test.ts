import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const greetingSource = readFileSync(resolve(root, "greeting.js"), "utf8");

function loadGreetingApi() {
  const sandbox: Record<string, unknown> = {};
  runInNewContext(greetingSource, sandbox);
  return sandbox.apshuleGreeting as {
    getGreetingKey: (date: Date) => string;
    getGreeting: (language: string, date: Date) => string;
    formatGreeting: (name: string, language: string, date: Date, fallback?: string) => string;
  };
}

describe("shared time-based greeting contract", () => {
  const api = loadGreetingApi();

  it("uses morning before noon, afternoon through 17:59, and evening from 18:00", () => {
    expect(api.getGreetingKey(new Date(2026, 8, 19, 11, 59))).toBe("morning");
    expect(api.getGreetingKey(new Date(2026, 8, 19, 12, 0))).toBe("afternoon");
    expect(api.getGreetingKey(new Date(2026, 8, 19, 17, 59))).toBe("afternoon");
    expect(api.getGreetingKey(new Date(2026, 8, 19, 18, 0))).toBe("evening");
  });

  it("keeps the selected language and account name in the formatted greeting", () => {
    const date = new Date(2026, 8, 19, 14, 0);
    expect(api.getGreeting("Swahili", date)).toBe("Habari za mchana");
    expect(api.formatGreeting("Amina Nabirye", "Swahili", date)).toBe("Habari za mchana, Amina!");
    expect(api.formatGreeting("", "English", date, "team")).toBe("Good afternoon, team!");
  });

  it("falls back to English for unknown languages", () => {
    expect(api.getGreeting("Unknown", new Date(2026, 8, 19, 19, 0))).toBe("Good evening");
  });
});