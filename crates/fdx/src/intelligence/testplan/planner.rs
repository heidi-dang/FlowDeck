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
use crate::intelligence::semantic::health::{ProviderFreshness, ProviderHealth};
use crate::intelligence::semantic::provider::{ProviderState, ProviderType};
use crate::intelligence::semantic::state::load_provider_states;
use crate::intelligence::semantic::LanguageId;
use crate::intelligence::testplan::bounds::get_active_test_plan_limits;
use crate::intelligence::testplan::discover::{
    discover_tests_and_checks, fallback_scope_ids_for_dir,
};
use crate::intelligence::testplan::mapping::resolve_test_mappings;
use crate::intelligence::testplan::model::*;
use crate::intelligence::testplan::policy::VerificationPolicy;
use crate::protocol::{AssuranceLevel, EvidenceStrength};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MappingScopeState {
    FreshComplete,
    Stale(String),
    Missing(String),
    Failed(String),
    Truncated,
}

/// Check if a provider scope root path contains a candidate package/directory path with strict path boundary semantics.
pub fn scope_contains_path(scope_root: &str, candidate_path: &str) -> bool {
    let s_norm = scope_root.trim().trim_matches('/');
    if s_norm.is_empty() || s_norm == "." || s_norm == "workspace:root" {
        return true;
    }
    let c_norm = candidate_path.trim().trim_matches('/');
    if c_norm.is_empty() || c_norm == "." {
        return false;
    }
    c_norm == s_norm || c_norm.starts_with(&format!("{}/", s_norm))
}

/// Check if a ProviderState covers a package scope with path-boundary correctness.
pub fn provider_covers_package(provider: &ProviderState, package_scope: &str) -> bool {
    let pkg_clean = package_scope
        .strip_prefix("pkg:npm:")
        .or_else(|| package_scope.strip_prefix("pkg:cargo:"))
        .unwrap_or(package_scope);

    if let Some(ref p_pkg) = provider.scope.package {
        let p_pkg_clean = p_pkg
            .strip_prefix("pkg:npm:")
            .or_else(|| p_pkg.strip_prefix("pkg:cargo:"))
            .unwrap_or(p_pkg);
        p_pkg == package_scope || p_pkg_clean == pkg_clean || p_pkg == pkg_clean
    } else {
        scope_contains_path(&provider.scope.workspace_root, pkg_clean)
    }
}

/// Derive the set of relevant languages for an impacted package scope.
pub fn derive_relevant_languages_for_package(
    package_scope: &str,
    inventory: &TestInventory,
    impacted_files: &HashSet<String>,
    build_snapshot: &CurrentBuildSnapshot,
) -> BTreeSet<LanguageId> {
    let mut langs = BTreeSet::new();

    // 1. Inspect tests belonging to this package
    for test in &inventory.tests {
        if test.owning_package_id.as_deref() == Some(package_scope) {
            let p = &test.canonical_path;
            if p.ends_with(".ts")
                || p.ends_with(".tsx")
                || p.ends_with(".mts")
                || p.ends_with(".cts")
            {
                langs.insert(LanguageId::TypeScript);
            } else if p.ends_with(".js")
                || p.ends_with(".jsx")
                || p.ends_with(".mjs")
                || p.ends_with(".cjs")
            {
                langs.insert(LanguageId::JavaScript);
            } else if p.ends_with(".rs") {
                langs.insert(LanguageId::Rust);
            }
        }
    }

    // 2. Inspect impacted files belonging to this package
    let pkg_clean = package_scope
        .strip_prefix("pkg:npm:")
        .or_else(|| package_scope.strip_prefix("pkg:cargo:"))
        .unwrap_or(package_scope);

    for file in impacted_files {
        let belongs = if let Some(pkgs) = build_snapshot.contains_file_to_packages.get(file) {
            pkgs.contains(&package_scope.to_string()) || pkgs.contains(&pkg_clean.to_string())
        } else {
            scope_contains_path(pkg_clean, file)
        };

        if belongs {
            if file.ends_with(".ts")
                || file.ends_with(".tsx")
                || file.ends_with(".mts")
                || file.ends_with(".cts")
            {
                langs.insert(LanguageId::TypeScript);
            } else if file.ends_with(".js")
                || file.ends_with(".jsx")
                || file.ends_with(".mjs")
                || file.ends_with(".cjs")
            {
                langs.insert(LanguageId::JavaScript);
            } else if file.ends_with(".rs") {
                langs.insert(LanguageId::Rust);
            }
        }
    }

    // 3. Fallback defaults by package manager identity if no files found
    if langs.is_empty() {
        if package_scope.starts_with("pkg:cargo:") {
            langs.insert(LanguageId::Rust);
        } else if package_scope.starts_with("pkg:npm:") {
            langs.insert(LanguageId::TypeScript);
        }
    }

    langs
}

