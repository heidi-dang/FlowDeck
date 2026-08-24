use fdx::intelligence::policy::{
    apply_additive_overlay, compute_template_digest, LearnedPolicyTrigger, PolicyAction,
    PolicySnapshot, PolicyState, PromotedPolicy,
};
use fdx::intelligence::runtime::sha256_bytes;
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

fn policy_template(id: &str, scope: &str) -> PlannedCheck {
    let mut template = check(id, scope);
    template.reason = format!("learned additive policy check for scope {scope}");
    template.selection = SelectionReason::PolicyWidening;
    template.strength = EvidenceStrength::Structural;
    template.widening_reason = Some("learned_policy_add_check".to_string());
    template
}

fn promoted_policy(scope: &str, check_id: &str, template_digest: String) -> PromotedPolicy {
    let candidate_id = format!("candidate-{check_id}");
    let candidate_digest = format!("candidate-digest-{check_id}");
    let promotion_policy_digest = format!("promotion-policy-digest-{check_id}");
    let policy_id = format!(
        "policy_{}",
        sha256_bytes(
            format!(
                "{}:{}:{}:{}",
                candidate_id, candidate_digest, promotion_policy_digest, template_digest
            )
            .as_bytes()
        )
    );
    let promoted_policy_digest = sha256_bytes(
        format!(
            "{}:{}:{}:{}:{}:{}:{}",
            1, candidate_id, "add_check", "scope", scope, check_id, template_digest
        )
        .as_bytes(),
    );
    PromotedPolicy {
        policy_id,
        policy_contract_version: 1,
        candidate_id,
        action: PolicyAction::AddCheck,
        trigger: LearnedPolicyTrigger::scope(scope.to_string()).unwrap(),
        check_id: check_id.to_string(),
        template_digest,
        candidate_digest,
        promotion_policy_digest,
        promoted_policy_digest,
        state: PolicyState::Promoted,
        promoted_at_ms: 1,
        revoked_at_ms: None,
        revoke_reason: None,
    }
}

fn snapshot_and_templates(
    scope: &str,
    check_id: &str,
) -> (PolicySnapshot, BTreeMap<String, PlannedCheck>) {
    let template = policy_template(check_id, scope);
    let template_digest = compute_template_digest(&template).unwrap();
    let policy = promoted_policy(scope, check_id, template_digest.clone());
    (
        PolicySnapshot {
            policies: vec![policy],
            snapshot_digest: "snapshot-digest".to_string(),
        },
        BTreeMap::from([(template_digest, template)]),
    )
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
    let (snapshot, templates) = snapshot_and_templates("pkg.beta", "policy-check");
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
    let (snapshot, templates) = snapshot_and_templates("pkg.beta", "policy-check");

    let unaffected = BTreeSet::from(["pkg.alpha".to_string()]);
    let no_op = apply_additive_overlay(&base, &snapshot, &templates, &unaffected).unwrap();
    assert_eq!(no_op.plan, base);
    assert!(no_op.added_check_ids.is_empty());

    let affected = BTreeSet::from(["pkg.beta".to_string()]);
    assert!(apply_additive_overlay(&base, &snapshot, &BTreeMap::new(), &affected).is_err());

    let mut invalid = snapshot.clone();
    invalid.policies[0].state = PolicyState::Revoked;
    assert!(apply_additive_overlay(&base, &invalid, &templates, &affected).is_err());

    let mut tampered = snapshot.clone();
    tampered.policies[0].template_digest = "tampered-template".to_string();
    assert!(apply_additive_overlay(&base, &tampered, &templates, &affected).is_err());
}

#[test]
fn test_overlay_noop_application_is_deterministic_and_additive() {
    let base = base_plan();
    let (snapshot, templates) = snapshot_and_templates("pkg.beta", "policy-check");
    let unaffected = BTreeSet::from(["pkg.alpha".to_string()]);

    let first = apply_additive_overlay(&base, &snapshot, &templates, &unaffected).unwrap();
    let second = apply_additive_overlay(&base, &snapshot, &templates, &unaffected).unwrap();

    assert_eq!(first.plan, base);
    assert!(first.added_check_ids.is_empty());
    assert_eq!(first.application, second.application);
    assert_eq!(first.base_check_ids, vec!["base-check"]);
}
