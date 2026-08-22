use std::fs;
use std::process::Command;
use tempfile::tempdir;

#[test]
fn test_build_cli_status_and_refresh() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    fs::write(
        root.join("package.json"),
        r#"{ "name": "app", "version": "1.0.0" }"#,
    )
    .unwrap();

    let target_bin = env!("CARGO_BIN_EXE_fdx");

    // fdx build refresh
    let refresh_out = Command::new(target_bin)
        .args(["build", "refresh"])
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        refresh_out.status.success(),
        "fdx build refresh must succeed"
    );

    // fdx build status
    let status_out = Command::new(target_bin)
        .args(["build", "status"])
        .current_dir(root)
        .output()
        .unwrap();
    assert!(status_out.status.success(), "fdx build status must succeed");
    let status_str = String::from_utf8_lossy(&status_out.stdout);
    assert!(status_str.contains("BUILD") || status_str.contains("builtin-package-json"));
}
