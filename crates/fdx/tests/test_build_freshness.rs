use fdx::intelligence::build::freshness::evaluate_build_freshness;
use fdx::intelligence::build::ingest::refresh_all_build_providers;
use fdx::intelligence::semantic::health::ProviderFreshness;
use std::fs;
use tempfile::tempdir;

#[test]
fn test_passive_effective_freshness_when_manifest_modified() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    fs::write(
        root.join("package.json"),
        r#"{ "name": "app", "version": "1.0.0" }"#,
    )
    .unwrap();

    // Initial ingest
    refresh_all_build_providers(root, false).unwrap();

    // Verify fresh
    let states = evaluate_build_freshness(root).unwrap();
    let pkg_state = states
        .iter()
        .find(|s| s.provider_id == "builtin-package-json")
        .unwrap();
    assert_eq!(pkg_state.freshness, ProviderFreshness::Fresh);

    // Modify manifest on disk without refresh
    fs::write(
        root.join("package.json"),
        r#"{ "name": "app", "version": "1.0.1" }"#,
    )
    .unwrap();

    // Passive evaluation must detect stale fingerprint without running any subprocess or DB mutation
    let states2 = evaluate_build_freshness(root).unwrap();
    let pkg_state2 = states2
        .iter()
        .find(|s| s.provider_id == "builtin-package-json")
        .unwrap();
    assert_eq!(pkg_state2.freshness, ProviderFreshness::Stale);
}
