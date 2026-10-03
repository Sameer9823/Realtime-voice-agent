"use client";

import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import type { TranscriptEntry } from "@/lib/voice/types";

/**
 * The conversation log.
 *
 * Always open. Reading back what was said is half the product, and hiding it behind a toggle meant
 * most sessions were never read at all.
 *
 * Entries stream in as audio is recognised rather than appearing at the end of a turn. An
 * interrupted assistant response is kept and visibly flagged, because the alternative — dropping the
 * partial turn — makes the transcript quietly disagree with what was heard.
 *
 * Speaker colour is the same ultramarine/amber pair used by the ring and the turn indicator: you sit
 * right, the assistant sits left. The serif face is used here and nowhere else, since this is the
 * one region of the interface meant for reading rather than scanning.
 */

export interface VoiceTranscriptProps {
  entries: TranscriptEntry[];
  agentName: string;
  /** Header actions, rendered opposite the title. */
  actions?: ReactNode;
  /** Composer, rendered below the log so the log keeps its own scroll region. */
  composer?: ReactNode;
}

function formatTime(ms: number): string {
  const date = new Date(ms);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function VoiceTranscript({ entries, agentName, actions, composer }: VoiceTranscriptProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const pinnedToBottomRef = useRef(true);

  /**
   * Auto-scroll only while the reader is already at the bottom. Someone scrolling up to re-read
   * something would otherwise be dragged back down by every incoming fragment.
   */
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !pinnedToBottomRef.current) return;
    list.scrollTop = list.scrollHeight;
  }, [entries]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onScroll = () => {
      const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
      pinnedToBottomRef.current = distanceFromBottom < 48;
    };
    list.addEventListener("scroll", onScroll, { passive: true });
    return () => list.removeEventListener("scroll", onScroll);
  }, []);

  const count = entries.length;

  return (
    <section className="conversation" aria-labelledby="conversation-heading">
      <header className="conversation-header">
        <h2 id="conversation-heading" className="conversation-title">
          Conversation
        </h2>
        {actions && <div className="conversation-actions">{actions}</div>}
      </header>

      <div
        className="transcript-log"
        ref={listRef}
        role="log"
        aria-live="polite"
        aria-label="Conversation transcript"
        tabIndex={0}
      >
        {count === 0 ? (
          <p className="transcript-empty">
            Start a conversation and say something out loud. Your words and the assistant&rsquo;s
            answers appear here as they are spoken.
          </p>
        ) : (
          entries.map((entry) => (
            <article
              key={entry.id}
              className={`entry entry-${entry.role} ${entry.status === "interrupted" ? "entry-interrupted" : ""}`}
            >
              <header className="entry-header">
                <span className="entry-speaker">{entry.role === "user" ? "You" : agentName}</span>
                <time
                  className="entry-time"
                  dateTime={new Date(entry.startedAt).toISOString()}
                  // The visible text is formatted in the viewer's locale and time zone, so it can
                  // legitimately differ from what the server rendered. Entries normally only exist
                  // client-side, but suppressing the warning keeps a server-rendered transcript
                  // from tripping hydration on a machine in another time zone.
                  suppressHydrationWarning
                >
                  {formatTime(entry.startedAt)}
                </time>
                {entry.status === "interrupted" && <span className="entry-flag">Interrupted</span>}
              </header>
              <p className="entry-text">
                {entry.text || <span className="entry-placeholder">{entry.status === "streaming" ? "…" : ""}</span>}
                {entry.status === "interrupted" && <span className="entry-ellipsis">…</span>}
              </p>
            </article>
          ))
        )}
      </div>

      {composer}
    </section>
  );
}