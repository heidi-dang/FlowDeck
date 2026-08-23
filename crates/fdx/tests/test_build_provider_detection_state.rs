use fdx::intelligence::build::config::TsConfigProvider;
use fdx::intelligence::build::ingest::refresh_all_build_providers;
use fdx::intelligence::build::package::PackageJsonProvider;
use fdx::intelligence::build::provider::{BuildConfigProvider, ProviderDetection};
use fdx::intelligence::build::target::CargoProvider;
use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use std::fs;
use tempfile::tempdir;

#[test]
fn test_provider_detection_tri_state_behavior() {
    let tmp = tempdir().unwrap();
    let repo_root = tmp.path();

    let pkg_prov = PackageJsonProvider::new();
    let ts_prov = TsConfigProvider::new();
    let cargo_prov = CargoProvider::new();

    // 1. Initial empty directory: all Absent
    assert_eq!(pkg_prov.detect_state(repo_root), ProviderDetection::Absent);
    assert_eq!(ts_prov.detect_state(repo_root), ProviderDetection::Absent);
    assert_eq!(
        cargo_prov.detect_state(repo_root),
        ProviderDetection::Absent
    );

    // 2. Add package.json -> PackageJson is Present, others Absent
    fs::write(
        repo_root.join("package.json"),
        serde_json::json!({ "name": "my-app", "version": "1.0.0" }).to_string(),
    )
    .unwrap();
    assert_eq!(pkg_prov.detect_state(repo_root), ProviderDetection::Present);
    assert_eq!(ts_prov.detect_state(repo_root), ProviderDetection::Absent);
    assert_eq!(
        cargo_prov.detect_state(repo_root),
        ProviderDetection::Absent
    );

    // Refresh and verify evidence published
    let reports = refresh_all_build_providers(repo_root, false).unwrap();
    assert!(reports
        .iter()
        .any(|r| r.provider_id == "builtin-package-json" && r.nodes > 0));

    // 3. Proven absence: remove package.json and refresh
    fs::remove_file(repo_root.join("package.json")).unwrap();
    assert_eq!(pkg_prov.detect_state(repo_root), ProviderDetection::Absent);

    let retire_reports = refresh_all_build_providers(repo_root, false).unwrap();
    let pkg_report = retire_reports
        .iter()
        .find(|r| r.provider_id == "builtin-package-json")
        .unwrap();
    assert_eq!(pkg_report.nodes, 0);
    assert_eq!(pkg_report.edges, 0);

    // Verify DB retired
    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly).unwrap();
    let count_nodes: i64 = db
        .conn
        .query_row(
            "SELECT COUNT(*) FROM nodes WHERE source_identity = 'builtin-package-json'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count_nodes, 0);

    let count_edges: i64 = db
        .conn
        .query_row(
            "SELECT COUNT(*) FROM edges WHERE source_identity = 'builtin-package-json'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count_edges, 0);
}
