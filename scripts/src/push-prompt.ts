export type PromptResult = "confirmed" | "aborted";

type QuestionFn = (prompt: string) => Promise<string>;
type OpenDiffFn = () => void;

const PROMPT = "\nPush these changes? (y/N/d to view full diff): ";

/**
 * Runs the interactive push-confirmation loop.
 *
 * - "y"  → returns "confirmed"
 * - "n" / anything else → returns "aborted"
 * - "d"  → calls openDiff(), then re-prompts
 *
 * Dependencies are injected so the function is unit-testable without spawning
 * a real readline interface or an actual pager.
 */
export async function runPrompt(
  question: QuestionFn,
  openDiff: OpenDiffFn
): Promise<PromptResult> {
  while (true) {
    const answer = await question(PROMPT);
    const choice = answer.trim().toLowerCase();

    if (choice === "d") {
      try {
        openDiff();
      } catch {
        // pager unavailable or user quit with non-zero exit — fall through and re-prompt
      }
      continue;
    }

    if (choice !== "y") {
      return "aborted";
    }

    return "confirmed";
  }
}
