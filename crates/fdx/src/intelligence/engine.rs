use crate::intelligence::db::EvidenceDatabase;
use crate::intelligence::index::TransactionalGraph;
use crate::intelligence::invalidation::InvalidationEngine;
use crate::intelligence::model::IndexedFile;
use crate::protocol::canonicalize_repo_path;
use ignore::WalkBuilder;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::SystemTime;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("Database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Invalidation error: {0}")]
    Invalidation(#[from] crate::intelligence::invalidation::InvalidationError),
    #[error("Index error: {0}")]
    Index(#[from] crate::intelligence::index::IndexError),
    #[error("Database init error: {0}")]
    Database(#[from] crate::intelligence::db::DatabaseError),
    #[error("Ignore error: {0}")]
    Ignore(#[from] ignore::Error),
}

pub struct IndexStatus {
    pub files: usize,
    pub changed: usize,
}

pub fn run_incremental_index(repo_root: &Path, refresh: bool) -> Result<IndexStatus, EngineError> {
    let mut db = EvidenceDatabase::open(repo_root)?;

    // Read current files
    let mut current_files: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    {
        let mut stmt = db
            .conn
            .prepare("SELECT canonical_path, content_hash FROM files")?;
        let rows = stmt.query_map([], |row| {
            let path: String = row.get(0)?;
            let hash: String = row.get(1)?;
            Ok((path, hash))
        })?;
        for (p, h) in rows.flatten() {
            current_files.insert(p, h);
        }
    }

    let mut discovered: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut changed_count = 0;

    let walker = WalkBuilder::new(repo_root)
        .hidden(true)
        .git_ignore(true)
        .require_git(false)
        .build();

    for result in walker {
        let entry = match result {
            Ok(e) => e,
            Err(_) => continue,
        };

        if entry.file_type().is_none_or(|ft| !ft.is_file()) {
            continue;
        }

        let path = entry.path();
        if path
            .components()
            .any(|c| c.as_os_str() == ".fdx" || c.as_os_str() == ".git")
        {
            continue;
        }

        let canonical = match canonicalize_repo_path(path, repo_root) {
            Ok(c) => c,
            Err(_) => continue,
        };
        discovered.insert(canonical.clone());

        let metadata = entry.metadata()?;
        let size = metadata.len();
        let mtime_ms = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64);

        let content = std::fs::read(path)?;
        let mut hasher = Sha256::new();
        hasher.update(&content);
        let hash = format!("{:x}", hasher.finalize());

        let is_changed = match current_files.get(&canonical) {
            Some(old_hash) => old_hash != &hash || refresh,
            None => true,
        };

        if is_changed {
            InvalidationEngine::invalidate_file(&db.conn, &canonical)?;
            let indexed_at = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64;

            let file_model = IndexedFile {
                canonical_path: canonical,
                content_hash: hash,
                size,
                mtime_ms,
                language: None, // Simplified for now
                indexed_at,
            };

            let tx = TransactionalGraph::new(&mut db.conn)?;
            tx.insert_file(&file_model)?;
            tx.commit()?;
            changed_count += 1;
        }
    }

    // Delete files that no longer exist
    for old_path in current_files.keys() {
        if !discovered.contains(old_path) {
            InvalidationEngine::delete_file(&db.conn, old_path)?;
            changed_count += 1;
        }
    }

    InvalidationEngine::delete_stale_edges(&db.conn)?;

    let total_files: i64 = db
        .conn
        .query_row("SELECT count(*) FROM files", [], |row| row.get(0))?;

    Ok(IndexStatus {
        files: total_files as usize,
        changed: changed_count,
    })
}
