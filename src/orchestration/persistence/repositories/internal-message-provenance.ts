import type { Database } from "bun:sqlite";
import type { TransactionManager } from "../transaction-manager";
import { BaseRepository } from "./repository";

export type InternalMessageProvenance =
  | "FLOWDECK_SPECIALIST_DISPATCH"
  | "FLOWDECK_CONTINUATION"
  | "FLOWDECK_VERIFICATION"
  | "FLOWDECK_RECOVERY"
  | "FLOWDECK_INTERNAL_CONTROL";

const VALID_PROVENANCE = new Set<InternalMessageProvenance>([
  "FLOWDECK_SPECIALIST_DISPATCH",
  "FLOWDECK_CONTINUATION",
  "FLOWDECK_VERIFICATION",
  "FLOWDECK_RECOVERY",
  "FLOWDECK_INTERNAL_CONTROL",
]);

export interface InternalMessageRecord {
  sessionId: string;
  messageId: string;
  provenance: InternalMessageProvenance;
  dispatchIdentity: string | null;
  createdAt: string;
}

export interface InternalMessageProvenanceStats {
  totalCount: number;
  oldestCreatedAt: string | null;
}

/**
 * Persists semantic FlowDeck message provenance independently of OpenCode's
 * role=user transport. A caller can only reserve a known native message ID
 * before sending it; arbitrary user text therefore cannot obtain this state.
 */
export class InternalMessageProvenanceRepository extends BaseRepository {
  constructor(db: Database, tx: TransactionManager) {
    super(db, tx);
  }

  reserve(input: {
    sessionId: string;
    messageId: string;
    provenance: InternalMessageProvenance;
    dispatchIdentity?: string;
  }): boolean {
    if (!VALID_PROVENANCE.has(input.provenance)) {
      throw new Error(`INVALID_INTERNAL_MESSAGE_PROVENANCE: ${input.provenance}`);
    }

    return this.tx.write(() => {
      const existing = this.find(input.sessionId, input.messageId);
      if (existing) {
        return existing.provenance === input.provenance
          && existing.dispatchIdentity === (input.dispatchIdentity ?? null);
      }

      const inserted = this.db.query(`
        INSERT INTO flowdeck_internal_messages (
          session_id, message_id, provenance, dispatch_identity, created_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id, message_id) DO NOTHING
      `).run(
        input.sessionId,
        input.messageId,
        input.provenance,
        input.dispatchIdentity ?? null,
        new Date().toISOString(),
      );

      if (inserted.changes > 0) return true;
      const concurrent = this.find(input.sessionId, input.messageId);
      return Boolean(
        concurrent
        && concurrent.provenance === input.provenance
        && concurrent.dispatchIdentity === (input.dispatchIdentity ?? null),
      );
    });
  }

  find(sessionId: string, messageId: string): InternalMessageRecord | null {
    return this.tx.read(() => {
      const row = this.db.query(`
        SELECT session_id, message_id, provenance, dispatch_identity, created_at
        FROM flowdeck_internal_messages
        WHERE session_id = ? AND message_id = ?
      `).get(sessionId, messageId) as Record<string, unknown> | null;
      if (!row) return null;
      const provenance = row.provenance;
      if (typeof provenance !== "string" || !VALID_PROVENANCE.has(provenance as InternalMessageProvenance)) {
        return null;
      }
      return {
        sessionId: String(row.session_id),
        messageId: String(row.message_id),
        provenance: provenance as InternalMessageProvenance,
        dispatchIdentity: typeof row.dispatch_identity === "string" ? row.dispatch_identity : null,
        createdAt: String(row.created_at),
      };
    });
  }

  isInternal(sessionId: string, messageId?: string): boolean {
    return Boolean(messageId && this.find(sessionId, messageId));
  }

  /**
   * Deletes all provenance records for a given session when the session is deleted.
   */
  deleteForSession(sessionId: string): number {
    return this.tx.write(() => {
      const result = this.db.query(`
        DELETE FROM flowdeck_internal_messages
        WHERE session_id = ?
      `).run(sessionId);
      return result.changes;
    });
  }

  /**
   * Prunes settled/completed internal message provenance records older than the cutoff.
   * Unresolved/in-flight dispatches or records tied to outcome_unknown dispatches are retained.
   */
  pruneExpired(olderThanIso: string): number {
    return this.tx.write(() => {
      const result = this.db.query(`
        DELETE FROM flowdeck_internal_messages
        WHERE created_at < ?
          AND (
            dispatch_identity IS NULL
            OR dispatch_identity NOT IN (
              SELECT identity FROM continuation_dispatches
              WHERE status IN ('pending', 'outcome_unknown')
            )
          )
      `).run(olderThanIso);
      return result.changes;
    });
  }

  /**
   * Returns diagnostic statistics for the provenance ledger.
   */
  getStats(): InternalMessageProvenanceStats {
    return this.tx.read(() => {
      const countRow = this.db.query(`
        SELECT COUNT(*) as count, MIN(created_at) as oldest
        FROM flowdeck_internal_messages
      `).get() as { count: number; oldest: string | null } | null;

      return {
        totalCount: countRow?.count ?? 0,
        oldestCreatedAt: countRow?.oldest ?? null,
      };
    });
  }
}
