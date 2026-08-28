#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SchemaVersion {
    pub version: u32,
}

pub const CURRENT_SCHEMA_VERSION: u32 = 10;

pub const INITIALIZE_SCHEMA_SQL: &str = r#"
PRAGMA user_version = 1;

CREATE TABLE IF NOT EXISTS schema_metadata (
    version INTEGER PRIMARY KEY
);

INSERT OR IGNORE INTO schema_metadata (version) VALUES (1);

CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
    canonical_path TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms INTEGER,
    language TEXT,
    indexed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
    stable_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    canonical_path TEXT,
    symbol_identity TEXT,
    package_identity TEXT,
    metadata TEXT,
    FOREIGN KEY(canonical_path) REFERENCES files(canonical_path) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS edges (
    stable_id TEXT PRIMARY KEY,
    from_node TEXT NOT NULL,
    to_node TEXT NOT NULL,
    kind TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_fingerprint TEXT NOT NULL,
    strength INTEGER NOT NULL,
    source_identity TEXT,
    source_hash TEXT,
    created_revision INTEGER NOT NULL,
    updated_revision INTEGER NOT NULL,
    stale BOOLEAN NOT NULL DEFAULT 0,
    FOREIGN KEY(from_node) REFERENCES nodes(stable_id) ON DELETE CASCADE,
    FOREIGN KEY(to_node) REFERENCES nodes(stable_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_node);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_node);
CREATE INDEX IF NOT EXISTS idx_edges_source_hash ON edges(source_hash);
CREATE INDEX IF NOT EXISTS idx_edges_provider ON edges(provider);

CREATE TABLE IF NOT EXISTS provider_state (
    provider TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    compatibility_data TEXT
);
"#;

/// SQL applied when migrating a v1 database to v2.
///
/// v2 additions:
/// - provider-owned node provenance (nodes.provider / provider_fingerprint /
///   generation / source_hash / stale)
/// - semantic generation + occurrence metadata on edges
/// - the semantic_providers registry table (typed provider state, never an
///   opaque blob)
pub const MIGRATE_V1_TO_V2_SQL: &str = r#"
ALTER TABLE nodes ADD COLUMN provider TEXT;
ALTER TABLE nodes ADD COLUMN provider_fingerprint TEXT;
ALTER TABLE nodes ADD COLUMN generation INTEGER;
ALTER TABLE nodes ADD COLUMN source_hash TEXT;
ALTER TABLE nodes ADD COLUMN stale BOOLEAN NOT NULL DEFAULT 0;
ALTER TABLE edges ADD COLUMN generation INTEGER;
ALTER TABLE edges ADD COLUMN metadata TEXT;

CREATE TABLE IF NOT EXISTS semantic_providers (
    provider_id TEXT PRIMARY KEY,
    provider_type TEXT NOT NULL,
    provider_version TEXT NOT NULL,
    executable_identity TEXT NOT NULL,
    scip_schema_version TEXT NOT NULL,
    languages TEXT NOT NULL,
    workspace_root TEXT NOT NULL,
    package TEXT,
    config_fingerprint TEXT NOT NULL,
    input_fingerprint TEXT NOT NULL,
    last_successful_run INTEGER,
    health TEXT NOT NULL,
    freshness TEXT NOT NULL,
    output_digest TEXT,
    failure_reason TEXT,
    semantic_generation INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nodes_provider ON nodes(provider);
CREATE INDEX IF NOT EXISTS idx_nodes_provider_fingerprint ON nodes(provider_fingerprint);
CREATE INDEX IF NOT EXISTS idx_nodes_generation ON nodes(generation);
CREATE INDEX IF NOT EXISTS idx_edges_generation ON edges(generation);
"#;

/// SQL applied when migrating a v2 database to v3.
///
/// v3 additions:
/// - separate active provider state from attempt diagnostics
///   (last_attempt_fingerprint, last_attempt_at, last_attempt_health,
///   last_attempt_failure_reason)
pub const MIGRATE_V2_TO_V3_SQL: &str = r#"
ALTER TABLE semantic_providers ADD COLUMN last_attempt_fingerprint TEXT;
ALTER TABLE semantic_providers ADD COLUMN last_attempt_at INTEGER;
ALTER TABLE semantic_providers ADD COLUMN last_attempt_health TEXT;
ALTER TABLE semantic_providers ADD COLUMN last_attempt_failure_reason TEXT;
"#;

/// SQL applied when migrating a v3 database to v4.
///
/// v4 additions:
/// - explicit semantic node derivation identity (nodes.source_identity)
pub const MIGRATE_V3_TO_V4_SQL: &str = r#"
ALTER TABLE nodes ADD COLUMN source_identity TEXT;
"#;

/// SQL applied when migrating a v4 database to v5.
///
/// v5 additions:
/// - explicit semantic edge provider_id ownership for precise provenance and freshness correlation
pub const MIGRATE_V4_TO_V5_SQL: &str = r#"
ALTER TABLE edges ADD COLUMN provider_id TEXT;
CREATE INDEX IF NOT EXISTS idx_edges_provider_id ON edges(provider_id);
"#;
