//! Transactional SCIP ingestion into the EvidenceGraph.
//!
//! Provider refresh behaves as:
//!
//!   old complete provider generation
//!   OR
//!   new complete provider generation
//!
//! A provider run produces an SCIP index, which is validated, parsed, and
//! published in a single transaction that first removes the provider own
//! previous evidence. If anything fails (provider crash, timeout, malformed
//! or oversized SCIP, DB error), the transaction rolls back and the previous
//! evidence remains active under its old freshness/compatibility state.
//! Provider output is untrusted input: every path is jailed against the
//! repository root before anything touches the graph.

use crate::intelligence::db::{DatabaseError, DatabaseOpenMode, EvidenceDatabase};
use crate::intelligence::index::{TransactionalGraph, FILE_NODE_PREFIX};
use crate::intelligence::model::{IndexedFile, SemanticEdge, SemanticNode};
use crate::intelligence::semantic::health::{ProviderFreshness, ProviderHealth};
use crate::intelligence::semantic::limits::MAX_SCIP_INDEX_BYTES;
use crate::intelligence::semantic::provider::{
    now_ms, sha256_hex, ProviderFingerprint, ProviderIdentity, ProviderScope, ProviderState,
    ProviderType, SemanticIngestRequest, SemanticIngestResult, SemanticProvider,
    SemanticProviderError,
};
use crate::intelligence::semantic::scip::decoder::{decode_index, ScipDecodeError};
use crate::intelligence::semantic::scip::model::{
    is_local_symbol, ScipDocument, ScipIndex, ScipOccurrence,
};
use crate::intelligence::semantic::state;
use crate::intelligence::semantic::LanguageId;
use crate::protocol::{
    canonicalize_repo_path, EdgeKind, EvidenceProviderKind, EvidenceStrength, NodeKind,
};
use std::collections::HashMap;
use std::path::Path;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum IngestError {
    #[error("provider error: {0}")]
    Provider(#[from] SemanticProviderError),
    #[error("SCIP decode error: {0}")]
    Scip(#[from] ScipDecodeError),
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("database open error: {0}")]
    DbOpen(#[from] DatabaseError),
    #[error("index error: {0}")]
    Index(#[from] crate::intelligence::index::IndexError),
    #[error("path jail violation: {0}")]
    PathJail(String),
    #[error("SCIP size limit exceeded: {0}")]
    SizeLimit(String),
    #[error("document path does not resolve inside repository: {0}")]
    UnresolvablePath(String),
    #[error("unsupported language in SCIP document: {0}")]
    UnknownLanguage(String),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

/// Result of a provider refresh.
#[derive(Debug, Clone)]
pub struct IngestReport {
    pub provider_id: String,
    pub skipped: bool,
    pub documents: usize,
    pub occurrences: usize,
    pub symbols: usize,
    pub nodes: usize,
    pub edges: usize,
    pub generation: u64,
    pub output_digest: Option<String>,
    pub tool_name: Option<String>,
    pub tool_version: Option<String>,
    pub provider_runtime_ms: u64,
}

/// Refresh one provider: bounded run -> SCIP decode -> transactional publish.
pub fn refresh_provider(
    repo_root: &Path,
    provider: &dyn SemanticProvider,
    force: bool,
) -> Result<IngestReport, IngestError> {
    let mut db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadWrite)?;
    let scope = provider.scope(repo_root);
    let fingerprint = match provider.fingerprint(repo_root) {
        Ok(f) => f,
        Err(e) => {
            let persisted = load_or_default_state(
                &db,
                provider.id(),
                scope.clone(),
                fingerprint_default(provider),
            );
            let failed_state = persisted_with_failure(persisted, provider.id(), scope, &e);
            let tx = TransactionalGraph::new(&mut db.conn)?;
            state::upsert_provider_state(&tx, &failed_state)?;
            tx.commit()?;
            return Err(IngestError::Provider(e));
        }
    };

    let persisted = load_or_default_state(&db, provider.id(), scope.clone(), fingerprint.clone());
    let fingerprint_unchanged = persisted
        .as_ref()
        .map(|p| p.fingerprint.digest == fingerprint.digest)
        .unwrap_or(false);
    if !force
        && fingerprint_unchanged
        && persisted
            .as_ref()
            .map(|p| p.freshness == ProviderFreshness::Fresh)
            .unwrap_or(false)
        && persisted
            .as_ref()
            .and_then(|p| p.last_successful_run)
            .is_some()
    {
        return Ok(IngestReport {
            provider_id: provider.id().to_string(),
            skipped: true,
            documents: 0,
            occurrences: 0,
            symbols: 0,
            nodes: 0,
            edges: 0,
            generation: persisted
                .as_ref()
                .map(|p| p.semantic_generation)
                .unwrap_or(0),
            output_digest: persisted.as_ref().and_then(|p| p.output_digest.clone()),
            tool_name: Some(provider.id().to_string()),
            tool_version: persisted
                .as_ref()
                .map(|p| p.identity.provider_version.clone()),
            provider_runtime_ms: 0,
        });
    }

    match provider.health(repo_root) {
        ProviderHealth::Missing => {
            let failed_state = persisted_with_failure(
                persisted,
                provider.id(),
                scope,
                &SemanticProviderError::Missing(format!(
                    "{} not found on PATH (no auto-download; install manually)",
                    provider.id()
                )),
            );
            let tx = TransactionalGraph::new(&mut db.conn)?;
            state::upsert_provider_state(&tx, &failed_state)?;
            tx.commit()?;
            return Err(IngestError::Provider(SemanticProviderError::Missing(
                provider.id().to_string(),
            )));
        }
        ProviderHealth::Unsupported => {
            let unsupported_state = ProviderStateForPersist {
                provider_id: provider.id().to_string(),
                scope,
                fingerprint,
                health: ProviderHealth::Unsupported,
                freshness: ProviderFreshness::Absent,
                failure_reason: Some("unsupported language/sources".to_string()),
            };
            let tx = TransactionalGraph::new(&mut db.conn)?;
            state::upsert_provider_state(&tx, &unsupported_state.into_state())?;
            tx.commit()?;
            return Err(IngestError::Provider(
                SemanticProviderError::UnsupportedLanguage(provider.id().to_string()),
            ));
        }
        _ => {}
    }

    let cache_dir = repo_root.join(".fdx").join("cache");
    std::fs::create_dir_all(&cache_dir)?;
    let output_path = cache_dir.join(format!(
        "{}-{}.scip",
        provider.id(),
        &sha256_hex(&now_ms().to_le_bytes())[..12]
    ));

    let request = SemanticIngestRequest {
        repo_root: repo_root.to_path_buf(),
        scope: scope.clone(),
        fingerprint: fingerprint.clone(),
        output_path: output_path.clone(),
        time_limit: crate::intelligence::semantic::limits::MAX_PROVIDER_RUNTIME,
        max_output_bytes: MAX_SCIP_INDEX_BYTES,
        max_stderr_bytes: crate::intelligence::semantic::limits::MAX_PROVIDER_STDERR_BYTES,
    };

    let result: SemanticIngestResult = match provider.ingest(request) {
        Ok(r) => r,
        Err(e) => {
            persist_failure_state(repo_root, &persisted, provider.id(), scope, fingerprint, &e)?;
            return Err(IngestError::Provider(e));
        }
    };

    let index_bytes = std::fs::read(&result.output_path)?;
    if index_bytes.len() as u64 > MAX_SCIP_INDEX_BYTES {
        persist_failure_state(
            repo_root,
            &persisted,
            provider.id(),
            scope,
            fingerprint,
            &SemanticProviderError::SizeLimit(format!(
                "index exceeds {} bytes",
                MAX_SCIP_INDEX_BYTES
            )),
        )?;
        return Err(IngestError::SizeLimit(format!(
            "{} bytes > MAX_SCIP_INDEX_BYTES",
            index_bytes.len()
        )));
    }

    let index = match decode_index(&index_bytes) {
        Ok(i) => i,
        Err(e) => {
            persist_failure_state(
                repo_root,
                &persisted,
                provider.id(),
                scope,
                fingerprint,
                &SemanticProviderError::MalformedScip(e.to_string()),
            )?;
            return Err(IngestError::Scip(e));
        }
    };

    ingest_scip_index(repo_root, provider, &scope, &fingerprint, &result, &index)
}

/// Transactional ingest of an already-decoded SCIP index for one provider.
pub fn ingest_scip_index(
    repo_root: &Path,
    provider: &dyn SemanticProvider,
    scope: &ProviderScope,
    fingerprint: &ProviderFingerprint,
    result: &SemanticIngestResult,
    index: &ScipIndex,
) -> Result<IngestReport, IngestError> {
    ingest_scip_index_impl(
        repo_root,
        provider,
        scope,
        fingerprint,
        result,
        index,
        None,
        false,
    )
}

/// Fault-injectable variant used by tests to prove atomic publication.
#[doc(hidden)]
#[allow(clippy::too_many_arguments)]
pub fn ingest_scip_index_with_faults(
    repo_root: &Path,
    provider: &dyn SemanticProvider,
    scope: &ProviderScope,
    fingerprint: &ProviderFingerprint,
    result: &SemanticIngestResult,
    index: &ScipIndex,
    fail_after_documents: Option<usize>,
    fail_db_insert: bool,
) -> Result<IngestReport, IngestError> {
    ingest_scip_index_impl(
        repo_root,
        provider,
        scope,
        fingerprint,
        result,
        index,
        fail_after_documents,
        fail_db_insert,
    )
}

#[allow(clippy::too_many_arguments)] // fault-injection seam for atomicity tests
fn ingest_scip_index_impl(
    repo_root: &Path,
    provider: &dyn SemanticProvider,
    scope: &ProviderScope,
    fingerprint: &ProviderFingerprint,
    result: &SemanticIngestResult,
    index: &ScipIndex,
    fail_after_documents: Option<usize>,
    fail_db_insert: bool,
) -> Result<IngestReport, IngestError> {
    let mut db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadWrite)?;
    let persisted = load_or_default_state(&db, provider.id(), scope.clone(), fingerprint.clone());
    let prior_generation = persisted
        .as_ref()
        .map(|p| p.semantic_generation)
        .unwrap_or(0);
    let new_generation = prior_generation + 1;

    // 1. Validate + normalize (outside the transaction): every path must jail
    //    inside the repository, and every document must resolve to a real file.
    let mut plan: Vec<DocPlan> = Vec::new();
    let mut symbol_defining_file: HashMap<String, String> = HashMap::new();

    for (doc_index, doc) in index.documents.iter().enumerate() {
        let lang = doc_language(doc)?;
        let canonical = jail_document_path(repo_root, &doc.relative_path)?;
        let absolute = repo_root.join(&canonical);
        if !absolute.is_file() {
            return Err(IngestError::UnresolvablePath(canonical.clone()));
        }
        let file_node = format!("{}{}", FILE_NODE_PREFIX, canonical);
        plan.push(DocPlan {
            canonical: canonical.clone(),
            language: lang,
            file_node: file_node.clone(),
            doc_index,
        });
        for occ in &doc.occurrences {
            if occ.symbol_roles.is_definition() && !is_local_symbol(&occ.symbol) {
                symbol_defining_file
                    .entry(occ.symbol.clone())
                    .or_insert_with(|| canonical.clone());
            }
        }
        if let Some(limit) = fail_after_documents {
            if doc_index + 1 >= limit {
                // Simulate a parse failure halfway through the documents.
                return Err(IngestError::Scip(ScipDecodeError::Truncated));
            }
        }
        if fail_db_insert && fail_after_documents.is_none() {
            // Simulate a DB insert failure.
            return Err(IngestError::Db(rusqlite::Error::InvalidQuery));
        }
    }

    let mut semantic_nodes: Vec<SemanticNode> = Vec::new();
    let mut semantic_edges: Vec<SemanticEdge> = Vec::new();
    let mut occurrence_groups: HashMap<(String, String, EdgeKind), Vec<serde_json::Value>> =
        HashMap::new();
    let mut package_nodes: HashMap<String, String> = HashMap::new();
    let mut seen_symbol_nodes: HashMap<String, String> = HashMap::new();

    // File nodes first (shared).
    for p in &plan {
        let node = SemanticNode {
            stable_id: p.file_node.clone(),
            kind: NodeKind::File,
            canonical_path: Some(p.canonical.clone()),
            symbol_identity: None,
            package_identity: None,
            metadata: Some(format!("{{\"language\":\"{}\"}}", p.language.as_str())),
            provider: provider.id().to_string(),
            provider_fingerprint: fingerprint.digest.clone(),
            generation: new_generation,
            source_hash: None,
        };
        semantic_nodes.push(node);
    }

    // Symbol nodes from Document.symbols (metadata: display name, kind) plus
    // relationship edges between locally-defined symbols.
    for doc in &index.documents {
        for info in &doc.symbols {
            if info.symbol.is_empty() {
                continue;
            }
            let node_id = semantic_symbol_node_id(&doc.relative_path, &info.symbol);
            seen_symbol_nodes.insert(info.symbol.clone(), node_id.clone());
            let package_id = package_node_id_for_symbol(&info.symbol);
            let metadata = format!(
                "{{\"display_name\":{},\"scip_kind\":{}}}",
                json_str_or_null(info.display_name.as_deref()),
                info.kind,
            );
            semantic_nodes.push(SemanticNode {
                stable_id: node_id.clone(),
                kind: NodeKind::Symbol,
                canonical_path: None,
                symbol_identity: Some(info.symbol.clone()),
                package_identity: package_id.clone(),
                metadata: Some(metadata),
                provider: provider.id().to_string(),
                provider_fingerprint: fingerprint.digest.clone(),
                generation: new_generation,
                source_hash: None,
            });
            if let Some(pkg) = package_id {
                ensure_package_node(
                    &mut package_nodes,
                    &mut semantic_nodes,
                    &pkg,
                    provider,
                    fingerprint,
                    new_generation,
                );
            }
            for rel in &info.relationships {
                if rel.symbol.is_empty() {
                    continue;
                }
                let target = seen_symbol_nodes.get(&rel.symbol).cloned();
                if let Some(target) = target {
                    if rel.is_implementation {
                        semantic_edges.push(make_symbol_edge(
                            &node_id,
                            &target,
                            EdgeKind::Implements,
                            provider,
                            fingerprint,
                            new_generation,
                        ));
                    }
                    if rel.is_definition && target != node_id {
                        semantic_edges.push(make_symbol_edge(
                            &node_id,
                            &target,
                            EdgeKind::Defines,
                            provider,
                            fingerprint,
                            new_generation,
                        ));
                    }
                    if rel.is_reference && target != node_id {
                        semantic_edges.push(make_symbol_edge(
                            &node_id,
                            &target,
                            EdgeKind::References,
                            provider,
                            fingerprint,
                            new_generation,
                        ));
                    }
                }
            }
        }
    }

    // Occurrence edges: FILE -> SYMBOL with per-(from,to,kind) dedupe and
    // occurrence positions preserved in edge metadata.
    for p in &plan {
        let doc = &index.documents[p.doc_index];
        for occ in &doc.occurrences {
            if occ.symbol.is_empty() || occ.symbol_roles.is_generated() {
                continue;
            }
            let node_id = semantic_symbol_node_id(&p.canonical, &occ.symbol);
            seen_symbol_nodes.insert(occ.symbol.clone(), node_id.clone());
            if !semantic_nodes.iter().any(|n| n.stable_id == node_id) {
                let package_id = package_node_id_for_symbol(&occ.symbol);
                semantic_nodes.push(SemanticNode {
                    stable_id: node_id.clone(),
                    kind: NodeKind::Symbol,
                    canonical_path: None,
                    symbol_identity: Some(occ.symbol.clone()),
                    package_identity: package_id.clone(),
                    metadata: None,
                    provider: provider.id().to_string(),
                    provider_fingerprint: fingerprint.digest.clone(),
                    generation: new_generation,
                    source_hash: None,
                });
                if let Some(pkg) = package_id {
                    ensure_package_node(
                        &mut package_nodes,
                        &mut semantic_nodes,
                        &pkg,
                        provider,
                        fingerprint,
                        new_generation,
                    );
                }
            }
            let kind = if occ.symbol_roles.is_definition() {
                EdgeKind::Defines
            } else if occ.symbol_roles.is_import() {
                EdgeKind::Imports
            } else {
                EdgeKind::References
            };
            let key = (p.file_node.clone(), node_id.clone(), kind);
            occurrence_groups
                .entry(key)
                .or_default()
                .push(occurrence_json(occ));
        }
    }

    for ((from, to, kind), positions) in occurrence_groups {
        semantic_edges.push(SemanticEdge {
            stable_id: semantic_edge_id(&from, &to, kind, provider.id()),
            from_node: from,
            to_node: to,
            kind,
            provider: EvidenceProviderKind::Scip,
            provider_fingerprint: fingerprint.digest.clone(),
            strength: EvidenceStrength::Precise,
            source_identity: None,
            source_hash: None,
            generation: new_generation,
            metadata: Some(serde_json::to_string(&positions).unwrap_or_else(|_| "[]".to_string())),
        });
    }

    // EXPORTS: the dual of a cross-package IMPORT. When file F2 (package B)
    // imports symbol S defined in file F1 (package A != B), F1 exports S.
    // Only produced from real cross-package import evidence, never invented.
    let mut export_keys: std::collections::HashSet<(String, String)> =
        std::collections::HashSet::new();
    for p in &plan {
        let doc = &index.documents[p.doc_index];
        for occ in &doc.occurrences {
            if !occ.symbol_roles.is_import() || occ.symbol.is_empty() {
                continue;
            }
            let importer_pkg = package_id_of(&occ.symbol).unwrap_or_default();
            if let Some(definer) = symbol_defining_file.get(&occ.symbol) {
                let definer_pkg = package_id_of(&occ.symbol).unwrap_or_default();
                if definer != &p.canonical
                    && importer_pkg != definer_pkg
                    && !importer_pkg.is_empty()
                {
                    let file_node = format!("{}{}", FILE_NODE_PREFIX, definer);
                    let symbol_node = semantic_symbol_node_id(definer, &occ.symbol);
                    if export_keys.insert((file_node.clone(), symbol_node.clone())) {
                        semantic_edges.push(SemanticEdge {
                            stable_id: semantic_edge_id(
                                &file_node,
                                &symbol_node,
                                EdgeKind::Exports,
                                provider.id(),
                            ),
                            from_node: file_node,
                            to_node: symbol_node,
                            kind: EdgeKind::Exports,
                            provider: EvidenceProviderKind::Scip,
                            provider_fingerprint: fingerprint.digest.clone(),
                            strength: EvidenceStrength::Precise,
                            source_identity: None,
                            source_hash: None,
                            generation: new_generation,
                            metadata: None,
                        });
                    }
                }
            }
        }
    }

    // Deduplicate node inserts by stable id (keep first).
    let mut seen_nodes: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut dedup_nodes: Vec<SemanticNode> = Vec::new();
    for n in semantic_nodes {
        if seen_nodes.insert(n.stable_id.clone()) {
            dedup_nodes.push(n);
        }
    }

    // 2. Publish transactionally (old generation is replaced atomically).
    let tx = TransactionalGraph::new(&mut db.conn)?;
    tx.replace_provider_evidence(provider.id())?;

    for p in &plan {
        let absolute = repo_root.join(&p.canonical);
        let bytes = std::fs::read(&absolute)?;
        let file_model = IndexedFile {
            canonical_path: p.canonical.clone(),
            content_hash: sha256_hex(&bytes),
            size: bytes.len() as u64,
            mtime_ms: None,
            language: Some(p.language.as_str().to_string()),
            indexed_at: now_ms(),
        };
        tx.upsert_file_row(&file_model)?;
    }

    for node in &dedup_nodes {
        if node.stable_id.starts_with(FILE_NODE_PREFIX) {
            let canonical = node.canonical_path.clone().unwrap_or_default();
            let language = node.metadata.as_deref().and_then(|m| {
                serde_json::from_str::<serde_json::Value>(m)
                    .ok()
                    .and_then(|v| v.get("language").cloned())
                    .and_then(|v| v.as_str().map(|s| s.to_string()))
            });
            tx.insert_shared_file_node(&canonical, language.as_deref())?;
        } else {
            tx.insert_semantic_node(node)?;
        }
    }
    for edge in &semantic_edges {
        tx.insert_semantic_edge(edge)?;
    }

    let new_state = ProviderState {
        identity: ProviderIdentity {
            provider_id: provider.id().to_string(),
            provider_type: provider.provider_type(),
            provider_version: fingerprint.provider_version.clone(),
            executable_identity: fingerprint.executable_identity.clone(),
            scip_schema_version: fingerprint.scip_schema_version.clone(),
        },
        scope: scope.clone(),
        fingerprint: fingerprint.clone(),
        health: ProviderHealth::Available,
        freshness: ProviderFreshness::Fresh,
        last_successful_run: Some(now_ms()),
        output_digest: Some(result.output_digest.clone()),
        failure_reason: None,
        semantic_generation: new_generation,
    };
    state::upsert_provider_state(&tx, &new_state)?;
    tx.commit()?;

    Ok(IngestReport {
        provider_id: provider.id().to_string(),
        skipped: false,
        documents: index.documents.len(),
        occurrences: index.occurrence_count(),
        symbols: index
            .documents
            .iter()
            .map(|d| d.symbols.len())
            .sum::<usize>(),
        nodes: dedup_nodes.len(),
        edges: semantic_edges.len(),
        generation: new_generation,
        output_digest: Some(result.output_digest.clone()),
        tool_name: result.tool_name.clone(),
        tool_version: result.tool_version.clone(),
        provider_runtime_ms: result.provider_runtime_ms,
    })
}

struct DocPlan {
    canonical: String,
    language: LanguageId,
    file_node: String,
    doc_index: usize,
}

fn doc_language(doc: &ScipDocument) -> Result<LanguageId, IngestError> {
    LanguageId::from_str_opt(&doc.language)
        .ok_or_else(|| IngestError::UnknownLanguage(doc.language.clone()))
}

/// Jail a document path: rejects absolute paths, URL-ish paths, any ..
/// component, and Windows-style separators up front; then canonicalizes the
/// resolved path (refusing symlink escapes) and re-validates against the
/// repository jail.
fn jail_document_path(repo_root: &Path, relative_path: &str) -> Result<String, IngestError> {
    if relative_path.starts_with('/')
        || relative_path.contains("://")
        || relative_path.contains("..")
        || relative_path.contains('\\')
    {
        return Err(IngestError::PathJail(relative_path.to_string()));
    }
    let candidate = repo_root.join(relative_path);
    let canonical = std::fs::canonicalize(&candidate)
        .map_err(|_| IngestError::PathJail(relative_path.to_string()))?;
    let canonical_str = canonicalize_repo_path(&canonical, repo_root)
        .map_err(|e| IngestError::PathJail(format!("{}: {}", relative_path, e)))?;
    Ok(canonical_str)
}

fn occurrence_json(occ: &ScipOccurrence) -> serde_json::Value {
    match occ.range {
        Some(r) => serde_json::json!({
            "start_line": r.start_line,
            "start_character": r.start_character,
            "end_line": r.end_line,
            "end_character": r.end_character,
        }),
        None => serde_json::json!({}),
    }
}

/// Stable node id for a symbol: the SCIP canonical symbol string, or a
/// document-scoped id for local symbols. Never line/byte-position based.
fn semantic_symbol_node_id(doc_path: &str, symbol: &str) -> String {
    if is_local_symbol(symbol) {
        format!("sem:local:{}:{}", doc_path, symbol)
    } else {
        format!("sem:{}", symbol)
    }
}

fn semantic_edge_id(from: &str, to: &str, kind: EdgeKind, provider_id: &str) -> String {
    let kind_str = serde_json::to_string(&kind)
        .unwrap_or_else(|_| "unknown".to_string())
        .trim_matches('"')
        .to_string();
    format!("se:{}:{}:{}:{}", from, to, kind_str, provider_id)
}

fn json_str_or_null(s: Option<&str>) -> String {
    match s {
        Some(v) => serde_json::to_string(v).unwrap_or_else(|_| "null".to_string()),
        None => "null".to_string(),
    }
}

fn make_symbol_edge(
    from: &str,
    to: &str,
    kind: EdgeKind,
    provider: &dyn SemanticProvider,
    fingerprint: &ProviderFingerprint,
    generation: u64,
) -> SemanticEdge {
    SemanticEdge {
        stable_id: semantic_edge_id(from, to, kind, provider.id()),
        from_node: from.to_string(),
        to_node: to.to_string(),
        kind,
        provider: EvidenceProviderKind::Scip,
        provider_fingerprint: fingerprint.digest.clone(),
        strength: EvidenceStrength::Precise,
        source_identity: None,
        source_hash: None,
        generation,
        metadata: None,
    }
}

fn ensure_package_node(
    package_nodes: &mut HashMap<String, String>,
    semantic_nodes: &mut Vec<SemanticNode>,
    pkg: &str,
    provider: &dyn SemanticProvider,
    fingerprint: &ProviderFingerprint,
    generation: u64,
) {
    if !package_nodes.contains_key(pkg) {
        let package_node_id = format!("pkg:{}", pkg);
        package_nodes.insert(pkg.to_string(), package_node_id.clone());
        semantic_nodes.push(SemanticNode {
            stable_id: package_node_id,
            kind: NodeKind::Package,
            canonical_path: None,
            symbol_identity: None,
            package_identity: Some(pkg.to_string()),
            metadata: None,
            provider: provider.id().to_string(),
            provider_fingerprint: fingerprint.digest.clone(),
            generation,
            source_hash: None,
        });
    }
}

/// Parse a global SCIP symbol into (scheme, manager, name, version).
fn parse_symbol_parts(symbol: &str) -> Option<(&str, &str, &str, &str)> {
    if is_local_symbol(symbol) {
        return None;
    }
    let mut parts = symbol.split(' ');
    let scheme = parts.next()?;
    if scheme.is_empty() || scheme == "local" {
        return None;
    }
    let manager = parts.next()?;
    let name = parts.next()?;
    let version = parts.next()?;
    Some((scheme, manager, name, version))
}

fn package_node_id_for_symbol(symbol: &str) -> Option<String> {
    package_id_of(symbol).map(|p| format!("pkg:{}", p))
}

fn package_id_of(symbol: &str) -> Option<String> {
    let (_scheme, manager, name, version) = parse_symbol_parts(symbol)?;
    if name.is_empty() || name == "." || manager.is_empty() || manager == "." {
        return None;
    }
    Some(format!("{}:{}:{}", manager, name, version))
}

struct ProviderStateForPersist {
    provider_id: String,
    scope: ProviderScope,
    fingerprint: ProviderFingerprint,
    health: ProviderHealth,
    freshness: ProviderFreshness,
    failure_reason: Option<String>,
}

impl ProviderStateForPersist {
    fn into_state(self) -> ProviderState {
        ProviderState {
            identity: ProviderIdentity {
                provider_id: self.provider_id.clone(),
                provider_type: ProviderType::Scip,
                provider_version: self.fingerprint.provider_version.clone(),
                executable_identity: self.fingerprint.executable_identity.clone(),
                scip_schema_version: self.fingerprint.scip_schema_version.clone(),
            },
            scope: self.scope,
            fingerprint: self.fingerprint,
            health: self.health,
            freshness: self.freshness,
            last_successful_run: None,
            output_digest: None,
            failure_reason: self.failure_reason,
            semantic_generation: 0,
        }
    }
}

fn fingerprint_default(provider: &dyn SemanticProvider) -> ProviderFingerprint {
    ProviderFingerprint::compute("unknown", provider.id(), "0.1.0", None, "unknown")
}

fn fingerprint_unknown(provider_id: &str) -> ProviderFingerprint {
    ProviderFingerprint::compute("unknown", provider_id, "0.1.0", None, "unknown")
}

fn load_or_default_state(
    db: &EvidenceDatabase,
    provider_id: &str,
    scope: ProviderScope,
    fingerprint: ProviderFingerprint,
) -> Option<ProviderState> {
    state::load_provider_state(db, provider_id)
        .ok()
        .flatten()
        .or_else(|| Some(default_state(provider_id, scope, fingerprint)))
}

fn default_state(
    provider_id: &str,
    scope: ProviderScope,
    fingerprint: ProviderFingerprint,
) -> ProviderState {
    ProviderState {
        identity: ProviderIdentity {
            provider_id: provider_id.to_string(),
            provider_type: ProviderType::Scip,
            provider_version: fingerprint.provider_version.clone(),
            executable_identity: fingerprint.executable_identity.clone(),
            scip_schema_version: fingerprint.scip_schema_version.clone(),
        },
        scope,
        fingerprint,
        health: ProviderHealth::Missing,
        freshness: ProviderFreshness::Absent,
        last_successful_run: None,
        output_digest: None,
        failure_reason: None,
        semantic_generation: 0,
    }
}

fn persisted_with_failure(
    persisted: Option<ProviderState>,
    provider_id: &str,
    scope: ProviderScope,
    err: &SemanticProviderError,
) -> ProviderState {
    let mut state = persisted
        .unwrap_or_else(|| default_state(provider_id, scope, fingerprint_unknown(provider_id)));
    match &err {
        SemanticProviderError::Missing(_) => {
            state.health = ProviderHealth::Missing;
            state.freshness = ProviderFreshness::Absent;
        }
        SemanticProviderError::TimedOut(_) => {
            state.health = ProviderHealth::TimedOut;
            state.freshness = ProviderFreshness::Unknown;
        }
        _ => {
            state.health = ProviderHealth::Failed;
            state.freshness = ProviderFreshness::Unknown;
        }
    }
    state.failure_reason = Some(err.to_string());
    state
}

fn persist_failure_state(
    repo_root: &Path,
    persisted: &Option<ProviderState>,
    provider_id: &str,
    scope: ProviderScope,
    fingerprint: ProviderFingerprint,
    err: &SemanticProviderError,
) -> Result<(), IngestError> {
    let mut fail_state = persisted_with_failure(persisted.clone(), provider_id, scope, err);
    fail_state.fingerprint = fingerprint;
    let mut db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadWrite)?;
    let tx = TransactionalGraph::new(&mut db.conn)?;
    state::upsert_provider_state(&tx, &fail_state)?;
    tx.commit()?;
    Ok(())
}
