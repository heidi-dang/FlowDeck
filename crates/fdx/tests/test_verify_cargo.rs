use fdx::intelligence::testplan::model::{
    PlannedCheck, SelectionReason, VerificationCheckKind, VerificationPlan,
};
use fdx::intelligence::verify::{execute_verification_plan, VerificationExecutorOptions};
use fdx::protocol::{AssuranceLevel, EvidenceStrength};
use tempfile::tempdir;

#[test]
fn test_verify_cargo_invocation_model() {
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

    let plan = VerificationPlan {
        assurance: AssuranceLevel::Exact,
        changed: vec![],
        impacted_targets: vec![],
        selected_checks: vec![PlannedCheck {
            check_id: "check:pkg:cargo:crates/my_crate:check".to_string(),
            display_name: "cargo check".to_string(),
            kind: VerificationCheckKind::Build,
            scope: "pkg:cargo:crates/my_crate".to_string(),
            reason: "changed".to_string(),
            selection: SelectionReason::MandatoryCheck,
            strength: EvidenceStrength::Precise,
            evidence_path: None,
            evidence_refs: vec![],
            widening_reason: None,
            mandatory: true,
        }],
        uncertainty: vec![],
        unresolved_obligations: vec![],
    };

    let options = VerificationExecutorOptions {
        persist: false,
        ..Default::default()
    };

    let run = execute_verification_plan(dir.path(), &plan, &options).unwrap();
    assert_eq!(run.checks.len(), 1);
    let check_res = &run.checks[0];
    assert_eq!(check_res.command, vec!["cargo", "check", "-p", "my_crate"]);
}
