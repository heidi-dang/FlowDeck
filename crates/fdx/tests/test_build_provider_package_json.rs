use fdx::intelligence::build::package::PackageJsonProvider;
use fdx::intelligence::build::provider::BuildConfigProvider;
use fdx::protocol::{EdgeKind, EvidenceStrength};
use std::fs;
use tempfile::tempdir;

#[test]
fn test_package_json_workspace_and_dependencies() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    // Root package.json with workspaces
    fs::write(
        root.join("package.json"),
        r#"{
            "name": "root",
            "private": true,
            "workspaces": ["packages/*"]
        }"#,
    )
    .unwrap();

    // Package A
    fs::create_dir_all(root.join("packages/core")).unwrap();
    fs::write(
        root.join("packages/core/package.json"),
        r#"{
            "name": "@app/core",
            "version": "1.0.0",
            "scripts": {
                "build": "tsc",
                "test": "vitest"
            },
            "dependencies": {
                "lodash": "^4.17.21"
            }
        }"#,
    )
    .unwrap();

    // Package B depending on A
    fs::create_dir_all(root.join("packages/web")).unwrap();
    fs::write(
        root.join("packages/web/package.json"),
        r#"{
            "name": "@app/web",
            "version": "1.0.0",
            "scripts": {
                "build": "vite build"
            },
            "dependencies": {
                "@app/core": "^1.0.0"
            }
        }"#,
    )
    .unwrap();

    let provider = PackageJsonProvider::new();
    assert!(provider.detect(root));

    let result = provider.ingest(root).unwrap();

    // Workspaces
    assert_eq!(result.workspaces.len(), 1);
    assert_eq!(result.workspaces[0].stable_id, "workspace:.");

    // Packages
    assert_eq!(result.packages.len(), 2);
    let pkg_ids: Vec<_> = result
        .packages
        .iter()
        .map(|p| p.stable_id.as_str())
        .collect();
    assert!(pkg_ids.contains(&"pkg:npm:packages/core"));
    assert!(pkg_ids.contains(&"pkg:npm:packages/web"));

    // Check dependency edge web -> core
    let dep_edge = result.edges.iter().find(|e| {
        e.from_node == "pkg:npm:packages/web"
            && e.to_node == "pkg:npm:packages/core"
            && e.kind == EdgeKind::DependsOn
    });
    assert!(dep_edge.is_some(), "web must depend on core");
    assert_eq!(dep_edge.unwrap().strength, EvidenceStrength::Structural);

    // Check script targets
    let core_build = result
        .targets
        .iter()
        .find(|t| t.name == "build" && t.package_id == "pkg:npm:packages/core");
    assert!(core_build.is_some());
    assert_eq!(
        core_build.unwrap().stable_id,
        "build:pkg:npm:packages/core:script:build"
    );

    // Check external dependency
    let ext_dep = result
        .external_dependencies
        .iter()
        .find(|e| e.name == "lodash");
    assert!(ext_dep.is_some());
    assert_eq!(ext_dep.unwrap().stable_id, "ext:npm:lodash");
}
