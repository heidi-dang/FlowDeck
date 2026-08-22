//! Transitive impact traversal and query engine over EvidenceGraph.

use crate::intelligence::change::classify::{
    classify_changes, read_git_file_content, ClassifyError,
};
use crate::intelligence::change::explain::{
    render_path_explanation, EvidencePath, EvidenceStep, ImpactedTarget,
};
use crate::intelligence::change::model::SemanticChange;
use crate::intelligence::change::policy::{
    edge_impact_direction, ImpactPolicy, TraversalDirection,
};
use crate::intelligence::change::seed::generate_impact_seeds;
use crate::intelligence::change::uncertainty::{compute_result_assurance, UncertaintyReason};
use crate::intelligence::db::{DatabaseError, DatabaseOpenMode, EvidenceDatabase};
use crate::intelligence::semantic::health::{ProviderFreshness, ProviderHealth};
use crate::protocol::{
    canonicalize_repo_path, AssuranceLevel, EdgeKind, EvidenceStrength, NodeKind,
};
use rusqlite::Connection;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum TraverseError {
    #[error("Database error: {0}")]
    Db(#[from] DatabaseError),
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("Classification error: {0}")]
    Classify(#[from] ClassifyError),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ImpactV2Result {
    pub assurance: AssuranceLevel,
    pub changes: Vec<SemanticChange>,
    pub impacted: Vec<ImpactedTarget>,
    pub uncertainty: Vec<UncertaintyReason>,
}

#[derive(Debug, Clone)]
struct DbEdgeRow {
    from_node: String,
    to_node: String,
    kind: EdgeKind,
    provider: String,
    strength: EvidenceStrength,
    stale: bool,
}

#[derive(Debug, Clone)]
struct DbNodeRow {
    #[allow(dead_code)]
    stable_id: String,
    kind: NodeKind,
    canonical_path: Option<String>,
    #[allow(dead_code)]
    symbol_identity: Option<String>,
}

fn parse_node_kind(kind_str: &str) -> NodeKind {
    match kind_str {
        "file" => NodeKind::File,
        "module" => NodeKind::Module,
        "package" => NodeKind::Package,
        "symbol" => NodeKind::Symbol,
        "test" => NodeKind::Test,
        "config" => NodeKind::Config,
        "generated_artifact" => NodeKind::GeneratedArtifact,
        "external_dependency" => NodeKind::ExternalDependency,
        _ => NodeKind::File,
    }
}

pub fn parse_edge_kind(kind_str: &str) -> Option<EdgeKind> {
    match kind_str {
        "imports" => Some(EdgeKind::Imports),
        "re_exports" => Some(EdgeKind::ReExports),
        "calls" => Some(EdgeKind::Calls),
        "defines" => Some(EdgeKind::Defines),
        "exports" => Some(EdgeKind::Exports),
        "extends" => Some(EdgeKind::Extends),
        "implements" => Some(EdgeKind::Implements),
        "references" => Some(EdgeKind::References),
        "configures" => Some(EdgeKind::Configures),
        "generates" => Some(EdgeKind::Generates),
        "tests" => Some(EdgeKind::Tests),
        "orders_before" => Some(EdgeKind::OrdersBefore),
        _ => None,
    }
}

fn parse_strength(val: i64) -> EvidenceStrength {
    match val {
        4 => EvidenceStrength::Precise,
        3 => EvidenceStrength::Observed,
        2 => EvidenceStrength::Structural,
        1 => EvidenceStrength::Heuristic,
        _ => EvidenceStrength::Unknown,
    }
}

fn query_node(conn: &Connection, node_id: &str) -> Option<DbNodeRow> {
    let mut stmt = conn
        .prepare("SELECT stable_id, kind, canonical_path, symbol_identity FROM nodes WHERE stable_id = ?1")
        .ok()?;
    stmt.query_row(rusqlite::params![node_id], |row| {
        let sid: String = row.get(0)?;
        let kstr: String = row.get(1)?;
        let cpath: Option<String> = row.get(2)?;
        let sym: Option<String> = row.get(3)?;
        Ok(DbNodeRow {
            stable_id: sid,
            kind: parse_node_kind(&kstr),
            canonical_path: cpath,
            symbol_identity: sym,
        })
    })
    .ok()
}

fn query_incoming_impact_edges(
    conn: &Connection,
    target_node: &str,
    stale_providers: &HashSet<String>,
    unknown_kinds: &mut HashSet<String>,
) -> Vec<DbEdgeRow> {
    let mut edges = Vec::new();

    // 1. Reverse edges: where to_node = target_node (caller -> callee, importer -> imported, etc.)
    if let Ok(mut stmt) = conn.prepare(
        "SELECT from_node, to_node, kind, provider, strength, stale FROM edges WHERE to_node = ?1",
    ) {
        if let Ok(rows) = stmt.query_map(rusqlite::params![target_node], |row| {
            let from_n: String = row.get(0)?;
            let to_n: String = row.get(1)?;
            let kstr: String = row.get(2)?;
            let prov: String = row.get(3)?;
            let str_val: i64 = row.get(4)?;
            let mut stale: bool = row.get(5)?;
            if stale_providers.contains(&prov) {
                stale = true;
            }
            Ok((from_n, to_n, kstr, prov, str_val, stale))
        }) {
            for item in rows.flatten() {
                let (from_n, to_n, kstr, prov, str_val, stale) = item;
                if let Some(kind) = parse_edge_kind(&kstr) {
                    if edge_impact_direction(kind) == TraversalDirection::Reverse {
                        edges.push(DbEdgeRow {
                            from_node: from_n,
                            to_node: to_n,
                            kind,
                            provider: prov,
                            strength: parse_strength(str_val),
                            stale,
                        });
                    }
                } else {
                    unknown_kinds.insert(kstr);
                }
            }
        }
    }

    // 2. Forward edges: where from_node = target_node (config -> target, generator -> artifact)
    if let Ok(mut stmt) = conn.prepare(
        "SELECT from_node, to_node, kind, provider, strength, stale FROM edges WHERE from_node = ?1",
    ) {
        if let Ok(rows) = stmt.query_map(rusqlite::params![target_node], |row| {
            let from_n: String = row.get(0)?;
            let to_n: String = row.get(1)?;
            let kstr: String = row.get(2)?;
            let prov: String = row.get(3)?;
            let str_val: i64 = row.get(4)?;
            let mut stale: bool = row.get(5)?;
            if stale_providers.contains(&prov) {
                stale = true;
            }
            Ok((from_n, to_n, kstr, prov, str_val, stale))
        }) {
            for item in rows.flatten() {
                let (from_n, to_n, kstr, prov, str_val, stale) = item;
                if let Some(kind) = parse_edge_kind(&kstr) {
                    if edge_impact_direction(kind) == TraversalDirection::Forward {
                        edges.push(DbEdgeRow {
                            from_node: from_n,
                            to_node: to_n,
                            kind,
                            provider: prov,
                            strength: parse_strength(str_val),
                            stale,
                        });
                    }
                } else {
                    unknown_kinds.insert(kstr);
                }
            }
        }
    }

    edges
}

fn resolve_import_path(source_file: &Path, import_str: &str, repo_root: &Path) -> Option<String> {
    if !import_str.starts_with('.') {
        return None;
    }
    let parent = source_file.parent().unwrap_or(Path::new(""));
    let candidate = parent.join(import_str);

    let extensions = ["ts", "tsx", "js", "jsx", "rs"];
    if candidate.is_file() {
        return canonicalize_repo_path(&candidate, repo_root).ok();
    }
    for ext in extensions {
        let with_ext = candidate.with_extension(ext);
        if with_ext.is_file() {
            return canonicalize_repo_path(&with_ext, repo_root).ok();
        }
        let index_file = candidate.join(format!("index.{}", ext));
        if index_file.is_file() {
            return canonicalize_repo_path(&index_file, repo_root).ok();
        }
    }
    None
}

/// Inverted index for fast structural and lexical dependency lookups (with before-state awareness).
struct StructuralGraphIndex {
    imported_to_importers: HashMap<String, Vec<String>>,
    symbol_to_referencing_files: HashMap<String, Vec<String>>,
}

impl StructuralGraphIndex {
    fn build(repo_root: &Path, files: &[String], base_ref: Option<&str>) -> Self {
        let mut imported_to_importers: HashMap<String, Vec<String>> = HashMap::new();
        let mut symbol_to_referencing_files: HashMap<String, Vec<String>> = HashMap::new();

        let base_name = base_ref.unwrap_or("HEAD");

        for canon in files {
            let full = repo_root.join(canon);
            let content = if full.is_file() {
                std::fs::read_to_string(&full).ok()
            } else {
                read_git_file_content(repo_root, base_name, canon)
            };

            let Some(content) = content else {
                continue;
            };

            let mut imported_files = HashSet::new();

            for line in content.lines() {
                let trimmed = line.trim();
                if trimmed.starts_with("import ") || trimmed.starts_with("export ") {
                    for q in ['\'', '"'] {
                        if let Some(start) = trimmed.rfind(q) {
                            if let Some(end) = trimmed[..start].rfind(q) {
                                let spec = &trimmed[end + 1..start];
                                if let Some(resolved) = resolve_import_path(
                                    &canon_to_path(repo_root, canon),
                                    spec,
                                    repo_root,
                                ) {
                                    imported_files.insert(resolved);
                                }
                            }
                        }
                    }
                }
            }

            for imp in imported_files {
                imported_to_importers
                    .entry(imp)
                    .or_default()
                    .push(canon.clone());
            }

            // Extract alphanumeric tokens for symbol references
            for word in content.split(|c: char| !c.is_alphanumeric() && c != '_') {
                if word.len() >= 2 {
                    let entry = symbol_to_referencing_files
                        .entry(word.to_string())
                        .or_default();
                    if entry.last().map(|s| s != canon).unwrap_or(true) {
                        entry.push(canon.clone());
                    }
                }
            }
        }

        Self {
            imported_to_importers,
            symbol_to_referencing_files,
        }
    }

    fn find_incoming_edges(
        &self,
        target_path: &str,
        target_symbol: Option<&str>,
    ) -> Vec<DbEdgeRow> {
        let mut edges = Vec::new();
        let mut seen = HashSet::new();

        if let Some(importers) = self.imported_to_importers.get(target_path) {
            for imp in importers {
                if imp == target_path {
                    continue;
                }
                if seen.insert(imp.clone()) {
                    edges.push(DbEdgeRow {
                        from_node: format!("file:{}", imp),
                        to_node: format!("file:{}", target_path),
                        kind: EdgeKind::Imports,
                        provider: "tree_sitter".to_string(),
                        strength: EvidenceStrength::Structural,
                        stale: false,
                    });
                }
            }
        }

        if let Some(sym) = target_symbol {
            if let Some(referencers) = self.symbol_to_referencing_files.get(sym) {
                for ref_file in referencers {
                    if ref_file == target_path {
                        continue;
                    }
                    if seen.insert(ref_file.clone()) {
                        edges.push(DbEdgeRow {
                            from_node: format!("file:{}", ref_file),
                            to_node: format!("sym:{}:{}", target_path, sym),
                            kind: EdgeKind::References,
                            provider: "tree_sitter".to_string(),
                            strength: EvidenceStrength::Structural,
                            stale: false,
                        });
                    }
                }
            }
        }

        edges
    }
}

/// Pre-collect all candidate repository code files from database or disk (at most once).
fn collect_all_repo_code_files(conn: Option<&Connection>, repo_root: &Path) -> Vec<String> {
    let mut files = Vec::new();
    if let Some(c) = conn {
        if let Ok(mut stmt) = c.prepare("SELECT canonical_path FROM files") {
            if let Ok(rows) = stmt.query_map([], |row| row.get(0)) {
                for f in rows.flatten() {
                    files.push(f);
                }
            }
        }
    }

    if files.is_empty() {
        // Fallback: gitignore-aware bounded walk
        let walker = ignore::WalkBuilder::new(repo_root)
            .hidden(true)
            .git_ignore(true)
            .require_git(false)
            .build();
        for res in walker {
            let Ok(entry) = res else { continue };
            if entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
                let path = entry.path();
                let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
                if ["ts", "tsx", "js", "jsx", "rs", "py"].contains(&ext) {
                    if let Ok(canon) = canonicalize_repo_path(path, repo_root) {
                        files.push(canon);
                        if files.len() >= 2000 {
                            break;
                        }
                    }
                }
            }
        }
    }

    files
}

