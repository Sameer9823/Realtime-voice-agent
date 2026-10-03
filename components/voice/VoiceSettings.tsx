"use client";

import { LANGUAGES, PERSONAS, findLanguage, findPersona } from "@/lib/voice/personas";
import { VOICES } from "@/lib/voice/guard";

/**
 * Session settings, offered only before a conversation starts.
 *
 * The heading is a question rather than the word "Settings", because the choice being made is not
 * about configuration — it is about who you want to talk to.
 *
 * Every control sends an id, never a prompt. The server resolves ids to instructions, so nothing
 * typed into this panel can become a system prompt: there is no text field here to type one into.
 *
 * Once a session is live the panel is replaced by a one-line summary. The settings are fixed for the
 * life of a conversation, so showing them as disabled controls during it is a column of dead
 * weight.
 */

export interface VoiceSettingsProps {
  personaId: string;
  language: string;
  voice: string;
  disabled: boolean;
  onPersonaChange(personaId: string): void;
  onLanguageChange(language: string): void;
  onVoiceChange(voice: string): void;
}

export function VoiceSettings({
  personaId,
  language,
  voice,
  disabled,
  onPersonaChange,
  onLanguageChange,
  onVoiceChange,
}: VoiceSettingsProps) {
  if (disabled) {
    const persona = findPersona(personaId);
    const languageLabel = findLanguage(language)?.label ?? "Auto";
    return (
      <section className="settings" aria-labelledby="settings-heading">
        <h2 id="settings-heading" className="settings-heading">
          This conversation
        </h2>
        <p className="settings-summary">
          <span>
            Talking to <strong>{persona?.label ?? personaId}</strong>
          </span>
          <span>
            Language <strong>{languageLabel}</strong>
          </span>
          <span>
            Voice <strong>{voice}</strong>
          </span>
        </p>
      </section>
    );
  }

  return (
    <section className="settings" aria-labelledby="settings-heading">
      <h2 id="settings-heading" className="settings-heading">
        Who do you want to talk to?
      </h2>

      <fieldset className="settings-fieldset">
        <legend className="settings-legend">Persona</legend>
        <div className="settings-options" role="radiogroup" aria-label="Assistant persona">
          {PERSONAS.map((persona) => {
            const id = `persona-${persona.id}`;
            return (
              <label key={persona.id} className="settings-option" htmlFor={id}>
                <input
                  type="radio"
                  id={id}
                  name="persona"
                  value={persona.id}
                  checked={personaId === persona.id}
                  onChange={() => onPersonaChange(persona.id)}
                />
                <span className="settings-option-label">{persona.label}</span>
                <span className="settings-option-hint">{persona.description}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="settings-fieldset">
        <label className="settings-legend" htmlFor="language-select">
          Language
        </label>
        <select
          id="language-select"
          className="settings-select"
          value={language}
          onChange={(event) => onLanguageChange(event.target.value)}
        >
          {LANGUAGES.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="settings-fieldset">
        <label className="settings-legend" htmlFor="voice-select">
          Voice
        </label>
        <select
          id="voice-select"
          className="settings-select"
          value={voice}
          onChange={(event) => onVoiceChange(event.target.value)}
        >
          {VOICES.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>
    </section>
  );
}