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

const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024; // 10MB limit
const MAX_INDEXED_FILES: usize = 50000;
const MAX_TOTAL_INDEX_BYTES_PER_REFRESH: u64 = 5 * 1024 * 1024 * 1024; // 5GB limit

pub fn run_incremental_index(repo_root: &Path, refresh: bool) -> Result<IndexStatus, EngineError> {
    let mut db = EvidenceDatabase::open(
        repo_root,
        crate::intelligence::db::DatabaseOpenMode::ReadWrite,
    )?;

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
    let mut total_indexed_files = 0;
    let mut total_indexed_bytes = 0;
    let mut skipped_files = 0;
    let mut skip_reasons: std::collections::HashSet<&'static str> = std::collections::HashSet::new();

    let walker = WalkBuilder::new(repo_root)
        .hidden(true)
        .git_ignore(true)
        .require_git(false)
        .build();

    let gen: u64 = db
        .get_metadata("generation")
        .unwrap_or(None)
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let new_gen = gen + 1;

    // ONE BIG TRANSACTION for atomicity
    let tx = TransactionalGraph::new(&mut db.conn)?;

    // Update status to IN_PROGRESS so a crash is detectable
    tx.set_metadata("status", "IN_PROGRESS")?;

    let mut traversal_errors = 0;
    for result in walker {
        let entry = match result {
            Ok(e) => e,
            Err(_) => {
                traversal_errors += 1;
                continue;
            }
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

        if size > MAX_FILE_BYTES {
            skipped_files += 1;
            skip_reasons.insert("file_too_large");
            continue;
        }

        if total_indexed_files >= MAX_INDEXED_FILES {
            skipped_files += 1;
            skip_reasons.insert("file_limit_exceeded");
            continue;
        }

        if total_indexed_bytes + size > MAX_TOTAL_INDEX_BYTES_PER_REFRESH {
            skipped_files += 1;
            skip_reasons.insert("byte_budget_exceeded");
            continue;
        }

        let mut file = std::fs::File::open(path)?;
        let mut hasher = Sha256::new();
        std::io::copy(&mut file, &mut hasher)?;
        let hash = format!("{:x}", hasher.finalize());

        total_indexed_files += 1;
        total_indexed_bytes += size;

        let is_changed = match current_files.get(&canonical) {
            Some(old_hash) => old_hash != &hash || refresh,
            None => true,
        };

        if is_changed {
            InvalidationEngine::invalidate_file(&tx.tx, &canonical)?;
            let indexed_at = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64;

            let file_model = IndexedFile {
                canonical_path: canonical,
                content_hash: hash,
                size,
                mtime_ms,
                language: None,
                indexed_at,
            };

            tx.insert_file(&file_model)?;
            changed_count += 1;
        }
    }

    // Delete files that no longer exist, only if traversal was completely successful.
    // If there were traversal errors, we cannot be sure if a file was deleted or just inaccessible.
    if traversal_errors == 0 {
        for old_path in current_files.keys() {
            if !discovered.contains(old_path) {
                InvalidationEngine::delete_file(&tx.tx, old_path)?;
                changed_count += 1;
            }
        }
    }

    InvalidationEngine::delete_stale_edges(&tx.tx)?;

    if traversal_errors > 0 {
        tx.rollback()?;
        
        // Save diagnostic metadata using a separate short transaction
        // so we don't commit partial graph updates
        let err_msg = "Traversal errors occurred during indexing";
        
        let tx_err = TransactionalGraph::new(&mut db.conn)?;
        tx_err.set_metadata("status", "DEGRADED")?;
        tx_err.set_metadata("last_error", err_msg)?;
        tx_err.commit()?;
        
        return Err(EngineError::Io(std::io::Error::other(err_msg)));
    }

    // Commit generation and status
    if skipped_files > 0 {
        tx.set_metadata("status", "DEGRADED")?;
        let mut sorted_reasons: Vec<_> = skip_reasons.into_iter().collect();
        sorted_reasons.sort();
        let err_msg = format!("Skipped {} files due to: {}", skipped_files, sorted_reasons.join(","));
        tx.set_metadata("last_error", &err_msg)?;
    } else {
        tx.set_metadata("status", "FRESH")?;
        tx.set_metadata("last_error", "")?;
    }
    
    tx.set_metadata("generation", &new_gen.to_string())?;
    let now_ms = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    tx.set_metadata("last_successful_refresh_at", &now_ms.to_string())?;
    crate::intelligence::compatibility::persist_compatibility(
        &tx,
        &crate::protocol::GraphCompatibility::default(),
    )?;

    // Save snapshot
    let snapshot = crate::intelligence::snapshot::get_repository_snapshot(repo_root);
    if let Some(h) = snapshot.head {
        tx.set_metadata("snapshot_head", &h)?;
    }
    tx.set_metadata("snapshot_dirty", &snapshot.dirty_fingerprint)?;

    tx.commit()?;

    let total_files: i64 = db
        .conn
        .query_row("SELECT count(*) FROM files", [], |row| row.get(0))?;

    Ok(IndexStatus {
        files: total_files as usize,
        changed: changed_count,
    })
}