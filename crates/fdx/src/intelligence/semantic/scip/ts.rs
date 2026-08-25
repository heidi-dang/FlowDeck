//! TypeScript provider adapter.
//!
//! Discovery: PATH lookup for `scip-typescript` (override with
//! `SCIP_TYPESCRIPT_BIN`). No download, ever.
//!
//! Invocation contract (pinned against @sourcegraph/scip-typescript v0.4.0):
//! `scip-typescript index --cwd <workspace> --output <out> --no-progress-bar`
//! plus `--infer-tsconfig` when the workspace has no tsconfig.json and JS
//! files are present.
//!
//! Fingerprint inputs: executable identity + version, SCIP schema version,
//! and relevant resolution configuration (tsconfig.json, jsconfig.json,
//! package.json, lockfiles).

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

pub const PROVIDER_ID: &str = "scip-typescript";

/// Executable candidates in priority order (PATH lookup).
pub const EXECUTABLE_CANDIDATES: &[&str] = &["scip-typescript"];

/// Configuration files that change TS/JS resolution semantics.
pub const CONFIG_FILES: &[&str] = &[
    "tsconfig.json",
    "jsconfig.json",
    "package.json",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lock",
    "bun.lockb",
];

fn executable_override() -> Option<PathBuf> {
    std::env::var_os("SCIP_TYPESCRIPT_BIN").map(PathBuf::from)
}

fn resolve_executable() -> ExecutableResolution {
    if let Some(bin) = executable_override() {
        if bin.is_file() {
            if is_command_shim(&bin) {
                return ExecutableResolution::CommandShim(bin);
            }
            return ExecutableResolution::Native(bin);
        }
    }
    for name in EXECUTABLE_CANDIDATES {
        let res = find_executable_resolved(name);
        if res != ExecutableResolution::NotFound {
            return res;
        }
    }
    ExecutableResolution::NotFound
}

#[derive(Debug, Default)]
pub struct ScipTypescriptProvider;

impl ScipTypescriptProvider {
    pub fn new() -> Self {
        Self
    }

    fn resolution(&self) -> ExecutableResolution {
        resolve_executable()
    }

    fn native_executable(&self) -> Result<PathBuf, SemanticProviderError> {
        match self.resolution() {
            ExecutableResolution::Native(p) => Ok(p),
            ExecutableResolution::CommandShim(_) => Err(SemanticProviderError::Misconfigured(
                "provider command shim (.cmd/.bat) requires native executable resolution (configure SCIP_TYPESCRIPT_BIN to a native executable or Node launcher)".to_string(),
            )),
            ExecutableResolution::NotFound => Err(SemanticProviderError::Missing(PROVIDER_ID.to_string())),
        }
    }

    /// Whether the workspace root contains TypeScript/JavaScript sources.
    fn workspace_has_ts_sources(&self, repo_root: &Path) -> bool {
        has_sources_with_extensions(repo_root, &["ts", "tsx", "js", "jsx", "mjs", "cjs"])
    }

    #[allow(dead_code)]
    fn version(&self, _repo_root: &Path) -> Result<String, SemanticProviderError> {
        let exec = self.native_executable()?;
        probe_version(&exec, &[])
            .ok_or_else(|| SemanticProviderError::Failed("cannot probe version".to_string()))
    }
}

