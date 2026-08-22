//! Seed generation from semantic changes for graph traversal.

use crate::intelligence::change::model::{SemanticChange, SemanticChangeKind};
use crate::intelligence::change::uncertainty::{minimum_evidence_strength, UncertaintyReason};
use crate::protocol::{AssuranceLevel, EvidenceStrength};
use rusqlite::Connection;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImpactSeed {
    pub seed_node: String,
    pub canonical_path: String,
    pub change_id: String,
    pub symbol: Option<String>,
    pub strength: EvidenceStrength,
    pub assurance: AssuranceLevel,
    pub widening_reason: Option<UncertaintyReason>,
}

/// Query database for canonical M3 SCIP or structural node IDs associated with a file/symbol.
pub fn find_node_ids_for_symbol(
    conn: &Connection,
    canonical_path: &str,
    symbol_name: &str,
) -> (Vec<String>, Option<UncertaintyReason>) {
    let mut matching_node_ids = Vec::new();

    let mut stmt = conn
        .prepare(
            "SELECT stable_id, symbol_identity, metadata FROM nodes
             WHERE canonical_path = ?1 AND kind = 'symbol'",
        )
        .ok();

    if let Some(ref mut stmt) = stmt {
        let rows = stmt
            .query_map(rusqlite::params![canonical_path], |row| {
                let sid: String = row.get(0)?;
                let sym_ident: Option<String> = row.get(1)?;
                let meta: Option<String> = row.get(2)?;
                Ok((sid, sym_ident, meta))
            })
            .ok();

        if let Some(rows) = rows {
            for item in rows.flatten() {
                let (sid, sym_ident, meta) = item;
                let mut matched = false;

                // 1. Check metadata display_name
                if let Some(ref m) = meta {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(m) {
                        if val.get("display_name").and_then(|d| d.as_str()) == Some(symbol_name) {
                            matched = true;
                        }
                    }
                }

                // 2. Check exact symbol_identity or stable_id match
                if !matched {
                    if let Some(ref ident) = sym_ident {
                        if ident == symbol_name
                            || ident.ends_with(&format!("/{}().", symbol_name))
                            || ident.ends_with(&format!("/{}#.", symbol_name))
                            || ident.ends_with(&format!("/{}#", symbol_name))
                            || ident.ends_with(&format!("/{}", symbol_name))
                            || ident.ends_with(&format!(" {}().", symbol_name))
                            || ident.ends_with(&format!(" {}#.", symbol_name))
                            || ident.ends_with(&format!(" {}.", symbol_name))
                        {
                            matched = true;
                        }
                    }
                }

                if !matched && sid == format!("sym:{}:{}", canonical_path, symbol_name) {
                    matched = true;
                }

                if matched {
                    matching_node_ids.push(sid);
                }
            }
        }
    }

    if matching_node_ids.len() > 1 {
        let reason = UncertaintyReason::AmbiguousSymbol(format!(
            "Multiple symbol matches for {} in {}",
            symbol_name, canonical_path
        ));
        (matching_node_ids, Some(reason))
    } else if matching_node_ids.len() == 1 {
        (matching_node_ids, None)
    } else {
        // Fallback structural identity
        let fallback = format!("sym:{}:{}", canonical_path, symbol_name);
        (vec![fallback], None)
    }
}

/// Find all build, config, and package nodes associated with a file path.
pub fn find_build_nodes_for_file(conn: &Connection, canonical_path: &str) -> Vec<String> {
    let mut matching = Vec::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT stable_id FROM nodes WHERE canonical_path = ?1 AND kind IN ('config', 'package', 'build_target', 'workspace')"
    ) {
        if let Ok(rows) = stmt.query_map(rusqlite::params![canonical_path], |r| r.get(0)) {
            for id in rows.flatten() {
                matching.push(id);
            }
        }
    }
    let config_id = format!("config:{}", canonical_path);
    if !matching.contains(&config_id) {
        matching.push(config_id);
    }
    matching
}

