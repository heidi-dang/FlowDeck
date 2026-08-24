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

/// Deterministically construct a shadow reference check set that is a guaranteed superset of candidate checks.
pub fn construct_shadow_reference_set(
    repo_root: &Path,
    candidate_plan: &VerificationPlan,
    policy: &CalibrationPolicy,
) -> (Vec<PlannedCheck>, bool) {
    let inventory = discover_tests_and_checks(repo_root);
    let fallback_inv = discover_fallback_build_inventory(repo_root);
    let build_snapshot = CurrentBuildSnapshot::build(repo_root);

    // 1. Identify affected package scopes if scoped to affected packages
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
            for p in pkgs {
                affected_scopes.insert(p.clone());
            }
        }
        for pkg_dir in &fallback_inv.package_dirs {
            let p_ref = Path::new(&ch.file);
            if p_ref.starts_with(pkg_dir) || pkg_dir == "." {
                for scope_id in fallback_scope_ids_for_dir(repo_root, pkg_dir) {
                    affected_scopes.insert(scope_id);
                }
            }
        }
    }

    // 2. Index candidate plan selected checks (these are preserved verbatim)
    let mut check_map: BTreeMap<String, PlannedCheck> = BTreeMap::new();
    for check in &candidate_plan.selected_checks {
        check_map.insert(check.check_id.clone(), check.clone());
    }

    // Helper to test if a package scope matches affected scopes
    let is_scope_matching = |scope: &str| -> bool {
        if policy.scope == ReferenceScope::Workspace {
            return true;
        }
        if affected_scopes.is_empty() {
            // If no affected scopes were detected (e.g. empty diff), allow all discovered
            return true;
        }
        if affected_scopes.contains(scope) {
            return true;
        }
        // Prefix matching for scoped packages (e.g. pkg:npm:packages/core matches pkg:npm:packages/core/sub)
        affected_scopes.iter().any(|aff| {
            scope == aff
                || scope.starts_with(&format!("{}/", aff))
                || aff.starts_with(&format!("{}/", scope))
        })
    };

    // 3. Add all discovered static test files within policy scope
    for test in &inventory.tests {
        let owning_scope = test.owning_package_id.as_deref().unwrap_or("repo");
        if is_scope_matching(owning_scope) {
            let check_id = test.stable_id.clone();
            if !check_map.contains_key(&check_id) {
                check_map.insert(
                    check_id.clone(),
                    PlannedCheck {
                        check_id,
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
    }

    // 4. Add all discovered package/workspace checks within policy scope
    for check in &inventory.checks {
        if is_scope_matching(&check.owning_scope_id) {
            let check_id = check.check_id.clone();
            if !check_map.contains_key(&check_id) {
                check_map.insert(
                    check_id.clone(),
                    PlannedCheck {
                        check_id,
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
    }

    // 5. Convert to deterministic sorted Vec and apply max_shadow_checks limit
    let total_discovered = check_map.len();
    let is_truncated = total_discovered > policy.max_shadow_checks;

    let checks: Vec<PlannedCheck> = check_map
        .into_values()
        .take(policy.max_shadow_checks)
        .collect();

    (checks, is_truncated)
}
