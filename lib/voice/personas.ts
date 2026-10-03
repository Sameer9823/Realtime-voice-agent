/**
 * Personas and languages.
 *
 * The client sends an id from one of these lists, never a prompt. Instructions are resolved here
 * on the server and handed back in the session response, which the client then replays verbatim
 * over the data channel. That indirection is the point: if the client composed its own
 * instructions, a caller could simply POST a different system prompt and the server-side mapping
 * would be decorative.
 */

/** Assistant personas. Ids are stable; the prose around them is not part of any contract. */
export const PERSONA_IDS = ["friendly", "concise-expert", "language-tutor"] as const;
export type PersonaId = (typeof PERSONA_IDS)[number];

export interface Persona {
  id: PersonaId;
  label: string;
  description: string;
  /** Appended after the shared spoken-style rules, so the base voice is never lost. */
  guidance: string;
}

export const PERSONAS: ReadonlyArray<Persona> = [
  {
    id: "friendly",
    label: "Friendly assistant",
    description: "Warm and relaxed. Good for everyday questions.",
    guidance:
      "You are warm and easygoing. Be encouraging without being syrupy, and a little playful when it fits. Match the user's energy rather than forcing a tone.",
  },
  {
    id: "concise-expert",
    label: "Concise expert",
    description: "Direct and precise. Best for technical questions.",
    guidance:
      "You are a domain expert who values precision. Answer in as few words as the question deserves, lead with the answer, and skip preamble and pleasantries. If the user wants more depth, they will ask.",
  },
  {
    id: "language-tutor",
    label: "Language tutor",
    description: "Patient and encouraging. Corrects mistakes gently.",
    guidance:
      "You are a patient language tutor. If the user makes a mistake, correct it once, briefly, then carry on - do not repeat the correction and do not list every error. Encourage them to keep talking. Match the language level to theirs: if they use simple structures, keep your replies simple too.",
  },
];

export function isPersonaId(value: unknown): value is PersonaId {
  return typeof value === "string" && (PERSONA_IDS as readonly string[]).includes(value);
}

export function findPersona(id: string): Persona | undefined {
  return PERSONAS.find((persona) => persona.id === id);
}

/** Languages the selector offers. `auto` lets the model match the user. */
export const LANGUAGE_IDS = ["auto", "en", "hi", "ta", "es", "fr"] as const;
export type LanguageId = (typeof LANGUAGE_IDS)[number];

export interface Language {
  id: LanguageId;
  label: string;
  /** BCP-47 tag, or null when the choice is "follow the user". */
  bcp47: string | null;
  /** English name, used to describe the language inside an English-language prompt. */
  name: string;
}

export const LANGUAGES: ReadonlyArray<Language> = [
  { id: "auto", label: "Auto (match me)", bcp47: null, name: "the language the user speaks" },
  { id: "en", label: "English", bcp47: "en", name: "English" },
  { id: "hi", label: "Hindi", bcp47: "hi", name: "Hindi" },
  { id: "ta", label: "Tamil", bcp47: "ta", name: "Tamil" },
  { id: "es", label: "Spanish", bcp47: "es", name: "Spanish" },
  { id: "fr", label: "French", bcp47: "fr", name: "French" },
];

export function isLanguageId(value: unknown): value is LanguageId {
  return typeof value === "string" && (LANGUAGE_IDS as readonly string[]).includes(value);
}

export function findLanguage(id: string): Language | undefined {
  return LANGUAGES.find((language) => language.id === id);
}

/**
 * Builds the transcription hint for a language.
 *
 * Only a real language code gets sent. Passing `"auto"` through would make OpenAI try to transcribe
 * a language literally called "auto", so the auto case sends no hint and lets the model decide.
 */
export function transcriptionHint(languageId: string): { language?: string } {
  const language = findLanguage(languageId);
  return language?.bcp47 ? { language: language.bcp47 } : {};
}