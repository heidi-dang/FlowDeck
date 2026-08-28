//! Milestone 5 Trust Proof: Determinstic Bound Tests & Conservative Widening.

use fdx::intelligence::build::bounds::{
    with_test_build_limits, with_test_walker_error, BuildLimits,
};
use fdx::intelligence::build::snapshot::CurrentBuildSnapshot;
use fdx::intelligence::change::traverse::analyze_impact_v2;
use fdx::protocol::{AssuranceLevel, EdgeKind, NodeKind};
use std::fs;
use tempfile::tempdir;

fn init_git(dir: &std::path::Path) {
    std::process::Command::new("git")
        .args(["init", "--initial-branch=main"])
        .current_dir(dir)
        .output()
        .unwrap();
    std::process::Command::new("git")
        .args(["config", "user.name", "Test Runner"])
        .current_dir(dir)
        .output()
        .unwrap();
    std::process::Command::new("git")
        .args(["config", "user.email", "test@example.com"])
        .current_dir(dir)
        .output()
        .unwrap();
}

fn commit_all(dir: &std::path::Path, msg: &str) {
    std::process::Command::new("git")
        .args(["add", "-A"])
        .current_dir(dir)
        .output()
        .unwrap();
    std::process::Command::new("git")
        .args(["commit", "-m", msg, "--allow-empty"])
        .current_dir(dir)
        .output()
        .unwrap();
}

#[test]
fn test_omitted_edge_conservative_widening_adversarial() {
    let tmp = tempdir().unwrap();
    let repo_root = tmp.path();
    init_git(repo_root);

    // Root package.json
    fs::write(
        repo_root.join("package.json"),
        serde_json::json!({
            "name": "root",
            "private": true,
            "workspaces": ["packages/*"]
        })
        .to_string(),
    )
    .unwrap();

    // Create 4 packages:
    // pkg-a DEPENDS_ON pkg-b
    // pkg-b DEPENDS_ON pkg-c
    // pkg-c DEPENDS_ON pkg-d
    // pkg-d has no internal deps
    // No direct source-code imports between packages.
    for (name, dep_name) in [
        ("pkg-a", Some("@app/pkg-b")),
        ("pkg-b", Some("@app/pkg-c")),
        ("pkg-c", Some("@app/pkg-d")),
        ("pkg-d", None),
    ] {
        let pdir = repo_root.join("packages").join(name);
        fs::create_dir_all(pdir.join("src")).unwrap();
        fs::write(
            pdir.join("src").join("index.ts"),
            format!("export const val_{} = 1;", name.replace('-', "_")),
        )
        .unwrap();

        let mut deps = serde_json::Map::new();
        if let Some(dep) = dep_name {
            deps.insert(
                dep.to_string(),
                serde_json::Value::String("1.0.0".to_string()),
            );
        }

        fs::write(
            pdir.join("package.json"),
            serde_json::json!({
                "name": format!("@app/{}", name),
                "version": "1.0.0",
                "dependencies": deps
            })
            .to_string(),
        )
        .unwrap();
    }

    commit_all(repo_root, "init");

    let low_edge_limits = BuildLimits {
        edges: 2,
        ..Default::default()
    };

    // Step 1: Lower-level proof that without conservative widening, A is absent from exact reverse graph
    with_test_build_limits(low_edge_limits, || {
        let snapshot = CurrentBuildSnapshot::build(repo_root);
        assert_eq!(snapshot.edges.len(), 2);
        let pkg_b_node = "pkg:npm:packages/pkg-b";
        let rev_deps_b = snapshot.depends_on_reverse.get(pkg_b_node);
        assert!(
            rev_deps_b.is_none()
                || !rev_deps_b
                    .unwrap()
                    .contains(&"pkg:npm:packages/pkg-a".to_string()),
            "A -> B reverse dependency must be absent from exact truncated snapshot"
        );
    });

    // Step 2: Refresh build providers with edge bound
    with_test_build_limits(low_edge_limits, || {
        let _ = fdx::intelligence::build::ingest::refresh_all_build_providers(repo_root, false)
            .unwrap();
    });

    // Step 3: Modify ONLY pkg-d/src/index.ts
    fs::write(
        repo_root.join("packages/pkg-d/src/index.ts"),
        "export const val_pkg_d = 2;",
    )
    .unwrap();

    // Step 4: Run impact-v2 under low edge limits
    let res = with_test_build_limits(low_edge_limits, || {
        analyze_impact_v2(repo_root, Some("HEAD"), None, Some(5)).unwrap()
    });

    // Verify D directly impacted
    assert!(res
        .impacted
        .iter()
        .any(|t| t.target.contains("packages/pkg-d")));
    // Verify C and B impacted
    assert!(res
        .impacted
        .iter()
        .any(|t| t.target.contains("packages/pkg-c")));
    assert!(res
        .impacted
        .iter()
        .any(|t| t.target.contains("packages/pkg-b")));

    // CRITICAL: Verify A is also safely included through conservative widening despite omitted edge
    let pkg_a = res
        .impacted
        .iter()
        .find(|t| t.target.contains("packages/pkg-a"));
    assert!(
        pkg_a.is_some(),
        "pkg-a must be safely included in impacted set via conservative widening"
    );
    assert_eq!(
        pkg_a.unwrap().widening_reason.as_deref(),
        Some("build_limit_reached")
    );

    // Verify BuildLimitReached uncertainty present
    assert!(res
        .uncertainty
        .iter()
        .any(|u| u.code() == "build_limit_reached"));

    // Verify assurance is degraded
    assert!(res.assurance <= AssuranceLevel::Degraded);
}

