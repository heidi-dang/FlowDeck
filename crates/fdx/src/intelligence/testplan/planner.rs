//! Verification planner core logic.
//!
//! Integrates M3/M4/M5 evidence graph, static test discovery, changed-code mapping,
//! policy widening, and fail-closed assurance rules into a deterministic verification plan.
//!
//! Strictly read-only: does NOT execute tests or builds.

use crate::intelligence::build::snapshot::CurrentBuildSnapshot;
use crate::intelligence::change::traverse::{analyze_impact_v2, TraverseError};
use crate::intelligence::change::uncertainty::{compute_result_assurance, UncertaintyReason};
use crate::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use crate::intelligence::testplan::bounds::get_active_test_plan_limits;
use crate::intelligence::testplan::discover::discover_tests_and_checks;
use crate::intelligence::testplan::freshness::detect_dynamic_test_configs;
use crate::intelligence::testplan::mapping::resolve_test_mappings;
use crate::intelligence::testplan::model::*;
use crate::intelligence::testplan::policy::VerificationPolicy;
use crate::protocol::{AssuranceLevel, EvidenceStrength};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::Path;

/// Generate an explainable, deterministic verification plan given git base/head refs and verification policy.
pub fn plan_verification(
    repo_root: &Path,
    base_ref: Option<&str>,
    head_ref: Option<&str>,
    policy_opt: Option<VerificationPolicy>,
) -> Result<VerificationPlan, TraverseError> {
    let policy = policy_opt.unwrap_or_default();
    let limits = get_active_test_plan_limits();

    // 1. Run M4/M5 transitive impact analysis
    let impact_result = analyze_impact_v2(repo_root, base_ref, head_ref, Some(5))?;

    let mut uncertainties = impact_result.uncertainty;
    let mut selected_checks_map: BTreeMap<String, PlannedCheck> = BTreeMap::new();

    // 2. Discover static test files and verification checks
    let inventory = discover_tests_and_checks(repo_root);
    if inventory.truncated {
        uncertainties.push(UncertaintyReason::BuildLimitReached(
            "Test discovery reached maximum bounded test limit".to_string(),
        ));
    }

    // 3. Detect dynamic test configs
    let dynamic_configs = detect_dynamic_test_configs(repo_root);
    for dc in &dynamic_configs {
        uncertainties.push(UncertaintyReason::DynamicConfigExpression(dc.clone()));
    }

    // 4. Open EvidenceDatabase in ReadOnly mode
    let db_res = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly);
    let (db_opt, has_db) = match db_res {
        Ok(d) => (Some(d), true),
        _ => (None, false),
    };

    let build_snapshot = CurrentBuildSnapshot::build(repo_root);
    let mappings = resolve_test_mappings(
        db_opt.as_ref().map(|d| &d.conn),
        &build_snapshot,
        &inventory,
    );

    // Build lookup maps
    let mut target_to_test_edges: HashMap<
        String,
        Vec<crate::intelligence::testplan::mapping::TestMappingEdge>,
    > = HashMap::new();
    for edge in mappings {
        target_to_test_edges
            .entry(edge.target_node.clone())
            .or_default()
            .push(edge);
    }

    let mut path_to_test: HashMap<String, &DiscoveredTest> = HashMap::new();
    for t in &inventory.tests {
        path_to_test.insert(t.canonical_path.clone(), t);
    }

    // Track all impacted packages and files
    let mut impacted_packages: HashSet<String> = HashSet::new();
    let mut impacted_files: HashSet<String> = HashSet::new();

    for imp in &impact_result.impacted {
        if imp.target.starts_with("pkg:") {
            impacted_packages.insert(imp.target.clone());
        } else {
            impacted_files.insert(imp.target.clone());
            if let Some(pkgs) = build_snapshot.contains_file_to_packages.get(&imp.target) {
                for p in pkgs {
                    impacted_packages.insert(p.clone());
                }
            }
        }
    }

    for ch in &impact_result.changes {
        impacted_files.insert(ch.file.clone());
        if let Some(pkgs) = build_snapshot.contains_file_to_packages.get(&ch.file) {
            for p in pkgs {
                impacted_packages.insert(p.clone());
            }
        }
    }

    // Transitive package dependency impact propagation (e.g. app depends on core)
    let mut pkg_queue: VecDeque<String> = impacted_packages.iter().cloned().collect();
    while let Some(current_pkg) = pkg_queue.pop_front() {
        if let Some(dependents) = build_snapshot.depends_on_reverse.get(&current_pkg) {
            for dep in dependents {
                if impacted_packages.insert(dep.clone()) {
                    pkg_queue.push_back(dep.clone());
                }
            }
        }
    }

    // Direct change check: if root config changed, widen to all packages
    let root_config_changed = impact_result.changes.iter().any(|c| {
        c.file == "tsconfig.json"
            || c.file == "package.json"
            || c.file == "Cargo.toml"
            || c.file == "pnpm-workspace.yaml"
    });

    if root_config_changed {
        for pkg in &inventory.checks {
            impacted_packages.insert(pkg.owning_scope_id.clone());
        }
    }

    let mut direct_tests_selected = HashSet::new();

    // 5. Direct symbol & file test mappings (Highest precision: SCIP references, filename rules)
    for ch in &impact_result.changes {
        let file_node = format!("file:{}", ch.file);
        let mut target_keys = vec![ch.file.clone(), file_node];
        if let Some(ref sym) = ch.symbol {
            target_keys.push(format!("sym:{}:{}", ch.file, sym));
            target_keys.push(format!("{}:{}", ch.file, sym));
        }

        for target_key in &target_keys {
            if let Some(edges) = target_to_test_edges.get(target_key.as_str()) {
                for edge in edges {
                    let test_file = edge
                        .test_node
                        .strip_prefix("file:")
                        .unwrap_or(&edge.test_node);
                    let check_id = if edge.test_node.starts_with("test:") {
                        edge.test_node.clone()
                    } else {
                        format!("test:npm:{}", test_file)
                    };

                    let kind = if test_file.contains("/tests/") || test_file.contains("tests/") {
                        VerificationCheckKind::IntegrationTest
                    } else {
                        VerificationCheckKind::UnitTest
                    };

                    let owning_scope = inventory
                        .tests
                        .iter()
                        .find(|t| t.canonical_path == test_file)
                        .and_then(|t| t.owning_package_id.clone())
                        .unwrap_or_else(|| "repo".to_string());

                    let reason = if let Some(ref sym) = ch.symbol {
                        format!("tests impacted symbol {}::{}", ch.file, sym)
                    } else {
                        format!("tests impacted file {}", ch.file)
                    };

                    let check = PlannedCheck {
                        check_id: check_id.clone(),
                        display_name: test_file.to_string(),
                        kind,
                        scope: owning_scope,
                        reason,
                        selection: SelectionReason::Evidence,
                        strength: edge.strength,
                        evidence_path: None,
                        widening_reason: None,
                        mandatory: false,
                    };

                    direct_tests_selected.insert(check_id.clone());
                    selected_checks_map.insert(check_id, check);
                }
            }
        }
    }

    // 6. Select tests from impacted graph targets (Transitive callers/importers)
    for imp in &impact_result.impacted {
        let norm_target = imp.target.strip_prefix("file:").unwrap_or(&imp.target);
        if let Some(discovered_test) = path_to_test.get(norm_target) {
            if !direct_tests_selected.contains(&discovered_test.stable_id) {
                let owning_scope = discovered_test
                    .owning_package_id
                    .clone()
                    .unwrap_or_else(|| "repo".to_string());

                let reason = if let Some(ref p) = imp.primary_path {
                    p.explanation.clone()
                } else {
                    format!("tests impacted by changes to {}", imp.target)
                };

                let check = PlannedCheck {
                    check_id: discovered_test.stable_id.clone(),
                    display_name: discovered_test.canonical_path.clone(),
                    kind: discovered_test.kind,
                    scope: owning_scope,
                    reason,
                    selection: SelectionReason::Evidence,
                    strength: imp.strength,
                    evidence_path: imp.primary_path.clone(),
                    widening_reason: imp.widening_reason.clone(),
                    mandatory: false,
                };

                direct_tests_selected.insert(discovered_test.stable_id.clone());
                selected_checks_map.insert(discovered_test.stable_id.clone(), check);
            }
        }
    }

    // 7. Policy widening: if semantic evidence is missing, stale, or dynamic config detected, widen to package tests
    let has_fresh_scip = has_db
        && !uncertainties.iter().any(|u| {
            matches!(
                u,
                UncertaintyReason::ProviderStale(_)
                    | UncertaintyReason::ProviderMissing(_)
                    | UncertaintyReason::GraphAbsent(_)
                    | UncertaintyReason::GraphCorrupt(_)
            )
        });

    let needs_package_widening = !has_fresh_scip
        || !dynamic_configs.is_empty()
        || inventory.truncated
        || uncertainties.iter().any(|u| {
            matches!(
                u,
                UncertaintyReason::ProviderStale(_)
                    | UncertaintyReason::ProviderMissing(_)
                    | UncertaintyReason::DynamicConfigExpression(_)
                    | UncertaintyReason::BuildLimitReached(_)
            )
        });

    if needs_package_widening {
        for test in &inventory.tests {
            let matches_package = test
                .owning_package_id
                .as_ref()
                .map(|p| impacted_packages.contains(p))
                .unwrap_or(false);

            if matches_package && !direct_tests_selected.contains(&test.stable_id) {
                let pkg_id = test.owning_package_id.clone().unwrap_or_default();
                selected_checks_map.insert(
                    test.stable_id.clone(),
                    PlannedCheck {
                        check_id: test.stable_id.clone(),
                        display_name: test.canonical_path.clone(),
                        kind: test.kind,
                        scope: pkg_id,
                        reason: "conservative package widening due to incomplete/stale semantic evidence".to_string(),
                        selection: SelectionReason::PolicyWidening,
                        strength: EvidenceStrength::Structural,
                        evidence_path: None,
                        widening_reason: Some("stale_or_incomplete_evidence".to_string()),
                        mandatory: false,
                    },
                );
            }
        }
    }

    // 8. Mandatory package checks (typecheck, lint, build, test scripts)
    if policy.mandatory_package_checks {
        for check in &inventory.checks {
            let is_impacted_scope =
                impacted_packages.contains(&check.owning_scope_id) || root_config_changed;

            if is_impacted_scope {
                let should_include = match check.kind {
                    VerificationCheckKind::Typecheck => policy.include_typecheck,
                    VerificationCheckKind::Lint => policy.include_lint,
                    VerificationCheckKind::Build => policy.include_build,
                    VerificationCheckKind::UnitTest | VerificationCheckKind::IntegrationTest => {
                        needs_package_widening
                    }
                    _ => false,
                };

                if should_include && !selected_checks_map.contains_key(&check.check_id) {
                    selected_checks_map.insert(
                        check.check_id.clone(),
                        PlannedCheck {
                            check_id: check.check_id.clone(),
                            display_name: check.display_name.clone(),
                            kind: check.kind,
                            scope: check.owning_scope_id.clone(),
                            reason: format!(
                                "mandatory check for impacted scope {}",
                                check.owning_scope_id
                            ),
                            selection: SelectionReason::MandatoryCheck,
                            strength: EvidenceStrength::Structural,
                            evidence_path: None,
                            widening_reason: None,
                            mandatory: true,
                        },
                    );
                }
            }
        }
    }

    // 9. Compute final assurance level
    let mut final_assurance =
        compute_result_assurance(impact_result.assurance, &uncertainties, false);

    if has_fresh_scip
        && !needs_package_widening
        && uncertainties.is_empty()
        && impact_result.assurance == AssuranceLevel::Exact
    {
        final_assurance = AssuranceLevel::Exact;
    } else if final_assurance > AssuranceLevel::Conservative && needs_package_widening {
        final_assurance = AssuranceLevel::Conservative;
    }

    let mut sorted_checks: Vec<PlannedCheck> = selected_checks_map.into_values().collect();
    sorted_checks.sort_by(|a, b| a.check_id.cmp(&b.check_id));

    // Cap selected checks by bounded limits
    if sorted_checks.len() > limits.max_selected_checks {
        sorted_checks.truncate(limits.max_selected_checks);
        uncertainties.push(UncertaintyReason::BuildLimitReached(
            "Selected verification checks exceeded limit; truncated".to_string(),
        ));
        final_assurance = AssuranceLevel::Degraded;
    }

    let mut sorted_uncertainties = uncertainties;
    sorted_uncertainties.sort_by(|a, b| a.code().cmp(b.code()));
    sorted_uncertainties.dedup();

    Ok(VerificationPlan {
        assurance: final_assurance,
        changed: impact_result.changes,
        impacted_targets: impact_result.impacted,
        selected_checks: sorted_checks,
        uncertainty: sorted_uncertainties,
    })
}
