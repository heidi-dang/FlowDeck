use fdx::intelligence::build::provider::BuildConfigProvider;
use fdx::intelligence::build::target::CargoProvider;
use fdx::protocol::{EdgeKind, EvidenceStrength};
use std::fs;
use tempfile::tempdir;

#[test]
fn test_cargo_workspace_path_deps_and_targets() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    // Root Cargo.toml
    fs::write(
        root.join("Cargo.toml"),
        r#"[workspace]
members = [
    "crates/core",
    "crates/cli",
]
"#,
    )
    .unwrap();

    // crates/core
    fs::create_dir_all(root.join("crates/core/src")).unwrap();
    fs::write(
        root.join("crates/core/src/lib.rs"),
        "pub fn add(a: i32, b: i32) -> i32 { a + b }",
    )
    .unwrap();
    fs::write(
        root.join("crates/core/Cargo.toml"),
        r#"[package]
name = "core"
version = "0.1.0"
edition = "2021"

[dependencies]
serde = "1.0"
"#,
    )
    .unwrap();

    // crates/cli with path dep on core and build.rs
    fs::create_dir_all(root.join("crates/cli/src")).unwrap();
    fs::write(root.join("crates/cli/src/main.rs"), "fn main() {}").unwrap();
    fs::write(root.join("crates/cli/build.rs"), "fn main() {}").unwrap();
    fs::write(
        root.join("crates/cli/Cargo.toml"),
        r#"[package]
name = "cli"
version = "0.1.0"
edition = "2021"
build = "build.rs"

[dependencies]
core = { path = "../core" }
"#,
    )
    .unwrap();

    let provider = CargoProvider::new();
    assert!(provider.detect(root));

    let result = provider.ingest(root).unwrap();

    // Workspace
    assert_eq!(result.workspaces.len(), 1);
    assert_eq!(result.workspaces[0].stable_id, "workspace:.");

    // Packages
    assert_eq!(result.packages.len(), 2);
    let pkg_ids: Vec<_> = result
        .packages
        .iter()
        .map(|p| p.stable_id.as_str())
        .collect();
    assert!(pkg_ids.contains(&"pkg:cargo:crates/core"));
    assert!(pkg_ids.contains(&"pkg:cargo:crates/cli"));

    // Path dependency cli -> core
    let dep_edge = result.edges.iter().find(|e| {
        e.from_node == "pkg:cargo:crates/cli"
            && e.to_node == "pkg:cargo:crates/core"
            && e.kind == EdgeKind::DependsOn
    });
    assert!(dep_edge.is_some(), "cli must depend on core via path dep");
    assert_eq!(dep_edge.unwrap().strength, EvidenceStrength::Structural);

    // Build targets: lib in core, bin and build_rs in cli
    let lib_target = result
        .targets
        .iter()
        .find(|t| t.package_id == "pkg:cargo:crates/core" && t.name == "core");
    assert!(lib_target.is_some());
    assert_eq!(
        lib_target.unwrap().stable_id,
        "build:pkg:cargo:crates/core:lib:core"
    );

    let bin_target = result
        .targets
        .iter()
        .find(|t| t.package_id == "pkg:cargo:crates/cli" && t.name == "cli");
    assert!(bin_target.is_some());
    assert_eq!(
        bin_target.unwrap().stable_id,
        "build:pkg:cargo:crates/cli:bin:cli"
    );

    let build_rs_target = result
        .targets
        .iter()
        .find(|t| t.package_id == "pkg:cargo:crates/cli" && t.name == "build_rs");
    assert!(build_rs_target.is_some());
    assert_eq!(
        build_rs_target.unwrap().stable_id,
        "build:pkg:cargo:crates/cli:custom:build_rs"
    );
}
