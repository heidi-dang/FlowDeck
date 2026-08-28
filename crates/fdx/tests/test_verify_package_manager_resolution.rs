use fdx::intelligence::verify::resolve::{
    detect_package_manager, detect_package_manager_for_pkg, PackageManagerResolution,
};
use tempfile::tempdir;

#[test]
fn test_no_evidence_resolves_missing_not_npm() {
    let dir = tempdir().unwrap();
    std::fs::write(
        dir.path().join("package.json"),
        r#"{"name": "pkg-without-pm-evidence"}"#,
    )
    .unwrap();

    // package.json alone is NOT npm evidence
    assert_eq!(
        detect_package_manager(dir.path()),
        PackageManagerResolution::Missing
    );
}

#[test]
fn test_single_lockfile_resolves_unambiguously() {
    let dir = tempdir().unwrap();
    std::fs::write(dir.path().join("package.json"), "{}").unwrap();
    std::fs::write(dir.path().join("pnpm-lock.yaml"), "").unwrap();
    assert_eq!(
        detect_package_manager(dir.path()),
        PackageManagerResolution::Resolved("pnpm".to_string())
    );

    let dir2 = tempdir().unwrap();
    std::fs::write(dir2.path().join("package.json"), "{}").unwrap();
    std::fs::write(dir2.path().join("package-lock.json"), "").unwrap();
    assert_eq!(
        detect_package_manager(dir2.path()),
        PackageManagerResolution::Resolved("npm".to_string())
    );
}

#[test]
fn test_package_manager_field_and_lockfile_contradiction_fails_closed() {
    let dir = tempdir().unwrap();
    std::fs::write(
        dir.path().join("package.json"),
        r#"{"packageManager": "pnpm@8.0.0"}"#,
    )
    .unwrap();
    std::fs::write(dir.path().join("package-lock.json"), "").unwrap();

    // pnpm != npm -> Ambiguous
    assert!(matches!(
        detect_package_manager(dir.path()),
        PackageManagerResolution::Ambiguous(_)
    ));
}

#[test]
fn test_package_manager_npm_and_pnpm_lockfile_contradiction_fails_closed() {
    let dir = tempdir().unwrap();
    std::fs::write(
        dir.path().join("package.json"),
        r#"{"packageManager": "npm@10.0.0"}"#,
    )
    .unwrap();
    std::fs::write(dir.path().join("pnpm-lock.yaml"), "").unwrap();

    assert!(matches!(
        detect_package_manager(dir.path()),
        PackageManagerResolution::Ambiguous(_)
    ));
}

#[test]
fn test_nested_package_and_root_contradiction_fails_closed() {
    let dir = tempdir().unwrap();
    let sub_pkg = dir.path().join("packages").join("app");
    std::fs::create_dir_all(&sub_pkg).unwrap();

    std::fs::write(
        dir.path().join("package.json"),
        r#"{"packageManager": "yarn@1.22.0"}"#,
    )
    .unwrap();
    std::fs::write(
        sub_pkg.join("package.json"),
        r#"{"packageManager": "bun@1.1.0"}"#,
    )
    .unwrap();

    assert!(matches!(
        detect_package_manager_for_pkg(dir.path(), &sub_pkg),
        PackageManagerResolution::Ambiguous(_)
    ));
}
