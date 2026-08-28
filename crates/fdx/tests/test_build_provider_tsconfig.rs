use fdx::intelligence::build::config::TsConfigProvider;
use fdx::intelligence::build::provider::BuildConfigProvider;
use fdx::protocol::{EdgeKind, EvidenceStrength};
use std::fs;
use tempfile::tempdir;

#[test]
fn test_tsconfig_extends_and_references() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    // Base tsconfig
    fs::write(
        root.join("tsconfig.base.json"),
        r#"{
            // base config with comments
            "compilerOptions": {
                "target": "es2022",
                "module": "esnext",
            }
        }"#,
    )
    .unwrap();

    // Core tsconfig extending base
    fs::create_dir_all(root.join("packages/core")).unwrap();
    fs::write(
        root.join("packages/core/tsconfig.json"),
        r#"{
            "extends": "../../tsconfig.base.json",
            "compilerOptions": {
                "composite": true,
                "outDir": "./dist"
            },
            "include": ["src/**/*"]
        }"#,
    )
    .unwrap();

    // Web tsconfig referencing core
    fs::create_dir_all(root.join("packages/web")).unwrap();
    fs::write(
        root.join("packages/web/tsconfig.json"),
        r#"{
            "extends": "../../tsconfig.base.json",
            "compilerOptions": {
                "outDir": "./dist"
            },
            "references": [
                { "path": "../core" }
            ]
        }"#,
    )
    .unwrap();

    let provider = TsConfigProvider::new();
    assert!(provider.detect(root));

    let result = provider.ingest(root).unwrap();

    // Configs
    assert_eq!(result.configs.len(), 3);

    // Extends edge: packages/core/tsconfig.json -> tsconfig.base.json
    let extends_edge = result.edges.iter().find(|e| {
        e.from_node == "config:packages/core/tsconfig.json"
            && e.to_node == "config:tsconfig.base.json"
            && e.kind == EdgeKind::Extends
    });
    assert!(
        extends_edge.is_some(),
        "packages/core/tsconfig.json must extend tsconfig.base.json"
    );
    assert_eq!(extends_edge.unwrap().strength, EvidenceStrength::Structural);

    // References edge: packages/web/tsconfig.json -> packages/core/tsconfig.json
    let ref_edge = result.edges.iter().find(|e| {
        e.from_node == "config:packages/web/tsconfig.json"
            && e.to_node == "config:packages/core/tsconfig.json"
            && e.kind == EdgeKind::References
    });
    assert!(
        ref_edge.is_some(),
        "packages/web/tsconfig.json must reference packages/core/tsconfig.json"
    );
    assert_eq!(ref_edge.unwrap().strength, EvidenceStrength::Structural);
}
