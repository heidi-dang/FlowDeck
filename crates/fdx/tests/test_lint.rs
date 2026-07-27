use std::path::PathBuf;
use std::process::Command;

fn fdx_bin() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let debug = manifest.join("../../target/debug/fdx");
    if debug.exists() {
        return debug;
    }
    manifest.join("../../target/release/fdx")
}

#[test]
fn test_lint_clippy() {
    // Skip if clippy is not installed
    if Command::new("clippy-driver")
        .arg("--version")
        .output()
        .is_err()
        && Command::new("cargo-clippy")
            .arg("--version")
            .output()
            .is_err()
    {
        eprintln!("skipping test_lint_clippy: clippy not available");
        return;
    }

    let output = Command::new(fdx_bin())
        .args(["lint", "clippy"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("fdx lint clippy failed");

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("issues across") || stdout.contains("ok  no issues"),
        "should show lint result: {}",
        stdout
    );
}

#[test]
fn test_lint_unsupported() {
    let output = Command::new(fdx_bin())
        .args(["lint", "unknown_linter"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("fdx lint failed");

    assert!(
        !output.status.success(),
        "should fail for unsupported linter"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("unsupported"),
        "should show unsupported error: {}",
        stderr
    );
}
