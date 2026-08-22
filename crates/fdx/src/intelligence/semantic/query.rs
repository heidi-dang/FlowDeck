//! Semantic reference queries with explicit provenance/completeness.
//!
//! Every result retains provider, strength, source identity/hash, provider
//! fingerprint and scope, and completeness is categorical. A missing/stale/
//! failed provider never yields "no references exist": alongside absence of
//! evidence the completeness degrades explicitly.

use crate::intelligence::db::EvidenceDatabase;
use crate::intelligence::semantic::fallback::{
    structural_references, FallbackReference, FallbackRole,
};
use crate::intelligence::semantic::provider::ProviderState;
use crate::intelligence::semantic::router::{
    plan_routing, Completeness, EvidenceSource, IntelligenceIntent,
};
use crate::intelligence::semantic::state;
use crate::intelligence::semantic::LanguageId;
use crate::protocol::EvidenceStrength;
use std::path::Path;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SemanticReference {
    pub symbol: String,
    pub display_name: Option<String>,
    pub path: String,
    pub start_line: u32,
    pub start_character: u32,
    pub end_line: u32,
    pub end_character: u32,
    pub role: OccurrenceRole,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OccurrenceRole {
    Definition,
    Reference,
    Import,
}

impl OccurrenceRole {
    pub fn as_str(self) -> &'static str {
        match self {
            OccurrenceRole::Definition => "definition",
            OccurrenceRole::Reference => "reference",
            OccurrenceRole::Import => "import",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvidenceProvenance {
    pub provider: Option<String>,
    pub provider_fingerprint: Option<String>,
    pub strength: EvidenceStrength,
    pub source_identity: Option<String>,
    pub source_hash: Option<String>,
    pub degraded: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReferenceResult {
    pub references: Vec<SemanticReference>,
    pub provenance: EvidenceProvenance,
    pub completeness: Completeness,
    pub intent: IntelligenceIntent,
    pub source: EvidenceSource,
}

#[derive(Debug, Error)]
pub enum QueryError {
    #[error("database error: {0}")]
    Db(#[from] crate::intelligence::db::DatabaseError),
    #[error("fallback error: {0}")]
    Fallback(#[from] crate::intelligence::semantic::fallback::FallbackError),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
}
/// Resolved SCIP reference set: (references, provider id, provider fingerprint).
type ScipResolved = (Vec<SemanticReference>, String, Option<String>);

/// Resolve the SCIP graph reference set for a symbol: the symbol node plus
/// incoming semantic edges with occurrence positions. Returns the provider
/// that produced the node so provenance stays precise.
fn query_scip(db: &EvidenceDatabase, symbol: &str) -> Result<Option<ScipResolved>, QueryError> {
    let mut stmt = db.conn.prepare(
        "SELECT stable_id, metadata, provider, provider_fingerprint FROM nodes
         WHERE symbol_identity = ?1 AND stale = 0 AND provider IS NOT NULL
         LIMIT 1",
    )?;
    let mut rows = stmt.query_map(rusqlite::params![symbol], |row| {
        let id: String = row.get(0)?;
        let meta: Option<String> = row.get(1)?;
        let provider: Option<String> = row.get(2)?;
        let fp: Option<String> = row.get(3)?;
        Ok((id, meta, provider, fp))
    })?;
    let Some((node_id, symbol_meta, provider, fp)) = rows.next().transpose()? else {
        return Ok(None); // symbol not in graph: not negative evidence
    };
    let mut stmt = db.conn.prepare(
        r#"SELECT e.kind, e.metadata, n2.canonical_path
         FROM edges e
         JOIN nodes n2 ON n2.stable_id = e.from_node
         WHERE e.to_node = ?1 AND e.provider = 'scip' AND e.stale = 0
         ORDER BY n2.canonical_path"#,
    )?;
    let rows = stmt.query_map(rusqlite::params![node_id], |row| {
        let kind: String = row.get(0)?;
        let meta: Option<String> = row.get(1)?;
        let canon: Option<String> = row.get(2)?;
        Ok((kind, meta, canon))
    })?;
    let mut references: Vec<SemanticReference> = Vec::new();
    for r in rows.flatten() {
        let (kind, meta, canon) = r;
        let path = canon.unwrap_or_default();
        let role = match kind.as_str() {
            "imports" => OccurrenceRole::Import,
            "defines" => OccurrenceRole::Definition,
            _ => OccurrenceRole::Reference,
        };
        let positions = parse_edge_metadata(meta.as_deref());
        if positions.is_empty() {
            references.push(SemanticReference {
                symbol: symbol.to_string(),
                display_name: parse_display_name(symbol_meta.as_deref()),
                path: path.clone(),
                start_line: 0,
                start_character: 0,
                end_line: 0,
                end_character: 0,
                role,
            });
        }
        for pos in positions {
            references.push(SemanticReference {
                symbol: symbol.to_string(),
                display_name: parse_display_name(symbol_meta.as_deref()),
                path: path.clone(),
                start_line: pos.start_line,
                start_character: pos.start_character,
                end_line: pos.end_line,
                end_character: pos.end_character,
                role,
            });
        }
    }
    Ok(Some((references, provider.unwrap_or_default(), fp)))
}

fn parse_display_name(meta: Option<&str>) -> Option<String> {
    let m = meta?;
    let v: serde_json::Value = serde_json::from_str(m).ok()?;
    v.get("display_name")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
}

struct Position {
    start_line: u32,
    start_character: u32,
    end_line: u32,
    end_character: u32,
}

fn parse_edge_metadata(meta: Option<&str>) -> Vec<Position> {
    let Some(m) = meta else { return Vec::new() };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(m) else {
        return Vec::new();
    };
    let Some(arr) = v.as_array() else {
        return Vec::new();
    };
    arr.iter()
        .map(|item| Position {
            start_line: item.get("start_line").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
            start_character: item
                .get("start_character")
                .and_then(|x| x.as_u64())
                .unwrap_or(0) as u32,
            end_line: item.get("end_line").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
            end_character: item
                .get("end_character")
                .and_then(|x| x.as_u64())
                .unwrap_or(0) as u32,
        })
        .collect()
}
fn structural_query(
    repo_root: &Path,
    lang: LanguageId,
    symbol: &str,
    intent: IntelligenceIntent,
) -> Result<ReferenceResult, QueryError> {
    let refs = structural_references(repo_root, lang, symbol)?;
    let references: Vec<SemanticReference> = refs.iter().map(fallback_to_semantic).collect();
    Ok(ReferenceResult {
        references,
        provenance: EvidenceProvenance {
            provider: None,
            provider_fingerprint: None,
            strength: EvidenceStrength::Structural,
            source_identity: None,
            source_hash: None,
            degraded: true,
        },
        completeness: Completeness::Conservative,
        intent,
        source: EvidenceSource::TreeSitter,
    })
}

fn fallback_to_semantic(r: &FallbackReference) -> SemanticReference {
    SemanticReference {
        symbol: r.name.clone(),
        display_name: Some(r.name.clone()),
        path: r.canonical_path.clone(),
        start_line: r.start_line,
        start_character: r.start_character,
        end_line: r.start_line,
        end_character: r.end_character,
        role: match r.role {
            FallbackRole::Definition => OccurrenceRole::Definition,
            FallbackRole::Reference => OccurrenceRole::Reference,
        },
    }
}

/// Query references for a symbol with the given intent, honoring routing.
pub fn query_references(
    repo_root: &Path,
    db: &EvidenceDatabase,
    lang: LanguageId,
    symbol: &str,
    intent: IntelligenceIntent,
) -> Result<ReferenceResult, QueryError> {
    let states: Vec<ProviderState> = state::load_provider_states(db)?;
    let plan = plan_routing(intent, lang, &states);

    match plan.primary {
        EvidenceSource::Scip => {
            if let Some((scip_refs, provider, fp)) = query_scip(db, symbol)? {
                return Ok(ReferenceResult {
                    references: scip_refs,
                    provenance: EvidenceProvenance {
                        provider: if provider.is_empty() {
                            None
                        } else {
                            Some(provider)
                        },
                        provider_fingerprint: fp,
                        strength: EvidenceStrength::Precise,
                        source_identity: None,
                        source_hash: None,
                        degraded: false,
                    },
                    completeness: plan.completeness_cap,
                    intent,
                    source: EvidenceSource::Scip,
                });
            }
            // Symbol not present in a fresh provider graph: do NOT claim
            // absence; degrade to structural evidence.
            structural_query(repo_root, lang, symbol, intent)
        }
        EvidenceSource::TreeSitter => structural_query(repo_root, lang, symbol, intent),
        EvidenceSource::Lexical => {
            let references = lexical_scan(repo_root, lang, symbol)?;
            Ok(ReferenceResult {
                references,
                provenance: EvidenceProvenance {
                    provider: None,
                    provider_fingerprint: None,
                    strength: EvidenceStrength::Heuristic,
                    source_identity: None,
                    source_hash: None,
                    degraded: true,
                },
                completeness: Completeness::Partial,
                intent,
                source: EvidenceSource::Lexical,
            })
        }
    }
}
const MAX_LEXICAL_FILES: usize = 500;
const MAX_LEXICAL_MATCHES: usize = 5000;

fn lexical_scan(
    repo_root: &Path,
    lang: LanguageId,
    symbol: &str,
) -> Result<Vec<SemanticReference>, QueryError> {
    let mut results: Vec<SemanticReference> = Vec::new();
    let mut files_processed = 0usize;
    let mut stack = vec![repo_root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.components().any(|c| {
                c.as_os_str() == ".git"
                    || c.as_os_str() == ".fdx"
                    || c.as_os_str() == "target"
                    || c.as_os_str() == "node_modules"
            }) {
                continue;
            }
            if results.len() >= MAX_LEXICAL_MATCHES {
                return Ok(results);
            }
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if files_processed >= MAX_LEXICAL_FILES {
                return Ok(results);
            }
            let ext_ok = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| lang.extensions().contains(&e))
                .unwrap_or(false);
            if !ext_ok {
                continue;
            }
            if std::fs::metadata(&path)
                .map(|m| m.len() > 2 * 1024 * 1024)
                .unwrap_or(true)
            {
                continue;
            }
            let source = match std::fs::read_to_string(&path) {
                Ok(s) => s,
                Err(_) => continue,
            };
            let canonical = match crate::protocol::canonicalize_repo_path(&path, repo_root) {
                Ok(c) => c,
                Err(_) => continue,
            };
            files_processed += 1;
            for (i, line) in source.lines().enumerate() {
                if results.len() >= MAX_LEXICAL_MATCHES {
                    return Ok(results);
                }
                if line.contains(symbol) {
                    let start = line.find(symbol).unwrap_or(0) as u32;
                    results.push(SemanticReference {
                        symbol: symbol.to_string(),
                        display_name: Some(symbol.to_string()),
                        path: canonical.clone(),
                        start_line: (i + 1) as u32,
                        start_character: start,
                        end_line: (i + 1) as u32,
                        end_character: start + symbol.len() as u32,
                        role: OccurrenceRole::Reference,
                    });
                }
            }
        }
    }
    Ok(results)
}
