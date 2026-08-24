/**
 * SessionTurnRepository — Persistent SQLite repository for tracking monotonic user turn versions per session.
 *
 * Ensures:
 * - Atomic read-and-increment on genuine user turns within a write transaction.
 * - Idempotent handling of duplicate native message events (messageId / event hash), including out-of-order duplicates.
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

      // 1. Authoritative messageId deduplication against session_turn_messages
      if (input.messageId) {
        const existingMsg = this.db.query(
          "SELECT user_turn_version FROM session_turn_messages WHERE session_id = ? AND message_id = ?"
        ).get(input.sessionId, input.messageId) as { user_turn_version: number } | null;

        if (existingMsg) {
          return existingMsg.user_turn_version;
        }

        const existingTurn = this.findBySessionId(input.sessionId);
        const nextVersion = existingTurn ? existingTurn.userTurnVersion + 1 : 1;

        try {
          // Atomically record message identity and update turn version
          this.db.query(`
            INSERT INTO session_turn_messages (session_id, message_id, message_hash, user_turn_version, created_at)
            VALUES (?, ?, ?, ?, ?)
          `).run(
            input.sessionId,
            input.messageId,
            input.messageHash ?? null,
            nextVersion,
            now
          );

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
            input.messageId,
            input.messageHash ?? null,
            now,
            nextVersion
          );

          return nextVersion;
        } catch (err: any) {
          // On UNIQUE constraint conflict from concurrent duplicate insertion, reread and return established version
          const recheck = this.db.query(
            "SELECT user_turn_version FROM session_turn_messages WHERE session_id = ? AND message_id = ?"
          ).get(input.sessionId, input.messageId) as { user_turn_version: number } | null;
          if (recheck) {
            return recheck.user_turn_version;
          }
          throw err;
        }
      }

      // 2. Hash-only fallback when messageId is unavailable
      const existingTurn = this.findBySessionId(input.sessionId);
      if (existingTurn && input.messageHash && existingTurn.lastUserMessageHash === input.messageHash) {
        return existingTurn.userTurnVersion;
      }

      const nextVersion = existingTurn ? existingTurn.userTurnVersion + 1 : 1;

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
        null,
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
