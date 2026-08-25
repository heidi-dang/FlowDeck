//! Provider invocation and Windows execution safety tests (Milestone 3 final hardening).

use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::semantic::health::{ProviderFreshness, ProviderHealth};
use fdx::intelligence::semantic::ingest::refresh_provider;
use fdx::intelligence::semantic::provider::{
    find_executable_resolved, run_bounded_process, ExecutableResolution, SemanticProvider,
    SemanticProviderError,
};
use fdx::intelligence::semantic::scip::rust::{
    RustResolution, RustScipInvocation, ScipRustProvider,
};
use fdx::intelligence::semantic::scip::ts::ScipTypescriptProvider;
use fdx::intelligence::semantic::state;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

static ENV_LOCK: Mutex<()> = Mutex::new(());

fn lock_env() -> std::sync::MutexGuard<'static, ()> {
    ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/scip")
        .join(name)
}

fn rust_repo(repo: &Path) {
    std::fs::create_dir_all(repo.join("src")).unwrap();
    std::fs::write(
        repo.join("src/lib.rs"),
        "pub fn area() {}
",
    )
    .unwrap();
    std::fs::write(
        repo.join("Cargo.toml"),
        r#"[package]
name = "demo"
version = "0.1.0"
"#,
    )
    .unwrap();
}

#[allow(dead_code)]
fn ts_repo(repo: &Path) {
    std::fs::create_dir_all(repo.join("src")).unwrap();
    std::fs::write(
        repo.join("src/index.ts"),
        "export const x = 1;
",
    )
    .unwrap();
    std::fs::write(
        repo.join("tsconfig.json"),
        "{}
",
    )
    .unwrap();
}

#[cfg(unix)]
fn make_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[test]
fn test_path_discovered_rust_analyzer_invocations() {
    let guard = lock_env();

    let bin_dir = tempfile::tempdir().unwrap();
    let log_file = bin_dir.path().join("commands.log");
    let fake_ra = bin_dir.path().join("rust-analyzer");
    let fixture_abs = fixture("basic-rust.scip");

    // Fake rust-analyzer script enforcing strict CLI contract:
    // 1. --version -> prints version
    // 2. scip --help -> prints help with <PROJECT_PATH> --output <OUTPUT_PATH>
    // 3. scip <PROJECT_PATH> --output <OUTPUT_PATH> -> copies fixture to output
    // 4. scip --version or scip --output <PATH> (without repo path) -> REJECTED (exit 2)
    let script = format!(
        r#"#!/bin/bash
LOG="{log}"
FIXTURE="{fixture}"
echo "INVOKED: $@" >> "$LOG"

if [ "$1" = "--version" ] && [ "$#" -eq 1 ]; then
    echo "rust-analyzer 1.80.0 (fedcba98 2024-07-20)"
    exit 0
fi

if [ "$1" = "scip" ] && [ "$2" = "--help" ] && [ "$#" -eq 2 ]; then
    echo "rust-analyzer-scip"
    echo "Usage: rust-analyzer scip <PROJECT_PATH> --output <OUTPUT_PATH>"
    exit 0
fi

if [ "$1" = "scip" ] && [ "$#" -eq 4 ] && [ "$3" = "--output" ]; then
    PROJECT_PATH="$2"
    OUT_PATH="$4"
    if [ ! -d "$PROJECT_PATH" ]; then
        echo "Error: project path $PROJECT_PATH does not exist" >&2
        exit 3
    fi
    cp "$FIXTURE" "$OUT_PATH"
    exit 0
fi

echo "REJECTED INVALID INVOCATION: $@" >&2
exit 2
"#,
        log = log_file.display(),
        fixture = fixture_abs.display()
    );

    std::fs::write(&fake_ra, script).unwrap();
    #[cfg(unix)]
    make_executable(&fake_ra);

    // Set PATH to contain fake_ra directory, remove SCIP_RUST_BIN
    let orig_path = std::env::var_os("PATH").unwrap_or_default();
    let mut new_path = bin_dir.path().to_path_buf().into_os_string();
    new_path.push(if cfg!(windows) { ";" } else { ":" });
    new_path.push(&orig_path);

    std::env::set_var("PATH", &new_path);
    std::env::remove_var("SCIP_RUST_BIN");

    let repo = tempfile::tempdir().unwrap();
    rust_repo(repo.path());

    let provider = ScipRustProvider::new();

    // Check typed resolution
    let resolution = provider.resolution();
    match resolution {
        RustResolution::Resolved(RustScipInvocation::RustAnalyzer { ref executable }) => {
            assert_eq!(executable, &fake_ra);
        }
        other => panic!("Expected RustAnalyzer resolution, got {:?}", other),
    }

    // Check discovery
    let discovery = provider.discover(repo.path()).unwrap();
    assert!(discovery.supported);
    assert_eq!(
        discovery.provider_version.as_deref(),
        Some("rust-analyzer 1.80.0 (fedcba98 2024-07-20)")
    );

    // Refresh provider (active fingerprint + ingest)
    let report = refresh_provider(repo.path(), &provider, true).unwrap();
    assert_eq!(report.generation, 1);
    assert!(report.edges > 0);

    let db = EvidenceDatabase::open(repo.path(), DatabaseOpenMode::ReadOnly).unwrap();
    let st = state::load_provider_state(&db, "scip-rust")
        .unwrap()
        .unwrap();
    assert_eq!(st.freshness, ProviderFreshness::Fresh);

    // Verify command log
    let log_content = std::fs::read_to_string(&log_file).unwrap();
    println!(
        "Command log:
{}",
        log_content
    );

    // Ensure rust-analyzer scip --version was NEVER called
    assert!(
        !log_content.contains("scip --version"),
        "rust-analyzer scip --version must NEVER be invoked"
    );
    // Ensure scip was never invoked without repo root
    for line in log_content.lines() {
        if line.starts_with("INVOKED: scip --output") {
            panic!("rust-analyzer was called without project path: {}", line);
        }
    }

    // Clean up env
    std::env::set_var("PATH", &orig_path);
    drop(guard);
}

