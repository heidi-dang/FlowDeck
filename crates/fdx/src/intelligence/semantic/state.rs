//! Persistence of provider state in the EvidenceGraph (schema v2).
//!
//! Provider state is typed, not an opaque blob: every component needed for
//! diagnostics and selective invalidation is a column
//! (semantic_providers table).

use crate::intelligence::db::EvidenceDatabase;
use crate::intelligence::index::TransactionalGraph;
use crate::intelligence::semantic::health::{ProviderFreshness, ProviderHealth};
use crate::intelligence::semantic::provider::{
    now_ms, ProviderFingerprint, ProviderIdentity, ProviderScope, ProviderState, ProviderType,
};
use crate::intelligence::semantic::LanguageId;
use rusqlite::Connection;
use std::path::Path;

/// Serialize languages to the persisted JSON array of string ids.
fn languages_to_json(langs: &[LanguageId]) -> String {
    let ids: Vec<String> = langs.iter().map(|l| l.as_str().to_string()).collect();
    serde_json::to_string(&ids).unwrap_or_else(|_| "[]".to_string())
}

fn languages_from_json(s: &str) -> Vec<LanguageId> {
    serde_json::from_str::<Vec<String>>(s)
        .unwrap_or_default()
        .iter()
        .filter_map(|id| LanguageId::from_str_opt(id))
        .collect()
}

/// Insert or update a provider state row inside an open transaction.
pub fn upsert_provider_state(
    tx: &TransactionalGraph,
    state: &ProviderState,
) -> Result<(), crate::intelligence::index::IndexError> {
    let provider_type = state.identity.provider_type.as_str();
    let now = now_ms() as i64;
    let languages = languages_to_json(&state.scope.languages);
    tx.tx.execute(
        "INSERT INTO semantic_providers (
            provider_id, provider_type, provider_version, executable_identity,
            scip_schema_version, languages, workspace_root, package,
            config_fingerprint, input_fingerprint, last_successful_run, health,
            freshness, output_digest, failure_reason, semantic_generation,
            created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?17)
         ON CONFLICT(provider_id) DO UPDATE SET
            provider_type = excluded.provider_type,
            provider_version = excluded.provider_version,
            executable_identity = excluded.executable_identity,
            scip_schema_version = excluded.scip_schema_version,
            languages = excluded.languages,
            workspace_root = excluded.workspace_root,
            package = excluded.package,
            config_fingerprint = excluded.config_fingerprint,
            input_fingerprint = excluded.input_fingerprint,
            last_successful_run = excluded.last_successful_run,
            health = excluded.health,
            freshness = excluded.freshness,
            output_digest = excluded.output_digest,
            failure_reason = excluded.failure_reason,
            semantic_generation = excluded.semantic_generation,
            updated_at = excluded.updated_at",
        rusqlite::params![
            state.provider_id(),
            provider_type,
            state.identity.provider_version,
            state.identity.executable_identity,
            state.identity.scip_schema_version,
            languages,
            state.scope.workspace_root,
            state.scope.package,
            state.fingerprint.config_fingerprint,
            state.fingerprint.digest,
            state.last_successful_run.map(|v| v as i64),
            state.health.as_str(),
            state.freshness.as_str(),
            state.output_digest,
            state.failure_reason,
            state.semantic_generation as i64,
            now,
        ],
    )?;
    Ok(())
}

fn row_to_state(row: &rusqlite::Row) -> Result<ProviderState, rusqlite::Error> {
    let provider_id: String = row.get(0)?;
    let provider_type: String = row.get(1)?;
    let provider_version: String = row.get(2)?;
    let executable_identity: String = row.get(3)?;
    let scip_schema_version: String = row.get(4)?;
    let languages: String = row.get(5)?;
    let workspace_root: String = row.get(6)?;
    let package: Option<String> = row.get(7)?;
    let config_fingerprint: String = row.get(8)?;
    let input_fingerprint: String = row.get(9)?;
    let last_successful_run: Option<i64> = row.get(10)?;
    let health: String = row.get(11)?;
    let freshness: String = row.get(12)?;
    let output_digest: Option<String> = row.get(13)?;
    let failure_reason: Option<String> = row.get(14)?;
    let semantic_generation: i64 = row.get(15)?;

    Ok(ProviderState {
        identity: ProviderIdentity {
            provider_id,
            provider_type: ProviderType::from_str_opt(&provider_type).unwrap_or(ProviderType::Scip),
            provider_version: provider_version.clone(),
            executable_identity: executable_identity.clone(),
            scip_schema_version: scip_schema_version.clone(),
        },
        scope: ProviderScope {
            workspace_root,
            package,
            languages: languages_from_json(&languages),
        },
        fingerprint: ProviderFingerprint {
            provider_version,
            executable_identity,
            scip_schema_version,
            compiler_version: None,
            config_fingerprint,
            digest: input_fingerprint,
        },
        health: ProviderHealth::from_str_opt(&health).unwrap_or(ProviderHealth::Failed),
        freshness: ProviderFreshness::from_str_opt(&freshness)
            .unwrap_or(ProviderFreshness::Unknown),
        last_successful_run: last_successful_run.map(|v| v as u64),
        output_digest,
        failure_reason,
        semantic_generation: semantic_generation as u64,
    })
}

const PROVIDER_COLUMNS: &str = "provider_id, provider_type, provider_version, executable_identity,
    scip_schema_version, languages, workspace_root, package, config_fingerprint,
    input_fingerprint, last_successful_run, health, freshness, output_digest,
    failure_reason, semantic_generation";

