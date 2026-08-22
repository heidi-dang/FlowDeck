//! Semantic provider abstraction.
//!
//! Provider-neutral contracts shared by every SCIP adapter. Adapters own:
//! provider discovery, command construction, workspace/config scope, output
//! location and fingerprinting. SCIP decoding and EvidenceGraph ingestion
//! are shared (scip/, ingest.rs).

use crate::intelligence::semantic::health::{ProviderFreshness, ProviderHealth};
use crate::intelligence::semantic::LanguageId;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use thiserror::Error;

/// Kind of semantic factory that produced evidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderType {
    /// SCIP-compatible indexer (scip-typescript, scip-rust, ...).
    Scip,
}

impl ProviderType {
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderType::Scip => "scip",
        }
    }

    pub fn from_str_opt(s: &str) -> Option<ProviderType> {
        match s {
            "scip" => Some(ProviderType::Scip),
            _ => None,
        }
    }
}

/// Stable identity of a concrete provider instance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderIdentity {
    /// e.g. "scip-typescript", "scip-rust".
    pub provider_id: String,
    pub provider_type: ProviderType,
    /// Indexer version reported by the tool itself (e.g. `--version` output).
    pub provider_version: String,
    /// Resolved path to the executable that produced/would produce evidence.
    pub executable_identity: String,
    /// SCIP protocol schema version this build parses.
    pub scip_schema_version: String,
}

/// The workspace/package scope a provider indexes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderScope {
    /// Repository-relative canonical root the provider indexes.
    pub workspace_root: String,
    /// Optional package name when the provider scopes to a single package.
    pub package: Option<String>,
    pub languages: Vec<LanguageId>,
}

impl ProviderScope {
    /// True when `canonical_path` (repository-relative) falls inside this scope.
    pub fn covers(&self, canonical_path: &str) -> bool {
        let root = self.workspace_root.trim_matches('/').to_string();
        if root.is_empty() {
            return true;
        }
        let p = canonical_path.trim_start_matches('/');
        p == root || p.starts_with(&format!("{}/", root))
    }
}

/// Fingerprint of the inputs that determine provider semantics.
///
/// Deliberately not a single opaque string: components are kept separate for
/// diagnostics and selective invalidation, plus a digest over all of them for
/// cheap equality checks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderFingerprint {
    pub provider_version: String,
    pub executable_identity: String,
    pub scip_schema_version: String,
    /// Reserved for the underlying compiler/indexer version when the provider
    /// reports one separately from its own version.
    pub compiler_version: Option<String>,
    /// Digest over the relevant semantic configuration files.
    pub config_fingerprint: String,
    /// sha256 over all components above (the opaque comparison key).
    pub digest: String,
}

impl ProviderFingerprint {
    pub fn compute(
        provider_version: &str,
        executable_identity: &str,
        scip_schema_version: &str,
        compiler_version: Option<&str>,
        config_fingerprint: &str,
    ) -> ProviderFingerprint {
        let mut hasher = Sha256::new();
        hasher.update(provider_version.as_bytes());
        hasher.update(b"|");
        hasher.update(executable_identity.as_bytes());
        hasher.update(b"|");
        hasher.update(scip_schema_version.as_bytes());
        hasher.update(b"|");
        hasher.update(compiler_version.unwrap_or("").as_bytes());
        hasher.update(b"|");
        hasher.update(config_fingerprint.as_bytes());
        let digest = format!("{:x}", hasher.finalize());
        ProviderFingerprint {
            provider_version: provider_version.to_string(),
            executable_identity: executable_identity.to_string(),
            scip_schema_version: scip_schema_version.to_string(),
            compiler_version: compiler_version.map(|s| s.to_string()),
            config_fingerprint: config_fingerprint.to_string(),
            digest,
        }
    }
}

/// Persisted provider state with enough information for selective invalidation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderState {
    pub identity: ProviderIdentity,
    pub scope: ProviderScope,
    pub fingerprint: ProviderFingerprint,
    pub health: ProviderHealth,
    pub freshness: ProviderFreshness,
    pub last_successful_run: Option<u64>,
    pub output_digest: Option<String>,
    pub failure_reason: Option<String>,
    pub semantic_generation: u64,
}

