import type { Message } from "../types.js";
import type { SessionStore } from "../session.js";

export interface SqliteSessionStoreOptions {
  /** Path to the SQLite database file. Default: "./samai-sessions.db". Use ":memory:" for an ephemeral DB. */
  path?: string;
  /** Table name to store sessions in. Default: "samai_sessions". */
  tableName?: string;
}

interface MinimalStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): { messages: string } | undefined;
}

interface MinimalDatabase {
  exec(sql: string): void;
  prepare(sql: string): MinimalStatement;
}

/**
 * Persists sessions in a local SQLite file — no external server needed, survives process
 * restarts, and is a good fit for single-instance deployments or local development. Requires
 * the optional `better-sqlite3` peer dependency (`npm install better-sqlite3`); it's imported
 * dynamically so the rest of the SDK works fine without it installed.
 *
 * Usage:
 *   const store = new SqliteSessionStore({ path: "./data/sessions.db" });
 *   const session = createSession(userId, store);
 */
export class SqliteSessionStore implements SessionStore {
  private dbPromise: Promise<MinimalDatabase>;
  private tableName: string;

  constructor(options: SqliteSessionStoreOptions = {}) {
    this.tableName = (options.tableName ?? "samai_sessions").replace(/[^a-zA-Z0-9_]/g, "_");
    this.dbPromise = this.open(options.path ?? "./samai-sessions.db");
  }

  private async open(path: string): Promise<MinimalDatabase> {
    let Database: new (path: string) => MinimalDatabase;
    try {
      ({ default: Database } = await import("better-sqlite3"));
    } catch (err) {
      throw new Error(
        "SqliteSessionStore requires the optional `better-sqlite3` package. Install it with `npm install better-sqlite3`.",
        { cause: err }
      );
    }
    const db = new Database(path);
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${this.tableName} (session_id TEXT PRIMARY KEY, messages TEXT NOT NULL)`
    );
    return db;
  }

  async getMessages(sessionId: string): Promise<Message[]> {
    const db = await this.dbPromise;
    const row = db.prepare(`SELECT messages FROM ${this.tableName} WHERE session_id = ?`).get(sessionId);
    return row ? (JSON.parse(row.messages) as Message[]) : [];
  }

  async appendMessages(sessionId: string, messages: Message[]): Promise<void> {
    if (messages.length === 0) return;
    const db = await this.dbPromise;
    const existing = await this.getMessages(sessionId);
    const updated = [...existing, ...messages];
    db.prepare(
      `INSERT INTO ${this.tableName} (session_id, messages) VALUES (?, ?)
       ON CONFLICT(session_id) DO UPDATE SET messages = excluded.messages`
    ).run(sessionId, JSON.stringify(updated));
  }

  async clear(sessionId: string): Promise<void> {
    const db = await this.dbPromise;
    db.prepare(`DELETE FROM ${this.tableName} WHERE session_id = ?`).run(sessionId);
  }
}
