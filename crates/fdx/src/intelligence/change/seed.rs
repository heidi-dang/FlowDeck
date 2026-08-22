//! Seed generation from semantic changes for graph traversal.

use crate::intelligence::change::model::{SemanticChange, SemanticChangeKind};
use crate::intelligence::change::uncertainty::UncertaintyReason;
use rusqlite::Connection;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImpactSeed {
    pub seed_node: String,
    pub canonical_path: String,
    pub change_id: String,
    pub symbol: Option<String>,
    pub widening_reason: Option<UncertaintyReason>,
}

/// Query database for existing or historical node IDs associated with a file/symbol.
pub fn find_node_ids_for_symbol(
    conn: &Connection,
    canonical_path: &str,
    symbol_name: &str,
) -> Vec<String> {
    let mut node_ids = Vec::new();
    let mut stmt = conn
        .prepare(
            "SELECT stable_id FROM nodes
             WHERE (canonical_path = ?1 AND symbol_identity = ?2)
                OR symbol_identity = ?2
                OR stable_id = ?3",
        )
        .ok();

    if let Some(ref mut stmt) = stmt {
        let exact_stable = format!("sym:{}:{}", canonical_path, symbol_name);
        let rows = stmt
            .query_map(
                rusqlite::params![canonical_path, symbol_name, exact_stable],
                |row| row.get(0),
            )
            .ok();
        if let Some(rows) = rows {
            for id in rows.flatten() {
                node_ids.push(id);
            }
        }
    }

    if node_ids.is_empty() {
        node_ids.push(format!("sym:{}:{}", canonical_path, symbol_name));
    }
    node_ids
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

    if let Some(ref sym) = change.symbol {
        let node_ids = if let Some(c) = conn {
            find_node_ids_for_symbol(c, &change.file, sym)
        } else {
            vec![format!("sym:{}:{}", change.file, sym)]
        };

        for nid in node_ids {
            seeds.push(ImpactSeed {
                seed_node: nid,
                canonical_path: change.file.clone(),
                change_id: change.id.clone(),
                symbol: Some(sym.clone()),
                widening_reason: None,
            });
        }

        // Also include owning file node as a seed
        seeds.push(ImpactSeed {
            seed_node: file_node,
            canonical_path: change.file.clone(),
            change_id: change.id.clone(),
            symbol: None,
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
                    widening_reason: None,
                });

                if let Some(c) = conn {
                    for prior_node in find_prior_symbol_nodes_for_file(c, &change.file) {
                        seeds.push(ImpactSeed {
                            seed_node: prior_node,
                            canonical_path: change.file.clone(),
                            change_id: change.id.clone(),
                            symbol: None,
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
                    widening_reason: None,
                });
            }
        }
    }

    seeds
}
