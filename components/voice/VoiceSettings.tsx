"use client";

import { LANGUAGES, PERSONAS } from "@/lib/voice/personas";
import { VOICES } from "@/lib/voice/guard";

/**
 * Session settings.
 *
 * Every control here sends an id, never a prompt. The server resolves ids to instructions, so
 * nothing typed into this panel can become a system prompt — there is no text field to type one.
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
  return (
    <section className="settings" aria-labelledby="settings-heading">
      <h2 id="settings-heading" className="settings-heading">
        Settings
      </h2>

      <fieldset className="settings-fieldset" disabled={disabled}>
        <legend className="settings-legend">Assistant</legend>
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
          disabled={disabled}
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
          disabled={disabled}
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