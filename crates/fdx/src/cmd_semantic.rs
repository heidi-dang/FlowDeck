//! fdx semantic CLI operations (status, refresh, decode, references).
//!
//! Deliberately minimal: diagnostics + explicit provider refresh. Queries
//! never execute providers and never create semantic state.

use crate::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use crate::intelligence::semantic::health::ProviderHealth;
use crate::intelligence::semantic::ingest::refresh_provider;
use crate::intelligence::semantic::provider::ProviderState;
use crate::intelligence::semantic::query::query_references;
use crate::intelligence::semantic::registry::ProviderRegistry;
use crate::intelligence::semantic::router::IntelligenceIntent;
use crate::intelligence::semantic::scip::decoder::decode_index;
use crate::intelligence::semantic::scip::model::ScipIndex;
use crate::intelligence::semantic::state;
use crate::intelligence::semantic::LanguageId;
use std::path::Path;
use std::time::Instant;

/// Render the semantic provider status table.
pub fn semantic_status(repo_root: &Path) -> Result<String, String> {
    let db = match EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly) {
        Ok(d) => d,
        // No database yet is a truthful "no providers" state, not an error.
        Err(crate::intelligence::db::DatabaseError::NotIndexed) => {
            return Ok("SEMANTIC no providers
"
            .to_string());
        }
        Err(e) => return Err(format!("cannot open evidence database: {}", e)),
    };
    let states = state::load_provider_states(&db).map_err(|e| e.to_string())?;
    let (nodes, edges) = state::count_semantic_evidence(&db).map_err(|e| e.to_string())?;
    let mut out = String::new();
    for s in &states {
        render_provider(&mut out, s);
    }
    if states.is_empty() {
        out.push_str("SEMANTIC no providers\n");
    } else {
        out.push_str(&format!(
            "SEMANTIC providers={} nodes={} edges={}\n",
            states.len(),
            nodes,
            edges
        ));
    }
    Ok(out)
}

fn render_provider(out: &mut String, s: &ProviderState) {
    out.push_str(&format!("provider={}\n", s.provider_id()));
    out.push_str(&format!("  type={}\n", s.identity.provider_type.as_str()));
    out.push_str(&format!("  version={}\n", s.identity.provider_version));
    out.push_str(&format!(
        "  executable={}\n",
        s.identity.executable_identity
    ));
    out.push_str(&format!("  health={}\n", s.health.as_str()));
    out.push_str(&format!("  freshness={}\n", s.freshness.as_str()));
    out.push_str(&format!("  fingerprint={}\n", s.fingerprint.digest));
    out.push_str(&format!("  scope_root={}\n", s.scope.workspace_root));
    out.push_str(&format!(
        "  scope_package={}\n",
        s.scope.package.clone().unwrap_or_default()
    ));
    out.push_str(&format!(
        "  languages={}\n",
        s.scope
            .languages
            .iter()
            .map(|l| l.as_str())
            .collect::<Vec<_>>()
            .join(",")
    ));
    out.push_str(&format!(
        "  last_success={}\n",
        s.last_successful_run
            .map(|v| v.to_string())
            .unwrap_or_else(|| "none".to_string())
    ));
    out.push_str(&format!("  generation={}\n", s.semantic_generation));
    out.push_str(&format!(
        "  reason={}\n",
        s.failure_reason
            .clone()
            .unwrap_or_else(|| "none".to_string())
    ));
}
/// Refresh providers for the repository.
pub fn semantic_refresh(
    repo_root: &Path,
    provider_filter: Option<&str>,
) -> Result<(String, bool), String> {
    let registry = ProviderRegistry::new();
    let mut out = String::new();
    let mut any_failure = false;
    for provider in registry.providers() {
        if let Some(filter) = provider_filter {
            if provider.id() != filter {
                continue;
            }
        }
        match provider.health(repo_root) {
            ProviderHealth::Unsupported => {
                out.push_str(&format!("SEMANTIC {} unsupported\n", provider.id()));
                continue;
            }
            _ => {}
        }
        match refresh_provider(repo_root, provider, false) {
            Ok(report) if report.skipped => {
                out.push_str(&format!("SEMANTIC {} fresh (skipped)\n", provider.id()));
            }
            Ok(report) => {
                out.push_str(&format!(
                    "SEMANTIC {} fresh documents={} occurrences={} nodes={} edges={} generation={} runtime_ms={}\n",
                    provider.id(),
                    report.documents,
                    report.occurrences,
                    report.nodes,
                    report.edges,
                    report.generation,
                    report.provider_runtime_ms,
                ));
            }
            Err(e) => {
                out.push_str(&format!("SEMANTIC {} failed: {}\n", provider.id(), e));
                any_failure = true;
            }
        }
    }
    Ok((out, any_failure))
}
/// Decode an SCIP file and report bounded statistics.
pub fn semantic_decode(_repo_root: &Path, file: &Path) -> Result<String, String> {
    let bytes = std::fs::read(file).map_err(|e| format!("read {}: {}", file.display(), e))?;
    let started = Instant::now();
    let index: ScipIndex = decode_index(&bytes).map_err(|e| e.to_string())?;
    let elapsed_ms = started.elapsed().as_millis();
    let symbols = index
        .documents
        .iter()
        .map(|d| d.symbols.len())
        .sum::<usize>();
    Ok(format!(
        "docs={} occurrences={} symbols={} bytes={} decode_ms={}\n",
        index.document_count(),
        index.occurrence_count(),
        symbols,
        bytes.len(),
        elapsed_ms
    ))
}

/// Reference query with routing provenance.
pub fn semantic_references(
    repo_root: &Path,
    lang: LanguageId,
    symbol: &str,
    intent: IntelligenceIntent,
) -> Result<String, String> {
    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly).ok();
    let result = query_references(repo_root, db.as_ref(), lang, symbol, intent)
        .map_err(|e| e.to_string())?;
    let mut out = String::new();
    out.push_str(&format!(
        "source={:?} completeness={:?} strength={:?} degraded={}\n",
        result.source, result.completeness, result.provenance.strength, result.provenance.degraded,
    ));
    out.push_str(&format!(
        "provider={}\n",
        result
            .provenance
            .provider
            .clone()
            .unwrap_or_else(|| "none".to_string())
    ));
    for r in &result.references {
        out.push_str(&format!(
            "{}:{}:{} {} {}\n",
            r.path,
            r.start_line,
            r.start_character,
            r.role.as_str(),
            r.display_name.clone().unwrap_or_default(),
        ));
    }
    Ok(out)
}
