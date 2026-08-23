//! Milestone 5 Trust Proof: Real ProviderDetection::Indeterminate Lifecycle & Absence Control.

use fdx::intelligence::build::bounds::with_test_walker_error;
use fdx::intelligence::build::config::TsConfigProvider;
use fdx::intelligence::build::ingest::refresh_all_build_providers;
use fdx::intelligence::build::package::PackageJsonProvider;
use fdx::intelligence::build::provider::{BuildConfigProvider, ProviderDetection};
use fdx::intelligence::build::target::CargoProvider;
use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use std::fs;
use tempfile::tempdir;

#[test]
fn test_provider_detection_tri_state_and_indeterminate_preservation() {
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

    // 2. Add package.json -> PackageJson is Present
    fs::write(
        repo_root.join("package.json"),
        serde_json::json!({ "name": "my-app", "version": "1.0.0" }).to_string(),
    )
    .unwrap();
    assert_eq!(pkg_prov.detect_state(repo_root), ProviderDetection::Present);

    // Refresh successfully and record baseline evidence
    let reports = refresh_all_build_providers(repo_root, false).unwrap();
    let pkg_report = reports
        .iter()
        .find(|r| r.provider_id == "builtin-package-json")
        .unwrap();
    assert!(pkg_report.nodes > 0, "Package provider must publish nodes");
    let baseline_nodes = pkg_report.nodes;
    let baseline_edges = pkg_report.edges;
    let baseline_gen = pkg_report.generation;

    // Verify DB state
    {
        let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly).unwrap();
        let db_nodes: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM nodes WHERE source_identity = 'builtin-package-json'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(db_nodes as usize, baseline_nodes);

        let db_edges: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM edges WHERE source_identity = 'builtin-package-json'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(db_edges as usize, baseline_edges);
    }

    // 3. CRITICAL: Inject discovery failure -> detect_state == Indeterminate
    with_test_walker_error(
        Some("simulated permission/read failure".to_string()),
        || {
            let det = pkg_prov.detect_state(repo_root);
            assert!(
                matches!(det, ProviderDetection::Indeterminate(ref err) if err.contains("simulated permission/read failure")),
                "Provider must return Indeterminate on discovery failure"
            );

            // Refresh with indeterminate state: old evidence MUST be preserved, not retired!
            let ind_reports = refresh_all_build_providers(repo_root, false).unwrap();
            let ind_pkg_report = ind_reports
                .iter()
                .find(|r| r.provider_id == "builtin-package-json")
                .unwrap();
            assert!(ind_pkg_report.failure_reason.is_some());

            // Verify DB preserved nodes and edges and generation
            let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly).unwrap();
            let current_nodes: i64 = db
                .conn
                .query_row(
                    "SELECT COUNT(*) FROM nodes WHERE source_identity = 'builtin-package-json'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(
                current_nodes as usize, baseline_nodes,
                "Nodes must be preserved during Indeterminate discovery failure"
            );

            let current_edges: i64 = db
                .conn
                .query_row(
                    "SELECT COUNT(*) FROM edges WHERE source_identity = 'builtin-package-json'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(
                current_edges as usize, baseline_edges,
                "Edges must be preserved during Indeterminate discovery failure"
            );

            // Verify provider marked failed / stale
            let (health, freshness, failure_reason, gen): (String, String, Option<String>, i64) = db
            .conn
            .query_row(
                "SELECT health, freshness, failure_reason, semantic_generation FROM semantic_providers WHERE provider_id = 'builtin-package-json'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
            assert_eq!(health, "failed");
            assert_eq!(freshness, "stale");
            assert!(failure_reason
                .unwrap()
                .contains("simulated permission/read failure"));
            assert_eq!(gen as u64, baseline_gen);
        },
    );

    // 4. Disable injected failure -> returns Present
    assert_eq!(pkg_prov.detect_state(repo_root), ProviderDetection::Present);
    let healthy_reports = refresh_all_build_providers(repo_root, false).unwrap();
    assert!(healthy_reports
        .iter()
        .any(|r| r.provider_id == "builtin-package-json" && r.failure_reason.is_none()));

    // 5. Proven Absence Control: Delete manifest -> detect_state == Absent -> retires evidence
    fs::remove_file(repo_root.join("package.json")).unwrap();
    assert_eq!(pkg_prov.detect_state(repo_root), ProviderDetection::Absent);

    let retire_reports = refresh_all_build_providers(repo_root, false).unwrap();
    let retired_pkg = retire_reports
        .iter()
        .find(|r| r.provider_id == "builtin-package-json")
        .unwrap();
    assert_eq!(retired_pkg.nodes, 0);
    assert_eq!(retired_pkg.edges, 0);

    // Verify DB evidence retired
    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly).unwrap();
    let final_nodes: i64 = db
        .conn
        .query_row(
            "SELECT COUNT(*) FROM nodes WHERE source_identity = 'builtin-package-json'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        final_nodes, 0,
        "Evidence must be retired only on proven absence"
    );

    let final_edges: i64 = db
        .conn
        .query_row(
            "SELECT COUNT(*) FROM edges WHERE source_identity = 'builtin-package-json'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        final_edges, 0,
        "Edges must be retired only on proven absence"
    );
}
