#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SchemaVersion {
    pub version: u32,
}

pub const CURRENT_SCHEMA_VERSION: u32 = 1;

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
