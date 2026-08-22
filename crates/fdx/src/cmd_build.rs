//! fdx build CLI operations (status, refresh, graph).

use crate::intelligence::build::freshness::evaluate_build_freshness;
use crate::intelligence::build::ingest::refresh_all_build_providers;
use crate::intelligence::db::{DatabaseError, DatabaseOpenMode, EvidenceDatabase};
use std::path::Path;

pub fn build_status(repo_root: &Path) -> Result<String, String> {
    let states = evaluate_build_freshness(repo_root)?;
    let mut out = String::new();

    let db_opt = match EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly) {
        Ok(d) => Some(d),
        Err(DatabaseError::NotIndexed) => None,
        Err(e) => return Err(format!("cannot open evidence database: {}", e)),
    };

    let (nodes_count, edges_count) = if let Some(ref db) = db_opt {
        let n: i64 = db
            .conn
            .query_row(
                "SELECT count(*) FROM nodes WHERE provider = 'build_native'",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let e: i64 = db
            .conn
            .query_row(
                "SELECT count(*) FROM edges WHERE provider = 'build_native'",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        (n as usize, e as usize)
    } else {
        (0, 0)
    };

    for s in &states {
        out.push_str(&format!("provider={}\n", s.provider_id));
        out.push_str(&format!("  type={}\n", s.provider_type));
        out.push_str(&format!("  version={}\n", s.provider_version));
        out.push_str(&format!("  health={}\n", s.health.as_str()));
        out.push_str(&format!("  freshness={}\n", s.freshness.as_str()));
        out.push_str(&format!("  fingerprint={}\n", s.fingerprint));
        out.push_str(&format!("  workspace_root={}\n", s.workspace_root));
        out.push_str(&format!("  generation={}\n", s.generation));
        out.push_str(&format!(
            "  last_success={}\n",
            s.last_successful_run
                .map(|v| v.to_string())
                .unwrap_or_else(|| "none".to_string())
        ));
    }

    if states.is_empty() {
        out.push_str("BUILD no providers\n");
    } else {
        out.push_str(&format!(
            "BUILD providers={} nodes={} edges={}\n",
            states.len(),
            nodes_count,
            edges_count
        ));
    }

    Ok(out)
}

pub fn build_refresh(repo_root: &Path) -> Result<(String, bool), String> {
    let reports = refresh_all_build_providers(repo_root, false)?;
    let mut out = String::new();
    let mut any_failure = false;

    for r in &reports {
        if let Some(ref err) = r.failure_reason {
            any_failure = true;
            out.push_str(&format!(
                "REFRESH provider={} FAILED: {}\n",
                r.provider_id, err
            ));
        } else {
            out.push_str(&format!(
                "REFRESH provider={} ok nodes={} edges={} gen={}\n",
                r.provider_id, r.nodes, r.edges, r.generation
            ));
        }
    }

    Ok((out, any_failure))
}

pub fn build_graph_json(repo_root: &Path) -> Result<String, String> {
    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly)
        .map_err(|e| format!("cannot open database: {}", e))?;

    let mut nodes = Vec::new();
    if let Ok(mut stmt) = db.conn.prepare(
        "SELECT stable_id, kind, canonical_path, metadata FROM nodes WHERE provider = 'build_native'"
    ) {
        if let Ok(rows) = stmt.query_map([], |row| {
            let sid: String = row.get(0)?;
            let kind: String = row.get(1)?;
            let cpath: Option<String> = row.get(2)?;
            let meta: Option<String> = row.get(3)?;
            Ok(serde_json::json!({
                "stable_id": sid,
                "kind": kind,
                "canonical_path": cpath,
                "metadata": meta,
            }))
        }) {
            for item in rows.flatten() {
                nodes.push(item);
            }
        }
    }

    let mut edges = Vec::new();
    if let Ok(mut stmt) = db.conn.prepare(
        "SELECT stable_id, from_node, to_node, kind, provider_id, strength FROM edges WHERE provider = 'build_native'"
    ) {
        if let Ok(rows) = stmt.query_map([], |row| {
            let sid: String = row.get(0)?;
            let from_n: String = row.get(1)?;
            let to_n: String = row.get(2)?;
            let kind: String = row.get(3)?;
            let pid: Option<String> = row.get(4)?;
            let str_val: i64 = row.get(5)?;
            Ok(serde_json::json!({
                "stable_id": sid,
                "from_node": from_n,
                "to_node": to_n,
                "kind": kind,
                "provider_id": pid,
                "strength": str_val,
            }))
        }) {
            for item in rows.flatten() {
                edges.push(item);
            }
        }
    }

    let value = serde_json::json!({
        "nodes": nodes,
        "edges": edges,
    });

    serde_json::to_string_pretty(&value).map_err(|e| e.to_string())
}
