import type {
  GuardrailResult,
  InputGuardrail,
  Message,
  OutputGuardrail,
} from "../types.js";
import { getMessageText } from "./utils.js";

export type PiiType = "email" | "phone" | "credit-card" | "ssn" | "ip-address";

const PII_PATTERNS: Record<PiiType, RegExp> = {
  email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  // loose international-ish phone matcher; tuned to avoid matching plain numbers/years
  phone: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3,4}\)?[-.\s]\d{3,4}[-.\s]\d{3,4}\b/g,
  "credit-card": /\b(?:\d[ -]*?){13,16}\b/g,
  ssn: /\b\d{3}-\d{2}-\d{4}\b/g,
  "ip-address": /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\b/g,
};

export interface PiiGuardrailOptions {
  /** Which PII categories to check. Default: all. */
  types?: PiiType[];
  /** 'block' rejects the call; 'redact' rewrites the offending text with a placeholder. Default: 'redact'. */
  mode?: "block" | "redact";
}

function scanAndRedact(text: string, types: PiiType[]): { found: PiiType[]; redacted: string } {
  const found: PiiType[] = [];
  let redacted = text;
  for (const type of types) {
    const pattern = PII_PATTERNS[type];
    if (pattern.test(text)) {
      found.push(type);
      redacted = redacted.replace(new RegExp(pattern), `[REDACTED_${type.toUpperCase().replace("-", "_")}]`);
    }
    pattern.lastIndex = 0;
  }
  return { found, redacted };
}

function rewriteMessage(message: Message, redactedText: string): Message {
  if (typeof message.content === "string") {
    return { ...message, content: redactedText };
  }
  // Structured content: only rewrite text parts, leave tool calls/images alone
  let consumed = 0;
  const newContent = message.content.map((part) => {
    if (part.type !== "text") return part;
    // naive: since we redacted joined text, just re-split isn't reliable for multi-part;
    // for the common single-text-part case this is exact.
    consumed++;
    return { ...part, text: redactedText };
  });
  return { ...message, content: newContent };
}

/** Checks (and optionally redacts) PII in incoming user messages before they reach the model. */
export function createPiiInputGuardrail(options: PiiGuardrailOptions = {}): InputGuardrail {
  const types = options.types ?? (Object.keys(PII_PATTERNS) as PiiType[]);
  const mode = options.mode ?? "redact";

  return ({ messages }): GuardrailResult => {
    let anyFound: PiiType[] = [];
    const modifiedMessages = messages.map((msg) => {
      if (msg.role !== "user") return msg;
      const text = getMessageText(msg);
      if (!text) return msg;
      const { found, redacted } = scanAndRedact(text, types);
      if (found.length === 0) return msg;
      anyFound = [...new Set([...anyFound, ...found])];
      return mode === "redact" ? rewriteMessage(msg, redacted) : msg;
    });

    if (anyFound.length === 0) return { allowed: true };

    if (mode === "block") {
      return { allowed: false, reason: `Detected PII: ${anyFound.join(", ")}` };
    }
    return { allowed: true, modifiedMessages };
  };
}

/** Checks (and optionally redacts) PII in model output before it reaches the caller. */
export function createPiiOutputGuardrail(options: PiiGuardrailOptions = {}): OutputGuardrail {
  const types = options.types ?? (Object.keys(PII_PATTERNS) as PiiType[]);
  const mode = options.mode ?? "redact";

  return ({ result }): GuardrailResult => {
    const { found, redacted } = scanAndRedact(result.text, types);
    if (found.length === 0) return { allowed: true };

    if (mode === "block") {
      return { allowed: false, reason: `Output contains PII: ${found.join(", ")}` };
    }
    return { allowed: true, modifiedResult: { ...result, text: redacted } };
  };
}
