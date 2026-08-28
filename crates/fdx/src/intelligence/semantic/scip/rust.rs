//! Rust provider adapter.
//!
//! Discovery: PATH lookup for `scip-rust` (the standard SCIP indexer for
//! Rust, a shim around `rust-analyzer scip`), falling back to
//! `rust-analyzer` directly. Override with `SCIP_RUST_BIN`. No download.
//!
//! Invocation contracts (pinned against the published indexers):
//! - `scip-rust --output <out>`  (scip-rust shim forwards args to rust-analyzer)
//! - `rust-analyzer scip <repo_root> --output <out>` (direct)
//!
//! Non-Rust repositories are unsupported; a missing executable is reported as
//! MISSING, never auto-installed.
//!
//! Fingerprint inputs: executable identity + version, SCIP schema version,
//! and relevant resolution configuration (Cargo.toml, Cargo.lock, workspace
//! Cargo.toml, rust-toolchain).

use crate::intelligence::semantic::health::ProviderHealth;
use crate::intelligence::semantic::provider::{
    find_executable_resolved, fingerprint_config_files, is_command_shim, run_bounded_process,
    ExecFailure, ExecutableResolution, ProviderFingerprint, ProviderScope, SemanticIngestRequest,
    SemanticIngestResult, SemanticProvider, SemanticProviderDiscovery, SemanticProviderError,
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

/// Explicit typed invocation mode for Rust SCIP providers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RustScipInvocation {
    RustAnalyzer { executable: PathBuf },
    ScipRustShim { executable: PathBuf },
}

impl RustScipInvocation {
    pub fn executable(&self) -> &Path {
        match self {
            RustScipInvocation::RustAnalyzer { executable } => executable,
            RustScipInvocation::ScipRustShim { executable } => executable,
        }
    }

    pub fn probe_version(&self) -> Option<String> {
        probe_version(self.executable(), &[])
    }

    pub fn probe_help(&self) -> Option<String> {
        match self {
            RustScipInvocation::RustAnalyzer { executable } => {
                crate::intelligence::semantic::scip::probe_help(executable, &["scip".to_string()])
            }
            RustScipInvocation::ScipRustShim { executable } => {
                crate::intelligence::semantic::scip::probe_help(executable, &[])
            }
        }
    }

    /// Construct CLI arguments and determine if stdout streaming mode is needed.
    /// Returns `(args, is_stdout_mode)`.
    pub fn build_args(
        &self,
        repo_root: &Path,
        output_path: &Path,
        help_text: &str,
    ) -> (Vec<String>, bool) {
        match self {
            RustScipInvocation::RustAnalyzer { .. } => {
                let supports_output_flag = help_text.contains("--output");
                if supports_output_flag {
                    (
                        vec![
                            "scip".to_string(),
                            repo_root.to_string_lossy().into_owned(),
                            "--output".to_string(),
                            output_path.to_string_lossy().into_owned(),
                        ],
                        false,
                    )
                } else {
                    (
                        vec!["scip".to_string(), repo_root.to_string_lossy().into_owned()],
                        true,
                    )
                }
            }
            RustScipInvocation::ScipRustShim { .. } => {
                let supports_output_flag = help_text.contains("--output");
                let accepts_positional = help_text.contains("<PROJECT_PATH>")
                    || help_text.contains("<project-path>")
                    || help_text.contains("<path>")
                    || help_text.contains("<PATH>")
                    || help_text.contains("<dir>")
                    || help_text.contains("<DIR>")
                    || help_text.contains("[path]")
                    || help_text.contains("[PATH]")
                    || help_text.contains("[dir]")
                    || help_text.contains("[DIR]");

                let mut args = Vec::new();
                if accepts_positional {
                    args.push(repo_root.to_string_lossy().into_owned());
                }
                if supports_output_flag {
                    args.push("--output".to_string());
                    args.push(output_path.to_string_lossy().into_owned());
                    (args, false)
                } else {
                    (args, true)
                }
            }
        }
    }
}

/// Resolution state for Rust SCIP provider.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RustResolution {
    Resolved(RustScipInvocation),
    CommandShim(PathBuf),
    NotFound,
}

fn resolve_invocation() -> RustResolution {
    if let Some(bin) = executable_override() {
        if bin.is_file() {
            if is_command_shim(&bin) {
                return RustResolution::CommandShim(bin);
            }
            let fname = bin.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if fname.starts_with("rust-analyzer") {
                return RustResolution::Resolved(RustScipInvocation::RustAnalyzer {
                    executable: bin,
                });
            } else {
                return RustResolution::Resolved(RustScipInvocation::ScipRustShim {
                    executable: bin,
                });
            }
        }
    }

    match find_executable_resolved("scip-rust") {
        ExecutableResolution::Native(bin) => {
            return RustResolution::Resolved(RustScipInvocation::ScipRustShim { executable: bin });
        }
        ExecutableResolution::CommandShim(shim) => {
            return RustResolution::CommandShim(shim);
        }
        ExecutableResolution::NotFound => {}
    }

    match find_executable_resolved("rust-analyzer") {
        ExecutableResolution::Native(bin) => {
            return RustResolution::Resolved(RustScipInvocation::RustAnalyzer { executable: bin });
        }
        ExecutableResolution::CommandShim(shim) => {
            return RustResolution::CommandShim(shim);
        }
        ExecutableResolution::NotFound => {}
    }

    RustResolution::NotFound
}

