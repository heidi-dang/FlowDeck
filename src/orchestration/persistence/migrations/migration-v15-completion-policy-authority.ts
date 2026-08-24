import type { Database } from "bun:sqlite";

/**
 * V15 extends the existing V10 `heidi_completion_reviews` ledger.  The policy
 * must be reconstructable after restart, so the review record carries the
 * exact Run state and durable verification result on which a completion CAS
 * was evaluated.  This is intentionally an extension of the existing review
 * system rather than a second completion-decision store.
 */
export const MIGRATION_V15_COMPLETION_POLICY_AUTHORITY_SQL = `
ALTER TABLE heidi_completion_reviews ADD COLUMN state_version INTEGER;
ALTER TABLE heidi_completion_reviews ADD COLUMN state_fingerprint TEXT;
ALTER TABLE heidi_completion_reviews ADD COLUMN verification_id TEXT;
ALTER TABLE heidi_completion_reviews ADD COLUMN decision_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE heidi_completion_reviews ADD COLUMN policy_version TEXT NOT NULL DEFAULT 'completion-policy-v1';

CREATE UNIQUE INDEX idx_completion_review_live_identity
  ON heidi_completion_reviews(task_run_id, state_version, state_fingerprint, verification_id)
  WHERE task_run_id IS NOT NULL
    AND state_version IS NOT NULL
    AND state_fingerprint IS NOT NULL
    AND verification_id IS NOT NULL;
CREATE INDEX idx_completion_review_run_status
  ON heidi_completion_reviews(task_run_id, status, created_at);
`;

export const MIGRATION_V15_COMPLETION_POLICY_AUTHORITY_CHECKSUM_SOURCE = `
-- v15-completion-policy-authority-contract
${MIGRATION_V15_COMPLETION_POLICY_AUTHORITY_SQL.trim()}
-- apply: inspect the V10 completion-review table; no-op if the historical
-- closure subsystem is absent; add only missing authority columns and indexes.
`;

export function applyV15Migration(db: Database): void {
  const columns = db.query("PRAGMA table_info(heidi_completion_reviews)").all() as { name: string }[];
  if (columns.length === 0) return;

  const existing = new Set(columns.map(column => column.name));
  const additions: Array<[string, string]> = [
    ["state_version", "INTEGER"],
    ["state_fingerprint", "TEXT"],
    ["verification_id", "TEXT"],
    ["decision_json", "TEXT NOT NULL DEFAULT '{}'"] ,
    ["policy_version", "TEXT NOT NULL DEFAULT 'completion-policy-v1'"],
  ];
  for (const [name, definition] of additions) {
    if (!existing.has(name)) db.exec(`ALTER TABLE heidi_completion_reviews ADD COLUMN ${name} ${definition}`);
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_completion_review_live_identity
      ON heidi_completion_reviews(task_run_id, state_version, state_fingerprint, verification_id)
      WHERE task_run_id IS NOT NULL
        AND state_version IS NOT NULL
        AND state_fingerprint IS NOT NULL
        AND verification_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_completion_review_run_status
      ON heidi_completion_reviews(task_run_id, status, created_at);
  `);
}
