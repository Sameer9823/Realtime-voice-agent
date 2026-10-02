"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TranscriptEntry } from "@/lib/voice/types";

/**
 * Collapsible live transcript.
 *
 * Entries stream in as audio is recognised rather than appearing at the end of a turn, and an
 * interrupted assistant response is kept and explicitly labelled so the conversation history stays
 * truthful about what was actually said.
 */

export interface VoiceTranscriptProps {
  entries: TranscriptEntry[];
  agentName: string;
}

function formatTime(ms: number): string {
  const date = new Date(ms);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function VoiceTranscript({ entries, agentName }: VoiceTranscriptProps) {
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const pinnedToBottomRef = useRef(true);

  /** Auto-scroll only while the user is already at the bottom, so reading back isn't disrupted. */
  useLayoutEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list || !pinnedToBottomRef.current) return;
    list.scrollTop = list.scrollHeight;
  }, [entries, open]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onScroll = () => {
      const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
      pinnedToBottomRef.current = distanceFromBottom < 48;
    };
    list.addEventListener("scroll", onScroll, { passive: true });
    return () => list.removeEventListener("scroll", onScroll);
  }, [open]);

  const count = entries.length;

  return (
    <section className={`transcript ${open ? "transcript-open" : ""}`}>
      <button type="button" className="transcript-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="transcript-toggle-label">Transcript</span>
        <span className="transcript-count">{count}</span>
        <span className="transcript-chevron" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>

      {open && (
        <div className="transcript-body" ref={listRef} role="log" aria-live="polite" aria-label="Conversation transcript">
          {count === 0 && <p className="transcript-empty">Nothing yet. Start the conversation and talk — words appear here as they are spoken.</p>}
          {entries.map((entry) => (
            <article key={entry.id} className={`entry entry-${entry.role}`}>
              <header className="entry-header">
                <span className="entry-speaker">{entry.role === "user" ? "You" : agentName}</span>
                <time className="entry-time">{formatTime(entry.startedAt)}</time>
                {entry.status === "interrupted" && <span className="entry-flag">interrupted</span>}
              </header>
              <p className="entry-text">
                {entry.text || <span className="entry-placeholder">{entry.status === "streaming" ? "…" : ""}</span>}
                {entry.status === "interrupted" && <span className="entry-ellipsis">…</span>}
              </p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}