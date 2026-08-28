use fdx::intelligence::calibration::model::{CalibrationPolicy, ReferenceScope};
use fdx::intelligence::calibration::policy::{compute_policy_digest, generate_calibration_id};

#[test]
fn test_policy_digest_determinism_and_field_sensitivity() {
    let p1 = CalibrationPolicy {
        scope: ReferenceScope::AffectedPackage,
        max_shadow_checks: 50,
        max_total_duration_ms: 60_000,
        per_check_timeout_ms: 10_000,
        max_output_bytes: 16 * 1024 * 1024,
    };
    let p2 = CalibrationPolicy {
        scope: ReferenceScope::AffectedPackage,
        max_shadow_checks: 50,
        max_total_duration_ms: 60_000,
        per_check_timeout_ms: 10_000,
        max_output_bytes: 16 * 1024 * 1024,
    };
    let d1 = compute_policy_digest(&p1).unwrap();
    let d2 = compute_policy_digest(&p2).unwrap();
    assert_eq!(d1, d2, "identical policies produce identical digests");

    // Modify scope
    let mut p_scope = p1.clone();
    p_scope.scope = ReferenceScope::Workspace;
    assert_ne!(d1, compute_policy_digest(&p_scope).unwrap());

    // Modify max_shadow_checks
    let mut p_checks = p1.clone();
    p_checks.max_shadow_checks = 100;
    assert_ne!(d1, compute_policy_digest(&p_checks).unwrap());

    // Modify max_total_duration_ms
    let mut p_dur = p1.clone();
    p_dur.max_total_duration_ms = 30_000;
    assert_ne!(d1, compute_policy_digest(&p_dur).unwrap());

    // Modify per_check_timeout_ms
    let mut p_timeout = p1.clone();
    p_timeout.per_check_timeout_ms = 5_000;
    assert_ne!(d1, compute_policy_digest(&p_timeout).unwrap());

    // Modify max_output_bytes
    let mut p_bytes = p1.clone();
    p_bytes.max_output_bytes = 1024 * 1024;
    assert_ne!(d1, compute_policy_digest(&p_bytes).unwrap());
}

#[test]
fn test_calibration_id_binding() {
    let id1 = generate_calibration_id("run_1", "plan_1", "policy_1", 8);
    let id2 = generate_calibration_id("run_1", "plan_1", "policy_1", 8);
    assert_eq!(id1, id2);

    let id_diff_run = generate_calibration_id("run_2", "plan_1", "policy_1", 8);
    assert_ne!(id1, id_diff_run);

    let id_diff_plan = generate_calibration_id("run_1", "plan_2", "policy_1", 8);
    assert_ne!(id1, id_diff_plan);

    let id_diff_policy = generate_calibration_id("run_1", "plan_1", "policy_2", 8);
    assert_ne!(id1, id_diff_policy);

    let id_diff_schema = generate_calibration_id("run_1", "plan_1", "policy_1", 9);
    assert_ne!(id1, id_diff_schema);
}
