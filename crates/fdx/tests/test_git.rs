use std::path::PathBuf;
use std::process::Command;

fn fdx_bin() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // Try debug first (cargo test), then release (cargo test --release)
    let debug = manifest.join("../../target/debug/fdx");
    if debug.exists() {
        return debug;
    }
    manifest.join("../../target/release/fdx")
}

#[test]
fn test_git_status() {
    let output = Command::new(fdx_bin())
        .args(["git", "status"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("fdx git status failed");

    let stdout = String::from_utf8_lossy(&output.stdout);
    // Should show either clean or some status groups
    assert!(
        stdout.contains("clean")
            || stdout.contains("staged")
            || stdout.contains("unstaged")
            || stdout.contains("untracked"),
        "should show status: {}",
        stdout
    );
    assert!(output.status.success());
}

#[test]
fn test_git_log() {
    let output = Command::new(fdx_bin())
        .args(["git", "log", "-n", "3"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("fdx git log failed");

    let stdout = String::from_utf8_lossy(&output.stdout);
    // Should show commit SHAs (7 hex chars)
    assert!(stdout.len() > 20, "should have log output: {}", stdout);
    assert!(output.status.success());
}

#[test]
fn test_git_branch() {
    let output = Command::new(fdx_bin())
        .args(["git", "branch"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("fdx git branch failed");

    let stdout = String::from_utf8_lossy(&output.stdout);
    let has_branch = stdout.contains("main") || stdout.contains("HEAD");
    assert!(has_branch, "should show current branch or HEAD: {}", stdout);
    assert!(output.status.success());
}

#[test]
fn test_git_pass_through() {
    // Test that allowed subcommands pass through
    let output = Command::new(fdx_bin())
        .args(["git", "rev-parse", "--is-inside-work-tree"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("fdx git rev-parse failed");

    assert!(output.status.success(), "git rev-parse should succeed");
}