impl ProviderState {
    pub fn provider_id(&self) -> &str {
        &self.identity.provider_id
    }
}

/// Result of provider discovery: what was found and whether it is usable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SemanticProviderDiscovery {
    pub provider_id: String,
    pub executable: Option<PathBuf>,
    pub provider_version: Option<String>,
    pub supported: bool,
    pub reasons: Vec<String>,
}

/// Request to execute a provider and produce a fresh SCIP index at
/// `output_path` (bounded execution, explicit output path).
#[derive(Debug, Clone)]
pub struct SemanticIngestRequest {
    pub repo_root: PathBuf,
    pub scope: ProviderScope,
    pub fingerprint: ProviderFingerprint,
    pub output_path: PathBuf,
    pub time_limit: Duration,
    pub max_output_bytes: u64,
    pub max_stderr_bytes: u64,
}

/// Result returned by a provider after producing an SCIP index file.
#[derive(Debug, Clone)]
pub struct SemanticIngestResult {
    pub output_path: PathBuf,
    pub output_digest: String,
    pub output_bytes: u64,
    pub tool_name: Option<String>,
    pub tool_version: Option<String>,
    pub provider_runtime_ms: u64,
}

impl Default for SemanticIngestRequest {
    fn default() -> Self {
        Self {
            repo_root: PathBuf::new(),
            scope: ProviderScope {
                workspace_root: String::new(),
                package: None,
                languages: Vec::new(),
            },
            fingerprint: ProviderFingerprint {
                provider_version: String::new(),
                executable_identity: String::new(),
                scip_schema_version: String::new(),
                compiler_version: None,
                config_fingerprint: String::new(),
                digest: String::new(),
            },
            output_path: PathBuf::new(),
            time_limit: crate::intelligence::semantic::limits::MAX_PROVIDER_RUNTIME,
            max_output_bytes: crate::intelligence::semantic::limits::MAX_SCIP_INDEX_BYTES,
            max_stderr_bytes: crate::intelligence::semantic::limits::MAX_PROVIDER_STDERR_BYTES,
        }
    }
}

/// Provider-neutral error type.
#[derive(Debug, Error)]
pub enum SemanticProviderError {
    #[error("provider missing: {0}")]
    Missing(String),
    #[error("provider misconfigured: {0}")]
    Misconfigured(String),
    #[error("provider execution failed: {0}")]
    Failed(String),
    #[error("provider timed out after {0:?}")]
    TimedOut(Duration),
    #[error("provider stdout exceeded limit ({0} bytes)")]
    OutputTooLarge(u64),
    #[error("provider stderr exceeded limit ({0} bytes)")]
    StderrTooLarge(u64),
    #[error("malformed SCIP output: {0}")]
    MalformedScip(String),
    #[error("SCIP size limit exceeded: {0}")]
    SizeLimit(String),
    #[error("path jail violation: {0}")]
    PathJail(String),
    #[error("unsupported language: {0}")]
    UnsupportedLanguage(String),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
}

/// A semantic provider: discovery, fingerprint, health and bounded execution.
pub trait SemanticProvider: Send + Sync {
    fn id(&self) -> &'static str;
    fn provider_type(&self) -> ProviderType;
    fn languages(&self) -> &[LanguageId];

    /// The workspace/package scope this provider indexes for `repo_root`.
    fn scope(&self, repo_root: &Path) -> ProviderScope;

    /// Fingerprint of semantic inputs (executable/version, config, SCIP
    /// version). Must be stable for identical inputs and change when any
    /// semantic-relevant input changes.
    fn fingerprint(&self, repo_root: &Path) -> Result<ProviderFingerprint, SemanticProviderError>;

    /// Current health: can this provider run right now?
    fn health(&self, repo_root: &Path) -> ProviderHealth;

    /// Discover the installed indexer without downloading anything.
    fn discover(
        &self,
        repo_root: &Path,
    ) -> Result<SemanticProviderDiscovery, SemanticProviderError>;

    /// Run the provider bounded and produce an SCIP index at
    /// `request.output_path`. Never auto-downloads, never uses a shell.
    fn ingest(
        &self,
        request: SemanticIngestRequest,
    ) -> Result<SemanticIngestResult, SemanticProviderError>;
}

