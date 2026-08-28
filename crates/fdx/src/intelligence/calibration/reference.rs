//! Deterministic construction of shadow reference check sets.

use crate::intelligence::build::discover::discover_fallback_build_inventory;
use crate::intelligence::build::snapshot::CurrentBuildSnapshot;
use crate::intelligence::calibration::model::{CalibrationPolicy, ReferenceScope};
use crate::intelligence::testplan::discover::{
    discover_tests_and_checks, fallback_scope_ids_for_dir,
};
use crate::intelligence::testplan::model::{PlannedCheck, SelectionReason, VerificationPlan};
use crate::protocol::EvidenceStrength;
use std::collections::{BTreeMap, HashSet};
use std::path::Path;

/// Deterministically construct a shadow reference set that unconditionally contains every
/// candidate-plan check. `max_shadow_checks` limits only additional, unselected checks.
pub fn construct_shadow_reference_set(
    repo_root: &Path,
    candidate_plan: &VerificationPlan,
    policy: &CalibrationPolicy,
) -> (Vec<PlannedCheck>, bool) {
    let inventory = discover_tests_and_checks(repo_root);
    let fallback_inv = discover_fallback_build_inventory(repo_root);
    let build_snapshot = CurrentBuildSnapshot::build(repo_root);

    let mut affected_scopes: HashSet<String> = HashSet::new();
    for check in &candidate_plan.selected_checks {
        affected_scopes.insert(check.scope.clone());
    }
    for imp in &candidate_plan.impacted_targets {
        if imp.target.starts_with("pkg:") {
            affected_scopes.insert(imp.target.clone());
        }
    }
    for ch in &candidate_plan.changed {
        if let Some(pkgs) = build_snapshot.contains_file_to_packages.get(&ch.file) {
            affected_scopes.extend(pkgs.iter().cloned());
        }
        for pkg_dir in &fallback_inv.package_dirs {
            let path = Path::new(&ch.file);
            if path.starts_with(pkg_dir) || pkg_dir == "." {
                affected_scopes.extend(fallback_scope_ids_for_dir(repo_root, pkg_dir));
            }
        }
    }

    let is_scope_matching = |scope: &str| -> bool {
        if policy.scope == ReferenceScope::Workspace || affected_scopes.is_empty() {
            return true;
        }
        affected_scopes.contains(scope)
            || affected_scopes.iter().any(|affected| {
                scope == affected
                    || scope.starts_with(&format!("{}/", affected))
                    || affected.starts_with(&format!("{}/", scope))
            })
    };

    // Candidate checks and discovered extras are intentionally separate. A lexical sort or
    // truncated discovered set must never remove an M6-selected obligation.
    let mut candidates: BTreeMap<String, PlannedCheck> = BTreeMap::new();
    for check in &candidate_plan.selected_checks {
        candidates.insert(check.check_id.clone(), check.clone());
    }

    let mut additional: BTreeMap<String, PlannedCheck> = BTreeMap::new();
    for test in &inventory.tests {
        let owning_scope = test.owning_package_id.as_deref().unwrap_or("repo");
        if is_scope_matching(owning_scope) && !candidates.contains_key(&test.stable_id) {
            additional.insert(
                test.stable_id.clone(),
                PlannedCheck {
                    check_id: test.stable_id.clone(),
                    display_name: test.canonical_path.clone(),
                    kind: test.kind,
                    scope: owning_scope.to_string(),
                    reason: "shadow reference test (package superset)".to_string(),
                    selection: SelectionReason::Evidence,
                    strength: EvidenceStrength::Structural,
                    evidence_path: None,
                    evidence_refs: Vec::new(),
                    widening_reason: None,
                    mandatory: false,
                },
            );
        }
    }
    for check in &inventory.checks {
        if is_scope_matching(&check.owning_scope_id) && !candidates.contains_key(&check.check_id) {
            additional.insert(
                check.check_id.clone(),
                PlannedCheck {
                    check_id: check.check_id.clone(),
                    display_name: check.display_name.clone(),
                    kind: check.kind,
                    scope: check.owning_scope_id.clone(),
                    reason: "shadow reference check (package check superset)".to_string(),
                    selection: SelectionReason::MandatoryCheck,
                    strength: EvidenceStrength::Structural,
                    evidence_path: None,
                    evidence_refs: Vec::new(),
                    widening_reason: None,
                    mandatory: true,
                },
            );
        }
    }

    let reference_truncated = additional.len() > policy.max_shadow_checks;
    let mut reference: Vec<PlannedCheck> = candidates.into_values().collect();
    reference.extend(additional.into_values().take(policy.max_shadow_checks));

    // Defensive invariant validation independent of construction mechanics.
    let reference_ids: HashSet<&str> = reference
        .iter()
        .map(|check| check.check_id.as_str())
        .collect();
    if candidate_plan
        .selected_checks
        .iter()
        .any(|check| !reference_ids.contains(check.check_id.as_str()))
    {
        // This is unreachable unless this function is changed incorrectly. Returning an empty
        // reference causes evaluation to fail closed rather than producing planner-quality data.
        return (Vec::new(), true);
    }

    (reference, reference_truncated)
}
