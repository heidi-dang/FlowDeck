use crate::intelligence::model::{GraphEdge, GraphNode, IndexedFile, SemanticEdge, SemanticNode};
use rusqlite::Transaction;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum IndexError {
    #[error("Database error: {0}")]
    Db(#[from] rusqlite::Error),
}

pub struct TransactionalGraph<'a> {
    pub tx: Transaction<'a>,
}

/// Stable-ID prefix for repository FILE nodes (shared, provider-neutral).
pub const FILE_NODE_PREFIX: &str = "file:";

impl<'a> TransactionalGraph<'a> {
    pub fn new(conn: &'a mut rusqlite::Connection) -> Result<Self, IndexError> {
        let tx = conn.transaction()?;
        Ok(Self { tx })
    }

    /// Milestone 2 file-evidence replacement, made provider-aware:
    ///
    /// - file-owned/structural nodes for the path are removed (cascading their
    ///   edges)
    /// - shared repository FILE nodes (stable_id `file:...`) survive
    /// - provider-derived nodes for the path are marked stale, never deleted
    ///   here — a provider refresh replaces them transactionally
    pub fn replace_file_evidence(&self, canonical_path: &str) -> Result<(), IndexError> {
        self.tx.execute(
            "DELETE FROM nodes
             WHERE canonical_path = ?1
               AND provider IS NULL
               AND stable_id NOT LIKE 'file:%'",
            rusqlite::params![canonical_path],
        )?;
        self.tx.execute(
            "UPDATE nodes SET stale = 1
             WHERE canonical_path = ?1 AND provider IS NOT NULL",
            rusqlite::params![canonical_path],
        )?;
        Ok(())
    }

    /// Upsert a row in `files` without touching nodes (used by semantic
    /// ingest; the file row must exist for FK constraints on node paths).
    pub fn upsert_file_row(&self, file: &IndexedFile) -> Result<(), IndexError> {
        self.tx.execute(
            "INSERT INTO files (canonical_path, content_hash, size, mtime_ms, language, indexed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(canonical_path) DO UPDATE SET
                content_hash = excluded.content_hash,
                size = excluded.size,
                mtime_ms = excluded.mtime_ms,
                language = excluded.language,
                indexed_at = excluded.indexed_at",
            rusqlite::params![
                file.canonical_path,
                file.content_hash,
                file.size as i64,
                file.mtime_ms.map(|v| v as i64),
                file.language,
                file.indexed_at as i64,
            ],
        )?;
        Ok(())
    }

    pub fn insert_file(&self, file: &IndexedFile) -> Result<(), IndexError> {
        self.replace_file_evidence(&file.canonical_path)?;
        self.tx.execute(
            "INSERT INTO files (canonical_path, content_hash, size, mtime_ms, language, indexed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(canonical_path) DO UPDATE SET
                content_hash = excluded.content_hash,
                size = excluded.size,
                mtime_ms = excluded.mtime_ms,
                language = excluded.language,
                indexed_at = excluded.indexed_at",
            rusqlite::params![
                file.canonical_path,
                file.content_hash,
                file.size as i64,
                file.mtime_ms.map(|v| v as i64),
                file.language,
                file.indexed_at as i64,
            ],
        )?;
        Ok(())
    }

    pub fn insert_node(&self, node: &GraphNode) -> Result<(), IndexError> {
        let kind_str = serde_json::to_string(&node.kind)
            .unwrap_or_else(|_| "\"unknown\"".to_string())
            .trim_matches('"')
            .to_string();
        self.tx.execute(
            "INSERT INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity, metadata, source_identity)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(stable_id) DO UPDATE SET
                kind = excluded.kind,
                canonical_path = excluded.canonical_path,
                symbol_identity = excluded.symbol_identity,
                package_identity = excluded.package_identity,
                metadata = excluded.metadata,
                source_identity = excluded.source_identity",
            rusqlite::params![
                node.stable_id,
                kind_str,
                node.canonical_path,
                node.symbol_identity,
                node.package_identity,
                node.metadata,
                node.source_identity,
            ],
        )?;
        Ok(())
    }