/// Find all symbol nodes defined in a file from previous index (for deletions).
pub fn find_prior_symbol_nodes_for_file(conn: &Connection, canonical_path: &str) -> Vec<String> {
    let mut node_ids = Vec::new();
    if let Ok(mut stmt) = conn.prepare("SELECT stable_id FROM nodes WHERE canonical_path = ?1") {
        if let Ok(rows) = stmt.query_map(rusqlite::params![canonical_path], |row| row.get(0)) {
            for id in rows.flatten() {
                node_ids.push(id);
            }
        }
    }
    node_ids
}

/// Generate impact seeds from a SemanticChange, resolving graph node identities when DB is present.
pub fn generate_impact_seeds(
    change: &SemanticChange,
    conn: Option<&Connection>,
) -> Vec<ImpactSeed> {
    let mut seeds = Vec::new();
    let file_node = format!("file:{}", change.file);
    let seed_strength = minimum_evidence_strength(&change.evidence);
    let seed_assurance = change.assurance;

    if let Some(ref sym) = change.symbol {
        let (node_ids, ambiguity) = if let Some(c) = conn {
            find_node_ids_for_symbol(c, &change.file, sym)
        } else {
            (vec![format!("sym:{}:{}", change.file, sym)], None)
        };

        for nid in node_ids {
            seeds.push(ImpactSeed {
                seed_node: nid,
                canonical_path: change.file.clone(),
                change_id: change.id.clone(),
                symbol: Some(sym.clone()),
                strength: seed_strength,
                assurance: seed_assurance,
                widening_reason: ambiguity.clone(),
            });
        }

        // Also include owning file node as a seed
        seeds.push(ImpactSeed {
            seed_node: file_node,
            canonical_path: change.file.clone(),
            change_id: change.id.clone(),
            symbol: None,
            strength: seed_strength,
            assurance: seed_assurance,
            widening_reason: None,
        });
    } else {
        match change.change_kind {
            SemanticChangeKind::FileDeleted => {
                seeds.push(ImpactSeed {
                    seed_node: file_node.clone(),
                    canonical_path: change.file.clone(),
                    change_id: change.id.clone(),
                    symbol: None,
                    strength: seed_strength,
                    assurance: seed_assurance,
                    widening_reason: None,
                });

                if let Some(c) = conn {
                    for prior_node in find_prior_symbol_nodes_for_file(c, &change.file) {
                        seeds.push(ImpactSeed {
                            seed_node: prior_node,
                            canonical_path: change.file.clone(),
                            change_id: change.id.clone(),
                            symbol: None,
                            strength: seed_strength,
                            assurance: seed_assurance,
                            widening_reason: None,
                        });
                    }
                }
            }
            SemanticChangeKind::Unknown => {
                seeds.push(ImpactSeed {
                    seed_node: file_node,
                    canonical_path: change.file.clone(),
                    change_id: change.id.clone(),
                    symbol: None,
                    strength: seed_strength,
                    assurance: seed_assurance,
                    widening_reason: Some(UncertaintyReason::SemanticChangeUnknown(format!(
                        "Unknown change in {}",
                        change.file
                    ))),
                });
            }
            _ => {
                seeds.push(ImpactSeed {
                    seed_node: file_node,
                    canonical_path: change.file.clone(),
                    change_id: change.id.clone(),
                    symbol: None,
                    strength: seed_strength,
                    assurance: seed_assurance,
                    widening_reason: None,
                });
            }
        }
    }

    if let Some(c) = conn {
        for b_node in find_build_nodes_for_file(c, &change.file) {
            seeds.push(ImpactSeed {
                seed_node: b_node,
                canonical_path: change.file.clone(),
                change_id: change.id.clone(),
                symbol: None,
                strength: seed_strength,
                assurance: seed_assurance,
                widening_reason: None,
            });
        }
    }

    seeds
}
