import type { Database } from "bun:sqlite";

/**
 * Canonical V14 contract. `applyV14Migration` uses table/column inspection so
 * historical partial databases that predate verification persistence still
 * advance their migration ledger without fabricating a verification subsystem.
 */
export const MIGRATION_V14_LIVE_VERIFICATION_AUTHORITY_SQL = `
-- Durable identity and reconstructable evidence for authoritative live verification.
ALTER TABLE verification_results ADD COLUMN state_version INTEGER;
ALTER TABLE verification_results ADD COLUMN state_fingerprint TEXT;
ALTER TABLE verification_results ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE verification_results ADD COLUMN failure_reasons TEXT;
ALTER TABLE verification_results ADD COLUMN correlation_id TEXT;
ALTER TABLE verification_results ADD COLUMN causation_id TEXT;
ALTER TABLE verification_results ADD COLUMN updated_at TEXT;

-- NULL state_version keeps historical/manual verification rows outside the live identity.
CREATE UNIQUE INDEX idx_vr_live_identity
  ON verification_results(run_id, state_version, state_fingerprint, verification_type)
  WHERE state_version IS NOT NULL;
CREATE INDEX idx_vr_live_state
  ON verification_results(run_id, state_version, state_fingerprint, status);
`;

export const MIGRATION_V14_LIVE_VERIFICATION_AUTHORITY_CHECKSUM_SOURCE = `
-- v14-live-verification-authority-contract
${MIGRATION_V14_LIVE_VERIFICATION_AUTHORITY_SQL.trim()}
-- apply: inspect verification_results; no-op when the legacy table is absent;
-- add only missing V14 columns; create the two indexes with IF NOT EXISTS.
`;

export function applyV14Migration(db: Database): void {
  const columns = db.query("PRAGMA table_info(verification_results)").all() as { name: string }[];
  // Some historical pre-runtime fixtures never had the verification table.
  // They are allowed to advance, but cannot claim live verification authority
  // until the canonical verification schema is present.
  if (columns.length === 0) return;

  const existing = new Set(columns.map(column => column.name));
  const additions: Array<[string, string]> = [
    ["state_version", "INTEGER"],
    ["state_fingerprint", "TEXT"],
    ["evidence_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["failure_reasons", "TEXT"],
    ["correlation_id", "TEXT"],
    ["causation_id", "TEXT"],
    ["updated_at", "TEXT"],
  ];
  for (const [name, definition] of additions) {
    if (!existing.has(name)) db.exec(`ALTER TABLE verification_results ADD COLUMN ${name} ${definition}`);
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vr_live_identity
      ON verification_results(run_id, state_version, state_fingerprint, verification_type)
      WHERE state_version IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_vr_live_state
      ON verification_results(run_id, state_version, state_fingerprint, status);
  `);
}