#[test]
fn test_workspace_member_bound_safe_widening() {
    let tmp = tempdir().unwrap();
    let repo_root = tmp.path();
    init_git(repo_root);

    // Root workspace with 3 members: pkg-a, pkg-b, pkg-c
    fs::write(
        repo_root.join("package.json"),
        serde_json::json!({
            "name": "root",
            "private": true,
            "workspaces": ["packages/*"]
        })
        .to_string(),
    )
    .unwrap();

    for name in ["pkg-a", "pkg-b", "pkg-c"] {
        let pdir = repo_root.join("packages").join(name);
        fs::create_dir_all(pdir.join("src")).unwrap();
        fs::write(pdir.join("src/index.ts"), "export const x = 1;").unwrap();
        fs::write(
            pdir.join("package.json"),
            serde_json::json!({ "name": format!("@app/{}", name), "version": "1.0.0" }).to_string(),
        )
        .unwrap();
    }

    commit_all(repo_root, "init");

    // Low workspace member limit = 2 (so pkg-c is beyond workspace member enumeration)
    let low_ws_limits = BuildLimits {
        workspace_members: 2,
        ..Default::default()
    };

    // PROOF: In exact snapshot, workspace membership map excludes pkg-c AND Workspace CONTAINS Package edge is absent
    with_test_build_limits(low_ws_limits, || {
        let snapshot = CurrentBuildSnapshot::build(repo_root);
        assert_eq!(snapshot.package_to_owning_workspace.len(), 2);
        assert!(!snapshot
            .package_to_owning_workspace
            .contains_key("pkg:npm:packages/pkg-c"));

        let ws_contains_c_edge = "edge:contains:workspace:npm:.:pkg:npm:packages/pkg-c".to_string();
        assert!(
            !snapshot
                .edges
                .iter()
                .any(|e| e.stable_id == ws_contains_c_edge),
            "Workspace CONTAINS pkg-c edge must NOT be published when member is omitted by bound"
        );
    });

    with_test_build_limits(low_ws_limits, || {
        let _ = fdx::intelligence::build::ingest::refresh_all_build_providers(repo_root, false)
            .unwrap();
    });

    // Modify root package.json
    fs::write(
        repo_root.join("package.json"),
        serde_json::json!({
            "name": "root",
            "private": true,
            "workspaces": ["packages/*", "libs/*"]
        })
        .to_string(),
    )
    .unwrap();

    let res = with_test_build_limits(low_ws_limits, || {
        analyze_impact_v2(repo_root, Some("HEAD"), None, Some(3)).unwrap()
    });

    // pkg-c must still be conservatively covered by safe fallback widening
    assert!(
        res.impacted
            .iter()
            .any(|t| t.target.contains("packages/pkg-c")),
        "pkg-c must be covered by safe widening when workspace member limit is reached"
    );
    assert!(res
        .uncertainty
        .iter()
        .any(|u| u.code() == "build_limit_reached"));
    assert!(res.assurance <= AssuranceLevel::Degraded);
}