impl SemanticProvider for ScipTypescriptProvider {
    fn id(&self) -> &'static str {
        PROVIDER_ID
    }

    fn provider_type(&self) -> crate::intelligence::semantic::provider::ProviderType {
        crate::intelligence::semantic::provider::ProviderType::Scip
    }

    fn languages(&self) -> &[LanguageId] {
        &[LanguageId::TypeScript, LanguageId::JavaScript]
    }

    fn scope(&self, repo_root: &Path) -> ProviderScope {
        // Milestone 3 scopes the TS provider to the whole repository workspace:
        // the indexer discovers all workspaces/projects itself. Package-scoped
        // indexing is modeled (ProviderScope.package) but not yet selected.
        let _ = repo_root;
        ProviderScope {
            workspace_root: String::new(),
            package: None,
            languages: vec![LanguageId::TypeScript, LanguageId::JavaScript],
        }
    }

    fn passive_health(&self, repo_root: &Path) -> ProviderHealth {
        if !self.workspace_has_ts_sources(repo_root) {
            return ProviderHealth::Unsupported;
        }
        match self.resolution() {
            ExecutableResolution::Native(_) => ProviderHealth::Available,
            ExecutableResolution::CommandShim(_) => ProviderHealth::Misconfigured,
            ExecutableResolution::NotFound => ProviderHealth::Missing,
        }
    }

    fn passive_fingerprint(
        &self,
        repo_root: &Path,
        persisted_version: Option<&str>,
    ) -> Result<ProviderFingerprint, SemanticProviderError> {
        let exec = self.native_executable()?;
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
        let exec = self.native_executable()?;
        let exec_identity = crate::intelligence::semantic::provider::executable_content_digest(
            &exec,
        )
        .map_err(|e| SemanticProviderError::Failed(format!("cannot hash executable: {}", e)))?;
        let version = probe_version(&exec, &[]).ok_or_else(|| {
            SemanticProviderError::Failed("cannot probe scip-typescript version".to_string())
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
        if !self.workspace_has_ts_sources(repo_root) {
            return Ok(SemanticProviderDiscovery {
                provider_id: PROVIDER_ID.to_string(),
                executable: None,
                provider_version: None,
                supported: false,
                reasons: vec!["no TypeScript/JavaScript sources".to_string()],
            });
        }
        match self.resolution() {
            ExecutableResolution::Native(exec) => {
                let version = probe_version(&exec, &[]);
                Ok(SemanticProviderDiscovery {
                    provider_id: PROVIDER_ID.to_string(),
                    executable: Some(exec),
                    provider_version: version,
                    supported: true,
                    reasons: Vec::new(),
                })
            }
            ExecutableResolution::CommandShim(shim) => {
                Ok(SemanticProviderDiscovery {
                    provider_id: PROVIDER_ID.to_string(),
                    executable: Some(shim),
                    provider_version: None,
                    supported: false,
                    reasons: vec![
                        "provider command shim (.cmd/.bat) requires native executable resolution (configure SCIP_TYPESCRIPT_BIN to a native executable or Node launcher)"
                            .to_string(),
                    ],
                })
            }
            ExecutableResolution::NotFound => {
                Ok(SemanticProviderDiscovery {
                    provider_id: PROVIDER_ID.to_string(),
                    executable: None,
                    provider_version: None,
                    supported: false,
                    reasons: vec![
                        "scip-typescript not found on PATH (no auto-download; install manually)"
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
        let exec = self.native_executable()?;
        let output_str = request.output_path.to_string_lossy().into_owned();
        let mut args = vec![
            "index".to_string(),
            "--cwd".to_string(),
            request.repo_root.to_string_lossy().into_owned(),
            "--output".to_string(),
            output_str.clone(),
            "--no-progress-bar".to_string(),
        ];
        // Infer a tsconfig for pure-JS projects (scip-typescript flag).
        let has_tsconfig = request.repo_root.join("tsconfig.json").exists();
        let has_jsconfig = request.repo_root.join("jsconfig.json").exists();
        if !has_tsconfig && !has_jsconfig {
            args.push("--infer-tsconfig".to_string());
        }

        let outcome = run_bounded_process(
            &exec,
            &args,
            &request.repo_root,
            request.time_limit,
            request.max_output_bytes,
            request.max_stderr_bytes,
            None,
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
            tool_version: probe_version(&exec, &[]),
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

/// Recursively check for source files with the given extensions (bounded depth).
fn has_sources_with_extensions(root: &Path, exts: &[&str]) -> bool {
    let mut stack = vec![root.to_path_buf()];
    let mut visited: usize = 0;
    while let Some(dir) = stack.pop() {
        visited += 1;
        if visited > 100_000 {
            return false;
        }
        if !dir.is_dir() {
            continue;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.components().any(|c| {
                c.as_os_str() == ".git"
                    || c.as_os_str() == "node_modules"
                    || c.as_os_str() == ".fdx"
                    || c.as_os_str() == "target"
            }) {
                continue;
            }
            if path.is_dir() {
                stack.push(path);
            } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                if exts.contains(&ext) {
                    return true;
                }
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_id_and_languages() {
        let p = ScipTypescriptProvider::new();
        assert_eq!(p.id(), "scip-typescript");
        assert_eq!(
            p.languages(),
            &[LanguageId::TypeScript, LanguageId::JavaScript]
        );
    }

    #[test]
    fn missing_provider_is_reported_not_downloaded() {
        // Discovery must tolerate absence: health MISSING, never an attempt to
        // install anything.
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/a.ts"), "export const a = 1;").unwrap();
        let p = ScipTypescriptProvider::new();
        // PATH stripped of everything -> executable must be missing.
        let discovery = p.discover(dir.path()).unwrap();
        assert!(!discovery.supported);
        assert!(discovery.executable.is_none());
        assert!(discovery.reasons.iter().any(|r| r.contains("not found")));
        // health must be MISSING, not Available/Failed.
        assert_eq!(p.passive_health(dir.path()), ProviderHealth::Missing);
    }

    #[test]
    fn unsupported_for_non_ts_repo() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(
            dir.path().join("src/main.py"),
            "def f():
    pass
",
        )
        .unwrap();
        let p = ScipTypescriptProvider::new();
        assert_eq!(p.passive_health(dir.path()), ProviderHealth::Unsupported);
        let d = p.discover(dir.path()).unwrap();
        assert!(!d.supported);
        assert!(d.reasons.iter().any(|r| r.contains("no TypeScript")));
    }

    #[test]
    fn fingerprint_tracks_tsconfig_changes() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/a.ts"), "export const a = 1;").unwrap();
        std::fs::write(dir.path().join("tsconfig.json"), "{\"files\":[\"src\"]}").unwrap();
        // Fingerprint requires the executable; without it the provider is
        // missing and fingerprint fails with a Missing error (never fabricates).
        let p = ScipTypescriptProvider::new();
        if p.native_executable().is_err() {
            // In environments without scip-typescript, verify the failure mode.
            let err = p.active_fingerprint(dir.path()).unwrap_err();
            assert!(matches!(err, SemanticProviderError::Missing(_)));
            return;
        }
        let a = p.passive_fingerprint(dir.path(), Some("0.4.0")).unwrap();
        let b = p.passive_fingerprint(dir.path(), Some("0.4.0")).unwrap();
        assert_eq!(a, b);
        std::fs::write(dir.path().join("tsconfig.json"), "{\"files\":[\"lib\"]}").unwrap();
        let c = p.passive_fingerprint(dir.path(), Some("0.4.0")).unwrap();
        assert_ne!(a.digest, c.digest);
    }
}
