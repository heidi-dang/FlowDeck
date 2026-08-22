use fdx::intelligence::build::config::TsConfigProvider;
use fdx::intelligence::build::provider::BuildConfigProvider;
use std::fs;
use tempfile::tempdir;

#[test]
fn test_adversarial_cyclic_tsconfig_extends_does_not_loop_infinitely() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    // A extends B, B extends A
    fs::write(
        root.join("tsconfig.a.json"),
        r#"{ "extends": "./tsconfig.b.json" }"#,
    )
    .unwrap();
    fs::write(
        root.join("tsconfig.b.json"),
        r#"{ "extends": "./tsconfig.a.json" }"#,
    )
    .unwrap();

    let provider = TsConfigProvider::new();
    let result = provider.ingest(root).unwrap();

    // Must finish in finite time, detect cycle, and emit uncertainty
    assert!(result.uncertainties.iter().any(|u| u.code.contains("cycle")
        || u.reason.contains("cycle")
        || u.reason.contains("recursive")));
}

#[test]
fn test_adversarial_deep_nested_config_chain_bounded() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    // Create a 50-step tsconfig extends chain
    for i in 0..50 {
        let next = if i == 49 {
            "".to_string()
        } else {
            format!(r#""extends": "./tsconfig.{}.json","#, i + 1)
        };
        fs::write(
            root.join(format!("tsconfig.{}.json", i)),
            format!(r#"{{ {} "compilerOptions": {{}} }}"#, next),
        )
        .unwrap();
    }

    let provider = TsConfigProvider::new();
    let result = provider.ingest(root).unwrap();
    assert!(!result.configs.is_empty());
}