#[test]
fn test_path_discovered_rust_analyzer_stdout_streaming() {
    let guard = lock_env();

    let bin_dir = tempfile::tempdir().unwrap();
    let log_file = bin_dir.path().join("commands.log");
    let fake_ra = bin_dir.path().join("rust-analyzer");
    let fixture_abs = fixture("basic-rust.scip");

    // Fake rust-analyzer whose help does NOT contain --output, emitting SCIP to stdout
    let script = format!(
        r#"#!/bin/bash
LOG="{log}"
FIXTURE="{fixture}"
echo "INVOKED: $@" >> "$LOG"

if [ "$1" = "--version" ] && [ "$#" -eq 1 ]; then
    echo "rust-analyzer 1.80.0"
    exit 0
fi

if [ "$1" = "scip" ] && [ "$2" = "--help" ] && [ "$#" -eq 2 ]; then
    echo "Usage: rust-analyzer scip <PROJECT_PATH> (emits to stdout)"
    exit 0
fi

if [ "$1" = "scip" ] && [ "$#" -eq 2 ]; then
    PROJECT_PATH="$2"
    if [ ! -d "$PROJECT_PATH" ]; then
        echo "Error: project path $PROJECT_PATH does not exist" >&2
        exit 3
    fi
    cat "$FIXTURE"
    exit 0
fi

echo "REJECTED INVALID INVOCATION: $@" >&2
exit 2
"#,
        log = log_file.display(),
        fixture = fixture_abs.display()
    );

    std::fs::write(&fake_ra, script).unwrap();
    #[cfg(unix)]
    make_executable(&fake_ra);

    let orig_path = std::env::var_os("PATH").unwrap_or_default();
    let mut new_path = bin_dir.path().to_path_buf().into_os_string();
    new_path.push(if cfg!(windows) { ";" } else { ":" });
    new_path.push(&orig_path);

    std::env::set_var("PATH", &new_path);
    std::env::remove_var("SCIP_RUST_BIN");

    let repo = tempfile::tempdir().unwrap();
    rust_repo(repo.path());

    let provider = ScipRustProvider::new();
    let report = refresh_provider(repo.path(), &provider, true).unwrap();
    assert_eq!(report.generation, 1);
    assert!(report.edges > 0);

    let log_content = std::fs::read_to_string(&log_file).unwrap();
    assert!(!log_content.contains("scip --version"));
    assert!(log_content.contains(&format!("INVOKED: scip {}", repo.path().display())));

    std::env::set_var("PATH", &orig_path);
    drop(guard);
}

