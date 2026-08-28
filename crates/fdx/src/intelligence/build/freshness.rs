//! Passive effective freshness evaluation for build and config providers.

use crate::intelligence::build::config::TsConfigProvider;
use crate::intelligence::build::package::PackageJsonProvider;
use crate::intelligence::build::provider::{
    BuildConfigProvider, BuildProviderState, ProviderDetection,
};
use crate::intelligence::build::scope::UncertaintyScope;
use crate::intelligence::build::target::CargoProvider;
use crate::intelligence::build::uncertainty::BuildUncertainty;
use crate::intelligence::db::{DatabaseError, DatabaseOpenMode, EvidenceDatabase};
use crate::intelligence::semantic::health::{ProviderFreshness, ProviderHealth};
use crate::protocol::AssuranceLevel;
use std::path::Path;

pub fn get_build_providers() -> Vec<Box<dyn BuildConfigProvider>> {
    vec![
        Box::new(PackageJsonProvider::new()),
        Box::new(TsConfigProvider::new()),
        Box::new(CargoProvider::new()),
    ]
}

/// Collect scoped build uncertainties across all detected providers passively.
pub fn collect_build_uncertainties(repo_root: &Path) -> Vec<BuildUncertainty> {
    let mut uncertainties = Vec::new();
    for prov in get_build_providers() {
        match prov.detect_state(repo_root) {
            ProviderDetection::Absent => continue,
            ProviderDetection::Indeterminate(err) => {
                uncertainties.push(BuildUncertainty::new(
                    "provider_detection_failed",
                    UncertaintyScope::Repository,
                    prov.id(),
                    format!("Provider {} detection error: {}", prov.id(), err),
                    AssuranceLevel::Degraded,
                    true,
                ));
                continue;
            }
            ProviderDetection::Present => {}
        }

        match prov.ingest(repo_root) {
            Ok(res) => {
                uncertainties.extend(res.uncertainties);
            }
            Err(err) => {
                uncertainties.push(BuildUncertainty::new(
                    "provider_ingest_failed",
                    UncertaintyScope::Repository,
                    prov.id(),
                    format!("Provider {} ingest failed: {}", prov.id(), err),
                    AssuranceLevel::Degraded,
                    true,
                ));
            }
        }
    }
    uncertainties
}

/// Passive evaluation of build provider freshness against persisted state.
/// Pure read-only operation: no shell executions, no database mutations.
pub fn evaluate_build_freshness(repo_root: &Path) -> Result<Vec<BuildProviderState>, String> {
    let db_opt = match EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly) {
        Ok(db) => Some(db),
        Err(DatabaseError::NotIndexed) => None,
        Err(e) => return Err(format!("cannot open database: {}", e)),
    };

    let providers = get_build_providers();
    let mut states = Vec::new();

    for prov in providers {
        if !prov.detect(repo_root) {
            continue;
        }

        let pid = prov.id();
        let current_fp = prov.passive_fingerprint(repo_root).unwrap_or_default();
        let scope = prov.scope(repo_root);

        let mut persisted_fp: Option<String> = None;
        let mut last_success: Option<u64> = None;
        let mut generation = 0u64;

        if let Some(ref db) = db_opt {
            let row_res: Result<(String, Option<i64>, i64), _> = db.conn.query_row(
                "SELECT input_fingerprint, last_successful_run, semantic_generation FROM semantic_providers WHERE provider_id = ?1",
                rusqlite::params![pid],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            );

            if let Ok((pfp, lsucc, gen)) = row_res {
                persisted_fp = Some(pfp);
                last_success = lsucc.map(|v| v as u64);
                generation = gen as u64;
            }
        }

        let (freshness, health) = match persisted_fp {
            Some(ref pfp) if pfp == &current_fp => {
                (ProviderFreshness::Fresh, ProviderHealth::Available)
            }
            Some(_) => (ProviderFreshness::Stale, ProviderHealth::Available),
            None => (ProviderFreshness::Stale, ProviderHealth::Misconfigured),
        };

        states.push(BuildProviderState {
            provider_id: pid.to_string(),
            provider_type: "build_native".to_string(),
            provider_version: "1.0.0".to_string(),
            workspace_root: scope.workspace_root,
            fingerprint: current_fp,
            health,
            freshness,
            last_successful_run: last_success,
            failure_reason: None,
            generation,
        });
    }

    Ok(states)
}