/// Load all persisted provider states.
pub fn load_provider_states(
    db: &EvidenceDatabase,
) -> Result<Vec<ProviderState>, crate::intelligence::db::DatabaseError> {
    let mut stmt = db.conn.prepare(&format!(
        "SELECT {} FROM semantic_providers",
        PROVIDER_COLUMNS
    ))?;
    let rows = stmt.query_map([], row_to_state)?;
    let mut states = Vec::new();
    for r in rows.flatten() {
        states.push(r);
    }
    Ok(states)
}

/// Load one persisted provider state.
pub fn load_provider_state(
    db: &EvidenceDatabase,
    provider_id: &str,
) -> Result<Option<ProviderState>, crate::intelligence::db::DatabaseError> {
    let mut stmt = db.conn.prepare(&format!(
        "SELECT {} FROM semantic_providers WHERE provider_id = ?1",
        PROVIDER_COLUMNS
    ))?;
    let mut rows = stmt.query_map(rusqlite::params![provider_id], row_to_state)?;
    if let Some(row) = rows.next() {
        Ok(Some(row?))
    } else {
        Ok(None)
    }
}

/// Mark providers whose scope covers a canonical path stale. Called inside an
/// index transaction when a file changes, so a changed source is never
/// presented as semantically fresh.
pub fn mark_providers_stale_for_path(
    conn: &Connection,
    provider_id_filter: Option<&str>,
    canonical_path: &str,
) -> Result<usize, rusqlite::Error> {
    let rows: Vec<(String, String, Option<String>, String)> = {
        let mut stmt = conn.prepare(
            "SELECT provider_id, workspace_root, package, languages
             FROM semantic_providers WHERE freshness = 'fresh'",
        )?;
        let mapped = stmt.query_map([], |row| {
            let id: String = row.get(0)?;
            let root: String = row.get(1)?;
            let pkg: Option<String> = row.get(2)?;
            let langs: String = row.get(3)?;
            Ok((id, root, pkg, langs))
        })?;
        mapped.flatten().collect()
    };
    let mut updated = 0usize;
    for (id, root, pkg, langs) in rows {
        if let Some(filter) = provider_id_filter {
            if filter != id {
                continue;
            }
        }
        let scope = ProviderScope {
            workspace_root: root,
            package: pkg,
            languages: languages_from_json(&langs),
        };
        if scope.covers(canonical_path) {
            conn.execute(
                "UPDATE semantic_providers SET freshness = 'stale', updated_at = ?2
                 WHERE provider_id = ?1 AND freshness = 'fresh'",
                rusqlite::params![id, now_ms() as i64],
            )?;
            updated += 1;
        }
    }
    Ok(updated)
}

/// Count provider-owned nodes and edges (for status/diagnostics).
pub fn count_semantic_evidence(
    db: &EvidenceDatabase,
) -> Result<(i64, i64), crate::intelligence::db::DatabaseError> {
    let nodes: i64 = db.conn.query_row(
        "SELECT count(*) FROM nodes WHERE provider IS NOT NULL AND stale = 0",
        [],
        |r| r.get(0),
    )?;
    let edges: i64 = db.conn.query_row(
        "SELECT count(*) FROM edges WHERE provider = 'scip' AND stale = 0",
        [],
        |r| r.get(0),
    )?;
    Ok((nodes, edges))
}

/// PLACEHOLDERNOTHING (removes ownership state; evidence rows are
/// removed via replace_provider_evidence on the next refresh or explicitly).
pub fn delete_provider_state(
    tx: &TransactionalGraph,
    provider_id: &str,
) -> Result<(), crate::intelligence::index::IndexError> {
    tx.tx.execute(
        "DELETE FROM semantic_providers WHERE provider_id = ?1",
        rusqlite::params![provider_id],
    )?;
    Ok(())
}

/// Recompute each provider fingerprint on disk and mark rows stale whose
/// semantic inputs changed (configs, executable identity/version). Called by
/// status and reference queries so freshness responds to relevant config
/// changes without a refresh.
pub fn reconcile_provider_freshness(
    repo_root: &Path,
    registry: &crate::intelligence::semantic::registry::ProviderRegistry,
    db: &EvidenceDatabase,
) -> Result<usize, String> {
    let mut changed = 0usize;
    let states = load_provider_states(db).map_err(|e| e.to_string())?;
    for state in &states {
        if state.freshness != ProviderFreshness::Fresh {
            continue;
        }
        let Some(provider) = registry.by_id(state.provider_id()) else {
            continue;
        };
        let fingerprint = match provider.fingerprint(repo_root) {
            Ok(f) => f,
            Err(_) => {
                // Provider no longer resolvable (executable gone): stale.
                mark_stale_by_id(db, state.provider_id())?;
                changed += 1;
                continue;
            }
        };
        if fingerprint.digest != state.fingerprint.digest {
            mark_stale_by_id(db, state.provider_id())?;
            changed += 1;
        }
    }
    Ok(changed)
}

fn mark_stale_by_id(db: &EvidenceDatabase, provider_id: &str) -> Result<(), String> {
    db.conn
        .execute(
            "UPDATE semantic_providers SET freshness = 'stale', updated_at = ?2
             WHERE provider_id = ?1 AND freshness = 'fresh'",
            rusqlite::params![provider_id, now_ms() as i64],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}
