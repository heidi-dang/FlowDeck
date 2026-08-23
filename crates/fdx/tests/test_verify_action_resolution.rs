use fdx::intelligence::testplan::model::{PlannedCheck, SelectionReason, VerificationCheckKind};
use fdx::intelligence::verify::action::ExecutionAction;
use fdx::intelligence::verify::resolve::{
    detect_package_manager, resolve_check_action, PackageManagerResolution,
};
use fdx::protocol::EvidenceStrength;
use std::path::PathBuf;
use tempfile::tempdir;

#[test]
fn test_package_manager_detection_lockfiles() {
    let dir = tempdir().unwrap();
    std::fs::write(dir.path().join("package.json"), "{}").unwrap();
    std::fs::write(dir.path().join("pnpm-lock.yaml"), "").unwrap();
    assert_eq!(
        detect_package_manager(dir.path()),
        PackageManagerResolution::Resolved("pnpm".to_string())
    );
}

#[test]
fn test_package_manager_detection_package_manager_field() {
    let dir = tempdir().unwrap();
    std::fs::write(
        dir.path().join("package.json"),
        r#"{"packageManager": "bun@1.1.0"}"#,
    )
    .unwrap();
    std::fs::write(dir.path().join("package-lock.json"), "").unwrap();
    // packageManager field takes precedence
    assert_eq!(
        detect_package_manager(dir.path()),
        PackageManagerResolution::Resolved("bun".to_string())
    );
}

#[test]
fn test_package_manager_ambiguity_fails_closed() {
    let dir = tempdir().unwrap();
    std::fs::write(dir.path().join("package.json"), "{}").unwrap();
    std::fs::write(dir.path().join("yarn.lock"), "").unwrap();
    std::fs::write(dir.path().join("pnpm-lock.yaml"), "").unwrap();
    assert!(matches!(
        detect_package_manager(dir.path()),
        PackageManagerResolution::Ambiguous(_)
    ));
}

#[test]
fn test_package_manager_nested_contradiction_fails_closed() {
    use fdx::intelligence::verify::resolve::detect_package_manager_for_pkg;
    let dir = tempdir().unwrap();
    let nested_pkg = dir.path().join("packages").join("sub");
    std::fs::create_dir_all(&nested_pkg).unwrap();
    std::fs::write(
        dir.path().join("package.json"),
        r#"{"packageManager": "pnpm@8.0.0"}"#,
    )
    .unwrap();
    std::fs::write(
        nested_pkg.join("package.json"),
        r#"{"packageManager": "yarn@1.22.0"}"#,
    )
    .unwrap();

    assert!(matches!(
        detect_package_manager_for_pkg(dir.path(), &nested_pkg),
        PackageManagerResolution::Ambiguous(_)
    ));
}

#[test]
fn test_resolve_cargo_check() {
    let dir = tempdir().unwrap();
    let pkg_dir = dir.path().join("crates").join("my_crate");
    std::fs::create_dir_all(&pkg_dir).unwrap();
    std::fs::write(
        pkg_dir.join("Cargo.toml"),
        r#"[package]
name = "my_crate"
version = "0.1.0"
"#,
    )
    .unwrap();

    let check = PlannedCheck {
        check_id: "check:pkg:cargo:crates/my_crate:test".to_string(),
        display_name: "test my_crate".to_string(),
        kind: VerificationCheckKind::UnitTest,
        scope: "pkg:cargo:crates/my_crate".to_string(),
        reason: "evidence".to_string(),
        selection: SelectionReason::Evidence,
        strength: EvidenceStrength::Precise,
        evidence_path: None,
        evidence_refs: vec![],
        widening_reason: None,
        mandatory: true,
    };

    let action = resolve_check_action(dir.path(), &check);
    assert_eq!(
        action,
        ExecutionAction::CargoTestPackage {
            pkg_dir: PathBuf::from("crates/my_crate"),
            package_name: Some("my_crate".to_string()),
        }
    );
}
