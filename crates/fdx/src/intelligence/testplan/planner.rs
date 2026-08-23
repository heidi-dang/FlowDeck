//! Verification planner core logic.
//!
//! Integrates M3/M4/M5 evidence graph, static test discovery, changed-code mapping,
//! policy widening, and fail-closed assurance rules into a deterministic verification plan.
//!
//! Strictly read-only: does NOT execute tests or builds.

use crate::intelligence::build::discover::discover_fallback_build_inventory;
use crate::intelligence::build::snapshot::CurrentBuildSnapshot;
use crate::intelligence::change::explain::{render_path_explanation, EvidencePath, EvidenceStep};
use crate::intelligence::change::traverse::{analyze_impact_v2, TraverseError};
use crate::intelligence::change::uncertainty::{compute_result_assurance, UncertaintyReason};
use crate::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use crate::intelligence::testplan::bounds::get_active_test_plan_limits;
use crate::intelligence::testplan::discover::{
    discover_tests_and_checks, fallback_scope_ids_for_dir,
};
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
    let mut unresolved_obligations: Vec<UnresolvedVerificationObligation> = Vec::new();

    // 2. Discover static test files and verification checks
    let inventory = discover_tests_and_checks(repo_root);
    if inventory.truncated {
        uncertainties.push(UncertaintyReason::BuildLimitReached(
            "Test discovery reached maximum bounded test limit".to_string(),
        ));
    }
    if inventory.fallback.truncated {
        uncertainties.push(UncertaintyReason::BuildLimitReached(
            "Fallback test inventory reached maximum boundary limit".to_string(),
        ));
    }

    if let DiscoveryState::Incomplete { ref issues } | DiscoveryState::Failed { ref issues } =
        inventory.state
    {
        for issue in issues {
            if issue.kind == "dynamic_config" {
                uncertainties.push(UncertaintyReason::DynamicConfigExpression(
                    issue.message.clone(),
                ));
            } else {
                uncertainties.push(UncertaintyReason::BuildLimitReached(format!(
                    "Test discovery {}: {}",
                    issue.kind, issue.message
                )));
            }
        }
    }

    // 3. Open EvidenceDatabase in ReadOnly mode
    let db_res = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly);
    let (db_opt, has_db) = match db_res {
        Ok(d) => (Some(d), true),
        _ => (None, false),
    };

    let build_snapshot = CurrentBuildSnapshot::build(repo_root);
    let fallback_build_inv = discover_fallback_build_inventory(repo_root);

    let mapping_resolution = resolve_test_mappings(
        db_opt.as_ref().map(|d| &d.conn),
        &build_snapshot,
        &inventory,
    );

    if mapping_resolution.truncated {
        uncertainties.push(UncertaintyReason::BuildLimitReached(
            "Test mapping edges reached maximum limit".to_string(),
        ));
    }

    for err in &mapping_resolution.errors {
        uncertainties.push(UncertaintyReason::GraphCorrupt(format!(
            "Test mapping query error: {}",
            err
        )));
    }

    // Build lookup maps
    let mut target_to_test_edges: HashMap<
        String,
        Vec<crate::intelligence::testplan::mapping::TestMappingEdge>,
    > = HashMap::new();
    for edge in mapping_resolution.mappings {
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
            } else {
                for pkg_dir in &fallback_build_inv.package_dirs {
                    if imp.target.starts_with(pkg_dir) {
                        for scope_id in fallback_scope_ids_for_dir(repo_root, pkg_dir) {
                            impacted_packages.insert(scope_id);
                        }
                    }
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
        } else {
            for pkg_dir in &fallback_build_inv.package_dirs {
                if ch.file.starts_with(pkg_dir) {
                    for scope_id in fallback_scope_ids_for_dir(repo_root, pkg_dir) {
                        impacted_packages.insert(scope_id);
                    }
                }
            }
        }
    }

    // Transitive package dependency impact propagation
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

    // Root config changes widen to all packages and scopes
    let root_config_changed = impact_result.changes.iter().any(|c| {
        c.file == "tsconfig.json"
            || c.file == "package.json"
            || c.file == "Cargo.toml"
            || c.file == "pnpm-workspace.yaml"
    });

    if root_config_changed {
        for test in &inventory.tests {
            if let Some(ref pkg) = test.owning_package_id {
                impacted_packages.insert(pkg.clone());
            }
        }
        for check in &inventory.checks {
            impacted_packages.insert(check.owning_scope_id.clone());
        }
        for pkg_dir in &fallback_build_inv.package_dirs {
            for scope_id in fallback_scope_ids_for_dir(repo_root, pkg_dir) {
                impacted_packages.insert(scope_id);
            }
        }
        for scope in &inventory.fallback.package_test_scopes {
            impacted_packages.insert(scope.clone());
        }
    }

    let mut direct_tests_selected = HashSet::new();
    let mut relevant_stale_mapping_detected = false;

    // 4. Direct symbol & file test mappings (SCIP references, filename rules)
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
                    if edge.stale {
                        relevant_stale_mapping_detected = true;
                        uncertainties.push(UncertaintyReason::ProviderStale(format!(
                            "Test mapping edge {} for {} is stale",
                            edge.provider_id, ch.file
                        )));
                    }

                    let test_file = edge
                        .test_node
                        .strip_prefix("file:")
                        .unwrap_or(&edge.test_node);
                    let check_id = if edge.test_node.starts_with("test:") {
                        edge.test_node.clone()
                    } else {
                        let is_rs = test_file.ends_with(".rs");
                        format!("test:{}:{}", if is_rs { "cargo" } else { "npm" }, test_file)
                    };

                    let kind = if test_file.contains("/tests/") || test_file.contains("tests/") {
                        VerificationCheckKind::IntegrationTest
                    } else {
                        VerificationCheckKind::UnitTest
                    };

                    let owning_scope = inventory
                        .tests
                        .iter()
                        .find(|t| t.canonical_path == test_file || t.stable_id == edge.test_node)
                        .and_then(|t| t.owning_package_id.clone())
                        .unwrap_or_else(|| "repo".to_string());

                    let reason = if let Some(ref sym) = ch.symbol {
                        format!("tests impacted symbol {}::{}", ch.file, sym)
                    } else {
                        format!("tests impacted file {}", ch.file)
                    };

                    let step = EvidenceStep {
                        from_node: edge.test_node.clone(),
                        edge_kind: edge.kind,
                        to_node: edge.target_node.clone(),
                        provider: edge.provider_id.clone(),
                        strength: edge.strength,
                        description: Some(format!("test mapping via {}", edge.provider_id)),
                    };
                    let path_explanation = render_path_explanation(
                        &edge.test_node,
                        target_key,
                        std::slice::from_ref(&step),
                    );
                    let evidence_path = EvidencePath {
                        change_id: format!("{}:{}", ch.file, ch.symbol.as_deref().unwrap_or("")),
                        seed_node: target_key.clone(),
                        target_node: edge.test_node.clone(),
                        steps: vec![step],
                        path_strength: edge.strength,
                        explanation: path_explanation,
                    };

                    let evidence_ref = CheckEvidenceRef {
                        evidence_id: edge.evidence_id.clone(),
                        provider: edge.provider.clone(),
                        provider_id: edge.provider_id.clone(),
                        provider_fingerprint: edge.provider_fingerprint.clone(),
                        source_identity: edge.source_identity.clone(),
                        strength: edge.strength,
                        stale: edge.stale,
                    };

                    let check = PlannedCheck {
                        check_id: check_id.clone(),
                        display_name: test_file.to_string(),
                        kind,
                        scope: owning_scope,
                        reason,
                        selection: SelectionReason::Evidence,
                        strength: edge.strength,
                        evidence_path: Some(evidence_path),
                        evidence_refs: vec![evidence_ref],
                        widening_reason: None,
                        mandatory: false,
                    };

                    direct_tests_selected.insert(check_id.clone());
                    selected_checks_map.insert(check_id, check);
                }
            }
        }
    }

    // 5. Select tests from impacted graph targets (Transitive callers/importers)
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

                let evidence_path = imp.primary_path.clone().or_else(|| {
                    Some(EvidencePath {
                        change_id: imp.target.clone(),
                        seed_node: imp.target.clone(),
                        target_node: discovered_test.stable_id.clone(),
                        steps: Vec::new(),
                        path_strength: imp.strength,
                        explanation: format!(
                            "{} impacted by graph traversal",
                            discovered_test.stable_id
                        ),
                    })
                });

                let check = PlannedCheck {
                    check_id: discovered_test.stable_id.clone(),
                    display_name: discovered_test.canonical_path.clone(),
                    kind: discovered_test.kind,
                    scope: owning_scope,
                    reason,
                    selection: SelectionReason::Evidence,
                    strength: imp.strength,
                    evidence_path,
                    evidence_refs: vec![CheckEvidenceRef {
                        evidence_id: None,
                        provider: "graph_traversal".to_string(),
                        provider_id: "graph_traversal".to_string(),
                        provider_fingerprint: None,
                        source_identity: Some(imp.target.clone()),
                        strength: imp.strength,
                        stale: false,
                    }],
                    widening_reason: None,
                    mandatory: false,
                };

                direct_tests_selected.insert(discovered_test.stable_id.clone());
                selected_checks_map.insert(discovered_test.stable_id.clone(), check);
            }
        }
    }

    // 6. Policy widening: if semantic evidence is missing, stale, or dynamic config detected, widen to package tests
    let has_fresh_scip = has_db
        && !relevant_stale_mapping_detected
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
        || relevant_stale_mapping_detected
        || inventory.truncated
        || inventory.fallback.truncated
        || mapping_resolution.truncated
        || !mapping_resolution.errors.is_empty()
        || matches!(
            inventory.state,
            DiscoveryState::Incomplete { .. } | DiscoveryState::Failed { .. }
        )
        || uncertainties.iter().any(|u| {
            matches!(
                u,
                UncertaintyReason::ProviderStale(_)
                    | UncertaintyReason::ProviderMissing(_)
                    | UncertaintyReason::DynamicConfigExpression(_)
                    | UncertaintyReason::BuildLimitReached(_)
                    | UncertaintyReason::GraphCorrupt(_)
            )
        });

    if needs_package_widening {
        for test in &inventory.tests {
            let matches_package = test
                .owning_package_id
                .as_ref()
                .map(|p| impacted_packages.contains(p))
                .unwrap_or(false);

            let kind_allowed = match test.kind {
                VerificationCheckKind::UnitTest => policy.include_unit_tests,
                VerificationCheckKind::IntegrationTest => policy.include_integration_tests,
                VerificationCheckKind::EndToEndTest => policy.include_e2e_tests,
                _ => true,
            };

            if matches_package && kind_allowed && !direct_tests_selected.contains(&test.stable_id) {
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
                        evidence_refs: Vec::new(),
                        widening_reason: Some("stale_or_incomplete_evidence".to_string()),
                        mandatory: false,
                    },
                );
            }
        }
    }

    // 7. Mandatory package checks (typecheck, lint, build, test scripts)
    if policy.mandatory_package_checks {
        for check in &inventory.checks {
            let is_impacted_scope =
                impacted_packages.contains(&check.owning_scope_id) || root_config_changed;

            if is_impacted_scope {
                let should_include = match check.kind {
                    VerificationCheckKind::Typecheck => policy.include_typecheck,
                    VerificationCheckKind::Lint => policy.include_lint,
                    VerificationCheckKind::Build => policy.include_build,
                    VerificationCheckKind::UnitTest => {
                        policy.include_unit_tests && needs_package_widening
                    }
                    VerificationCheckKind::IntegrationTest => {
                        policy.include_integration_tests && needs_package_widening
                    }
                    VerificationCheckKind::EndToEndTest => {
                        policy.include_e2e_tests && needs_package_widening
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
                                "mandatory check under policy for scope {}",
                                check.owning_scope_id
                            ),
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
    }

    // 8. General fail-closed handling of incomplete verification domains
    // If any discovery truncation, walker error, read error, or unparseable/dynamic config
    // can hide test domain membership without an enclosing executable test suite script,
    // generate typed UnresolvedVerificationObligation and force UNVERIFIED.
    let mut incomplete_scopes: HashSet<(String, String, String)> = HashSet::new();

    if inventory.truncated {
        for pkg_scope in &impacted_packages {
            incomplete_scopes.insert((
                pkg_scope.clone(),
                "exact test discovery truncated and no package test suite script exists to enclose omitted tests".to_string(),
                "discovery_limit".to_string(),
            ));
        }
    }

    if inventory.fallback.truncated {
        for pkg_scope in &impacted_packages {
            incomplete_scopes.insert((
                pkg_scope.clone(),
                "fallback test boundary inventory truncated without enclosing suite".to_string(),
                "fallback_limit".to_string(),
            ));
        }
    }

    if let DiscoveryState::Incomplete { ref issues } | DiscoveryState::Failed { ref issues } =
        inventory.state
    {
        for issue in issues {
            if let Some(ref p) = issue.path {
                let matching_scopes =
                    if let Some(pkgs) = build_snapshot.contains_file_to_packages.get(p) {
                        pkgs.clone()
                    } else {
                        let mut scs = Vec::new();
                        for pkg_dir in &fallback_build_inv.package_dirs {
                            if p.starts_with(pkg_dir) {
                                scs.extend(fallback_scope_ids_for_dir(repo_root, pkg_dir));
                            }
                        }
                        if scs.is_empty() {
                            if let Some(parent) = Path::new(p).parent() {
                                let p_str = parent.to_string_lossy();
                                if !p_str.is_empty() {
                                    scs.extend(fallback_scope_ids_for_dir(repo_root, &p_str));
                                }
                            }
                        }
                        scs
                    };

                for sc in matching_scopes {
                    if impacted_packages.contains(&sc) || root_config_changed {
                        incomplete_scopes.insert((
                            sc,
                            format!(
                                "test discovery {} at {} may hide required tests",
                                issue.kind, p
                            ),
                            issue.kind.clone(),
                        ));
                    }
                }
            } else {
                // Global issue without specific path (e.g. walker_error)
                for pkg_scope in &impacted_packages {
                    incomplete_scopes.insert((
                        pkg_scope.clone(),
                        format!("global test discovery {}: {}", issue.kind, issue.message),
                        issue.kind.clone(),
                    ));
                }
                if impacted_packages.is_empty() {
                    incomplete_scopes.insert((
                        "workspace:root".to_string(),
                        format!("global test discovery {}: {}", issue.kind, issue.message),
                        issue.kind.clone(),
                    ));
                }
            }
        }
    }

    for (scope, reason, source) in incomplete_scopes {
        let has_enclosing_suite = inventory.checks.iter().any(|c| {
            c.owning_scope_id == scope
                && (c.kind == VerificationCheckKind::UnitTest
                    || c.kind == VerificationCheckKind::IntegrationTest
                    || c.kind == VerificationCheckKind::EndToEndTest)
        });

        if !has_enclosing_suite {
            unresolved_obligations.push(UnresolvedVerificationObligation {
                scope,
                reason,
                source,
            });
        }
    }

    // 9. Compute final assurance level
    let mut final_assurance =
        compute_result_assurance(impact_result.assurance, &uncertainties, false);

    if !unresolved_obligations.is_empty() {
        final_assurance = AssuranceLevel::Unverified;
    } else if has_fresh_scip
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

    // 10. Safe output bounding: never silently truncate without retaining safe enclosing obligation
    if sorted_checks.len() > limits.max_selected_checks {
        let mut package_checks_available: HashMap<String, PlannedCheck> = HashMap::new();
        for check in &inventory.checks {
            if check.kind == VerificationCheckKind::UnitTest
                || check.kind == VerificationCheckKind::IntegrationTest
                || check.kind == VerificationCheckKind::EndToEndTest
            {
                package_checks_available.insert(
                    check.owning_scope_id.clone(),
                    PlannedCheck {
                        check_id: check.check_id.clone(),
                        display_name: check.display_name.clone(),
                        kind: check.kind,
                        scope: check.owning_scope_id.clone(),
                        reason: format!(
                            "safe enclosing package test suite for {}",
                            check.owning_scope_id
                        ),
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

        let mut rolled_up_map: BTreeMap<String, PlannedCheck> = BTreeMap::new();
        let mut unrepresented_omissions = false;

        for check in &sorted_checks {
            if check.check_id.starts_with("check:") {
                rolled_up_map.insert(check.check_id.clone(), check.clone());
            } else if let Some(pkg_check) = package_checks_available.get(&check.scope) {
                rolled_up_map.insert(pkg_check.check_id.clone(), pkg_check.clone());
            } else {
                unrepresented_omissions = true;
                unresolved_obligations.push(UnresolvedVerificationObligation {
                    scope: check.scope.clone(),
                    reason: format!(
                        "output limit exceeded for {} without enclosing suite script",
                        check.scope
                    ),
                    source: "output_limit".to_string(),
                });
            }
        }

        let mut candidate_checks: Vec<PlannedCheck> = rolled_up_map.into_values().collect();
        candidate_checks.sort_by(|a, b| a.check_id.cmp(&b.check_id));

        if !unrepresented_omissions && candidate_checks.len() <= limits.max_selected_checks {
            sorted_checks = candidate_checks;
            uncertainties.push(UncertaintyReason::BuildLimitReached(
                "Selected individual tests rolled up into enclosing package test suites due to output limit".to_string(),
            ));
            if final_assurance > AssuranceLevel::Conservative {
                final_assurance = AssuranceLevel::Conservative;
            }
        } else {
            if candidate_checks.len() > limits.max_selected_checks {
                candidate_checks.truncate(limits.max_selected_checks);
                sorted_checks = candidate_checks;
            }
            uncertainties.push(UncertaintyReason::BuildLimitReached(
                "Selected verification checks exceeded output limit and cannot be safely represented without missing obligations".to_string(),
            ));
            final_assurance = AssuranceLevel::Unverified;
        }
    }

    let mut sorted_uncertainties = uncertainties;
    sorted_uncertainties.sort_by(|a, b| a.code().cmp(b.code()));
    sorted_uncertainties.dedup();

    unresolved_obligations.sort_by(|a, b| a.scope.cmp(&b.scope));
    unresolved_obligations.dedup();

    Ok(VerificationPlan {
        assurance: final_assurance,
        changed: impact_result.changes,
        impacted_targets: impact_result.impacted,
        selected_checks: sorted_checks,
        uncertainty: sorted_uncertainties,
        unresolved_obligations,
    })
}
