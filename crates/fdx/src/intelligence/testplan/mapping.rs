//! Test-to-code mapping resolution (semantic, structural, and fallback).

use crate::intelligence::build::snapshot::CurrentBuildSnapshot;
use crate::intelligence::testplan::bounds::{
    get_active_test_plan_limits, get_test_mapping_db_error,
};
use crate::intelligence::testplan::model::*;
use crate::protocol::{EdgeKind, EvidenceStrength};
use rusqlite::Connection;
use std::collections::HashSet;

#[derive(Debug, Clone)]
pub struct TestMappingEdge {
    pub test_node: String,
    pub target_node: String,
    pub kind: EdgeKind,
    pub strength: EvidenceStrength,
    pub provider: String,
    pub provider_id: String,
    pub provider_fingerprint: Option<String>,
    pub evidence_id: Option<String>,
    pub source_identity: Option<String>,
    pub stale: bool,
}

#[derive(Debug, Clone, Default)]
pub struct TestMappingResolution {
    pub mappings: Vec<TestMappingEdge>,
    pub truncated: bool,
    pub errors: Vec<String>,
}

/// Retrieve test-to-code mapping edges from database and ephemeral current snapshot.
pub fn resolve_test_mappings(
    conn_opt: Option<&Connection>,
    _build_snapshot: &CurrentBuildSnapshot,
    inventory: &TestInventory,
) -> TestMappingResolution {
    let limits = get_active_test_plan_limits();
    let mut resolution = TestMappingResolution::default();
    let mut seen = HashSet::new();

    if let Some(err) = get_test_mapping_db_error() {
        resolution.errors.push(err);
    }

    // Valid test paths and IDs from discovered inventory
    let discovered_test_paths: HashSet<&str> = inventory
        .tests
        .iter()
        .map(|t| t.canonical_path.as_str())
        .collect();

    let discovered_test_ids: HashSet<&str> = inventory
        .tests
        .iter()
        .map(|t| t.stable_id.as_str())
        .collect();

    // 1. From database (SCIP references, explicit test relationships)
    if let Some(conn) = conn_opt {
        // Fetch all persisted test nodes to validate test:* origins
        let mut persisted_test_nodes: HashSet<String> = HashSet::new();
        match conn
            .prepare("SELECT stable_id FROM nodes WHERE kind = 'test' OR stable_id LIKE 'test:%'")
        {
            Ok(mut stmt) => match stmt.query_map([], |row| row.get::<_, String>(0)) {
                Ok(rows) => {
                    for item_res in rows {
                        match item_res {
                            Ok(r) => {
                                persisted_test_nodes.insert(r);
                            }
                            Err(err) => {
                                resolution.errors.push(err.to_string());
                            }
                        }
                    }
                }
                Err(err) => {
                    resolution.errors.push(err.to_string());
                }
            },
            Err(err) => {
                resolution.errors.push(err.to_string());
            }
        }

        let query_sql = "SELECT stable_id, from_node, to_node, kind, provider, provider_id, provider_fingerprint, strength, source_identity, stale FROM edges WHERE from_node LIKE 'file:%' OR from_node LIKE 'test:%'";
        match conn.prepare(query_sql) {
            Ok(mut stmt) => {
                match stmt.query_map([], |row| {
                    let stable_id: Option<String> = row.get(0)?;
                    let from_n: String = row.get(1)?;
                    let to_n: String = row.get(2)?;
                    let kstr: String = row.get(3)?;
                    let prov: String = row.get(4)?;
                    let prov_id: Option<String> = row.get(5)?;
                    let prov_fp: Option<String> = row.get(6)?;
                    let str_val: i64 = row.get(7)?;
                    let src_id: Option<String> = row.get(8)?;
                    let stale: bool = row.get(9)?;
                    Ok((
                        stable_id, from_n, to_n, kstr, prov, prov_id, prov_fp, str_val, src_id,
                        stale,
                    ))
                }) {
                    Ok(rows) => {
                        for item_res in rows {
                            let item = match item_res {
                                Ok(it) => it,
                                Err(err) => {
                                    resolution.errors.push(err.to_string());
                                    continue;
                                }
                            };
                            let (
                                stable_id,
                                from_n,
                                to_n,
                                kstr,
                                prov,
                                prov_id,
                                prov_fp,
                                str_val,
                                src_id,
                                stale,
                            ) = item;

                            // Restrict mapping edges to actual discovered test identities or valid persisted test nodes
                            let is_valid_test = if from_n.starts_with("test:") {
                                discovered_test_ids.contains(from_n.as_str())
                                    || persisted_test_nodes.contains(&from_n)
                                    || if let Some(sub) = from_n.strip_prefix("test:npm:") {
                                        discovered_test_paths.contains(sub)
                                    } else if let Some(sub) = from_n.strip_prefix("test:cargo:") {
                                        discovered_test_paths.contains(sub)
                                    } else {
                                        false
                                    }
                            } else if let Some(stripped) = from_n.strip_prefix("file:") {
                                discovered_test_paths.contains(stripped)
                                    || discovered_test_ids.contains(from_n.as_str())
                            } else {
                                false
                            };

                            if !is_valid_test {
                                continue;
                            }

                            let strength = match str_val {
                                4 => EvidenceStrength::Precise,
                                3 => EvidenceStrength::Observed,
                                2 => EvidenceStrength::Structural,
                                1 => EvidenceStrength::Heuristic,
                                _ => EvidenceStrength::Unknown,
                            };
                            let kind = match kstr.as_str() {
                                "references" => EdgeKind::References,
                                "tests" => EdgeKind::Tests,
                                "imports" => EdgeKind::Imports,
                                "calls" => EdgeKind::Calls,
                                _ => continue,
                            };

                            let key = format!("{}->{}:{:?}", from_n, to_n, kind);
                            if seen.insert(key) {
                                if resolution.mappings.len() >= limits.max_mapping_edges {
                                    resolution.truncated = true;
                                    break;
                                }
                                resolution.mappings.push(TestMappingEdge {
                                    test_node: from_n,
                                    target_node: to_n,
                                    kind,
                                    strength,
                                    provider: prov.clone(),
                                    provider_id: prov_id.unwrap_or(prov),
                                    provider_fingerprint: prov_fp,
                                    evidence_id: stable_id,
                                    source_identity: src_id,
                                    stale,
                                });
                            }
                        }
                    }
                    Err(err) => {
                        resolution.errors.push(err.to_string());
                    }
                }
            }
            Err(err) => {
                resolution.errors.push(err.to_string());
            }
        }
    }

    // 2. Structural mappings from discovered inventory & build snapshot
    for test in &inventory.tests {
        if resolution.mappings.len() >= limits.max_mapping_edges {
            resolution.truncated = true;
            break;
        }
        let test_file_node = format!("file:{}", test.canonical_path);

        // Package ownership structural mapping
        if let Some(ref pkg_id) = test.owning_package_id {
            let key = format!("{}->{}:BelongsTo", test.stable_id, pkg_id);
            if seen.insert(key) {
                if resolution.mappings.len() >= limits.max_mapping_edges {
                    resolution.truncated = true;
                    break;
                }
                resolution.mappings.push(TestMappingEdge {
                    test_node: test.stable_id.clone(),
                    target_node: pkg_id.clone(),
                    kind: EdgeKind::BelongsTo,
                    strength: EvidenceStrength::Structural,
                    provider: "build_native".to_string(),
                    provider_id: "build_native".to_string(),
                    provider_fingerprint: None,
                    evidence_id: None,
                    source_identity: None,
                    stale: false,
                });
            }
        }

        // File-naming structural mapping: foo.test.ts -> foo.ts
        if let Some(stem) = test.canonical_path.strip_suffix(".test.ts") {
            let source_candidate = format!("{}.ts", stem);
            let target_node = format!("file:{}", source_candidate);
            let key = format!("{}->{}:Tests", test_file_node, target_node);
            if seen.insert(key) {
                if resolution.mappings.len() >= limits.max_mapping_edges {
                    resolution.truncated = true;
                    break;
                }
                resolution.mappings.push(TestMappingEdge {
                    test_node: test_file_node.clone(),
                    target_node,
                    kind: EdgeKind::Tests,
                    strength: EvidenceStrength::Structural,
                    provider: "filename_convention".to_string(),
                    provider_id: "filename_convention".to_string(),
                    provider_fingerprint: None,
                    evidence_id: None,
                    source_identity: None,
                    stale: false,
                });
            }
        } else if let Some(stem) = test.canonical_path.strip_suffix(".test.js") {
            let source_candidate = format!("{}.js", stem);
            let target_node = format!("file:{}", source_candidate);
            let key = format!("{}->{}:Tests", test_file_node, target_node);
            if seen.insert(key) {
                if resolution.mappings.len() >= limits.max_mapping_edges {
                    resolution.truncated = true;
                    break;
                }
                resolution.mappings.push(TestMappingEdge {
                    test_node: test_file_node.clone(),
                    target_node,
                    kind: EdgeKind::Tests,
                    strength: EvidenceStrength::Structural,
                    provider: "filename_convention".to_string(),
                    provider_id: "filename_convention".to_string(),
                    provider_fingerprint: None,
                    evidence_id: None,
                    source_identity: None,
                    stale: false,
                });
            }
        }
    }

    resolution
}
