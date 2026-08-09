/**
 * Migration v2 — replay records for the durable replay engine.
 *
 * Applies after v1 (frozen schema-v0.2.6.sql). Adds the `replays` table used
 * by SqliteReplayRepository and ReplayService.runReplay to record, track and
 * validate deterministic event-stream replays.
 *
 * The frozen schema file is intentionally NOT modified; this migration is the
 * sanctioned additive path (see E.3.1 of the master-plan task brief).
 */

export const MIGRATION_V2_REPLAY_SQL = `
CREATE TABLE IF NOT EXISTS replays (
    id TEXT PRIMARY KEY,
    source_run_id TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    causation_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'in_progress', 'completed', 'failed')),
    event_count INTEGER NOT NULL DEFAULT 0,
    processed_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    result TEXT NOT NULL DEFAULT '{}',
    metadata TEXT NOT NULL DEFAULT '{}',
    events TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_replays_source_run ON replays(source_run_id);
CREATE INDEX IF NOT EXISTS idx_replays_status ON replays(status);
`;