// ── Bounded subprocess execution ─────────────────────────────────────

/// Outcome of a bounded provider run.
#[derive(Debug, Clone)]
pub struct ExecOutcome {
    pub exit_code: Option<i32>,
    pub stdout_bytes: u64,
    pub stdout_truncated: bool,
    /// Tail of stdout (bounded) — enough for version probes and diagnostics.
    pub stdout_tail: String,
    pub stderr_tail: String,
    pub stderr_truncated: bool,
    pub runtime_ms: u64,
}

/// Failure mode of a bounded provider run.
#[derive(Debug, Error)]
pub enum ExecFailure {
    #[error("process timed out after {0:?}")]
    TimedOut(Duration),
    #[error("stdout exceeded limit ({0} bytes)")]
    StdoutTooLarge(u64),
    #[error("stderr exceeded limit ({0} bytes)")]
    StderrTooLarge(u64),
    #[error("failed to spawn provider: {0}")]
    Spawn(std::io::Error),
    #[error("failed to read provider output: {0}")]
    Read(std::io::Error),
}

/// Run `args` with executable `exec` in `workdir` with hard bounds.
///
/// Direct process APIs only: no shell, no command-line interpolation, no
/// `sh -c`/`bash -c`/`cmd /C` construction. The child is killed when the
/// deadline or an output byte cap is exceeded, so no orphan process survives.
pub fn run_bounded_process(
    exec: &Path,
    args: &[String],
    workdir: &Path,
    deadline: Duration,
    max_stdout_bytes: u64,
    max_stderr_bytes: u64,
) -> Result<ExecOutcome, ExecFailure> {
    let mut command = Command::new(exec);
    command
        .args(args)
        .current_dir(workdir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Place the provider in its own process group so a timeout can kill the
    // whole group (no orphan grandchildren holding our pipes open).
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(ExecFailure::Spawn)?;

    let stdout_pipe = child
        .stdout
        .take()
        .ok_or_else(|| ExecFailure::Spawn(std::io::Error::other("stdout pipe unavailable")))?;
    let stderr_pipe = child
        .stderr
        .take()
        .ok_or_else(|| ExecFailure::Spawn(std::io::Error::other("stderr pipe unavailable")))?;

    use std::io::Read;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct Capture {
        bytes: u64,
        truncated: bool,
        tail: Vec<u8>,
    }

    let stdout_cap = Arc::new(Mutex::new(Capture::default()));
    let stderr_cap = Arc::new(Mutex::new(Capture::default()));
    let stdout_overflow = Arc::new(Mutex::new(false));
    let stderr_overflow = Arc::new(Mutex::new(false));

    fn spawn_capture(
        mut pipe: impl Read + Send + 'static,
        cap: Arc<Mutex<Capture>>,
        overflow: Arc<Mutex<bool>>,
        max_bytes: u64,
        tail_limit: usize,
    ) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                let n = match pipe.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(_) => break,
                };
                let mut guard = cap.lock().unwrap();
                if guard.bytes + n as u64 > max_bytes {
                    *overflow.lock().unwrap() = true;
                    break;
                }
                guard.bytes += n as u64;
                let keep = tail_limit.min(guard.tail.len() + n);
                if keep < guard.tail.len() + n {
                    let drop_bytes = guard.tail.len() + n - keep;
                    guard.tail.drain(0..drop_bytes);
                }
                guard.tail.extend_from_slice(&buf[..n]);
            }
        })
    }

    let tail_limit = crate::intelligence::semantic::limits::MAX_PROVIDER_STDERR_TAIL_BYTES;
    let h_stdout = spawn_capture(
        stdout_pipe,
        Arc::clone(&stdout_cap),
        Arc::clone(&stdout_overflow),
        max_stdout_bytes,
        tail_limit,
    );
    let h_stderr = spawn_capture(
        stderr_pipe,
        Arc::clone(&stderr_cap),
        Arc::clone(&stderr_overflow),
        max_stderr_bytes,
        tail_limit,
    );

    let started = Instant::now();
    let mut exit_code: Option<i32> = None;
    let mut failure: Option<ExecFailure> = None;
    loop {
        if started.elapsed() > deadline {
            failure = Some(ExecFailure::TimedOut(deadline));
            break;
        }
        if *stdout_overflow.lock().unwrap() {
            failure = Some(ExecFailure::StdoutTooLarge(max_stdout_bytes));
            break;
        }
        if *stderr_overflow.lock().unwrap() {
            failure = Some(ExecFailure::StderrTooLarge(max_stderr_bytes));
            break;
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                exit_code = status.code();
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(e) => {
                failure = Some(ExecFailure::Read(e));
                break;
            }
        }
    }

    if failure.is_some() || exit_code.is_none() {
        kill_process_group(&mut child);
    }
    let runtime_ms = started.elapsed().as_millis() as u64;
    let _ = h_stdout.join();
    let _ = h_stderr.join();

    if let Some(f) = failure {
        return Err(f);
    }

    let stdout_guard = stdout_cap.lock().unwrap();
    let stderr_guard = stderr_cap.lock().unwrap();
    Ok(ExecOutcome {
        exit_code,
        stdout_bytes: stdout_guard.bytes,
        stdout_truncated: stdout_guard.truncated || stdout_guard.bytes > max_stdout_bytes,
        stdout_tail: String::from_utf8_lossy(&stdout_guard.tail).into_owned(),
        stderr_tail: String::from_utf8_lossy(&stderr_guard.tail).into_owned(),
        stderr_truncated: stderr_guard.truncated,
        runtime_ms,
    })
}

