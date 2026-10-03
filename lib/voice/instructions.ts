import { BASE_INSTRUCTIONS, DEFAULT_LANGUAGE_ID, DEFAULT_PERSONA_ID } from "./config";
import { findLanguage, findPersona, type LanguageId, type PersonaId } from "./personas";

/**
 * Prompt composition. Server-only in practice: the result is sent to OpenAI and echoed back to the
 * browser for replay, never accepted from it.
 */

/** Composes the final system prompt for a persona and language. */
export function buildInstructions(personaId: string = DEFAULT_PERSONA_ID, languageId: string = DEFAULT_LANGUAGE_ID): string {
  // Unknown ids fall back to the defaults rather than throwing: the route validates before calling
  // this, so reaching the fallback means a caller skipped validation. An unrecognised language must
  // still get a Language section, otherwise the prompt would silently lose the rule entirely
  // instead of falling back to "match the user".
  const persona = findPersona(personaId) ?? findPersona(DEFAULT_PERSONA_ID)!;
  const language = findLanguage(languageId) ?? findLanguage(DEFAULT_LANGUAGE_ID)!;

  const sections = [BASE_INSTRUCTIONS.trimEnd(), persona.guidance];

  sections.push(
    language.bcp47
      ? `Language:\n- Speak ${language.name}. If the user switches to another language, switch with them.`
      : "Language:\n- Reply in the language the user speaks. If they switch, switch with them.",
  );

  return `${sections.join("\n\n")}\n`;
}

/** Narrowed re-exports so callers can import the id types from one place. */
export type { LanguageId, PersonaId };