#[derive(Debug, Default)]
pub struct ScipRustProvider;

impl ScipRustProvider {
    pub fn new() -> Self {
        Self
    }

    pub fn resolution(&self) -> RustResolution {
        resolve_invocation()
    }

    fn active_invocation(&self) -> Result<RustScipInvocation, SemanticProviderError> {
        match self.resolution() {
            RustResolution::Resolved(inv) => Ok(inv),
            RustResolution::CommandShim(_) => Err(SemanticProviderError::Misconfigured(
                "provider command shim (.cmd/.bat) requires native executable resolution (configure SCIP_RUST_BIN to a native executable)".to_string(),
            )),
            RustResolution::NotFound => Err(SemanticProviderError::Missing(PROVIDER_ID.to_string())),
        }
    }

    /// Whether the workspace root contains Rust sources.
    fn workspace_has_rust_sources(&self, repo_root: &Path) -> bool {
        has_rust_sources(repo_root)
    }

    #[allow(dead_code)]
    fn version(&self, _repo_root: &Path) -> Result<String, SemanticProviderError> {
        let inv = self.active_invocation()?;
        inv.probe_version().ok_or_else(|| {
            SemanticProviderError::Failed("cannot probe rust SCIP provider version".to_string())
        })
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
        match self.resolution() {
            RustResolution::Resolved(_) => ProviderHealth::Available,
            RustResolution::CommandShim(_) => ProviderHealth::Misconfigured,
            RustResolution::NotFound => ProviderHealth::Missing,
        }
    }

    fn passive_fingerprint(
        &self,
        repo_root: &Path,
        persisted_version: Option<&str>,
    ) -> Result<ProviderFingerprint, SemanticProviderError> {
        let inv = self.active_invocation()?;
        let exec_identity =
            crate::intelligence::semantic::provider::executable_content_digest(inv.executable())
                .map_err(|e| {
                    SemanticProviderError::Failed(format!("cannot hash executable: {}", e))
                })?;
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
        let inv = self.active_invocation()?;
        let exec_identity =
            crate::intelligence::semantic::provider::executable_content_digest(inv.executable())
                .map_err(|e| {
                    SemanticProviderError::Failed(format!("cannot hash executable: {}", e))
                })?;
        let version = inv.probe_version().ok_or_else(|| {
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
        match self.resolution() {
            RustResolution::Resolved(inv) => {
                let version = inv.probe_version();
                Ok(SemanticProviderDiscovery {
                    provider_id: PROVIDER_ID.to_string(),
                    executable: Some(inv.executable().to_path_buf()),
                    provider_version: version,
                    supported: true,
                    reasons: Vec::new(),
                })
            }
            RustResolution::CommandShim(shim) => {
                Ok(SemanticProviderDiscovery {
                    provider_id: PROVIDER_ID.to_string(),
                    executable: Some(shim),
                    provider_version: None,
                    supported: false,
                    reasons: vec![
                        "provider command shim (.cmd/.bat) requires native executable resolution (configure SCIP_RUST_BIN to a native executable)"
                            .to_string(),
                    ],
                })
            }
            RustResolution::NotFound => {
                Ok(SemanticProviderDiscovery {
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
        }
    }

    fn ingest(
        &self,
        request: SemanticIngestRequest,
    ) -> Result<SemanticIngestResult, SemanticProviderError> {
        let inv = self.active_invocation()?;
        let help_text = inv.probe_help().unwrap_or_default();
        let (args, is_stdout_mode) =
            inv.build_args(&request.repo_root, &request.output_path, &help_text);

        let outcome = run_bounded_process(
            inv.executable(),
            &args,
            &request.repo_root,
            request.time_limit,
            request.max_output_bytes,
            request.max_stderr_bytes,
            if is_stdout_mode {
                Some(&request.output_path)
            } else {
                None
            },
        )
        .map_err(map_exec_failure)?;

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
            tool_version: inv.probe_version(),
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
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/lib.rs"), "pub fn f() {}").unwrap();
        let p = ScipRustProvider::new();
        if matches!(p.resolution(), RustResolution::NotFound) {
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
            r#"[package]
name = "demo"
version = "0.1.0"
"#,
        )
        .unwrap();
        let p = ScipRustProvider::new();
        if matches!(p.resolution(), RustResolution::NotFound) {
            let err = p.active_fingerprint(dir.path()).unwrap_err();
            assert!(matches!(err, SemanticProviderError::Missing(_)));
            return;
        }
        let a = p.passive_fingerprint(dir.path(), Some("0.1.0")).unwrap();
        let b = p.passive_fingerprint(dir.path(), Some("0.1.0")).unwrap();
        assert_eq!(a, b);
        std::fs::write(
            dir.path().join("Cargo.toml"),
            r#"[package]
name = "demo"
version = "0.2.0"
"#,
        )
        .unwrap();
        let c = p.passive_fingerprint(dir.path(), Some("0.1.0")).unwrap();
        assert_ne!(a.digest, c.digest);
    }
}
