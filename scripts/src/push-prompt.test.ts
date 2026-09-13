import { describe, it, expect, vi } from "vitest";
import { runPrompt, type PromptResult } from "./push-prompt.js";

function makeQuestion(answers: string[]): (prompt: string) => Promise<string> {
  let index = 0;
  return async (_prompt: string) => {
    const answer = answers[index++];
    if (answer === undefined) throw new Error("Ran out of mock answers");
    return answer;
  };
}

describe("runPrompt", () => {
  it('returns "confirmed" when the user types "y"', async () => {
    const question = makeQuestion(["y"]);
    const openDiff = vi.fn();

    const result = await runPrompt(question, openDiff);

    expect(result).toBe<PromptResult>("confirmed");
    expect(openDiff).not.toHaveBeenCalled();
  });

  it('returns "confirmed" when the user types "Y" (case-insensitive)', async () => {
    const question = makeQuestion(["Y"]);
    const openDiff = vi.fn();

    const result = await runPrompt(question, openDiff);

    expect(result).toBe<PromptResult>("confirmed");
  });

  it('returns "aborted" when the user types "n"', async () => {
    const question = makeQuestion(["n"]);
    const openDiff = vi.fn();

    const result = await runPrompt(question, openDiff);

    expect(result).toBe<PromptResult>("aborted");
    expect(openDiff).not.toHaveBeenCalled();
  });

  it('returns "aborted" when the user types "N"', async () => {
    const question = makeQuestion(["N"]);
    const openDiff = vi.fn();

    const result = await runPrompt(question, openDiff);

    expect(result).toBe<PromptResult>("aborted");
  });

  it('returns "aborted" when the user presses Enter (empty input)', async () => {
    const question = makeQuestion([""]);
    const openDiff = vi.fn();

    const result = await runPrompt(question, openDiff);

    expect(result).toBe<PromptResult>("aborted");
  });

  it('returns "aborted" for any unexpected input', async () => {
    const question = makeQuestion(["maybe"]);
    const openDiff = vi.fn();

    const result = await runPrompt(question, openDiff);

    expect(result).toBe<PromptResult>("aborted");
  });

  it('calls openDiff and then re-prompts when the user types "d"', async () => {
    const question = makeQuestion(["d", "y"]);
    const openDiff = vi.fn();

    const result = await runPrompt(question, openDiff);

    expect(openDiff).toHaveBeenCalledOnce();
    expect(result).toBe<PromptResult>("confirmed");
  });

  it('calls openDiff and aborts when user types "d" then "n"', async () => {
    const question = makeQuestion(["d", "n"]);
    const openDiff = vi.fn();

    const result = await runPrompt(question, openDiff);

    expect(openDiff).toHaveBeenCalledOnce();
    expect(result).toBe<PromptResult>("aborted");
  });

  it('loops correctly through multiple "d" presses before confirming', async () => {
    const question = makeQuestion(["d", "d", "d", "y"]);
    const openDiff = vi.fn();

    const result = await runPrompt(question, openDiff);

    expect(openDiff).toHaveBeenCalledTimes(3);
    expect(result).toBe<PromptResult>("confirmed");
  });

  it('handles openDiff throwing (pager unavailable) and continues the loop', async () => {
    const question = makeQuestion(["d", "y"]);
    const openDiff = vi.fn().mockImplementation(() => {
      throw new Error("pager not found");
    });

    const result = await runPrompt(question, openDiff);

    expect(openDiff).toHaveBeenCalledOnce();
    expect(result).toBe<PromptResult>("confirmed");
  });

  it('trims whitespace from the user answer before comparing', async () => {
    const question = makeQuestion(["  y  "]);
    const openDiff = vi.fn();

    const result = await runPrompt(question, openDiff);

    expect(result).toBe<PromptResult>("confirmed");
  });
});