    /// Insert a provider-owned semantic node with full provenance.
    pub fn insert_semantic_node(&self, node: &SemanticNode) -> Result<(), IndexError> {
        let kind_str = serde_json::to_string(&node.kind)
            .unwrap_or_else(|_| "\"unknown\"".to_string())
            .trim_matches('"')
            .to_string();
        self.tx.execute(
            "INSERT INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity,
                                metadata, provider, provider_fingerprint, generation, source_identity, source_hash, stale)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0)
             ON CONFLICT(stable_id) DO UPDATE SET
                kind = excluded.kind,
                canonical_path = excluded.canonical_path,
                symbol_identity = excluded.symbol_identity,
                package_identity = excluded.package_identity,
                metadata = excluded.metadata,
                provider = excluded.provider,
                provider_fingerprint = excluded.provider_fingerprint,
                generation = excluded.generation,
                source_identity = excluded.source_identity,
                source_hash = excluded.source_hash,
                stale = 0",
            rusqlite::params![
                node.stable_id,
                kind_str,
                node.canonical_path,
                node.symbol_identity,
                node.package_identity,
                node.metadata,
                node.provider,
                node.provider_fingerprint,
                node.generation as i64,
                node.source_identity,
                node.source_hash,
            ],
        )?;
        Ok(())
    }

    /// Insert a shared repository FILE node (provider-neutral, never replaced
    /// by provider refreshes).
    pub fn insert_shared_file_node(
        &self,
        canonical_path: &str,
        language: Option<&str>,
    ) -> Result<(), IndexError> {
        let stable_id = format!("{}{}", FILE_NODE_PREFIX, canonical_path);
        let metadata = language.map(|l| serde_json::json!({ "language": l }).to_string());
        self.tx.execute(
            "INSERT OR IGNORE INTO nodes (stable_id, kind, canonical_path, symbol_identity,
                                          package_identity, metadata, provider)
             VALUES (?1, 'file', ?2, NULL, NULL, ?3, NULL)",
            rusqlite::params![stable_id, canonical_path, metadata],
        )?;
        Ok(())
    }

    pub fn set_metadata(&self, key: &str, value: &str) -> Result<(), IndexError> {
        self.tx.execute(
            "INSERT INTO metadata (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![key, value],
        )?;
        Ok(())
    }

    pub fn insert_edge(&self, edge: &GraphEdge) -> Result<(), IndexError> {
        let kind_str = serde_json::to_string(&edge.kind)
            .unwrap_or_else(|_| "\"unknown\"".to_string())
            .trim_matches('"')
            .to_string();
        let provider_str = serde_json::to_string(&edge.provider)
            .unwrap_or_else(|_| "\"unknown\"".to_string())
            .trim_matches('"')
            .to_string();
        let strength_int = edge.strength as i32;

        self.tx.execute(
            "INSERT INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(stable_id) DO UPDATE SET
                stale = excluded.stale,
                updated_revision = excluded.updated_revision,
                source_hash = excluded.source_hash,
                strength = excluded.strength",
            rusqlite::params![
                edge.stable_id,
                edge.from_node,
                edge.to_node,
                kind_str,
                provider_str,
                edge.provider_fingerprint,
                strength_int,
                edge.source_identity,
                edge.source_hash,
                edge.created_revision as i64,
                edge.updated_revision as i64,
                edge.stale,
            ],
        )?;
        Ok(())
    }

    /// Insert a provider-owned semantic edge with full provenance and
    /// generation; occurrence positions are stored in `metadata` JSON so
    /// edge identity stays stable across harmless location changes.
    pub fn insert_semantic_edge(&self, edge: &SemanticEdge) -> Result<(), IndexError> {
        let kind_str = serde_json::to_string(&edge.kind)
            .unwrap_or_else(|_| "\"unknown\"".to_string())
            .trim_matches('"')
            .to_string();
        let provider_str = serde_json::to_string(&edge.provider)
            .unwrap_or_else(|_| "\"unknown\"".to_string())
            .trim_matches('"')
            .to_string();
        let strength_int = edge.strength as i32;

        self.tx.execute(
            "INSERT INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint,
                                strength, source_identity, source_hash, created_revision, updated_revision,
                                stale, generation, metadata)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, ?12, ?13)
             ON CONFLICT(stable_id) DO UPDATE SET
                stale = 0,
                updated_revision = excluded.updated_revision,
                source_hash = excluded.source_hash,
                strength = excluded.strength,
                generation = excluded.generation,
                metadata = excluded.metadata",
            rusqlite::params![
                edge.stable_id,
                edge.from_node,
                edge.to_node,
                kind_str,
                provider_str,
                edge.provider_fingerprint,
                strength_int,
                edge.source_identity,
                edge.source_hash,
                edge.generation as i64,
                edge.generation as i64,
                edge.generation as i64,
                edge.metadata,
            ],
        )?;
        Ok(())
    }

    /// Delete all evidence owned by a provider (nodes carry the provider id;
    /// edges cascade via FK). Used for whole-provider generation replacement.
    pub fn replace_provider_evidence(&self, provider_id: &str) -> Result<usize, IndexError> {
        let count = self.tx.execute(
            "DELETE FROM nodes WHERE provider = ?1",
            rusqlite::params![provider_id],
        )?;
        Ok(count)
    }

    /// Delete stale provider-owned nodes (evidence for sources that changed
    /// and were never refreshed) — bounded cleanup, never during queries.
    pub fn delete_stale_provider_nodes(&self) -> Result<usize, IndexError> {
        let count = self.tx.execute(
            "DELETE FROM nodes WHERE provider IS NOT NULL AND stale = 1",
            [],
        )?;
        Ok(count)
    }

    pub fn commit(self) -> Result<(), IndexError> {
        self.tx.commit()?;
        Ok(())
    }

    pub fn rollback(self) -> Result<(), IndexError> {
        self.tx.rollback()?;
        Ok(())
    }
}