/// Deterministically evaluate MappingScopeState for a package across its required language domains.
pub fn evaluate_mapping_scope(
    package_scope: &str,
    relevant_languages: &BTreeSet<LanguageId>,
    providers: &[ProviderState],
) -> MappingScopeState {
    if relevant_languages.is_empty() {
        return MappingScopeState::Missing(format!(
            "cannot determine language domain for scope {}",
            package_scope
        ));
    }

    let mut lang_failures: Vec<String> = Vec::new();
    let mut lang_stales: Vec<String> = Vec::new();
    let mut lang_missings: Vec<String> = Vec::new();

    for lang in relevant_languages {
        let mut candidates: Vec<&ProviderState> = providers
            .iter()
            .filter(|p| {
                p.identity.provider_type == ProviderType::Scip
                    && provider_covers_package(p, package_scope)
                    && p.scope.languages.contains(lang)
            })
            .collect();

        // Sort deterministically to prevent insertion-order sensitivity
        candidates.sort_by_key(|p| p.provider_id());

        if candidates.is_empty() {
            lang_missings.push(format!(
                "no provider covers {:?} in {}",
                lang, package_scope
            ));
            continue;
        }

        let has_fresh_available = candidates.iter().any(|p| {
            p.health == ProviderHealth::Available && p.freshness == ProviderFreshness::Fresh
        });

        if has_fresh_available {
            // Language domain is satisfied fresh
            continue;
        }

        let all_failed = candidates
            .iter()
            .all(|p| p.health != ProviderHealth::Available);

        if all_failed {
            lang_failures.push(format!(
                "provider for {:?} in {} failed ({:?})",
                lang, package_scope, candidates[0].health
            ));
        } else {
            lang_stales.push(format!(
                "provider for {:?} in {} is stale ({:?})",
                lang, package_scope, candidates[0].freshness
            ));
        }
    }

    if let Some(fail) = lang_failures.first() {
        MappingScopeState::Failed(fail.clone())
    } else if let Some(stale) = lang_stales.first() {
        MappingScopeState::Stale(stale.clone())
    } else if let Some(missing) = lang_missings.first() {
        MappingScopeState::Missing(missing.clone())
    } else {
        MappingScopeState::FreshComplete
    }
}

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

    let build_snapshot = CurrentBuildSnapshot::build(repo_root);
    let fallback_build_inv = discover_fallback_build_inventory(repo_root);

    // Track path-scoped discovery/config issues vs global issues
    let mut path_scoped_widening_packages: HashMap<String, String> = HashMap::new();
    let mut global_discovery_issue = false;

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

            if let Some(ref p) = issue.path {
                let matching_scopes =
                    if let Some(pkgs) = build_snapshot.contains_file_to_packages.get(p) {
                        pkgs.clone()
                    } else {
                        let mut scs = Vec::new();
                        for pkg_dir in &fallback_build_inv.package_dirs {
                            if scope_contains_path(pkg_dir, p) {
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
                    path_scoped_widening_packages.insert(
                        sc,
                        format!(
                            "path_scoped_discovery_issue ({}: {})",
                            issue.kind, issue.message
                        ),
                    );
                }
            } else {
                global_discovery_issue = true;
            }
        }
    }

    // 3. Open EvidenceDatabase in ReadOnly mode and inspect provider states
    let db_res = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly);
    let (db_opt, _has_db) = match db_res {
        Ok(d) => (Some(d), true),
        _ => (None, false),
    };

    let persisted_providers = db_opt
        .as_ref()
        .and_then(|d| load_provider_states(d).ok())
        .unwrap_or_default();

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
    let mut package_to_impact_path: HashMap<String, EvidencePath> = HashMap::new();

    for imp in &impact_result.impacted {
        if imp.target.starts_with("pkg:") {
            impacted_packages.insert(imp.target.clone());
            if let Some(ref p) = imp.primary_path {
                package_to_impact_path.insert(imp.target.clone(), p.clone());
            }
        } else {
            impacted_files.insert(imp.target.clone());
            if let Some(pkgs) = build_snapshot.contains_file_to_packages.get(&imp.target) {
                for p in pkgs {
                    impacted_packages.insert(p.clone());
                    if let Some(ref path) = imp.primary_path {
                        package_to_impact_path.insert(p.clone(), path.clone());
                    }
                }
            } else {
                for pkg_dir in &fallback_build_inv.package_dirs {
                    if scope_contains_path(pkg_dir, &imp.target) {
                        for scope_id in fallback_scope_ids_for_dir(repo_root, pkg_dir) {
                            impacted_packages.insert(scope_id.clone());
                            if let Some(ref path) = imp.primary_path {
                                package_to_impact_path.insert(scope_id, path.clone());
                            }
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
                if scope_contains_path(pkg_dir, &ch.file) {
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
                    if !package_to_impact_path.contains_key(dep) {
                        let step = EvidenceStep {
                            from_node: current_pkg.clone(),
                            edge_kind: crate::protocol::EdgeKind::DependsOn,
                            to_node: dep.clone(),
                            provider: "build_native".to_string(),
                            strength: EvidenceStrength::Structural,
                            description: Some(format!(
                                "package dependency {} -> {}",
                                dep, current_pkg
                            )),
                        };
                        package_to_impact_path.insert(
                            dep.clone(),
                            EvidencePath {
                                change_id: current_pkg.clone(),
                                seed_node: current_pkg.clone(),
                                target_node: dep.clone(),
                                steps: vec![step],
                                path_strength: EvidenceStrength::Structural,
                                explanation: format!("{} depends on {}", dep, current_pkg),
                            },
                        );
                    }
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

    // Build domain of affected targets for relevant mapping lookup
    let mut affected_target_keys: HashSet<String> = HashSet::new();
    for ch in &impact_result.changes {
        affected_target_keys.insert(ch.file.clone());
        affected_target_keys.insert(format!("file:{}", ch.file));
        if let Some(ref sym) = ch.symbol {
            affected_target_keys.insert(format!("sym:{}:{}", ch.file, sym));
            affected_target_keys.insert(format!("{}:{}", ch.file, sym));
        }
    }
    for imp in &impact_result.impacted {
        affected_target_keys.insert(imp.target.clone());
        let norm = imp.target.strip_prefix("file:").unwrap_or(&imp.target);
        affected_target_keys.insert(norm.to_string());
    }

    let mut direct_tests_selected = HashSet::new();
    let mut direct_tests_selected_per_package: HashMap<String, usize> = HashMap::new();
    let mut package_stale_mapping: HashMap<String, String> = HashMap::new();

    // 4. Direct symbol & file test mappings across affected targets with evidence compatibility validation
    for target_key in &affected_target_keys {
        if let Some(edges) = target_to_test_edges.get(target_key.as_str()) {
            for edge in edges {
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

                let owning_scope = inventory
                    .tests
                    .iter()
                    .find(|t| t.canonical_path == test_file || t.stable_id == edge.test_node)
                    .and_then(|t| t.owning_package_id.clone())
                    .unwrap_or_else(|| "repo".to_string());

                // Validate evidence edge compatibility with persisted provider state
                let matching_provider = persisted_providers.iter().find(|p| {
                    p.provider_id() == edge.provider_id
                        || p.identity.provider_id == edge.provider_id
                });

                let is_edge_compatible = match matching_provider {
                    Some(p) => {
                        let mut ok = true;
                        if p.health != ProviderHealth::Available {
                            package_stale_mapping.insert(
                                owning_scope.clone(),
                                format!(
                                    "Provider {} for edge in scope {} is {:?}",
                                    p.provider_id(),
                                    owning_scope,
                                    p.health
                                ),
                            );
                            uncertainties.push(UncertaintyReason::ProviderFailed(format!(
                                "Provider {} for edge in scope {} failed",
                                p.provider_id(),
                                owning_scope
                            )));
                            ok = false;
                        } else if p.freshness != ProviderFreshness::Fresh {
                            package_stale_mapping.insert(
                                owning_scope.clone(),
                                format!(
                                    "Provider {} for edge in scope {} is {:?}",
                                    p.provider_id(),
                                    owning_scope,
                                    p.freshness
                                ),
                            );
                            uncertainties.push(UncertaintyReason::ProviderStale(format!(
                                "Provider {} for edge in scope {} is stale",
                                p.provider_id(),
                                owning_scope
                            )));
                            ok = false;
                        } else if !provider_covers_package(p, &owning_scope) {
                            package_stale_mapping.insert(
                                owning_scope.clone(),
                                format!(
                                    "Provider {} scope does not cover {}",
                                    p.provider_id(),
                                    owning_scope
                                ),
                            );
                            uncertainties.push(UncertaintyReason::ProviderStale(format!(
                                "Provider {} scope does not cover {}",
                                p.provider_id(),
                                owning_scope
                            )));
                            ok = false;
                        } else if edge.stale {
                            package_stale_mapping.insert(
                                owning_scope.clone(),
                                format!(
                                    "Test mapping edge {} for {} is stale",
                                    edge.provider_id, target_key
                                ),
                            );
                            uncertainties.push(UncertaintyReason::ProviderStale(format!(
                                "Test mapping edge {} for {} in scope {} is stale",
                                edge.provider_id, target_key, owning_scope
                            )));
                            ok = false;
                        } else {
                            // Fingerprint compatibility check against M3 digest/config/input
                            let fp_opt = edge.provider_fingerprint.as_deref();
                            let fp_match = fp_opt == Some(p.fingerprint.digest.as_str())
                                || fp_opt == Some(p.fingerprint.config_fingerprint.as_str())
                                || fp_opt == Some(p.fingerprint.executable_identity.as_str())
                                || fp_opt == Some(p.identity.provider_id.as_str())
                                || fp_opt == Some(p.identity.executable_identity.as_str())
                                || fp_opt == Some(p.fingerprint.provider_version.as_str());
                            if !fp_match {
                                package_stale_mapping.insert(
                                    owning_scope.clone(),
                                    format!(
                                        "Fingerprint mismatch on edge {} (edge fp: {:?}, provider fp: {})",
                                        edge.provider_id, edge.provider_fingerprint, p.fingerprint.digest
                                    ),
                                );
                                uncertainties.push(UncertaintyReason::ProviderStale(format!(
                                    "Provider {} fingerprint mismatch on edge in scope {}",
                                    edge.provider_id, owning_scope
                                )));
                                ok = false;
                            }
                        }
                        ok
                    }
                    None => {
                        package_stale_mapping.insert(
                            owning_scope.clone(),
                            format!("Missing provider state for edge {}", edge.provider_id),
                        );
                        uncertainties.push(UncertaintyReason::ProviderMissing(format!(
                            "Provider {} not found in state for edge in scope {}",
                            edge.provider_id, owning_scope
                        )));
                        false
                    }
                };

                let kind = if test_file.contains("/tests/") || test_file.contains("tests/") {
                    VerificationCheckKind::IntegrationTest
                } else {
                    VerificationCheckKind::UnitTest
                };

                let reason = format!("tests impacted target {}", target_key);

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
                    change_id: target_key.clone(),
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
                    stale: !is_edge_compatible || edge.stale,
                };

                let check = PlannedCheck {
                    check_id: check_id.clone(),
                    display_name: test_file.to_string(),
                    kind,
                    scope: owning_scope.clone(),
                    reason,
                    selection: SelectionReason::Evidence,
                    strength: edge.strength,
                    evidence_path: Some(evidence_path),
                    evidence_refs: vec![evidence_ref],
                    widening_reason: None,
                    mandatory: false,
                };

                direct_tests_selected.insert(check_id.clone());
                if is_edge_compatible {
                    *direct_tests_selected_per_package
                        .entry(owning_scope)
                        .or_default() += 1;
                }
                selected_checks_map.insert(check_id, check);
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
                    scope: owning_scope.clone(),
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
                *direct_tests_selected_per_package
                    .entry(owning_scope)
                    .or_default() += 1;
                selected_checks_map.insert(discovered_test.stable_id.clone(), check);
            }
        }
    }

    // 6. Compute per-scope MappingScopeState deterministically with language coverage
    let mut package_scope_states: HashMap<String, MappingScopeState> = HashMap::new();
    for pkg_scope in &impacted_packages {
        if let Some(reason) = package_stale_mapping.get(pkg_scope) {
            package_scope_states
                .insert(pkg_scope.clone(), MappingScopeState::Stale(reason.clone()));
            continue;
        }

        let relevant_languages = derive_relevant_languages_for_package(
            pkg_scope,
            &inventory,
            &impacted_files,
            &build_snapshot,
        );

        let scope_state =
            evaluate_mapping_scope(pkg_scope, &relevant_languages, &persisted_providers);

        package_scope_states.insert(pkg_scope.clone(), scope_state);
    }

    // 7. Policy widening: compute packages requiring conservative widening
    let global_failure = root_config_changed
        || inventory.truncated
        || inventory.fallback.truncated
        || mapping_resolution.truncated
        || !mapping_resolution.errors.is_empty()
        || global_discovery_issue
        || uncertainties.iter().any(|u| {
            matches!(
                u,
                UncertaintyReason::BuildLimitReached(_) | UncertaintyReason::GraphCorrupt(_)
            )
        });

    let mut packages_requiring_widening: HashMap<String, String> = HashMap::new();
    for pkg_scope in &impacted_packages {
        if global_failure {
            packages_requiring_widening.insert(
                pkg_scope.clone(),
                "global_failure_or_root_change".to_string(),
            );
        } else if let Some(scoped_issue) = path_scoped_widening_packages.get(pkg_scope) {
            packages_requiring_widening.insert(pkg_scope.clone(), scoped_issue.clone());
        } else {
            let state = package_scope_states
                .get(pkg_scope)
                .cloned()
                .unwrap_or_else(|| MappingScopeState::Missing("unknown".to_string()));

            match state {
                MappingScopeState::FreshComplete => {
                    // If build-transitively impacted and NO direct tests were selected, it requires widening
                    let direct_tests_count = direct_tests_selected_per_package
                        .get(pkg_scope)
                        .copied()
                        .unwrap_or(0);
                    if direct_tests_count == 0 {
                        packages_requiring_widening.insert(
                            pkg_scope.clone(),
                            "build_transitive_package_impact".to_string(),
                        );
                    }
                }
                MappingScopeState::Stale(r) => {
                    packages_requiring_widening
                        .insert(pkg_scope.clone(), format!("stale_evidence: {}", r));
                }
                MappingScopeState::Missing(r) => {
                    packages_requiring_widening
                        .insert(pkg_scope.clone(), format!("missing_evidence: {}", r));
                }
                MappingScopeState::Failed(r) => {
                    packages_requiring_widening
                        .insert(pkg_scope.clone(), format!("failed_evidence: {}", r));
                }
                MappingScopeState::Truncated => {
                    packages_requiring_widening
                        .insert(pkg_scope.clone(), "truncated_evidence".to_string());
                }
            }
        }
    }

    // Apply widening only to packages in packages_requiring_widening
    for (pkg_scope, widen_reason) in &packages_requiring_widening {
        for test in &inventory.tests {
            if test.owning_package_id.as_deref() == Some(pkg_scope) {
                let kind_allowed = match test.kind {
                    VerificationCheckKind::UnitTest => policy.include_unit_tests,
                    VerificationCheckKind::IntegrationTest => policy.include_integration_tests,
                    VerificationCheckKind::EndToEndTest => policy.include_e2e_tests,
                    _ => true,
                };

                if kind_allowed && !direct_tests_selected.contains(&test.stable_id) {
                    selected_checks_map.insert(
                        test.stable_id.clone(),
                        PlannedCheck {
                            check_id: test.stable_id.clone(),
                            display_name: test.canonical_path.clone(),
                            kind: test.kind,
                            scope: pkg_scope.clone(),
                            reason: format!("package widening for {}: {}", pkg_scope, widen_reason),
                            selection: SelectionReason::PolicyWidening,
                            strength: EvidenceStrength::Structural,
                            evidence_path: None,
                            evidence_refs: Vec::new(),
                            widening_reason: Some(widen_reason.clone()),
                            mandatory: false,
                        },
                    );
                }
            }
        }
    }

    // 8. Mandatory package checks (typecheck, lint, build, test scripts)
    if policy.mandatory_package_checks {
        for check in &inventory.checks {
            let is_impacted_scope =
                impacted_packages.contains(&check.owning_scope_id) || root_config_changed;

            if is_impacted_scope {
                let is_widened = packages_requiring_widening.contains_key(&check.owning_scope_id);
                let should_include = match check.kind {
                    VerificationCheckKind::Typecheck => policy.include_typecheck,
                    VerificationCheckKind::Lint => policy.include_lint,
                    VerificationCheckKind::Build => policy.include_build,
                    VerificationCheckKind::UnitTest => policy.include_unit_tests && is_widened,
                    VerificationCheckKind::IntegrationTest => {
                        policy.include_integration_tests && is_widened
                    }
                    VerificationCheckKind::EndToEndTest => policy.include_e2e_tests && is_widened,
                    _ => false,
                };

                if should_include && !selected_checks_map.contains_key(&check.check_id) {
                    let reason =
                        if let Some(path) = package_to_impact_path.get(&check.owning_scope_id) {
                            format!(
                                "mandatory check for {} impacted via {}",
                                check.owning_scope_id, path.explanation
                            )
                        } else {
                            format!(
                                "mandatory check under policy for scope {}",
                                check.owning_scope_id
                            )
                        };

                    selected_checks_map.insert(
                        check.check_id.clone(),
                        PlannedCheck {
                            check_id: check.check_id.clone(),
                            display_name: check.display_name.clone(),
                            kind: check.kind,
                            scope: check.owning_scope_id.clone(),
                            reason,
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

    // 9. General fail-closed handling of incomplete verification domains
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
                            if scope_contains_path(pkg_dir, p) {
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

    // 10. Compute final assurance level
    let any_package_widened = !packages_requiring_widening.is_empty();
    let mut final_assurance =
        compute_result_assurance(impact_result.assurance, &uncertainties, false);

    if !unresolved_obligations.is_empty() {
        final_assurance = AssuranceLevel::Unverified;
    } else if !any_package_widened
        && uncertainties.is_empty()
        && impact_result.assurance == AssuranceLevel::Exact
    {
        final_assurance = AssuranceLevel::Exact;
    } else if final_assurance > AssuranceLevel::Conservative && any_package_widened {
        final_assurance = AssuranceLevel::Conservative;
    }

    let mut sorted_checks: Vec<PlannedCheck> = selected_checks_map.into_values().collect();
    sorted_checks.sort_by(|a, b| a.check_id.cmp(&b.check_id));

    // 11. Safe output bounding: never silently truncate without retaining safe enclosing obligation
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
