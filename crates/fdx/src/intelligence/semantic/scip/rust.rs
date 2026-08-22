//! Rust provider adapter.
//!
//! Discovery: PATH lookup for `scip-rust` (the standard SCIP indexer for
//! Rust, a shim around `rust-analyzer scip`), falling back to
//! `rust-analyzer` directly. Override with `SCIP_RUST_BIN`. No download.
//!
//! Invocation contracts (pinned against the published indexers):
//! - `scip-rust --output <out>`  (scip-rust shim forwards args to rust-analyzer)
//! - `rust-analyzer scip --output <out>` (direct)
//!
//! Non-Rust repositories are unsupported; a missing executable is reported as
//! MISSING, never auto-installed.
//!
//! Fingerprint inputs: executable identity + version, SCIP schema version,
//! and relevant resolution configuration (Cargo.toml, Cargo.lock, workspace
//! Cargo.toml, rust-toolchain).

use crate::intelligence::semantic::health::ProviderHealth;
use crate::intelligence::semantic::provider::{
    find_executable, fingerprint_config_files, run_bounded_process, ExecFailure,
    ProviderFingerprint, ProviderScope, SemanticIngestRequest, SemanticIngestResult,
    SemanticProvider, SemanticProviderDiscovery, SemanticProviderError,
};
use crate::intelligence::semantic::scip::probe_version;
use crate::intelligence::semantic::scip::SCIP_SCHEMA_VERSION;
use crate::intelligence::semantic::LanguageId;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub const PROVIDER_ID: &str = "scip-rust";

/// Rust-related configuration files that change resolution semantics.
pub const CONFIG_FILES: &[&str] = &[
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain",
    "rust-toolchain.toml",
];

fn executable_override() -> Option<PathBuf> {
    std::env::var_os("SCIP_RUST_BIN").map(PathBuf::from)
}

/// (executable, args-prefix before --output)
fn resolve_invocation() -> Option<(PathBuf, Vec<String>)> {
    if let Some(bin) = executable_override() {
        if bin.is_file() {
            return Some((bin, Vec::new()));
        }
    }
    if let Some(bin) = find_executable("scip-rust") {
        return Some((bin, Vec::new()));
    }
    if let Some(bin) = find_executable("rust-analyzer") {
        return Some((bin, vec!["scip".to_string()]));
    }
    None
}

#[derive(Debug, Default)]
pub struct ScipRustProvider;

impl ScipRustProvider {
    pub fn new() -> Self {
        Self
    }

    fn invocation(&self) -> Option<(PathBuf, Vec<String>)> {
        resolve_invocation()
    }

    /// Whether the workspace root contains Rust sources.
    fn workspace_has_rust_sources(&self, repo_root: &Path) -> bool {
        has_rust_sources(repo_root)
    }

    fn version(&self, _repo_root: &Path) -> Result<String, SemanticProviderError> {
        let (exec, _prefix) = self
            .invocation()
            .ok_or_else(|| SemanticProviderError::Missing(PROVIDER_ID.to_string()))?;
        // The engine behind both entry points is rust-analyzer.
        let version = if exec
            .file_name()
            .map(|n| n == "rust-analyzer")
            .unwrap_or(false)
        {
            probe_version(&exec, &[])
        } else {
            probe_version(&exec, &["scip".to_string()])
        };
        Ok(version.unwrap_or_else(|| "unknown".to_string()))
    }
}