/// sha256 hex digest of a byte slice.
pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Fingerprint a set of relevant configuration files.
///
/// Only the listed config files participate. Missing files contribute a
/// "missing" marker so that appearing/disappearing configs invalidate the
/// fingerprint. Nothing else in the repository is hashed.
pub fn fingerprint_config_files(
    root: &Path,
    relative_candidates: &[&Path],
) -> Result<String, std::io::Error> {
    let mut entries: Vec<(String, String)> = Vec::new();
    for rel in relative_candidates {
        let full = root.join(rel);
        match std::fs::read(&full) {
            Ok(bytes) => entries.push((rel.to_string_lossy().into_owned(), sha256_hex(&bytes))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                entries.push((rel.to_string_lossy().into_owned(), "missing".to_string()));
            }
            Err(e) => return Err(e),
        }
    }
    entries.sort();
    let mut hasher = Sha256::new();
    for (rel, hash) in &entries {
        hasher.update(rel.as_bytes());
        hasher.update(b"=");
        hasher.update(hash.as_bytes());
        hasher.update(b";");
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Resolve an executable name against PATH.
pub fn find_executable(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(name);
        if is_executable_file(&candidate) {
            return Some(candidate);
        }
    }
    None
}

fn is_executable_file(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        match std::fs::metadata(p) {
            Ok(m) if m.is_file() => m.permissions().mode() & 0o111 != 0,
            _ => false,
        }
    }
    #[cfg(not(unix))]
    {
        std::fs::metadata(p).map(|m| m.is_file()).unwrap_or(false)
    }
}

