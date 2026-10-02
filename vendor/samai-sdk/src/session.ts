import type { Message } from "./types.js";

/**
 * Storage adapter interface for persisting conversation history across
 * separate `runAgent()` calls. Implement this to back sessions with Redis,
 * SQLite, Postgres, or anything else — the run loop only ever talks to
 * this interface, never to a specific database.
 */
export interface SessionStore {
  getMessages(sessionId: string): Promise<Message[]> | Message[];
  appendMessages(sessionId: string, messages: Message[]): Promise<void> | void;
  clear(sessionId: string): Promise<void> | void;
}

/** Default store — lives only for the process lifetime. Good for tests, scripts, and request-scoped usage. */
export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, Message[]>();

  getMessages(sessionId: string): Message[] {
    return [...(this.sessions.get(sessionId) ?? [])];
  }
  appendMessages(sessionId: string, messages: Message[]): void {
    const existing = this.sessions.get(sessionId) ?? [];
    this.sessions.set(sessionId, [...existing, ...messages]);
  }
  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

/** Persists each session as a JSON file on disk — survives process restarts with zero extra infra. */
export class FileSessionStore implements SessionStore {
  constructor(private dir: string) {}

  private async pathFor(sessionId: string): Promise<string> {
    const { join } = await import("node:path");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(this.dir, { recursive: true });
    return join(this.dir, `${encodeURIComponent(sessionId)}.json`);
  }

  async getMessages(sessionId: string): Promise<Message[]> {
    const { readFile } = await import("node:fs/promises");
    try {
      const raw = await readFile(await this.pathFor(sessionId), "utf-8");
      return JSON.parse(raw) as Message[];
    } catch (err: any) {
      if (err?.code === "ENOENT") return [];
      throw err;
    }
  }
  async appendMessages(sessionId: string, messages: Message[]): Promise<void> {
    const { writeFile } = await import("node:fs/promises");
    const existing = await this.getMessages(sessionId);
    await writeFile(await this.pathFor(sessionId), JSON.stringify([...existing, ...messages], null, 2), "utf-8");
  }
  async clear(sessionId: string): Promise<void> {
    const { rm } = await import("node:fs/promises");
    await rm(await this.pathFor(sessionId), { force: true });
  }
}

/**
 * A handle to one persistent conversation. Deliberately separate from:
 *  - Agent config (`defineAgent()`) — static, reusable, holds no state
 *  - Run state (inside `runAgentStream()`) — transient, exists only for one run
 * Session is the one piece that outlives a single `runAgent()` call.
 */
export interface Session {
  id: string;
  getMessages(): Promise<Message[]>;
  appendMessages(messages: Message[]): Promise<void>;
  clear(): Promise<void>;
}

export function createSession(id: string, store: SessionStore = new InMemorySessionStore()): Session {
  return {
    id,
    getMessages: async () => store.getMessages(id),
    appendMessages: async (messages) => store.appendMessages(id, messages),
    clear: async () => store.clear(id),
  };
}
