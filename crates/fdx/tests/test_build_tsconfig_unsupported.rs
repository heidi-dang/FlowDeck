use fdx::intelligence::build::config::TsConfigProvider;
use fdx::intelligence::build::provider::BuildConfigProvider;
use std::fs;
use tempfile::tempdir;

#[test]
fn test_unsupported_non_relative_tsconfig_extends_emits_uncertainty() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    // tsconfig with package-based non-relative extends
    fs::write(
        root.join("tsconfig.json"),
        r#"{"extends": "@company/tsconfig/base.json"}"#,
    )
    .unwrap();

    let provider = TsConfigProvider::new();
    let ingest_res = provider.ingest(root).unwrap();

    // Assert dynamic_config_expression uncertainty is emitted
    let has_dyn = ingest_res
        .uncertainties
        .iter()
        .any(|u| u.code == "dynamic_config_expression");
    assert!(
        has_dyn,
        "Unsupported extends must emit dynamic_config_expression: {:?}",
        ingest_res.uncertainties
    );
}