fn canon_to_path(repo_root: &Path, canon: &str) -> PathBuf {
    repo_root.join(canon)
}

struct QueueItem {
    current_node_id: String,
    depth: usize,
    strength: EvidenceStrength,
    steps: Vec<EvidenceStep>,
    change_id: String,
    seed_node: String,
}

/// Transitive, bounded, cycle-safe impact analysis.
pub fn analyze_impact_v2(
    repo_root: &Path,
    base_ref: Option<&str>,
    head_ref: Option<&str>,
    depth_limit: Option<usize>,
) -> Result<ImpactV2Result, TraverseError> {
    let policy = ImpactPolicy {
        max_depth: depth_limit.unwrap_or(3),
        ..Default::default()
    };

    let change_set = classify_changes(repo_root, base_ref, head_ref)?;

    let mut uncertainties = change_set.uncertainty.clone();
    let mut impacted_map: HashMap<String, ImpactedTarget> = HashMap::new();
    let mut has_fallback_path = false;

    let db_res = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly);

    let db = match db_res {
        Ok(d) => d,
        Err(DatabaseError::NotIndexed) => {
            uncertainties.push(UncertaintyReason::GraphAbsent(
                "Evidence graph database not found or unindexed".to_string(),
            ));
            for ch in &change_set.changes {
                impacted_map.insert(
                    ch.file.clone(),
                    ImpactedTarget {
                        target: ch.file.clone(),
                        target_kind: NodeKind::File,
                        depth: 0,
                        strength: EvidenceStrength::Heuristic,
                        primary_path: None,
                        alternate_paths: Vec::new(),
                        alternate_path_count: 0,
                        widening_reason: Some("Unindexed repository fallback".to_string()),
                    },
                );
            }

            let assurance = compute_result_assurance(change_set.assurance, &uncertainties, true);
            let mut impacted_list: Vec<ImpactedTarget> = impacted_map.into_values().collect();
            impacted_list.sort_by(|a, b| a.target.cmp(&b.target));

            return Ok(ImpactV2Result {
                assurance,
                changes: change_set.changes,
                impacted: impacted_list,
                uncertainty: uncertainties,
            });
        }
        Err(DatabaseError::Corrupt) => {
            uncertainties.push(UncertaintyReason::GraphCorrupt(
                "Evidence graph database is corrupt".to_string(),
            ));
            for ch in &change_set.changes {
                impacted_map.insert(
                    ch.file.clone(),
                    ImpactedTarget {
                        target: ch.file.clone(),
                        target_kind: NodeKind::File,
                        depth: 0,
                        strength: EvidenceStrength::Heuristic,
                        primary_path: None,
                        alternate_paths: Vec::new(),
                        alternate_path_count: 0,
                        widening_reason: Some("Corrupt database fallback".to_string()),
                    },
                );
            }

            let assurance = compute_result_assurance(change_set.assurance, &uncertainties, true);
            let mut impacted_list: Vec<ImpactedTarget> = impacted_map.into_values().collect();
            impacted_list.sort_by(|a, b| a.target.cmp(&b.target));

            return Ok(ImpactV2Result {
                assurance,
                changes: change_set.changes,
                impacted: impacted_list,
                uncertainty: uncertainties,
            });
        }
        Err(DatabaseError::FutureSchemaVersion(found)) => {
            uncertainties.push(UncertaintyReason::GraphIncompatible(format!(
                "Database schema v{} exceeds supported v{}",
                found,
                crate::intelligence::schema::CURRENT_SCHEMA_VERSION
            )));
            for ch in &change_set.changes {
                impacted_map.insert(
                    ch.file.clone(),
                    ImpactedTarget {
                        target: ch.file.clone(),
                        target_kind: NodeKind::File,
                        depth: 0,
                        strength: EvidenceStrength::Heuristic,
                        primary_path: None,
                        alternate_paths: Vec::new(),
                        alternate_path_count: 0,
                        widening_reason: Some("Future schema incompatible".to_string()),
                    },
                );
            }

            let assurance = compute_result_assurance(change_set.assurance, &uncertainties, true);
            let mut impacted_list: Vec<ImpactedTarget> = impacted_map.into_values().collect();
            impacted_list.sort_by(|a, b| a.target.cmp(&b.target));

            return Ok(ImpactV2Result {
                assurance,
                changes: change_set.changes,
                impacted: impacted_list,
                uncertainty: uncertainties,
            });
        }
        Err(other) => {
            uncertainties.push(UncertaintyReason::GraphUnavailable(format!(
                "Database error: {}",
                other
            )));
            for ch in &change_set.changes {
                impacted_map.insert(
                    ch.file.clone(),
                    ImpactedTarget {
                        target: ch.file.clone(),
                        target_kind: NodeKind::File,
                        depth: 0,
                        strength: EvidenceStrength::Heuristic,
                        primary_path: None,
                        alternate_paths: Vec::new(),
                        alternate_path_count: 0,
                        widening_reason: Some("Database unavailable fallback".to_string()),
                    },
                );
            }

            let assurance = compute_result_assurance(change_set.assurance, &uncertainties, true);
            let mut impacted_list: Vec<ImpactedTarget> = impacted_map.into_values().collect();
            impacted_list.sort_by(|a, b| a.target.cmp(&b.target));

            return Ok(ImpactV2Result {
                assurance,
                changes: change_set.changes,
                impacted: impacted_list,
                uncertainty: uncertainties,
            });
        }
    };

    // Evaluate M3 effective provider states passively against live disk configuration/executables
    let registry = crate::intelligence::semantic::registry::ProviderRegistry::default();
    let persisted_states =
        crate::intelligence::semantic::state::load_provider_states(&db).unwrap_or_default();
    let effective_states = crate::intelligence::semantic::state::evaluate_effective_states(
        repo_root,
        &registry,
        persisted_states,
    );

    let mut stale_providers = HashSet::new();
    for st in &effective_states {
        let pid = st.provider_id();
        if st.freshness != ProviderFreshness::Fresh {
            stale_providers.insert(pid.to_string());
            uncertainties.push(UncertaintyReason::ProviderStale(format!(
                "Provider {} is effectively stale",
                pid
            )));
        } else if st.health == ProviderHealth::Failed {
            uncertainties.push(UncertaintyReason::ProviderFailed(format!(
                "Provider {} failed",
                pid
            )));
        } else if st.health == ProviderHealth::Misconfigured {
            uncertainties.push(UncertaintyReason::ProviderMissing(format!(
                "Provider {} is misconfigured",
                pid
            )));
        }
    }

    let mut candidate_files = collect_all_repo_code_files(Some(&db.conn), repo_root);
    for ch in &change_set.changes {
        if !candidate_files.contains(&ch.file) {
            candidate_files.push(ch.file.clone());
        }
        if let Some(ref b) = ch.before {
            if !candidate_files.contains(&b.path) {
                candidate_files.push(b.path.clone());
            }
        }
    }

    let structural_index = StructuralGraphIndex::build(repo_root, &candidate_files, base_ref);

    // Collect all seeds from changes
    let mut seeds = Vec::new();
    for change in &change_set.changes {
        let s = generate_impact_seeds(change, Some(&db.conn));
        seeds.extend(s);
    }

    let mut visited_nodes: HashMap<String, usize> = HashMap::new();
    let mut total_nodes_visited = 0usize;
    let mut total_edges_visited = 0usize;
    let mut depth_limit_hit = false;
    let mut node_limit_hit = false;
    let mut edge_limit_hit = false;
    let mut unknown_kinds = HashSet::new();

    let mut queue: VecDeque<QueueItem> = VecDeque::new();

    // Enqueue seeds
    for seed in &seeds {
        visited_nodes.insert(seed.seed_node.clone(), 0);

        if let Some(ref w) = seed.widening_reason {
            uncertainties.push(w.clone());
        }

        // Record seed file target itself at depth 0
        if !impacted_map.contains_key(&seed.canonical_path) {
            impacted_map.insert(
                seed.canonical_path.clone(),
                ImpactedTarget {
                    target: seed.canonical_path.clone(),
                    target_kind: NodeKind::File,
                    depth: 0,
                    strength: seed.strength,
                    primary_path: Some(EvidencePath {
                        change_id: seed.change_id.clone(),
                        seed_node: seed.seed_node.clone(),
                        target_node: seed.seed_node.clone(),
                        steps: vec![EvidenceStep {
                            from_node: seed.seed_node.clone(),
                            edge_kind: EdgeKind::Defines,
                            to_node: format!("file:{}", seed.canonical_path),
                            provider: "change-delta".to_string(),
                            strength: seed.strength,
                            description: Some("directly modified".to_string()),
                        }],
                        path_strength: seed.strength,
                        explanation: format!("Directly modified in change {}", seed.change_id),
                    }),
                    alternate_paths: Vec::new(),
                    alternate_path_count: 0,
                    widening_reason: seed.widening_reason.as_ref().map(|r| r.code().to_string()),
                },
            );
        }

        queue.push_back(QueueItem {
            current_node_id: seed.seed_node.clone(),
            depth: 0,
            strength: seed.strength,
            steps: Vec::new(),
            change_id: seed.change_id.clone(),
            seed_node: seed.seed_node.clone(),
        });
    }

    while let Some(item) = queue.pop_front() {
        total_nodes_visited += 1;
        if total_nodes_visited > policy.max_nodes {
            node_limit_hit = true;
            break;
        }

        let mut outgoing_edges = query_incoming_impact_edges(
            &db.conn,
            &item.current_node_id,
            &stale_providers,
            &mut unknown_kinds,
        );

        // If no DB edges found for this node (or for deleted symbols/files), query structural/before index
        if outgoing_edges.is_empty() {
            let (target_p, target_s) =
                if let Some(stripped) = item.current_node_id.strip_prefix("file:") {
                    (stripped, None)
                } else if let Some(stripped) = item.current_node_id.strip_prefix("sym:") {
                    let parts: Vec<&str> = stripped.splitn(2, ':').collect();
                    if parts.len() == 2 {
                        (parts[0], Some(parts[1]))
                    } else {
                        (stripped, None)
                    }
                } else {
                    (item.current_node_id.as_str(), None)
                };

            let structural = structural_index.find_incoming_edges(target_p, target_s);
            if !structural.is_empty() {
                has_fallback_path = true;
                outgoing_edges.extend(structural);
            }
        }

        if item.depth >= policy.max_depth {
            if !outgoing_edges.is_empty() {
                depth_limit_hit = true;
            }
            continue;
        }

        for edge in outgoing_edges {
            total_edges_visited += 1;
            if total_edges_visited > policy.max_edges {
                edge_limit_hit = true;
                break;
            }

            if edge.stale {
                uncertainties.push(UncertaintyReason::ProviderStale(format!(
                    "Edge {}->{} backed by stale provider evidence",
                    edge.from_node, edge.to_node
                )));
            }

            if edge.strength < EvidenceStrength::Precise {
                has_fallback_path = true;
            }

            let next_node_id = if edge_impact_direction(edge.kind) == TraversalDirection::Reverse {
                edge.from_node.clone()
            } else {
                edge.to_node.clone()
            };

            let next_strength = std::cmp::min(item.strength, edge.strength);
            let next_depth = item.depth + 1;

            let step = EvidenceStep {
                from_node: edge.from_node.clone(),
                edge_kind: edge.kind,
                to_node: edge.to_node.clone(),
                provider: edge.provider.clone(),
                strength: edge.strength,
                description: None,
            };

            let mut new_steps = item.steps.clone();
            new_steps.push(step);

            // Determine target key
            let (target_key, node_kind) =
                if let Some(node_row) = query_node(&db.conn, &next_node_id) {
                    (
                        node_row
                            .canonical_path
                            .unwrap_or_else(|| next_node_id.clone()),
                        node_row.kind,
                    )
                } else if let Some(stripped) = next_node_id.strip_prefix("file:") {
                    (stripped.to_string(), NodeKind::File)
                } else if let Some(stripped) = next_node_id.strip_prefix("sym:") {
                    let parts: Vec<&str> = stripped.splitn(2, ':').collect();
                    (parts[0].to_string(), NodeKind::Symbol)
                } else {
                    (next_node_id.clone(), NodeKind::File)
                };

            let path_expl = render_path_explanation(&next_node_id, &item.seed_node, &new_steps);

            let ev_path = EvidencePath {
                change_id: item.change_id.clone(),
                seed_node: item.seed_node.clone(),
                target_node: next_node_id.clone(),
                steps: new_steps.clone(),
                path_strength: next_strength,
                explanation: path_expl,
            };

            if let Some(existing) = impacted_map.get_mut(&target_key) {
                if next_depth < existing.depth
                    || (next_depth == existing.depth && next_strength > existing.strength)
                {
                    if let Some(old_prim) = existing.primary_path.take() {
                        if existing.alternate_paths.len() < policy.max_paths_per_target {
                            existing.alternate_paths.push(old_prim);
                        }
                        existing.alternate_path_count += 1;
                    }
                    existing.depth = next_depth;
                    existing.strength = next_strength;
                    existing.primary_path = Some(ev_path);
                } else {
                    if existing.alternate_paths.len() < policy.max_paths_per_target {
                        existing.alternate_paths.push(ev_path);
                    }
                    existing.alternate_path_count += 1;
                }
            } else {
                impacted_map.insert(
                    target_key.clone(),
                    ImpactedTarget {
                        target: target_key,
                        target_kind: node_kind,
                        depth: next_depth,
                        strength: next_strength,
                        primary_path: Some(ev_path),
                        alternate_paths: Vec::new(),
                        alternate_path_count: 0,
                        widening_reason: None,
                    },
                );
            }

            // Cycle check
            if let Some(&prior_depth) = visited_nodes.get(&next_node_id) {
                if prior_depth <= next_depth {
                    continue;
                }
            }
            visited_nodes.insert(next_node_id.clone(), next_depth);

            queue.push_back(QueueItem {
                current_node_id: next_node_id,
                depth: next_depth,
                strength: next_strength,
                steps: new_steps,
                change_id: item.change_id.clone(),
                seed_node: item.seed_node.clone(),
            });
        }
    }

    for unk in unknown_kinds {
        uncertainties.push(UncertaintyReason::UnknownGraphRelation(format!(
            "Unknown graph relation kind '{}' skipped",
            unk
        )));
    }

    if depth_limit_hit {
        uncertainties.push(UncertaintyReason::DepthLimitReached {
            max_depth: policy.max_depth,
        });
    }
    if node_limit_hit {
        uncertainties.push(UncertaintyReason::NodeLimitReached {
            max_nodes: policy.max_nodes,
        });
    }
    if edge_limit_hit {
        uncertainties.push(UncertaintyReason::EdgeLimitReached {
            max_edges: policy.max_edges,
        });
    }

    // Deduplicate and sort uncertainties
    uncertainties.sort_by(|a, b| {
        a.code()
            .cmp(b.code())
            .then_with(|| format!("{:?}", a).cmp(&format!("{:?}", b)))
    });
    uncertainties.dedup();

    let assurance =
        compute_result_assurance(change_set.assurance, &uncertainties, has_fallback_path);

    // Convert map to sorted deterministic list
    let mut impacted_list: Vec<ImpactedTarget> = impacted_map.into_values().collect();
    impacted_list.sort_by(|a, b| {
        a.depth
            .cmp(&b.depth)
            .then_with(|| (b.strength as u8).cmp(&(a.strength as u8)))
            .then_with(|| a.target.cmp(&b.target))
            .then_with(|| format!("{:?}", a.target_kind).cmp(&format!("{:?}", b.target_kind)))
    });

    Ok(ImpactV2Result {
        assurance,
        changes: change_set.changes,
        impacted: impacted_list,
        uncertainty: uncertainties,
    })
}

/// Explain why a specific target is impacted, utilizing the exact same impact machinery.
pub fn explain_why_target(
    repo_root: &Path,
    target: &str,
    base_ref: Option<&str>,
    head_ref: Option<&str>,
    depth_limit: Option<usize>,
) -> Result<Option<ImpactedTarget>, TraverseError> {
    let result = analyze_impact_v2(repo_root, base_ref, head_ref, depth_limit)?;
    let found = result
        .impacted
        .into_iter()
        .find(|t| t.target == target || t.target.ends_with(target) || target.ends_with(&t.target));
    Ok(found)
}