#[test]
fn test_config_bound_safe_widening_tsconfig_only() {
    let tmp = tempdir().unwrap();
    let repo_root = tmp.path();
    init_git(repo_root);

    // TSCONFIG-ONLY repository: NO package.json, NO Cargo.toml
    for name in ["a", "b", "c"] {
        let dir = repo_root.join(format!("proj-{}", name));
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("src/index.ts"), "export const x = 1;").unwrap();
        fs::write(
            dir.join("tsconfig.json"),
            serde_json::json!({
                "compilerOptions": { "composite": true }
            })
            .to_string(),
        )
        .unwrap();
    }

    commit_all(repo_root, "init");

    // Config limit = 2 (so proj-c/tsconfig.json is beyond exact config enumeration)
    let low_cfg_limits = BuildLimits {
        configs: 2,
        ..Default::default()
    };

    // PROOF: proj-c/tsconfig.json is absent from exact config snapshot
    with_test_build_limits(low_cfg_limits, || {
        let snapshot = CurrentBuildSnapshot::build(repo_root);
        let cfg_nodes: Vec<_> = snapshot
            .nodes
            .values()
            .filter(|n| n.kind == NodeKind::Config)
            .collect();
        assert_eq!(cfg_nodes.len(), 2);
        assert!(!snapshot.nodes.contains_key("config:proj-c/tsconfig.json"));
    });

    with_test_build_limits(low_cfg_limits, || {
        let _ = fdx::intelligence::build::ingest::refresh_all_build_providers(repo_root, false)
            .unwrap();
    });

    // Modify proj-c tsconfig
    fs::write(
        repo_root.join("proj-c/tsconfig.json"),
        serde_json::json!({
            "compilerOptions": { "composite": true, "declaration": true }
        })
        .to_string(),
    )
    .unwrap();

    let res = with_test_build_limits(low_cfg_limits, || {
        analyze_impact_v2(repo_root, Some("HEAD"), None, Some(3)).unwrap()
    });

    // proj-c must still be represented and safe widening covers config directory/scope
    assert!(
        res.impacted.iter().any(|t| t.target.contains("proj-c")),
        "proj-c must be safely covered by conservative fallback widening"
    );
    assert!(res
        .uncertainty
        .iter()
        .any(|u| u.code() == "build_limit_reached"));
    assert!(res.assurance <= AssuranceLevel::Degraded);
}

#[test]
fn test_target_bound_safe_widening() {
    let tmp = tempdir().unwrap();
    let repo_root = tmp.path();
    init_git(repo_root);

    let pdir = repo_root.join("packages/pkg-a");
    fs::create_dir_all(pdir.join("src")).unwrap();
    fs::write(pdir.join("src/index.ts"), "export const a = 1;").unwrap();
    fs::write(
        pdir.join("package.json"),
        serde_json::json!({
            "name": "@app/pkg-a",
            "version": "1.0.0",
            "scripts": {
                "build": "tsc",
                "test": "vitest",
                "lint": "eslint"
            }
        })
        .to_string(),
    )
    .unwrap();

    commit_all(repo_root, "init");

    // Target limit = 1
    let low_tgt_limits = BuildLimits {
        targets: 1,
        ..Default::default()
    };

    // PROOF: In exact snapshot, only 1 target exists, and subsequent targets are absent from nodes and edges
    with_test_build_limits(low_tgt_limits, || {
        let snapshot = CurrentBuildSnapshot::build(repo_root);
        let target_nodes = snapshot
            .nodes
            .values()
            .filter(|n| n.kind == NodeKind::BuildTarget)
            .count();
        assert_eq!(target_nodes, 1);
        let belongs_to_edges = snapshot
            .edges
            .iter()
            .filter(|e| e.kind == EdgeKind::BelongsTo)
            .count();
        assert_eq!(belongs_to_edges, 1);
    });

    with_test_build_limits(low_tgt_limits, || {
        let _ = fdx::intelligence::build::ingest::refresh_all_build_providers(repo_root, false)
            .unwrap();
    });

    // Modify script in package.json
    fs::write(
        pdir.join("package.json"),
        serde_json::json!({
            "name": "@app/pkg-a",
            "version": "1.0.0",
            "scripts": {
                "build": "tsc",
                "test": "vitest run",
                "lint": "eslint"
            }
        })
        .to_string(),
    )
    .unwrap();

    let res = with_test_build_limits(low_tgt_limits, || {
        analyze_impact_v2(repo_root, Some("HEAD"), None, Some(3)).unwrap()
    });

    assert!(res
        .impacted
        .iter()
        .any(|t| t.target.contains("packages/pkg-a")));
    assert!(res
        .uncertainty
        .iter()
        .any(|u| u.code() == "build_limit_reached"));
}

