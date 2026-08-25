//! Verification planner data contract and type tests.

use fdx::intelligence::testplan::model::*;
use fdx::protocol::{AssuranceLevel, EvidenceStrength};

#[test]
fn test_verification_plan_contract_and_serialization() {
    let check = PlannedCheck {
        check_id: "test:npm:packages/api/tests/user.test.ts".to_string(),
        display_name: "packages/api/tests/user.test.ts".to_string(),
        kind: VerificationCheckKind::UnitTest,
        scope: "pkg:npm:packages/api".to_string(),
        reason: "tests impacted symbol packages/api/src/user.ts::createUser".to_string(),
        selection: SelectionReason::Evidence,
        strength: EvidenceStrength::Precise,
        evidence_path: None,
        evidence_refs: vec![CheckEvidenceRef {
            evidence_id: Some("edge_1".to_string()),
            provider: "scip_ts".to_string(),
            provider_id: "scip-typescript".to_string(),
            provider_fingerprint: Some("fp123".to_string()),
            source_identity: Some("packages/api/tests/user.test.ts".to_string()),
            strength: EvidenceStrength::Precise,
            stale: false,
        }],
        widening_reason: None,
        mandatory: false,
    };

    let plan = VerificationPlan {
        assurance: AssuranceLevel::Exact,
        changed: Vec::new(),
        impacted_targets: Vec::new(),
        selected_checks: vec![check],
        uncertainty: Vec::new(),
        unresolved_obligations: Vec::new(),
    };

    let json_str = serde_json::to_string_pretty(&plan).expect("serialize plan");
    let deserialized: VerificationPlan = serde_json::from_str(&json_str).expect("deserialize plan");

    assert_eq!(deserialized.assurance, AssuranceLevel::Exact);
    assert_eq!(deserialized.selected_checks.len(), 1);
    assert_eq!(
        deserialized.selected_checks[0].check_id,
        "test:npm:packages/api/tests/user.test.ts"
    );
    assert_eq!(
        deserialized.selected_checks[0].kind,
        VerificationCheckKind::UnitTest
    );
    assert_eq!(
        deserialized.selected_checks[0].selection,
        SelectionReason::Evidence
    );
    assert_eq!(
        deserialized.selected_checks[0].strength,
        EvidenceStrength::Precise
    );
    assert_eq!(deserialized.selected_checks[0].evidence_refs.len(), 1);
    assert_eq!(
        deserialized.selected_checks[0].evidence_refs[0].provider_id,
        "scip-typescript"
    );
}

#[test]
fn test_verification_check_kind_enumeration() {
    let kinds = [
        VerificationCheckKind::UnitTest,
        VerificationCheckKind::IntegrationTest,
        VerificationCheckKind::EndToEndTest,
        VerificationCheckKind::Typecheck,
        VerificationCheckKind::Lint,
        VerificationCheckKind::Build,
        VerificationCheckKind::Format,
        VerificationCheckKind::Custom,
    ];

    for kind in kinds {
        let json_str = serde_json::to_string(&kind).unwrap();
        let parsed: VerificationCheckKind = serde_json::from_str(&json_str).unwrap();
        assert_eq!(kind, parsed);
    }
}
