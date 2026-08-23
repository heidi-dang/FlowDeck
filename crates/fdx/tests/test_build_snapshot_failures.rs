use fdx::intelligence::build::freshness::collect_build_uncertainties;
use fdx::intelligence::build::snapshot::CurrentBuildSnapshot;
use std::fs;
use tempfile::tempdir;

#[test]
fn test_snapshot_propagates_malformed_root_manifest_failure() {
    let tmp = tempdir().unwrap();
    let repo_root = tmp.path();

    // Create a malformed root package.json
    fs::write(
        repo_root.join("package.json"),
        "{\"name\": \"root\", INVALID_JSON",
    )
    .unwrap();

    let snapshot = CurrentBuildSnapshot::build(repo_root);
    assert!(!snapshot.uncertainties.is_empty());
    assert!(snapshot
        .uncertainties
        .iter()
        .any(|u| u.code == "provider_ingest_failed" || u.code == "malformed_package_json"));
    assert!(snapshot.uncertainties.iter().any(|u| u.should_widen));

    let direct_unc = collect_build_uncertainties(repo_root);
    assert!(!direct_unc.is_empty());
    assert!(direct_unc
        .iter()
        .any(|u| u.code == "provider_ingest_failed" || u.code == "malformed_package_json"));
}

#[test]
fn test_snapshot_propagates_malformed_cargo_manifest_failure() {
    let tmp = tempdir().unwrap();
    let repo_root = tmp.path();

    // Create a malformed root Cargo.toml
    fs::write(
        repo_root.join("Cargo.toml"),
        "[workspace]\nmembers = [ UNCLOSED_BRACKET",
    )
    .unwrap();

    let snapshot = CurrentBuildSnapshot::build(repo_root);
    assert!(!snapshot.uncertainties.is_empty());
    assert!(snapshot
        .uncertainties
        .iter()
        .any(|u| u.code == "provider_ingest_failed" || u.code == "malformed_cargo_toml"));
    assert!(snapshot.uncertainties.iter().any(|u| u.should_widen));
}
