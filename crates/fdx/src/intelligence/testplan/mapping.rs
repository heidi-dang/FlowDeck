//! Test-to-code mapping resolution (semantic, structural, and fallback).

use crate::intelligence::build::snapshot::CurrentBuildSnapshot;
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
    pub stale: bool,
}

/// Retrieve test-to-code mapping edges from database and ephemeral current snapshot.
pub fn resolve_test_mappings(
    conn_opt: Option<&Connection>,
    _build_snapshot: &CurrentBuildSnapshot,
    inventory: &TestInventory,
) -> Vec<TestMappingEdge> {
    let mut mappings = Vec::new();
    let mut seen = HashSet::new();

    // 1. From database (SCIP references, explicit test relationships)
    if let Some(conn) = conn_opt {
        if let Ok(mut stmt) = conn.prepare(
            "SELECT from_node, to_node, kind, provider, strength, stale FROM edges WHERE from_node LIKE 'file:%' OR from_node LIKE 'test:%'",
        ) {
            if let Ok(rows) = stmt.query_map([], |row| {
                let from_n: String = row.get(0)?;
                let to_n: String = row.get(1)?;
                let kstr: String = row.get(2)?;
                let prov: String = row.get(3)?;
                let str_val: i64 = row.get(4)?;
                let stale: bool = row.get(5)?;
                Ok((from_n, to_n, kstr, prov, str_val, stale))
            }) {
                for item in rows.flatten() {
                    let (from_n, to_n, kstr, prov, str_val, stale) = item;
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
                        mappings.push(TestMappingEdge {
                            test_node: from_n,
                            target_node: to_n,
                            kind,
                            strength,
                            provider: prov,
                            stale,
                        });
                    }
                }
            }
        }
    }

    // 2. Structural mappings from discovered inventory & build snapshot
    for test in &inventory.tests {
        let test_file_node = format!("file:{}", test.canonical_path);

        // Package ownership structural mapping
        if let Some(ref pkg_id) = test.owning_package_id {
            let key = format!("{}->{}:BelongsTo", test.stable_id, pkg_id);
            if seen.insert(key) {
                mappings.push(TestMappingEdge {
                    test_node: test.stable_id.clone(),
                    target_node: pkg_id.clone(),
                    kind: EdgeKind::BelongsTo,
                    strength: EvidenceStrength::Structural,
                    provider: "build_native".to_string(),
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
                mappings.push(TestMappingEdge {
                    test_node: test_file_node.clone(),
                    target_node,
                    kind: EdgeKind::Tests,
                    strength: EvidenceStrength::Structural,
                    provider: "filename_convention".to_string(),
                    stale: false,
                });
            }
        } else if let Some(stem) = test.canonical_path.strip_suffix(".test.js") {
            let source_candidate = format!("{}.js", stem);
            let target_node = format!("file:{}", source_candidate);
            let key = format!("{}->{}:Tests", test_file_node, target_node);
            if seen.insert(key) {
                mappings.push(TestMappingEdge {
                    test_node: test_file_node.clone(),
                    target_node,
                    kind: EdgeKind::Tests,
                    strength: EvidenceStrength::Structural,
                    provider: "filename_convention".to_string(),
                    stale: false,
                });
            }
        }
    }

    mappings
}
