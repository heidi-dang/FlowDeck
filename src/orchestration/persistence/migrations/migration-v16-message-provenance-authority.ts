import type { Database } from "bun:sqlite";

/**
 * V16 records FlowDeck-originated prompt message identities outside OpenCode's
 * transport role. OpenCode may deliver internal promptAsync traffic as role=user;
 * only this durable association may classify a message as internal.
 */
export const MIGRATION_V16_MESSAGE_PROVENANCE_AUTHORITY_SQL = `
CREATE TABLE IF NOT EXISTS flowdeck_internal_messages (
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK(provenance IN (
    'FLOWDECK_SPECIALIST_DISPATCH',
    'FLOWDECK_CONTINUATION',
    'FLOWDECK_VERIFICATION',
    'FLOWDECK_RECOVERY',
    'FLOWDECK_INTERNAL_CONTROL'
  )),
  dispatch_identity TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(session_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_flowdeck_internal_messages_session
  ON flowdeck_internal_messages(session_id, created_at);
`;

export const MIGRATION_V16_MESSAGE_PROVENANCE_AUTHORITY_CHECKSUM_SOURCE = `
-- v16-message-provenance-authority-contract
${MIGRATION_V16_MESSAGE_PROVENANCE_AUTHORITY_SQL.trim()}
-- OpenCode transport role is not semantic provenance. Records are keyed by the
-- native messageID supplied at FlowDeck prompt dispatch and fail closed on an
-- unknown or conflicting provenance value.
`;

export function applyV16Migration(db: Database): void {
  db.exec(MIGRATION_V16_MESSAGE_PROVENANCE_AUTHORITY_SQL);
}
