use crate::intelligence::model::{GraphEdge, GraphNode, IndexedFile};
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

impl<'a> TransactionalGraph<'a> {
    pub fn new(conn: &'a mut rusqlite::Connection) -> Result<Self, IndexError> {
        let tx = conn.transaction()?;
        Ok(Self { tx })
    }

    pub fn insert_file(&self, file: &IndexedFile) -> Result<(), IndexError> {
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
            "INSERT INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity, metadata)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(stable_id) DO UPDATE SET
                kind = excluded.kind,
                canonical_path = excluded.canonical_path,
                symbol_identity = excluded.symbol_identity,
                package_identity = excluded.package_identity,
                metadata = excluded.metadata",
            rusqlite::params![
                node.stable_id,
                kind_str,
                node.canonical_path,
                node.symbol_identity,
                node.package_identity,
                node.metadata,
            ]
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
            ]
        )?;
        Ok(())
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
