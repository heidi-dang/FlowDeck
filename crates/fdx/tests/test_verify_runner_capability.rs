use fdx::intelligence::testplan::model::{PlannedCheck, SelectionReason, VerificationCheckKind};
use fdx::intelligence::verify::action::{ExecutionAction, KnownJsTestRunner};
use fdx::intelligence::verify::resolve::{
    detect_individual_target_capability, resolve_check_action,
};
use fdx::protocol::EvidenceStrength;
use tempfile::tempdir;

#[test]
fn test_dependency_only_vitest_fails_individual_capability() {
    let dir = tempdir().unwrap();
    let pkg_json = dir.path().join("package.json");
    // devDependencies has vitest, but scripts.test runs custom script ignoring argv
    std::fs::write(
        &pkg_json,
        r#"{
            "name": "fake-vitest-dep",
            "scripts": { "test": "node -e 'process.exit(0)'" },
            "devDependencies": { "vitest": "^1.0.0" }
        }"#,
    )
    .unwrap();

    let cap = detect_individual_target_capability(dir.path());
    assert_eq!(cap, None);
}

#[test]
fn test_config_only_vitest_fails_individual_capability() {
    let dir = tempdir().unwrap();
    let pkg_json = dir.path().join("package.json");
    std::fs::write(
        &pkg_json,
        r#"{
            "name": "fake-vitest-config",
            "scripts": { "test": "node scripts/custom.js" }
        }"#,
    )
    .unwrap();
    std::fs::write(dir.path().join("vitest.config.ts"), "export default {};").unwrap();

    let cap = detect_individual_target_capability(dir.path());
    assert_eq!(cap, None);
}

#[test]
fn test_scripts_test_substring_echo_vitest_fails_capability() {
    let dir = tempdir().unwrap();
    let pkg_json = dir.path().join("package.json");
    std::fs::write(
        &pkg_json,
        r#"{
            "name": "echo-vitest",
            "scripts": { "test": "echo vitest" }
        }"#,
    )
    .unwrap();

    let cap = detect_individual_target_capability(dir.path());
    assert_eq!(cap, None);
}

#[test]
fn test_scripts_test_vitest_run_qualifies_capability() {
    let dir = tempdir().unwrap();
    let pkg_json = dir.path().join("package.json");
    std::fs::write(
        &pkg_json,
        r#"{
            "name": "real-vitest",
            "scripts": { "test": "vitest run" }
        }"#,
    )
    .unwrap();

    let cap = detect_individual_target_capability(dir.path());
    assert_eq!(cap, Some(KnownJsTestRunner::Vitest));
}

#[test]
fn test_scripts_test_jest_run_in_band_qualifies_capability() {
    let dir = tempdir().unwrap();
    let pkg_json = dir.path().join("package.json");
    std::fs::write(
        &pkg_json,
        r#"{
            "name": "real-jest",
            "scripts": { "test": "jest --runInBand" }
        }"#,
    )
    .unwrap();

    let cap = detect_individual_target_capability(dir.path());
    assert_eq!(cap, Some(KnownJsTestRunner::Jest));
}

#[test]
fn test_chained_and_piped_scripts_fail_capability() {
    let dir = tempdir().unwrap();
    let pkg_json = dir.path().join("package.json");
    let test_cases = [
        "vitest && node post.js",
        "jest | tee results.txt",
        "cross-env FOO=1 vitest",
        "node ./vitest-wrapper.js",
        "sh -c 'vitest'",
    ];

    for case in test_cases {
        std::fs::write(
            &pkg_json,
            format!(
                r#"{{"name": "chained", "scripts": {{"test": "{}"}}}}"#,
                case
            ),
        )
        .unwrap();
        assert_eq!(
            detect_individual_target_capability(dir.path()),
            None,
            "failed rejection for script: {}",
            case
        );
    }
}

#[test]
fn test_unproven_runner_rolls_up_to_package_suite() {
    let dir = tempdir().unwrap();
    std::fs::write(
        dir.path().join("package.json"),
        r#"{
            "name": "rollup-pkg",
            "packageManager": "npm@10.0.0",
            "scripts": { "test": "node custom.js" }
        }"#,
    )
    .unwrap();

    let check = PlannedCheck {
        check_id: "test:npm:tests/a.test.js".to_string(),
        display_name: "a test".to_string(),
        kind: VerificationCheckKind::UnitTest,
        scope: "pkg:npm:.".to_string(),
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
        ExecutionAction::NpmRunScript {
            pkg_dir: std::path::PathBuf::from("."),
            script_name: "test".to_string(),
            package_manager: "npm".to_string(),
        }
    );
}

#[test]
fn test_unproven_runner_without_test_script_fails_unsupported() {
    let dir = tempdir().unwrap();
    std::fs::write(
        dir.path().join("package.json"),
        r#"{
            "name": "no-test-script",
            "packageManager": "npm@10.0.0"
        }"#,
    )
    .unwrap();

    let check = PlannedCheck {
        check_id: "test:npm:tests/a.test.js".to_string(),
        display_name: "a test".to_string(),
        kind: VerificationCheckKind::UnitTest,
        scope: "pkg:npm:.".to_string(),
        reason: "evidence".to_string(),
        selection: SelectionReason::Evidence,
        strength: EvidenceStrength::Precise,
        evidence_path: None,
        evidence_refs: vec![],
        widening_reason: None,
        mandatory: true,
    };

    let action = resolve_check_action(dir.path(), &check);
    assert!(matches!(action, ExecutionAction::Unsupported { .. }));
}
