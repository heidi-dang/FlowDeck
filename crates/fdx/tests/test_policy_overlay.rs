use fdx::intelligence::policy::{
    apply_additive_overlay, LearnedPolicyTrigger, PolicyAction, PolicySnapshot, PolicyState,
    PromotedPolicy,
};
use fdx::intelligence::testplan::model::{
    PlannedCheck, SelectionReason, VerificationCheckKind, VerificationPlan,
};
use fdx::protocol::{AssuranceLevel, EvidenceStrength};
use std::collections::{BTreeMap, BTreeSet};

fn check(id: &str, scope: &str) -> PlannedCheck {
    PlannedCheck {
        check_id: id.to_string(),
        display_name: id.to_string(),
        kind: VerificationCheckKind::IntegrationTest,
        scope: scope.to_string(),
        reason: "fixture".to_string(),
        selection: SelectionReason::Evidence,
        strength: EvidenceStrength::Precise,
        evidence_path: None,
        evidence_refs: vec![],
        widening_reason: None,
        mandatory: false,
    }
}

fn promoted_policy(scope: &str, check_id: &str) -> PromotedPolicy {
    PromotedPolicy {
        policy_id: format!("policy-{check_id}"),
        policy_contract_version: 1,
        candidate_id: format!("candidate-{check_id}"),
        action: PolicyAction::AddCheck,
        trigger: LearnedPolicyTrigger::scope(scope.to_string()).unwrap(),
        check_id: check_id.to_string(),
        candidate_digest: "candidate-digest".to_string(),
        promotion_policy_digest: "promotion-policy-digest".to_string(),
        promoted_policy_digest: format!("policy-digest-{check_id}"),
        state: PolicyState::Promoted,
        promoted_at_ms: 1,
        revoked_at_ms: None,
        revoke_reason: None,
    }
}

fn base_plan() -> VerificationPlan {
    VerificationPlan {
        assurance: AssuranceLevel::Exact,
        changed: vec![],
        impacted_targets: vec![],
        selected_checks: vec![check("base-check", "pkg.alpha")],
        uncertainty: vec![],
        unresolved_obligations: vec![],
    }
}

#[test]
fn test_overlay_is_monotonic_and_uses_impacted_scope_even_without_a_base_check() {
    let base = base_plan();
    let snapshot = PolicySnapshot {
        policies: vec![promoted_policy("pkg.beta", "policy-check")],
        snapshot_digest: "snapshot-digest".to_string(),
    };
    let mut templates = BTreeMap::new();
    templates.insert(
        "policy-check".to_string(),
        check("policy-check", "pkg.beta"),
    );
    let impacted_scopes = BTreeSet::from(["pkg.beta".to_string()]);

    let effective = apply_additive_overlay(&base, &snapshot, &templates, &impacted_scopes).unwrap();
    assert_eq!(effective.plan.assurance, base.assurance);
    assert_eq!(
        effective.plan.unresolved_obligations,
        base.unresolved_obligations
    );
    assert_eq!(effective.base_check_ids, vec!["base-check"]);
    assert_eq!(effective.added_check_ids, vec!["policy-check"]);
    assert_eq!(
        effective
            .plan
            .selected_checks
            .iter()
            .map(|item| item.check_id.as_str())
            .collect::<Vec<_>>(),
        vec!["base-check", "policy-check"]
    );
    assert_eq!(
        effective.application.policy_snapshot_digest,
        "snapshot-digest"
    );
}

#[test]
fn test_overlay_is_noop_for_unaffected_scope_and_fails_closed_for_missing_template_or_invalid_state(
) {
    let base = base_plan();
    let snapshot = PolicySnapshot {
        policies: vec![promoted_policy("pkg.beta", "policy-check")],
        snapshot_digest: "snapshot-digest".to_string(),
    };
    let mut templates = BTreeMap::new();
    templates.insert(
        "policy-check".to_string(),
        check("policy-check", "pkg.beta"),
    );

    let unaffected = BTreeSet::from(["pkg.alpha".to_string()]);
    let no_op = apply_additive_overlay(&base, &snapshot, &templates, &unaffected).unwrap();
    assert_eq!(no_op.plan, base);
    assert!(no_op.added_check_ids.is_empty());

    let affected = BTreeSet::from(["pkg.beta".to_string()]);
    assert!(apply_additive_overlay(&base, &snapshot, &BTreeMap::new(), &affected).is_err());

    let mut invalid = snapshot.clone();
    invalid.policies[0].state = PolicyState::Revoked;
    assert!(apply_additive_overlay(&base, &invalid, &templates, &affected).is_err());
}
