use crate::intelligence::compatibility::{check_compatibility, CompatibilityStatus};
use crate::intelligence::db::EvidenceDatabase;
use crate::intelligence::snapshot::get_repository_snapshot;
use crate::protocol::GraphCompatibility;
use std::path::Path;

pub struct IndexStatusReport {
    pub state: String,
    pub generation: u64,
    pub reasons: Vec<String>,
    pub files: i32,
    pub nodes: i32,
    pub edges: i32,
    pub journal_mode: String,
    pub foreign_keys: bool,
    pub busy_timeout: i32,
    pub schema_version: u32,
}

pub fn evaluate_index_status(
    repo_root: &Path,
    db_result: Result<&EvidenceDatabase, &crate::intelligence::db::DatabaseError>,
    current_compatibility: &GraphCompatibility,
) -> IndexStatusReport {
    let db = match db_result {
        Ok(db) => db,
        Err(crate::intelligence::db::DatabaseError::NotIndexed) => {
            return IndexStatusReport {
                state: "absent".to_string(),
                generation: 0,
                reasons: vec![],
                files: 0,
                nodes: 0,
                edges: 0,
                journal_mode: "none".to_string(),
                foreign_keys: false,
                busy_timeout: 0,
                schema_version: 0,
            };
        }
        Err(e) => {
            return IndexStatusReport {
                state: "degraded".to_string(),
                generation: 0,
                reasons: vec![format!("Database open failed: {}", e)],
                files: 0,
                nodes: 0,
                edges: 0,
                journal_mode: "none".to_string(),
                foreign_keys: false,
                busy_timeout: 0,
                schema_version: 0,
            };
        }
    };

    let schema_version = db.get_schema_version().map(|v| v.version).unwrap_or(0);

    let mut reasons = Vec::new();
    let mut state = "fresh".to_string();

    // Check compatibility
    match check_compatibility(db, current_compatibility) {
        Ok(CompatibilityStatus::Compatible) => {}
        Ok(CompatibilityStatus::FutureSchema) => {
            state = "incompatible".to_string();
            reasons.push("future_schema".to_string());
        }
        Ok(CompatibilityStatus::MigrationRequired(_, _)) => {
            state = "stale".to_string();
            reasons.push("migration_required".to_string());
        }
        Ok(CompatibilityStatus::ProviderRefreshRequired) => {
            state = "stale".to_string();
            reasons.push("provider_refresh_required".to_string());
        }
        Ok(CompatibilityStatus::SemanticRebuildRequired) => {
            state = "stale".to_string();
            reasons.push("semantic_rebuild_required".to_string());
        }
        Ok(CompatibilityStatus::Incompatible) => {
            state = "incompatible".to_string();
            reasons.push("incompatible_schema".to_string());
        }
        Err(e) => {
            state = "degraded".to_string();
            reasons.push(format!("Compatibility check failed: {}", e));
        }
    }

    // Check last recorded status
    let recorded_status = db
        .get_metadata("status")
        .unwrap_or(Some("ABSENT".to_string()))
        .unwrap_or_else(|| "ABSENT".to_string());
    if recorded_status == "DEGRADED" {
        state = "degraded".to_string();
        reasons.push("previous_refresh_degraded".to_string());
    } else if recorded_status == "IN_PROGRESS" {
        state = "stale".to_string();
        reasons.push("previous_refresh_incomplete".to_string());
    } else if recorded_status == "ABSENT" {
        state = "absent".to_string();
    }

    // Check working tree snapshot
    let snapshot = get_repository_snapshot(repo_root);
    let stored_head = db.get_metadata("snapshot_head").unwrap_or(None);
    let stored_dirty = db.get_metadata("snapshot_dirty").unwrap_or(None);

    if snapshot.head != stored_head || Some(snapshot.dirty_fingerprint) != stored_dirty {
        state = "stale".to_string();
        reasons.push("working_tree_changed".to_string());
    }

    let generation = db
        .get_metadata("generation")
        .unwrap_or(None)
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let files: i32 = db
        .conn
        .query_row("SELECT count(*) FROM files", [], |r| r.get(0))
        .unwrap_or(0);
    let nodes: i32 = db
        .conn
        .query_row("SELECT count(*) FROM nodes", [], |r| r.get(0))
        .unwrap_or(0);
    let edges: i32 = db
        .conn
        .query_row("SELECT count(*) FROM edges", [], |r| r.get(0))
        .unwrap_or(0);

    let journal_mode: String = db
        .conn
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap_or_else(|_| "unknown".to_string());
    let fk_num: i32 = db
        .conn
        .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
        .unwrap_or(0);
    let foreign_keys = fk_num == 1;
    let busy_timeout: i32 = db
        .conn
        .query_row("PRAGMA busy_timeout", [], |r| r.get(0))
        .unwrap_or(0);

    IndexStatusReport {
        state,
        generation,
        reasons,
        files,
        nodes,
        edges,
        journal_mode,
        foreign_keys,
        busy_timeout,
        schema_version,
    }
}
