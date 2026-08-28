use tempfile::tempdir;

#[test]
fn test_fdx_verify_cli_basic() {
    let dir = tempdir().unwrap();
    // Initialize git repo in tempdir with an initial commit
    std::process::Command::new("git")
        .args(["init"])
        .current_dir(dir.path())
        .output()
        .unwrap();

    let pkg_json = dir.path().join("package.json");
    std::fs::write(
        &pkg_json,
        r#"{"name": "cli-pkg", "scripts": {"test": "node -e 'process.exit(0)'"}}"#,
    )
    .unwrap();

    std::process::Command::new("git")
        .args(["config", "user.name", "Test"])
        .current_dir(dir.path())
        .output()
        .unwrap();
    std::process::Command::new("git")
        .args(["config", "user.email", "test@example.com"])
        .current_dir(dir.path())
        .output()
        .unwrap();
    std::process::Command::new("git")
        .args(["add", "."])
        .current_dir(dir.path())
        .output()
        .unwrap();
    std::process::Command::new("git")
        .args(["commit", "-m", "initial"])
        .current_dir(dir.path())
        .output()
        .unwrap();

    let status = std::process::Command::new(env!("CARGO_BIN_EXE_fdx"))
        .current_dir(dir.path())
        .args(["verify", "--format", "json", "--no-persist"])
        .status()
        .expect("failed to execute fdx binary");

    assert!(status.success());
}