impl SemanticProvider for ScipRustProvider {
    fn id(&self) -> &'static str {
        PROVIDER_ID
    }

    fn provider_type(&self) -> crate::intelligence::semantic::provider::ProviderType {
        crate::intelligence::semantic::provider::ProviderType::Scip
    }

    fn languages(&self) -> &[LanguageId] {
        &[LanguageId::Rust]
    }

    fn scope(&self, repo_root: &Path) -> ProviderScope {
        let _ = repo_root;
        ProviderScope {
            workspace_root: String::new(),
            package: None,
            languages: vec![LanguageId::Rust],
        }
    }

    fn passive_health(&self, repo_root: &Path) -> ProviderHealth {
        if !self.workspace_has_rust_sources(repo_root) {
            return ProviderHealth::Unsupported;
        }
        match self.invocation() {
            Some(_) => ProviderHealth::Available,
            None => ProviderHealth::Missing,
        }
    }

    fn passive_fingerprint(
        &self,
        repo_root: &Path,
        persisted_version: Option<&str>,
    ) -> Result<ProviderFingerprint, SemanticProviderError> {
        let (exec, _prefix) = self
            .invocation()
            .ok_or_else(|| SemanticProviderError::Missing(PROVIDER_ID.to_string()))?;
        let exec_identity = crate::intelligence::semantic::provider::executable_content_digest(
            &exec,
        )
        .map_err(|e| SemanticProviderError::Failed(format!("cannot hash executable: {}", e)))?;
        let version = persisted_version.unwrap_or("");
        let config_files: Vec<&Path> = CONFIG_FILES.iter().map(Path::new).collect();
        let config_fingerprint = fingerprint_config_files(repo_root, &config_files)?;
        Ok(ProviderFingerprint::compute(
            version,
            &exec_identity,
            SCIP_SCHEMA_VERSION,
            None,
            &config_fingerprint,
        ))
    }

    fn active_fingerprint(
        &self,
        repo_root: &Path,
    ) -> Result<ProviderFingerprint, SemanticProviderError> {
        let (exec, prefix) = self
            .invocation()
            .ok_or_else(|| SemanticProviderError::Missing(PROVIDER_ID.to_string()))?;
        let exec_identity = crate::intelligence::semantic::provider::executable_content_digest(
            &exec,
        )
        .map_err(|e| SemanticProviderError::Failed(format!("cannot hash executable: {}", e)))?;
        let version = probe_version(&exec, &prefix).ok_or_else(|| {
            SemanticProviderError::Failed("cannot probe rust SCIP provider version".to_string())
        })?;
        let config_files: Vec<&Path> = CONFIG_FILES.iter().map(Path::new).collect();
        let config_fingerprint = fingerprint_config_files(repo_root, &config_files)?;
        Ok(ProviderFingerprint::compute(
            &version,
            &exec_identity,
            SCIP_SCHEMA_VERSION,
            None,
            &config_fingerprint,
        ))
    }

    fn discover(
        &self,
        repo_root: &Path,
    ) -> Result<SemanticProviderDiscovery, SemanticProviderError> {
        if !self.workspace_has_rust_sources(repo_root) {
            return Ok(SemanticProviderDiscovery {
                provider_id: PROVIDER_ID.to_string(),
                executable: None,
                provider_version: None,
                supported: false,
                reasons: vec!["no Rust sources".to_string()],
            });
        }
        let (exec, prefix) = match self.invocation() {
            Some(v) => v,
            None => {
                return Ok(SemanticProviderDiscovery {
                    provider_id: PROVIDER_ID.to_string(),
                    executable: None,
                    provider_version: None,
                    supported: false,
                    reasons: vec![
                        "scip-rust/rust-analyzer not found on PATH (no auto-download; install manually)"
                            .to_string(),
                    ],
                })
            }
        };
        let version = probe_version(&exec, &prefix);
        Ok(SemanticProviderDiscovery {
            provider_id: PROVIDER_ID.to_string(),
            executable: Some(exec),
            provider_version: version,
            supported: true,
            reasons: Vec::new(),
        })
    }

    fn ingest(
        &self,
        request: SemanticIngestRequest,
    ) -> Result<SemanticIngestResult, SemanticProviderError> {
        let (exec, mut prefix) = self
            .invocation()
            .ok_or_else(|| SemanticProviderError::Missing(PROVIDER_ID.to_string()))?;
        let help_text =
            crate::intelligence::semantic::scip::probe_help(&exec, &prefix).unwrap_or_default();
        let supports_output_flag = help_text.contains("--output");

        let outcome = if supports_output_flag {
            prefix.push("--output".to_string());
            prefix.push(request.output_path.to_string_lossy().into_owned());
            run_bounded_process(
                &exec,
                &prefix,
                &request.repo_root,
                request.time_limit,
                request.max_output_bytes,
                request.max_stderr_bytes,
                None,
            )
            .map_err(map_exec_failure)?
        } else {
            // Stdout streaming mode (e.g. rust-analyzer scip .)
            prefix.push(request.repo_root.to_string_lossy().into_owned());
            run_bounded_process(
                &exec,
                &prefix,
                &request.repo_root,
                request.time_limit,
                request.max_output_bytes,
                request.max_stderr_bytes,
                Some(&request.output_path),
            )
            .map_err(map_exec_failure)?
        };

        if outcome.exit_code != Some(0) {
            return Err(SemanticProviderError::Failed(format!(
                "{} exited with {:?}: {}",
                PROVIDER_ID,
                outcome.exit_code,
                outcome.stderr_tail.trim()
            )));
        }

        let output_bytes = std::fs::metadata(&request.output_path)
            .map_err(|e| {
                SemanticProviderError::Failed(format!("output file missing after run: {}", e))
            })?
            .len();
        if output_bytes > request.max_output_bytes {
            return Err(SemanticProviderError::OutputTooLarge(output_bytes));
        }
        let digest = read_digest(&request.output_path)?;
        Ok(SemanticIngestResult {
            output_path: request.output_path,
            output_digest: digest,
            output_bytes,
            tool_name: Some(PROVIDER_ID.to_string()),
            tool_version: self.version(&request.repo_root).ok(),
            provider_runtime_ms: outcome.runtime_ms,
        })
    }
}

