use crate::intelligence::db::EvidenceDatabase;
use crate::intelligence::index::TransactionalGraph;
use crate::intelligence::invalidation::InvalidationEngine;
use crate::intelligence::model::IndexedFile;
use crate::intelligence::status::IndexFreshness;
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

#[derive(Debug)]
pub struct IndexRunReport {
    pub state: IndexFreshness,
    pub files: usize,
    pub changed: usize,
    pub skipped: usize,
    pub reasons: Vec<String>,
    pub generation: u64,
}

const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_INDEXED_FILES: usize = 50000;
const MAX_TOTAL_INDEX_BYTES_PER_REFRESH: u64 = 5 * 1024 * 1024 * 1024;

pub fn run_incremental_index(
    repo_root: &Path,
    refresh: bool,
) -> Result<IndexRunReport, EngineError> {
    run_incremental_index_impl(repo_root, refresh, false)
}

#[doc(hidden)]
pub fn run_incremental_index_with_fault_injection(
    repo_root: &Path,
    refresh: bool,
    inject_traversal_error: bool,
) -> Result<IndexRunReport, EngineError> {
    run_incremental_index_impl(repo_root, refresh, inject_traversal_error)
}

fn run_incremental_index_impl(
    repo_root: &Path,
    refresh: bool,
    inject_traversal_error: bool,
) -> Result<IndexRunReport, EngineError> {
    let mut db = EvidenceDatabase::open(
        repo_root,
        crate::intelligence::db::DatabaseOpenMode::ReadWrite,
    )?;

    let gen: u64 = db
        .get_metadata("generation")
        .unwrap_or(None)
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let new_gen = gen + 1;

    // Enforce stored GraphCompatibility BEFORE indexing, but only when a
    // prior index exists. A pristine database (never indexed) has no
    // evidence that could be stale; the first index establishes the contract.
    let existing_files: i64 = db
        .conn
        .query_row("SELECT count(*) FROM files", [], |row| row.get(0))?;
    let prior_indexed = gen > 0 || existing_files > 0;

    let current_compat = crate::protocol::GraphCompatibility::default();
    let mut compat_blocked = false;
    let mut compat_reason = String::new();
    if prior_indexed {
        match crate::intelligence::compatibility::check_compatibility(&db, &current_compat)? {
            crate::intelligence::compatibility::CompatibilityStatus::Compatible => {}
            crate::intelligence::compatibility::CompatibilityStatus::ProviderRefreshRequired => {
                let tx = TransactionalGraph::new(&mut db.conn)?;
                tx.tx.execute(
                    "DELETE FROM edges WHERE provider_fingerprint != ?1",
                    rusqlite::params![current_compat.provider_fingerprint],
                )?;
                tx.tx.execute(
                    "DELETE FROM provider_state WHERE fingerprint != ?1",
                    rusqlite::params![current_compat.provider_fingerprint],
                )?;
                tx.commit()?;
                compat_blocked = true;
                compat_reason = "provider_refresh_required".to_string();
            }
            crate::intelligence::compatibility::CompatibilityStatus::SemanticRebuildRequired => {
                let tx = TransactionalGraph::new(&mut db.conn)?;
                tx.tx.execute("DELETE FROM edges", [])?;
                tx.tx.execute("DELETE FROM nodes", [])?;
                tx.commit()?;
                compat_blocked = true;
                compat_reason = "semantic_rebuild_required".to_string();
            }
            crate::intelligence::compatibility::CompatibilityStatus::MigrationRequired(_, _) => {}
            crate::intelligence::compatibility::CompatibilityStatus::FutureSchema
            | crate::intelligence::compatibility::CompatibilityStatus::Incompatible => {
                return Err(EngineError::Io(std::io::Error::other(
                    "Database schema is incompatible or from the future",
                )));
            }
        }
    }

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
    let mut changed_paths: Vec<String> = Vec::new();
    let mut changed_count = 0;
    let mut total_indexed_files = 0;
    let mut total_indexed_bytes = 0;
    let mut skipped_files = 0;
    let mut skip_reasons: std::collections::HashSet<&'static str> =
        std::collections::HashSet::new();

    let walker = WalkBuilder::new(repo_root)
        .hidden(true)
        .git_ignore(true)
        .require_git(false)
        .build();

    let tx = TransactionalGraph::new(&mut db.conn)?;

    tx.set_metadata("status", "IN_PROGRESS")?;

    let mut traversal_errors = 0;
    if inject_traversal_error {
        traversal_errors += 1;
    }
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
            changed_paths.push(canonical.clone());
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

    if traversal_errors == 0 {
        for old_path in current_files.keys() {
            if !discovered.contains(old_path) {
                InvalidationEngine::delete_file(&tx.tx, old_path)?;
                changed_paths.push(old_path.clone());
                changed_count += 1;
            }
        }
    }

    InvalidationEngine::delete_stale_edges(&tx.tx)?;

    // Semantic freshness: any file that changed makes scoped providers stale
    // inside the same transaction, so a changed source is never presented as
    // semantically fresh. Provider evidence itself is preserved (stale), and
    // only a provider refresh replaces it transactionally.
    for canonical in &changed_paths {
        let _ = crate::intelligence::semantic::state::mark_providers_stale_for_path(
            &tx.tx, None, canonical,
        );
    }

    if traversal_errors > 0 {
        tx.rollback()?;

        let err_msg = "Traversal errors occurred during indexing";

        let tx_err = TransactionalGraph::new(&mut db.conn)?;
        tx_err.set_metadata("status", "DEGRADED")?;
        tx_err.set_metadata("last_error", err_msg)?;
        tx_err.commit()?;

        return Err(EngineError::Io(std::io::Error::other(err_msg)));
    }

    let mut reasons = Vec::new();
    let mut state = IndexFreshness::Fresh;
    if skipped_files > 0 {
        state = IndexFreshness::Degraded;
        for reason in &skip_reasons {
            reasons.push(reason.to_string());
        }
    }
    if compat_blocked {
        state = IndexFreshness::Degraded;
        reasons.push(compat_reason.clone());
    }

    if state == IndexFreshness::Degraded {
        if !reasons.is_empty() {
            tx.set_metadata("last_error", &reasons.join(","))?;
        }
    } else {
        tx.set_metadata("last_error", "")?;
    }
    tx.set_metadata("status", state.as_status_str())?;

    tx.set_metadata("generation", &new_gen.to_string())?;
    let now_ms = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    tx.set_metadata("last_successful_refresh_at", &now_ms.to_string())?;

    if !compat_blocked {
        crate::intelligence::compatibility::persist_compatibility(&tx, &current_compat)?;
    }

    if let Ok(snapshot) = crate::intelligence::snapshot::get_repository_snapshot(repo_root) {
        if let Some(h) = snapshot.head {
            tx.set_metadata("snapshot_head", &h)?;
        }
        tx.set_metadata("snapshot_dirty", &snapshot.dirty_fingerprint)?;
    }

    tx.commit()?;

    let total_files: i64 = db
        .conn
        .query_row("SELECT count(*) FROM files", [], |row| row.get(0))?;

    Ok(IndexRunReport {
        state,
        files: total_files as usize,
        changed: changed_count,
        skipped: skipped_files,
        reasons,
        generation: new_gen,
    })
}
