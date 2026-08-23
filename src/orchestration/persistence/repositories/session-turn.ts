/**
 * SessionTurnRepository — Persistent SQLite repository for tracking monotonic user turn versions per session.
 *
 * Ensures:
 * - Atomic read-and-increment on genuine user turns within a write transaction.
 * - Idempotent handling of duplicate native message events (messageId / event hash).
 * - Monotonic turn version survives process restarts.
 * - Old autonomous continuation tokens become invalid when the user sends a new message.
 */

import type { Database } from "bun:sqlite";
import type { TransactionManager } from "../transaction-manager";
import { BaseRepository } from "./repository";

export interface SessionTurnRow {
  sessionId: string;
  userTurnVersion: number;
  lastUserMessageId: string | null;
  lastUserMessageHash: string | null;
  updatedAt: string;
}

export class SessionTurnRepository extends BaseRepository {
  constructor(db: Database, tx: TransactionManager) {
    super(db, tx);
  }

  getTurnVersion(sessionId: string): number {
    return this.tx.read(() => {
      const row = this.db.query(
        "SELECT user_turn_version FROM session_turns WHERE session_id = ?"
      ).get(sessionId) as { user_turn_version: number } | null;
      return row ? row.user_turn_version : 1;
    });
  }

  incrementTurnVersion(input: {
    sessionId: string;
    messageId?: string;
    messageHash?: string;
  }): number {
    return this.tx.write(() => {
      const now = new Date().toISOString();
      const existing = this.findBySessionId(input.sessionId);

      // Idempotency: duplicate delivery of the exact same message must NOT increment generation
      if (existing) {
        if (input.messageId && existing.lastUserMessageId === input.messageId) {
          return existing.userTurnVersion;
        }
        if (!input.messageId && input.messageHash && existing.lastUserMessageHash === input.messageHash) {
          return existing.userTurnVersion;
        }
      }

      const nextVersion = existing ? existing.userTurnVersion + 1 : 1;

      this.db.query(`
        INSERT INTO session_turns (session_id, user_turn_version, last_user_message_id, last_user_message_hash, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          user_turn_version = ?,
          last_user_message_id = excluded.last_user_message_id,
          last_user_message_hash = excluded.last_user_message_hash,
          updated_at = excluded.updated_at
      `).run(
        input.sessionId,
        nextVersion,
        input.messageId ?? null,
        input.messageHash ?? null,
        now,
        nextVersion
      );

      return nextVersion;
    });
  }

  findBySessionId(sessionId: string): SessionTurnRow | null {
    return this.tx.read(() => {
      const row = this.db.query(
        "SELECT * FROM session_turns WHERE session_id = ?"
      ).get(sessionId) as Record<string, unknown> | null;
      if (!row) return null;
      return {
        sessionId: row.session_id as string,
        userTurnVersion: row.user_turn_version as number,
        lastUserMessageId: (row.last_user_message_id as string) ?? null,
        lastUserMessageHash: (row.last_user_message_hash as string) ?? null,
        updatedAt: row.updated_at as string,
      };
    });
  }
}