#[test]
fn test_artifact_bound_safe_widening() {
    let tmp = tempdir().unwrap();
    let repo_root = tmp.path();
    init_git(repo_root);

    let pdir = repo_root.join("proj-a");
    fs::create_dir_all(pdir.join("src")).unwrap();
    fs::write(pdir.join("src/index.ts"), "export const a = 1;").unwrap();
    fs::write(
        pdir.join("tsconfig.json"),
        serde_json::json!({
            "compilerOptions": { "outDir": "./dist", "composite": true }
        })
        .to_string(),
    )
    .unwrap();

    commit_all(repo_root, "init");

    // Artifact limit = 0 (omitting artifact from exact graph)
    let low_art_limits = BuildLimits {
        artifacts: 0,
        ..Default::default()
    };

    with_test_build_limits(low_art_limits, || {
        let snapshot = CurrentBuildSnapshot::build(repo_root);
        assert!(!snapshot
            .nodes
            .values()
            .any(|n| n.kind == NodeKind::GeneratedArtifact));
        assert!(!snapshot.edges.iter().any(|e| e.kind == EdgeKind::Generates));
    });

    with_test_build_limits(low_art_limits, || {
        let _ = fdx::intelligence::build::ingest::refresh_all_build_providers(repo_root, false)
            .unwrap();
    });

    fs::write(pdir.join("src/index.ts"), "export const a = 2;").unwrap();

    let res = with_test_build_limits(low_art_limits, || {
        analyze_impact_v2(repo_root, Some("HEAD"), None, Some(3)).unwrap()
    });

    assert!(res.impacted.iter().any(|t| t.target.contains("proj-a")));
}

#[test]
fn test_incomplete_fallback_inventory_fails_closed_unverified() {
    let tmp = tempdir().unwrap();
    let repo_root = tmp.path();
    init_git(repo_root);

    // Create 3 packages
    for name in ["pkg-1", "pkg-2", "pkg-3"] {
        let pdir = repo_root.join("packages").join(name);
        fs::create_dir_all(pdir.join("src")).unwrap();
        fs::write(pdir.join("src/index.ts"), "export const x = 1;").unwrap();
        fs::write(
            pdir.join("package.json"),
            serde_json::json!({ "name": format!("@app/{}", name), "version": "1.0.0" }).to_string(),
        )
        .unwrap();
    }

    commit_all(repo_root, "init");

    // Set exact limit low AND fallback inventory limit = 1 (truncating fallback inventory)
    let low_both_limits = BuildLimits {
        edges: 1,
        fallback_inventory_entries: 1,
        ..Default::default()
    };

    with_test_build_limits(low_both_limits, || {
        let _ = fdx::intelligence::build::ingest::refresh_all_build_providers(repo_root, false)
            .unwrap();
    });

    fs::write(
        repo_root.join("packages/pkg-3/src/index.ts"),
        "export const x = 2;",
    )
    .unwrap();

    let res = with_test_build_limits(low_both_limits, || {
        analyze_impact_v2(repo_root, Some("HEAD"), None, Some(3)).unwrap()
    });

    // When exact topology AND fallback inventory are incomplete, must fail closed as UNVERIFIED
    assert_eq!(
        res.assurance,
        AssuranceLevel::Unverified,
        "Assurance must fail closed as UNVERIFIED when exact topology and fallback inventory are both incomplete"
    );
    assert!(res
        .uncertainty
        .iter()
        .any(|u| u.code() == "graph_unavailable"));
}

#[test]
fn test_fallback_inventory_walker_error_fails_closed_unverified() {
    let tmp = tempdir().unwrap();
    let repo_root = tmp.path();
    init_git(repo_root);

    let pdir = repo_root.join("packages/pkg-a");
    fs::create_dir_all(pdir.join("src")).unwrap();
    fs::write(pdir.join("src/index.ts"), "export const x = 1;").unwrap();
    fs::write(
        pdir.join("package.json"),
        serde_json::json!({ "name": "@app/pkg-a", "version": "1.0.0" }).to_string(),
    )
    .unwrap();

    commit_all(repo_root, "init");

    let low_edge_limits = BuildLimits {
        edges: 1,
        ..Default::default()
    };

    with_test_build_limits(low_edge_limits, || {
        let _ = fdx::intelligence::build::ingest::refresh_all_build_providers(repo_root, false)
            .unwrap();
    });

    fs::write(pdir.join("src/index.ts"), "export const x = 2;").unwrap();

    // Inject simulated discovery / walker error during traversal
    let res = with_test_build_limits(low_edge_limits, || {
        with_test_walker_error(
            Some("Simulated permission/read I/O error".to_string()),
            || analyze_impact_v2(repo_root, Some("HEAD"), None, Some(3)).unwrap(),
        )
    });

    assert_eq!(
        res.assurance,
        AssuranceLevel::Unverified,
        "Assurance must fail closed as UNVERIFIED on fallback walker error"
    );
}
