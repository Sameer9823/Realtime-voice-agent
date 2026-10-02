import type { GuardrailResult, InputGuardrail } from "../types.js";
import { getLastText } from "./utils.js";

// Pattern-level heuristics for common jailbreak/injection phrasing. Not exhaustive —
// this is a first line of defense, not a substitute for a trained classifier.
const SUSPICIOUS_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /ignore (all )?(previous|prior|above) instructions/i, label: "instruction-override" },
  { pattern: /disregard (your|the) (system prompt|instructions|rules)/i, label: "instruction-override" },
  { pattern: /you are now (dan|in developer mode|jailbroken|unrestricted)/i, label: "persona-override" },
  { pattern: /pretend (you have no|there are no) (restrictions|rules|guidelines)/i, label: "persona-override" },
  { pattern: /reveal (your|the) (system prompt|instructions|hidden prompt)/i, label: "prompt-extraction" },
  { pattern: /repeat (the words|everything) (above|before this)/i, label: "prompt-extraction" },
  { pattern: /act as if you (have no|had no) (content policy|filter|safety)/i, label: "persona-override" },
];

export interface PromptInjectionGuardrailOptions {
  /** Additional custom patterns to check alongside the built-in list */
  customPatterns?: { pattern: RegExp; label: string }[];
  /** 'block' rejects the call; 'flag' allows it through but reason explains what tripped. Default: 'block'. */
  mode?: "block" | "flag";
}

/**
 * Scans the latest user message for common prompt-injection / jailbreak phrasing.
 * This is heuristic pattern-matching — cheap and fast, but should be layered with
 * other defenses (e.g. keeping system instructions out of user-editable context).
 */
export function createPromptInjectionGuardrail(
  options: PromptInjectionGuardrailOptions = {}
): InputGuardrail {
  const patterns = [...SUSPICIOUS_PATTERNS, ...(options.customPatterns ?? [])];
  const mode = options.mode ?? "block";

  return ({ messages }): GuardrailResult => {
    const text = getLastText(messages, "user");
    if (!text) return { allowed: true };

    const matches = patterns.filter((p) => p.pattern.test(text));
    if (matches.length === 0) return { allowed: true };

    const labels = [...new Set(matches.map((m) => m.label))].join(", ");
    if (mode === "block") {
      return { allowed: false, reason: `Possible prompt injection detected (${labels})` };
    }
    return { allowed: true, reason: `Flagged: possible prompt injection (${labels})` };
  };
}