fn map_exec_failure(e: ExecFailure) -> SemanticProviderError {
    match e {
        ExecFailure::TimedOut(d) => SemanticProviderError::TimedOut(d),
        ExecFailure::StdoutTooLarge(n) => SemanticProviderError::OutputTooLarge(n),
        ExecFailure::StderrTooLarge(n) => SemanticProviderError::StderrTooLarge(n),
        ExecFailure::Spawn(e) => SemanticProviderError::Io(e),
        ExecFailure::Read(e) => SemanticProviderError::Io(e),
    }
}

fn read_digest(path: &Path) -> Result<String, SemanticProviderError> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)?;
    Ok(format!("{:x}", hasher.finalize()))
}

/// Bounded recursive check for *.rs files (excluding target/, .git, .fdx).
fn has_rust_sources(root: &Path) -> bool {
    fn walk(dir: &Path, visited: &mut usize) -> bool {
        *visited += 1;
        if *visited > 100_000 {
            return false;
        }
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return false,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.components().any(|c| {
                c.as_os_str() == ".git" || c.as_os_str() == ".fdx" || c.as_os_str() == "target"
            }) {
                continue;
            }
            if path.is_dir() {
                if walk(&path, visited) {
                    return true;
                }
            } else if path.extension().map(|e| e == "rs").unwrap_or(false) {
                return true;
            }
        }
        false
    }
    let mut visited = 0usize;
    walk(root, &mut visited)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_id_and_languages() {
        let p = ScipRustProvider::new();
        assert_eq!(p.id(), "scip-rust");
        assert_eq!(p.languages(), &[LanguageId::Rust]);
    }

    #[test]
    fn missing_provider_is_reported_not_downloaded() {
        // Discovery must tolerate absence and never auto-download. On
        // machines with rust-analyzer on PATH the provider IS available; the
        // truthful PATH-isolated proof lives in the integration suite.
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/lib.rs"), "pub fn f() {}").unwrap();
        let p = ScipRustProvider::new();
        if p.invocation().is_none() {
            let discovery = p.discover(dir.path()).unwrap();
            assert!(!discovery.supported);
            assert!(discovery.executable.is_none());
            assert_eq!(p.passive_health(dir.path()), ProviderHealth::Missing);
        }
    }

    #[test]
    fn unsupported_for_non_rust_repo() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("main.py"),
            "def f():
    pass
",
        )
        .unwrap();
        let p = ScipRustProvider::new();
        assert_eq!(p.passive_health(dir.path()), ProviderHealth::Unsupported);
        let d = p.discover(dir.path()).unwrap();
        assert!(d.reasons.iter().any(|r| r.contains("no Rust")));
    }

    #[test]
    fn fingerprint_tracks_cargo_toml_changes() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/lib.rs"), "pub fn f() {}").unwrap();
        std::fs::write(
            dir.path().join("Cargo.toml"),
            "[package]
name = \"demo\"
version = \"0.1.0\"
",
        )
        .unwrap();
        let p = ScipRustProvider::new();
        if p.invocation().is_none() {
            let err = p.active_fingerprint(dir.path()).unwrap_err();
            assert!(matches!(err, SemanticProviderError::Missing(_)));
            return;
        }
        let a = p.passive_fingerprint(dir.path(), Some("0.1.0")).unwrap();
        let b = p.passive_fingerprint(dir.path(), Some("0.1.0")).unwrap();
        assert_eq!(a, b);
        std::fs::write(
            dir.path().join("Cargo.toml"),
            "[package]
name = \"demo\"
version = \"0.2.0\"
",
        )
        .unwrap();
        let c = p.passive_fingerprint(dir.path(), Some("0.1.0")).unwrap();
        assert_ne!(a.digest, c.digest);
    }
}