#[test]
fn test_path_discovered_scip_rust_shim_invocations() {
    let guard = lock_env();

    let bin_dir = tempfile::tempdir().unwrap();
    let log_file = bin_dir.path().join("commands.log");
    let fake_shim = bin_dir.path().join("scip-rust");
    let fixture_abs = fixture("basic-rust.scip");

    // Fake scip-rust shim
    let script = format!(
        r#"#!/bin/bash
LOG="{log}"
FIXTURE="{fixture}"
echo "INVOKED: $@" >> "$LOG"

if [ "$1" = "--version" ] && [ "$#" -eq 1 ]; then
    echo "scip-rust 0.1.0"
    exit 0
fi

if [ "$1" = "--help" ] && [ "$#" -eq 1 ]; then
    echo "Usage: scip-rust [OPTIONS] [PROJECT_PATH] --output <OUTPUT_PATH>"
    exit 0
fi

if [ "$1" = "--output" ] && [ "$#" -eq 2 ]; then
    OUT_PATH="$2"
    cp "$FIXTURE" "$OUT_PATH"
    exit 0
fi

if [ "$#" -eq 3 ] && [ "$2" = "--output" ]; then
    PROJECT_PATH="$1"
    OUT_PATH="$3"
    cp "$FIXTURE" "$OUT_PATH"
    exit 0
fi

echo "REJECTED: $@" >&2
exit 2
"#,
        log = log_file.display(),
        fixture = fixture_abs.display()
    );

    std::fs::write(&fake_shim, script).unwrap();
    #[cfg(unix)]
    make_executable(&fake_shim);

    let orig_path = std::env::var_os("PATH").unwrap_or_default();
    let mut new_path = bin_dir.path().to_path_buf().into_os_string();
    new_path.push(if cfg!(windows) { ";" } else { ":" });
    new_path.push(&orig_path);

    std::env::set_var("PATH", &new_path);
    std::env::remove_var("SCIP_RUST_BIN");

    let repo = tempfile::tempdir().unwrap();
    rust_repo(repo.path());

    let provider = ScipRustProvider::new();
    let resolution = provider.resolution();
    match resolution {
        RustResolution::Resolved(RustScipInvocation::ScipRustShim { ref executable }) => {
            assert_eq!(executable, &fake_shim);
        }
        other => panic!("Expected ScipRustShim resolution, got {:?}", other),
    }

    let discovery = provider.discover(repo.path()).unwrap();
    assert!(discovery.supported);
    assert_eq!(
        discovery.provider_version.as_deref(),
        Some("scip-rust 0.1.0")
    );

    let report = refresh_provider(repo.path(), &provider, true).unwrap();
    assert_eq!(report.generation, 1);
    assert!(report.edges > 0);

    let log_content = std::fs::read_to_string(&log_file).unwrap();
    assert!(log_content.contains("INVOKED: --version"));
    assert!(log_content.contains("INVOKED: --help"));

    std::env::set_var("PATH", &orig_path);
    drop(guard);
}

#[test]
fn test_rust_version_probe_failure_fails_active_fingerprint() {
    let guard = lock_env();

    let bin_dir = tempfile::tempdir().unwrap();
    let fake_ra = bin_dir.path().join("rust-analyzer");

    // Fake rust-analyzer whose --version always fails (exit code 1)
    let script = r#"#!/bin/bash
exit 1
"#;
    std::fs::write(&fake_ra, script).unwrap();
    #[cfg(unix)]
    make_executable(&fake_ra);

    let orig_path = std::env::var_os("PATH").unwrap_or_default();
    let mut new_path = bin_dir.path().to_path_buf().into_os_string();
    new_path.push(if cfg!(windows) { ";" } else { ":" });
    new_path.push(&orig_path);

    std::env::set_var("PATH", &new_path);
    std::env::remove_var("SCIP_RUST_BIN");

    let repo = tempfile::tempdir().unwrap();
    rust_repo(repo.path());

    let provider = ScipRustProvider::new();
    let err = provider.active_fingerprint(repo.path()).unwrap_err();
    assert!(
        matches!(err, SemanticProviderError::Failed(_)),
        "Active fingerprint must fail when version probe fails, not fall back to 'unknown'"
    );

    std::env::set_var("PATH", &orig_path);
    drop(guard);
}