/// Kill the child and its entire process group (Unix) so no orphan grandchild
/// holds our pipes open after a timeout or output-cap abort.
fn kill_process_group(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        unsafe {
            libc::killpg(child.id() as i32, libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }
    let _ = child.wait();
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_components_and_digest_are_stable() {
        let a = ProviderFingerprint::compute(
            "1.2.3",
            "/usr/bin/scip-typescript",
            "0.1.0",
            Some("5.4.0"),
            "cfg1",
        );
        let b = ProviderFingerprint::compute(
            "1.2.3",
            "/usr/bin/scip-typescript",
            "0.1.0",
            Some("5.4.0"),
            "cfg1",
        );
        assert_eq!(a, b);
        assert_eq!(a.digest, b.digest);
        // Components remain individually inspectable (not one opaque string).
        assert_eq!(a.provider_version, "1.2.3");
        assert_eq!(a.scip_schema_version, "0.1.0");
    }

    #[test]
    fn fingerprint_changes_when_components_change() {
        let base = ProviderFingerprint::compute(
            "1.2.3",
            "/usr/bin/scip-typescript",
            "0.1.0",
            None,
            "cfg1",
        );
        let version_changed = ProviderFingerprint::compute(
            "9.9.9",
            "/usr/bin/scip-typescript",
            "0.1.0",
            None,
            "cfg1",
        );
        let executable_changed = ProviderFingerprint::compute(
            "1.2.3",
            "/usr/local/bin/scip-typescript",
            "0.1.0",
            None,
            "cfg1",
        );
        let scip_changed = ProviderFingerprint::compute(
            "1.2.3",
            "/usr/bin/scip-typescript",
            "0.2.0",
            None,
            "cfg1",
        );
        let config_changed = ProviderFingerprint::compute(
            "1.2.3",
            "/usr/bin/scip-typescript",
            "0.1.0",
            None,
            "cfg2",
        );
        assert_ne!(base, version_changed);
        assert_ne!(base, executable_changed);
        assert_ne!(base, scip_changed);
        assert_ne!(base, config_changed);
        assert_ne!(base.digest, version_changed.digest);
    }

    #[test]
    fn config_fingerprint_reacts_to_content_and_missing_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("tsconfig.json"), "{\"strict\":true}").unwrap();
        let a = fingerprint_config_files(dir.path(), &[Path::new("tsconfig.json")]).unwrap();
        let b = fingerprint_config_files(dir.path(), &[Path::new("tsconfig.json")]).unwrap();
        assert_eq!(a, b);

        std::fs::write(dir.path().join("tsconfig.json"), "{\"strict\":false}").unwrap();
        let c = fingerprint_config_files(dir.path(), &[Path::new("tsconfig.json")]).unwrap();
        assert_ne!(a, c);

        // Missing file contributes a marker -> appearing later changes digest.
        let d = fingerprint_config_files(dir.path(), &[Path::new("jsconfig.json")]).unwrap();
        std::fs::write(dir.path().join("jsconfig.json"), "{}").unwrap();
        let e = fingerprint_config_files(dir.path(), &[Path::new("jsconfig.json")]).unwrap();
        assert_ne!(d, e);
    }

    #[test]
    fn scope_covers_paths_within_workspace_root_only() {
        let scope = ProviderScope {
            workspace_root: "packages/web".to_string(),
            package: Some("web".to_string()),
            languages: vec![LanguageId::TypeScript],
        };
        assert!(scope.covers("packages/web/src/a.ts"));
        assert!(scope.covers("packages/web/a.ts"));
        assert!(!scope.covers("packages/backend/src/b.rs"));
        assert!(!scope.covers("packages/web2/x.ts"));
        // Workspace-root scope covers everything.
        let wide = ProviderScope {
            workspace_root: String::new(),
            package: None,
            languages: vec![LanguageId::Rust],
        };
        assert!(wide.covers("crates/backend/src/lib.rs"));
    }

    fn write_script(dir: &std::path::Path, name: &str, body: &str) -> std::path::PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, body).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        p
    }

    #[test]
    fn bounded_process_runs_and_reports_code() {
        let dir = tempfile::tempdir().unwrap();
        let script = write_script(dir.path(), "s.sh", "#!/bin/sh\necho hello\nexit 0\n");
        let out = run_bounded_process(
            &script,
            &[],
            Path::new("."),
            Duration::from_secs(5),
            1024 * 1024,
            1024 * 1024,
        )
        .unwrap();
        assert_eq!(out.exit_code, Some(0));
        assert!(out.stderr_tail.is_empty());
    }

    #[test]
    fn bounded_process_kills_on_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let script = write_script(dir.path(), "s.sh", "#!/bin/sh\nsleep 30\n");
        let started = Instant::now();
        let err = run_bounded_process(
            &script,
            &[],
            Path::new("."),
            Duration::from_millis(300),
            1024 * 1024,
            1024 * 1024,
        )
        .unwrap_err();
        assert!(matches!(err, ExecFailure::TimedOut(_)));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn bounded_process_caps_stderr() {
        let dir = tempfile::tempdir().unwrap();
        let script = write_script(
            dir.path(),
            "s.sh",
            "#!/bin/sh\nhead -c 100000 /dev/zero >&2\n",
        );
        let err = run_bounded_process(
            &script,
            &[],
            Path::new("."),
            Duration::from_secs(5),
            1024 * 1024,
            1024,
        )
        .unwrap_err();
        assert!(matches!(err, ExecFailure::StderrTooLarge(1024)));
    }
}
