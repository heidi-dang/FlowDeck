//! Transactional publication of build and configuration evidence.

use crate::intelligence::build::freshness::get_build_providers;
use crate::intelligence::build::provider::BuildIngestResult;
use crate::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use crate::intelligence::index::TransactionalGraph;
use crate::intelligence::model::{GraphEdge, IndexedFile};
use crate::protocol::EvidenceProviderKind;
use std::path::Path;

#[derive(Debug, Clone)]
pub struct BuildIngestReport {
    pub provider_id: String,
    pub nodes: usize,
    pub edges: usize,
    pub generation: u64,
    pub failure_reason: Option<String>,
}

/// Refresh all active build/config providers in an atomic transaction per provider.
pub fn refresh_all_build_providers(
    repo_root: &Path,
    _force: bool,
) -> Result<Vec<BuildIngestReport>, String> {
    let mut db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadWrite)
        .map_err(|e| format!("cannot open database: {}", e))?;

    let providers = get_build_providers();
    let mut reports = Vec::new();

    for prov in providers {
        if !prov.detect(repo_root) {
            continue;
        }

        let pid = prov.id();
        let ingest_res = prov.ingest(repo_root);

        let report = match ingest_res {
            Ok(result) => match publish_provider_evidence(&mut db, pid, &result) {
                Ok((nodes_cnt, edges_cnt, gen)) => BuildIngestReport {
                    provider_id: pid.to_string(),
                    nodes: nodes_cnt,
                    edges: edges_cnt,
                    generation: gen,
                    failure_reason: None,
                },
                Err(e) => BuildIngestReport {
                    provider_id: pid.to_string(),
                    nodes: 0,
                    edges: 0,
                    generation: 0,
                    failure_reason: Some(e),
                },
            },
            Err(e) => BuildIngestReport {
                provider_id: pid.to_string(),
                nodes: 0,
                edges: 0,
                generation: 0,
                failure_reason: Some(e),
            },
        };

        reports.push(report);
    }

    Ok(reports)
}

fn publish_provider_evidence(
    db: &mut EvidenceDatabase,
    provider_id: &str,
    result: &BuildIngestResult,
) -> Result<(usize, usize, u64), String> {
    let tx = TransactionalGraph::new(&mut db.conn).map_err(|e| e.to_string())?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    // Determine generation
    let prev_gen: i64 = tx
        .tx
        .query_row(
            "SELECT semantic_generation FROM semantic_providers WHERE provider_id = ?1",
            rusqlite::params![provider_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let next_gen = (prev_gen + 1) as u64;

    // 1. Delete previous edges owned by this provider
    tx.tx
        .execute(
            "DELETE FROM edges WHERE provider_id = ?1",
            rusqlite::params![provider_id],
        )
        .map_err(|e| e.to_string())?;

    // 2. Insert/upsert files for Foreign Key constraints
    for node in &result.nodes {
        if let Some(ref cpath) = node.canonical_path {
            let ifile = IndexedFile {
                canonical_path: cpath.clone(),
                content_hash: "build_native".to_string(),
                size: 0,
                mtime_ms: Some(now as u64),
                language: None,
                indexed_at: now as u64,
            };
            tx.upsert_file_row(&ifile).map_err(|e| e.to_string())?;
        }
    }

    // 3. Insert provider-owned build nodes
    for node in &result.nodes {
        let snode = crate::intelligence::model::SemanticNode {
            stable_id: node.stable_id.clone(),
            kind: node.kind,
            canonical_path: node.canonical_path.clone(),
            symbol_identity: None,
            package_identity: None,
            metadata: node.metadata.clone(),
            provider: "build_native".to_string(),
            provider_fingerprint: result.fingerprint.clone(),
            generation: next_gen,
            source_identity: Some(provider_id.to_string()),
            source_hash: None,
        };
        tx.insert_semantic_node(&snode).map_err(|e| e.to_string())?;
    }

    // 4. Ensure all referenced from_node / to_node exist in nodes
    for edge in &result.edges {
        tx.tx.execute(
            "INSERT OR IGNORE INTO nodes (stable_id, kind, canonical_path) VALUES (?1, 'package', NULL)",
            rusqlite::params![edge.from_node],
        ).map_err(|e| e.to_string())?;
        tx.tx.execute(
            "INSERT OR IGNORE INTO nodes (stable_id, kind, canonical_path) VALUES (?1, 'package', NULL)",
            rusqlite::params![edge.to_node],
        ).map_err(|e| e.to_string())?;
    }

    // 5. Insert edges
    for edge in &result.edges {
        let gedge = GraphEdge {
            stable_id: edge.stable_id.clone(),
            from_node: edge.from_node.clone(),
            to_node: edge.to_node.clone(),
            kind: edge.kind,
            provider: EvidenceProviderKind::BuildNative,
            provider_id: Some(provider_id.to_string()),
            provider_fingerprint: edge.provider_fingerprint.clone(),
            strength: edge.strength,
            source_identity: Some(provider_id.to_string()),
            source_hash: None,
            created_revision: next_gen,
            updated_revision: next_gen,
            stale: false,
        };
        tx.insert_edge(&gedge).map_err(|e| e.to_string())?;
    }

    // 5. Update provider state in semantic_providers
    tx.tx.execute(
        "INSERT INTO semantic_providers (
            provider_id, provider_type, provider_version, executable_identity,
            scip_schema_version, languages, workspace_root, package,
            config_fingerprint, input_fingerprint, last_successful_run, health,
            freshness, output_digest, failure_reason, semantic_generation,
            created_at, updated_at,
            last_attempt_fingerprint, last_attempt_at, last_attempt_health, last_attempt_failure_reason
         ) VALUES (?1, 'build_native', '1.0.0', 'builtin', 'n/a', '[]', '.', NULL,
                   ?2, ?2, ?3, 'available', 'fresh', NULL, NULL, ?4, ?3, ?3, ?2, ?3, 'available', NULL)
         ON CONFLICT(provider_id) DO UPDATE SET
            input_fingerprint = excluded.input_fingerprint,
            config_fingerprint = excluded.config_fingerprint,
            last_successful_run = excluded.last_successful_run,
            health = 'available',
            freshness = 'fresh',
            failure_reason = NULL,
            semantic_generation = excluded.semantic_generation,
            updated_at = excluded.updated_at,
            last_attempt_fingerprint = excluded.last_attempt_fingerprint,
            last_attempt_at = excluded.last_attempt_at,
            last_attempt_health = excluded.last_attempt_health,
            last_attempt_failure_reason = NULL",
        rusqlite::params![provider_id, result.fingerprint, now, next_gen as i64],
    ).map_err(|e| e.to_string())?;

    tx.tx.commit().map_err(|e| e.to_string())?;

    Ok((result.nodes.len(), result.edges.len(), next_gen))
}