#[test]
fn test_windows_cmd_bat_fail_closed_and_no_comspec() {
    let guard = lock_env();

    let bin_dir = tempfile::tempdir().unwrap();
    let cmd_file = bin_dir.path().join("scip-typescript.cmd");
    let bat_file = bin_dir.path().join("scip-rust.bat");
    let exe_file = bin_dir.path().join("native-tool.exe");

    std::fs::write(
        &cmd_file,
        "@echo off
echo 0.4.0
",
    )
    .unwrap();
    std::fs::write(
        &bat_file,
        "@echo off
echo 0.1.0
",
    )
    .unwrap();
    std::fs::write(&exe_file, "binary").unwrap();
    #[cfg(unix)]
    make_executable(&exe_file);

    let orig_path = std::env::var_os("PATH").unwrap_or_default();
    let mut new_path = bin_dir.path().to_path_buf().into_os_string();
    new_path.push(if cfg!(windows) { ";" } else { ":" });
    new_path.push(&orig_path);

    std::env::set_var("PATH", &new_path);
    std::env::remove_var("SCIP_TYPESCRIPT_BIN");
    std::env::remove_var("SCIP_RUST_BIN");

    // Test ExecutableResolution classification directly on PATH lookup
    let res_cmd = find_executable_resolved("scip-typescript");
    assert!(
        matches!(res_cmd, ExecutableResolution::CommandShim(_)),
        "scip-typescript must resolve as CommandShim on PATH with only .cmd"
    );

    let repo = tempfile::tempdir().unwrap();
    let src = repo.path().join("src");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(
        src.join("index.ts"),
        "export const x = 1;
",
    )
    .unwrap();
    std::fs::write(
        src.join("lib.rs"),
        "pub fn f() {}
",
    )
    .unwrap();
    std::fs::write(
        repo.path().join("tsconfig.json"),
        "{}
",
    )
    .unwrap();
    std::fs::write(
        repo.path().join("Cargo.toml"),
        r#"[package]
name="d"
version="0.1.0"
"#,
    )
    .unwrap();

    let ts_provider = ScipTypescriptProvider::new();
    let rust_provider = ScipRustProvider::new();

    // Explicit override pointing to .cmd also fails closed
    std::env::set_var("SCIP_TYPESCRIPT_BIN", &cmd_file);
    let ts_override_health = ts_provider.passive_health(repo.path());
    assert_eq!(
        ts_override_health,
        ProviderHealth::Misconfigured,
        "Explicit .cmd override must be Misconfigured"
    );

    let ts_disc = ts_provider.discover(repo.path()).unwrap();
    assert!(
        !ts_disc.supported,
        "Command shim must not be supported for execution"
    );
    assert!(
        ts_disc
            .reasons
            .iter()
            .any(|r| r.contains("command shim") || r.contains("native executable")),
        "Reason must explain command shim requires native executable"
    );

    // Refresh provider must fail safely
    let res = refresh_provider(repo.path(), &ts_provider, true);
    assert!(
        res.is_err(),
        "Ingestion must fail closed when provider is a command shim"
    );

    // Explicit override pointing to .bat on rust provider also fails closed
    std::env::set_var("SCIP_RUST_BIN", &bat_file);
    let rust_override_health = rust_provider.passive_health(repo.path());
    assert_eq!(
        rust_override_health,
        ProviderHealth::Misconfigured,
        "Explicit .bat override must be Misconfigured"
    );

    let rust_disc = rust_provider.discover(repo.path()).unwrap();
    assert!(
        !rust_disc.supported,
        "Command shim must not be supported for execution"
    );

    // Direct run_bounded_process rejects command shim immediately
    let run_res = run_bounded_process(
        &cmd_file,
        &[],
        repo.path(),
        Duration::from_secs(5),
        1024,
        1024,
        None,
    );
    assert!(
        run_res.is_err(),
        "run_bounded_process must reject .cmd file"
    );

    std::env::remove_var("SCIP_TYPESCRIPT_BIN");
    std::env::remove_var("SCIP_RUST_BIN");
    std::env::set_var("PATH", &orig_path);
    drop(guard);
}

#[test]
fn test_special_characters_in_process_execution_paths() {
    // Tests that paths with spaces, &, (, ), ", unicode are passed directly without shell splitting
    let bin_dir = tempfile::tempdir().unwrap();
    let special_arg_dir = bin_dir
        .path()
        .join(r#"test space & paren (1) [tag] 'quote' "dquote" 🚀"#);
    std::fs::create_dir_all(&special_arg_dir).unwrap();

    let echo_script = bin_dir.path().join("echo_args");
    let script = r#"#!/bin/bash
for a in "$@"; do
    echo "ARG: $a"
done
"#;
    std::fs::write(&echo_script, script).unwrap();
    #[cfg(unix)]
    make_executable(&echo_script);

    #[cfg(unix)]
    {
        let special_path_str = special_arg_dir.to_string_lossy().into_owned();
        let outcome = run_bounded_process(
            &echo_script,
            std::slice::from_ref(&special_path_str),
            bin_dir.path(),
            Duration::from_secs(5),
            1024 * 64,
            1024 * 64,
            None,
        )
        .unwrap();

        assert_eq!(outcome.exit_code, Some(0));
        assert!(
            outcome
                .stdout_tail
                .contains(&format!("ARG: {}", special_path_str)),
            "Argument with special characters must be preserved without shell interpolation"
        );
    }
}
