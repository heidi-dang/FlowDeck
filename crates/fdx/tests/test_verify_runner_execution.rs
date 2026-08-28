use fdx::intelligence::testplan::model::{
    PlannedCheck, SelectionReason, VerificationCheckKind, VerificationPlan,
};
use fdx::intelligence::verify::model::VerificationOutcome;
use fdx::intelligence::verify::{execute_verification_plan, VerificationExecutorOptions};
use fdx::protocol::{AssuranceLevel, EvidenceStrength};
use std::sync::Mutex;
use tempfile::tempdir;

static PATH_MUTEX: Mutex<()> = Mutex::new(());

#[test]
fn test_fake_vitest_executable_records_argv_and_target_marker() {
    let _lock = PATH_MUTEX.lock().unwrap();
    let dir = tempdir().unwrap();
    let bin_dir = dir.path().join("fake_bin");
    std::fs::create_dir_all(&bin_dir).unwrap();

    let marker_file = dir.path().join("vitest_marker.json");
    let marker_str = marker_file.to_string_lossy();

    // Create fake vitest executable in bin_dir
    let fake_vitest_script = format!(
        "#!/usr/bin/env node\nconst fs = require('fs'); fs.writeFileSync({:?}, JSON.stringify({{ argv: process.argv.slice(2) }})); process.exit(0);\n",
        marker_str
    );
    let fake_vitest_path = bin_dir.join("vitest");
    std::fs::write(&fake_vitest_path, fake_vitest_script).unwrap();

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake_vitest_path, std::fs::Permissions::from_mode(0o755))
            .unwrap();
    }

    // Setup npm package with accepted "vitest run" script
    let pkg_json = dir.path().join("package.json");
    std::fs::write(
        &pkg_json,
        r#"{"name": "vitest-marker-pkg", "packageManager": "npm@10.0.0", "scripts": {"test": "vitest run"}}"#,
    )
    .unwrap();

    let plan = VerificationPlan {
        assurance: AssuranceLevel::Exact,
        changed: vec![],
        impacted_targets: vec![],
        selected_checks: vec![PlannedCheck {
            check_id: "test:npm:tests/critical.test.ts".to_string(),
            display_name: "critical unit test".to_string(),
            kind: VerificationCheckKind::UnitTest,
            scope: "pkg:npm:.".to_string(),
            reason: "direct impact".to_string(),
            selection: SelectionReason::Evidence,
            strength: EvidenceStrength::Precise,
            evidence_path: None,
            evidence_refs: vec![],
            widening_reason: None,
            mandatory: true,
        }],
        uncertainty: vec![],
        unresolved_obligations: vec![],
    };

    // Inject bin_dir into PATH
    let original_path = std::env::var("PATH").unwrap_or_default();
    let new_path = format!("{}:{}", bin_dir.display(), original_path);
    std::env::set_var("PATH", &new_path);

    let options = VerificationExecutorOptions {
        persist: false,
        ..Default::default()
    };

    let run = execute_verification_plan(dir.path(), &plan, &options).unwrap();
    std::env::set_var("PATH", original_path);

    assert_eq!(run.outcome, VerificationOutcome::Passed);
    assert_eq!(run.checks.len(), 1);
    assert_eq!(
        run.checks[0].status,
        fdx::intelligence::verify::model::CheckExecutionStatus::Passed
    );

    // Assert the marker file exists and contains the expected test file target
    assert!(
        marker_file.exists(),
        "fake vitest executable marker was never created"
    );
    let marker_content = std::fs::read_to_string(&marker_file).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&marker_content).unwrap();
    let argv: Vec<String> = parsed["argv"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();

    assert!(
        argv.contains(&"tests/critical.test.ts".to_string()),
        "argv does not contain intended test target: {:?}",
        argv
    );
}

#[test]
fn test_fake_jest_executable_records_argv_and_target_marker() {
    let _lock = PATH_MUTEX.lock().unwrap();
    let dir = tempdir().unwrap();
    let bin_dir = dir.path().join("fake_bin");
    std::fs::create_dir_all(&bin_dir).unwrap();

    let marker_file = dir.path().join("jest_marker.json");
    let marker_str = marker_file.to_string_lossy();

    // Create fake jest executable in bin_dir
    let fake_jest_script = format!(
        "#!/usr/bin/env node\nconst fs = require('fs'); fs.writeFileSync({:?}, JSON.stringify({{ argv: process.argv.slice(2) }})); process.exit(0);\n",
        marker_str
    );
    let fake_jest_path = bin_dir.join("jest");
    std::fs::write(&fake_jest_path, fake_jest_script).unwrap();

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake_jest_path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    // Setup npm package with accepted "jest --runInBand" script
    let pkg_json = dir.path().join("package.json");
    std::fs::write(
        &pkg_json,
        r#"{"name": "jest-marker-pkg", "packageManager": "npm@10.0.0", "scripts": {"test": "jest --runInBand"}}"#,
    )
    .unwrap();

    let plan = VerificationPlan {
        assurance: AssuranceLevel::Exact,
        changed: vec![],
        impacted_targets: vec![],
        selected_checks: vec![PlannedCheck {
            check_id: "test:npm:tests/jest_unit.test.ts".to_string(),
            display_name: "jest unit test".to_string(),
            kind: VerificationCheckKind::UnitTest,
            scope: "pkg:npm:.".to_string(),
            reason: "direct impact".to_string(),
            selection: SelectionReason::Evidence,
            strength: EvidenceStrength::Precise,
            evidence_path: None,
            evidence_refs: vec![],
            widening_reason: None,
            mandatory: true,
        }],
        uncertainty: vec![],
        unresolved_obligations: vec![],
    };

    // Inject bin_dir into PATH
    let original_path = std::env::var("PATH").unwrap_or_default();
    let new_path = format!("{}:{}", bin_dir.display(), original_path);
    std::env::set_var("PATH", &new_path);

    let options = VerificationExecutorOptions {
        persist: false,
        ..Default::default()
    };

    let run = execute_verification_plan(dir.path(), &plan, &options).unwrap();
    std::env::set_var("PATH", original_path);

    assert_eq!(run.outcome, VerificationOutcome::Passed);
    assert_eq!(run.checks.len(), 1);
    assert_eq!(
        run.checks[0].status,
        fdx::intelligence::verify::model::CheckExecutionStatus::Passed
    );

    // Assert the marker file exists and contains the expected test file target
    assert!(
        marker_file.exists(),
        "fake jest executable marker was never created"
    );
    let marker_content = std::fs::read_to_string(&marker_file).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&marker_content).unwrap();
    let argv: Vec<String> = parsed["argv"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();

    assert!(
        argv.contains(&"tests/jest_unit.test.ts".to_string()),
        "argv does not contain intended test target: {:?}",
        argv
    );
}
