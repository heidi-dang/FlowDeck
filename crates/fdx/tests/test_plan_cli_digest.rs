//! Contract tests for native FDX plan digests emitted via CLI.

use std::process::Command;
use tempfile::tempdir;

#[test]
fn test_fdx_plan_cli_emits_authoritative_digests() {
    let dir = tempdir().unwrap();
    // Initialize git repo in tempdir
    Command::new("git")
        .args(["init"])
        .current_dir(dir.path())
        .output()
        .unwrap();

    let pkg_json = dir.path().join("package.json");
    std::fs::write(
        &pkg_json,
        r#"{"name": "plan-digest-pkg", "scripts": {"test": "node -e 'process.exit(0)'"}}"#,
    )
    .unwrap();

    Command::new("git")
        .args(["config", "user.name", "Test"])
        .current_dir(dir.path())
        .output()
        .unwrap();
    Command::new("git")
        .args(["config", "user.email", "test@example.com"])
        .current_dir(dir.path())
        .output()
        .unwrap();
    Command::new("git")
        .args(["add", "."])
        .current_dir(dir.path())
        .output()
        .unwrap();
    Command::new("git")
        .args(["commit", "-m", "initial"])
        .current_dir(dir.path())
        .output()
        .unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_fdx"))
        .current_dir(dir.path())
        .args(["plan", "--format", "json"])
        .output()
        .expect("failed to execute fdx plan");

    assert!(output.status.success());
    let stdout_str = String::from_utf8(output.stdout).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&stdout_str).unwrap();

    assert!(parsed.get("base_plan_digest").is_some());
    assert!(parsed.get("effective_plan_digest").is_some());
    let base_digest = parsed["base_plan_digest"].as_str().unwrap();
    let effective_digest = parsed["effective_plan_digest"].as_str().unwrap();
    assert_eq!(base_digest, effective_digest);
    assert_eq!(base_digest.len(), 64);
}

#[test]
fn test_fdx_verify_cli_emits_authoritative_digests() {
    let dir = tempdir().unwrap();
    Command::new("git")
        .args(["init"])
        .current_dir(dir.path())
        .output()
        .unwrap();

    let pkg_json = dir.path().join("package.json");
    std::fs::write(
        &pkg_json,
        r#"{"name": "verify-digest-pkg", "scripts": {"test": "node -e 'process.exit(0)'"}}"#,
    )
    .unwrap();

    Command::new("git")
        .args(["config", "user.name", "Test"])
        .current_dir(dir.path())
        .output()
        .unwrap();
    Command::new("git")
        .args(["config", "user.email", "test@example.com"])
        .current_dir(dir.path())
        .output()
        .unwrap();
    Command::new("git")
        .args(["add", "."])
        .current_dir(dir.path())
        .output()
        .unwrap();
    Command::new("git")
        .args(["commit", "-m", "initial"])
        .current_dir(dir.path())
        .output()
        .unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_fdx"))
        .current_dir(dir.path())
        .args(["verify", "--format", "json", "--no-persist"])
        .output()
        .expect("failed to execute fdx verify");

    assert!(output.status.success());
    let stdout_str = String::from_utf8(output.stdout).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&stdout_str).unwrap();

    assert!(parsed.get("base_plan_digest").is_some());
    assert!(parsed.get("effective_plan_digest").is_some());
    let base_digest = parsed["base_plan_digest"].as_str().unwrap();
    let effective_digest = parsed["effective_plan_digest"].as_str().unwrap();
    assert_eq!(base_digest, effective_digest);
    assert_eq!(base_digest.len(), 64);
}
