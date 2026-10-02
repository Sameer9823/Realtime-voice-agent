import type { GuardrailResult, InputGuardrail, OutputGuardrail } from "../types.js";
import { getLastText } from "./utils.js";

export interface BlocklistGuardrailOptions {
  /** Case-insensitive words/phrases to block. Supports plain strings or regexes. */
  terms: (string | RegExp)[];
}

function findMatch(text: string, terms: (string | RegExp)[]): string | null {
  for (const term of terms) {
    if (typeof term === "string") {
      if (text.toLowerCase().includes(term.toLowerCase())) return term;
    } else if (term.test(text)) {
      return term.source;
    }
  }
  return null;
}

/** Blocks a request if the latest user message contains a banned term or regex. */
export function createBlocklistInputGuardrail(options: BlocklistGuardrailOptions): InputGuardrail {
  return ({ messages }): GuardrailResult => {
    const text = getLastText(messages, "user");
    const match = findMatch(text, options.terms);
    if (match) return { allowed: false, reason: `Input contains blocked term: "${match}"` };
    return { allowed: true };
  };
}

/** Blocks a response if the model's output contains a banned term or regex. */
export function createBlocklistOutputGuardrail(options: BlocklistGuardrailOptions): OutputGuardrail {
  return ({ result }): GuardrailResult => {
    const match = findMatch(result.text, options.terms);
    if (match) return { allowed: false, reason: `Output contains blocked term: "${match}"` };
    return { allowed: true };
  };
}
