//! BuildConfigProvider abstraction and provider registry.

use crate::intelligence::build::model::*;
use crate::intelligence::build::uncertainty::BuildUncertainty;
use crate::intelligence::semantic::health::{ProviderFreshness, ProviderHealth};
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildProviderScope {
    pub workspace_root: String,
    pub manifest_files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct BuildProviderState {
    pub provider_id: String,
    pub provider_type: String,
    pub provider_version: String,
    pub workspace_root: String,
    pub fingerprint: String,
    pub health: ProviderHealth,
    pub freshness: ProviderFreshness,
    pub last_successful_run: Option<u64>,
    pub failure_reason: Option<String>,
    pub generation: u64,
}

#[derive(Debug, Clone, Default)]
pub struct BuildIngestResult {
    pub workspaces: Vec<Workspace>,
    pub packages: Vec<Package>,
    pub targets: Vec<BuildTarget>,
    pub configs: Vec<ConfigFile>,
    pub artifacts: Vec<GeneratedArtifact>,
    pub external_dependencies: Vec<ExternalDependency>,
    pub nodes: Vec<BuildNode>,
    pub edges: Vec<BuildEdge>,
    pub uncertainties: Vec<BuildUncertainty>,
    pub fingerprint: String,
}

pub trait BuildConfigProvider: Send + Sync {
    fn id(&self) -> &'static str;
    fn detect(&self, repo_root: &Path) -> bool;
    fn scope(&self, repo_root: &Path) -> BuildProviderScope;
    fn passive_fingerprint(&self, repo_root: &Path) -> Result<String, String>;
    fn ingest(&self, repo_root: &Path) -> Result<BuildIngestResult, String>;
}

/// Compute SHA-256 digest of concatenated file contents for passive fingerprinting.
pub fn hash_files(repo_root: &Path, file_paths: &[String], provider_version: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(provider_version.as_bytes());
    hasher.update(b"\0");

    let mut sorted = file_paths.to_vec();
    sorted.sort();

    for p in sorted {
        hasher.update(p.as_bytes());
        hasher.update(b"\0");
        let full = repo_root.join(&p);
        if let Ok(content) = std::fs::read(&full) {
            hasher.update(&content);
        } else {
            hasher.update(b"__MISSING__");
        }
        hasher.update(b"\0");
    }

    format!("{:x}", hasher.finalize())
}
