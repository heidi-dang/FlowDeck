//! Static discovery of test files, package test targets, and verification checks.
//!
//! Strictly read-only: does not execute npm/pnpm/yarn/bun/cargo/vitest/jest or arbitrary code.

use crate::intelligence::build::discover::{
    discover_build_files, discover_fallback_build_inventory,
};
use crate::intelligence::build::snapshot::CurrentBuildSnapshot;
use crate::intelligence::testplan::bounds::{
    get_active_test_plan_limits, get_test_config_walker_error, get_test_discovery_walker_error,
};
use crate::intelligence::testplan::freshness::{analyze_test_config, TestConfigAnalysis};
use crate::intelligence::testplan::model::*;
use crate::protocol::canonicalize_repo_path;
use glob::Pattern;
use ignore::WalkBuilder;
use regex::Regex;
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::Path;

/// Derive ecosystem-aware fallback scope IDs for a relative directory.
pub fn fallback_scope_ids_for_dir(repo_root: &Path, dir: &str) -> Vec<String> {
    let clean_dir = if dir == "." { "" } else { dir };
    let path = if clean_dir.is_empty() {
        repo_root.to_path_buf()
    } else {
        repo_root.join(clean_dir)
    };

    let display_dir = if clean_dir.is_empty() { "." } else { clean_dir };
    let mut ids = Vec::new();
    if path.join("Cargo.toml").exists() {
        ids.push(format!("pkg:cargo:{}", display_dir));
    }
    if path.join("package.json").exists() {
        ids.push(format!("pkg:npm:{}", display_dir));
    }
    if ids.is_empty() {
        ids.push(format!("pkg:npm:{}", display_dir));
    }
    ids
}

fn is_js_ts_test_file(path: &Path) -> bool {
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if file_name.ends_with(".test.ts")
        || file_name.ends_with(".test.tsx")
        || file_name.ends_with(".test.js")
        || file_name.ends_with(".test.jsx")
        || file_name.ends_with(".test.mjs")
        || file_name.ends_with(".test.cjs")
        || file_name.ends_with(".spec.ts")
        || file_name.ends_with(".spec.tsx")
        || file_name.ends_with(".spec.js")
        || file_name.ends_with(".spec.jsx")
        || file_name.ends_with(".spec.mjs")
        || file_name.ends_with(".spec.cjs")
    {
        return true;
    }

    let p_str = path.to_string_lossy();
    if p_str.contains("/__tests__/") || p_str.contains("/tests/") || p_str.contains("/test/") {
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if ["ts", "tsx", "js", "jsx", "mjs", "cjs"].contains(&ext) {
            return true;
        }
    }

    false
}

fn is_rust_test_or_bench(path: &Path, content: &str) -> (bool, bool) {
    let p_str = path.to_string_lossy();
    let is_integration = (p_str.contains("/tests/") || p_str.starts_with("tests/"))
        && path.extension().and_then(|e| e.to_str()) == Some("rs");
    let is_bench = (p_str.contains("/benches/") || p_str.starts_with("benches/"))
        && path.extension().and_then(|e| e.to_str()) == Some("rs");

    if is_integration || is_bench {
        return (true, is_bench);
    }

    let has_cfg_test = content.contains("#[cfg(test)]");
    (has_cfg_test, false)
}

/// Find owning package for a canonical path.
fn resolve_owning_package_id(
    canon_path: &str,
    repo_root: &Path,
    build_snapshot: &CurrentBuildSnapshot,
    fallback_package_dirs: &[String],
    is_rust: bool,
) -> Option<String> {
    if let Some(pkgs) = build_snapshot.contains_file_to_packages.get(canon_path) {
        if is_rust {
            if let Some(cargo_pkg) = pkgs.iter().find(|p| p.starts_with("pkg:cargo:")) {
                return Some(cargo_pkg.clone());
            }
        } else if let Some(npm_pkg) = pkgs.iter().find(|p| p.starts_with("pkg:npm:")) {
            return Some(npm_pkg.clone());
        }
        if let Some(first) = pkgs.first() {
            return Some(first.clone());
        }
    }

    // Match against fallback package directories (longest prefix match)
    let mut best_match: Option<&str> = None;
    for pkg_dir in fallback_package_dirs {
        if pkg_dir == "." || pkg_dir.is_empty() {
            if best_match.is_none() {
                best_match = Some(pkg_dir);
            }
        } else if canon_path.starts_with(pkg_dir) {
            let is_boundary = canon_path.as_bytes().get(pkg_dir.len()) == Some(&b'/');
            if is_boundary {
                if let Some(curr) = best_match {
                    if pkg_dir.len() > curr.len() {
                        best_match = Some(pkg_dir);
                    }
                } else {
                    best_match = Some(pkg_dir);
                }
            }
        }
    }

    if let Some(d) = best_match {
        let scopes = fallback_scope_ids_for_dir(repo_root, d);
        if is_rust {
            if let Some(cargo_scope) = scopes.iter().find(|s| s.starts_with("pkg:cargo:")) {
                return Some(cargo_scope.clone());
            }
        } else if let Some(npm_scope) = scopes.iter().find(|s| s.starts_with("pkg:npm:")) {
            return Some(npm_scope.clone());
        }
        if let Some(first) = scopes.first() {
            return Some(first.clone());
        }
    }

    // Check enclosing directories for package.json / Cargo.toml
    let mut curr = Path::new(canon_path).parent();
    while let Some(parent) = curr {
        let parent_str = parent.to_string_lossy().to_string();
        if parent_str.is_empty() {
            break;
        }
        if is_rust && repo_root.join(parent).join("Cargo.toml").exists() {
            return Some(format!("pkg:cargo:{}", parent_str));
        }
        if !is_rust && repo_root.join(parent).join("package.json").exists() {
            return Some(format!("pkg:npm:{}", parent_str));
        }
        if repo_root.join(parent).join("package.json").exists() {
            return Some(format!("pkg:npm:{}", parent_str));
        }
        if repo_root.join(parent).join("Cargo.toml").exists() {
            return Some(format!("pkg:cargo:{}", parent_str));
        }
        curr = parent.parent();
    }

    None
}

/// Single-pass static discovery of tests, checks, configs, and fallback boundaries.
pub fn discover_tests_and_checks(repo_root: &Path) -> TestInventory {
    let limits = get_active_test_plan_limits();
    let mut inventory = TestInventory::default();
    let mut issues = Vec::new();
    let mut seen_tests = HashSet::new();
    let mut seen_checks = HashSet::new();

    if let Some(err) = get_test_discovery_walker_error() {
        issues.push(TestDiscoveryIssue {
            kind: "walker_error".to_string(),
            path: None,
            message: err,
        });
    }
    if let Some(err) = get_test_config_walker_error() {
        issues.push(TestDiscoveryIssue {
            kind: "config_walker_error".to_string(),
            path: None,
            message: err,
        });
    }

    let build_snapshot = CurrentBuildSnapshot::build(repo_root);
    let fallback_build_inv = discover_fallback_build_inventory(repo_root);

    // 1. Single unified config discovery pass
    let mut static_custom_patterns: Vec<(String, Pattern)> = Vec::new();
    let mut static_custom_regexes: Vec<(String, Regex)> = Vec::new();
    let mut configured_roots: Vec<(String, String)> = Vec::new();

    let config_file_candidates = [
        "vitest.config.ts",
        "vitest.config.js",
        "vitest.config.mts",
        "vitest.config.mjs",
        "vitest.config.cjs",
        "vite.config.ts",
        "vite.config.js",
        "jest.config.ts",
        "jest.config.js",
        "jest.config.json",
        "jest.config.mjs",
        "jest.config.cjs",
    ];

    let config_walker = WalkBuilder::new(repo_root)
        .hidden(true)
        .git_ignore(true)
        .require_git(false)
        .build();

    for res in config_walker {
        let entry = match res {
            Ok(e) => e,
            Err(err) => {
                issues.push(TestDiscoveryIssue {
                    kind: "config_walker_error".to_string(),
                    path: None,
                    message: err.to_string(),
                });
                continue;
            }
        };
        if !entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
            continue;
        }
        let path = entry.path();
        let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

        if config_file_candidates.contains(&file_name) {
            let canon = match canonicalize_repo_path(path, repo_root) {
                Ok(c) => c,
                Err(err) => {
                    issues.push(TestDiscoveryIssue {
                        kind: "config_canonicalization_error".to_string(),
                        path: Some(path.to_string_lossy().to_string()),
                        message: err.to_string(),
                    });
                    continue;
                }
            };

            match fs::read_to_string(path) {
                Ok(content) => match analyze_test_config(path, &content) {
                    TestConfigAnalysis::Static(cfg) => {
                        let cfg_dir = Path::new(&canon)
                            .parent()
                            .map(|p| p.to_string_lossy().to_string())
                            .unwrap_or_default();

                        for root_str in cfg.test_roots {
                            let clean_root = root_str.trim_start_matches("<rootDir>/");
                            let combined = if cfg_dir.is_empty() || cfg_dir == "." {
                                clean_root.to_string()
                            } else {
                                format!("{}/{}", cfg_dir, clean_root)
                            };
                            configured_roots.push((canon.clone(), combined));
                        }

                        for pat_str in cfg.include_patterns {
                            let clean_pat = pat_str.trim_start_matches("<rootDir>/");
                            if let Ok(glob_pat) = Pattern::new(clean_pat) {
                                static_custom_patterns.push((cfg_dir.clone(), glob_pat));
                            }
                            if !cfg_dir.is_empty() && cfg_dir != "." {
                                let combined = format!("{}/{}", cfg_dir, clean_pat);
                                if let Ok(glob_pat) = Pattern::new(&combined) {
                                    static_custom_patterns.push((cfg_dir.clone(), glob_pat));
                                }
                            }
                        }

                        for reg_str in cfg.test_regex_patterns {
                            if let Ok(re) = Regex::new(&reg_str) {
                                static_custom_regexes.push((cfg_dir.clone(), re));
                            }
                        }
                    }
                    TestConfigAnalysis::Dynamic { reason, .. } => {
                        issues.push(TestDiscoveryIssue {
                            kind: "dynamic_config".to_string(),
                            path: Some(canon.clone()),
                            message: reason,
                        });
                    }
                    TestConfigAnalysis::Unsupported { reason, .. } => {
                        issues.push(TestDiscoveryIssue {
                            kind: "unsupported_config".to_string(),
                            path: Some(canon.clone()),
                            message: reason,
                        });
                    }
                    TestConfigAnalysis::Unparseable { reason, .. } => {
                        issues.push(TestDiscoveryIssue {
                            kind: "unparseable_config".to_string(),
                            path: Some(canon.clone()),
                            message: reason,
                        });
                    }
                },
                Err(err) => {
                    issues.push(TestDiscoveryIssue {
                        kind: "config_read_error".to_string(),
                        path: Some(canon.clone()),
                        message: err.to_string(),
                    });
                }
            }
        }
    }

    // 2. Discover package checks from manifests
    let build_files = discover_build_files(repo_root);

    for pkg_json_path in &build_files.package_jsons {
        let full = repo_root.join(pkg_json_path);
        let content = match fs::read_to_string(&full) {
            Ok(c) => c,
            Err(err) => {
                issues.push(TestDiscoveryIssue {
                    kind: "read_error".to_string(),
                    path: Some(pkg_json_path.clone()),
                    message: err.to_string(),
                });
                continue;
            }
        };
        let val = match serde_json::from_str::<Value>(&content) {
            Ok(v) => v,
            Err(err) => {
                issues.push(TestDiscoveryIssue {
                    kind: "parse_error".to_string(),
                    path: Some(pkg_json_path.clone()),
                    message: err.to_string(),
                });
                continue;
            }
        };

        let pkg_dir = Path::new(pkg_json_path).parent().unwrap_or(Path::new(""));
        let pkg_dir_str = pkg_dir.to_string_lossy();
        let pkg_id = format!(
            "pkg:npm:{}",
            if pkg_dir_str.is_empty() {
                "."
            } else {
                &pkg_dir_str
            }
        );

        if let Some(scripts) = val.get("scripts").and_then(|s| s.as_object()) {
            for (script_name, script_cmd) in scripts {
                let script_cmd_str = script_cmd.as_str().map(|s| s.to_string());
                let (check_kind, matches_known) = match script_name.as_str() {
                    "test" | "test:unit" => (VerificationCheckKind::UnitTest, true),
                    "test:integration" => (VerificationCheckKind::IntegrationTest, true),
                    "test:e2e" => (VerificationCheckKind::EndToEndTest, true),
                    "typecheck" | "check" | "types" => (VerificationCheckKind::Typecheck, true),
                    "lint" => (VerificationCheckKind::Lint, true),
                    "build" => (VerificationCheckKind::Build, true),
                    "format" | "fmt" => (VerificationCheckKind::Format, true),
                    _ => (VerificationCheckKind::Custom, false),
                };

                if matches_known {
                    let check_id = format!("check:{}:{}", pkg_id, script_name);
                    if seen_checks.insert(check_id.clone()) {
                        inventory.checks.push(DiscoveredCheck {
                            check_id,
                            display_name: format!("{} ({})", script_name, pkg_id),
                            owning_scope_id: pkg_id.clone(),
                            kind: check_kind,
                            command_or_script: script_cmd_str,
                        });
                    }
                }
            }
        }
    }

    for cargo_path in &build_files.cargo_tomls {
        let full = repo_root.join(cargo_path);
        if let Err(err) = fs::read_to_string(&full) {
            issues.push(TestDiscoveryIssue {
                kind: "read_error".to_string(),
                path: Some(cargo_path.clone()),
                message: err.to_string(),
            });
            continue;
        }

        let pkg_dir = Path::new(cargo_path).parent().unwrap_or(Path::new(""));
        let pkg_dir_str = pkg_dir.to_string_lossy();
        let pkg_id = format!(
            "pkg:cargo:{}",
            if pkg_dir_str.is_empty() {
                "."
            } else {
                &pkg_dir_str
            }
        );

        let standard_cargo_checks = [
            ("test", VerificationCheckKind::UnitTest, "cargo test"),
            ("check", VerificationCheckKind::Typecheck, "cargo check"),
            ("clippy", VerificationCheckKind::Lint, "cargo clippy"),
        ];

        for (name, kind, cmd) in standard_cargo_checks {
            let check_id = format!("check:{}:{}", pkg_id, name);
            if seen_checks.insert(check_id.clone()) {
                inventory.checks.push(DiscoveredCheck {
                    check_id,
                    display_name: format!("cargo {} ({})", name, pkg_id),
                    owning_scope_id: pkg_id.clone(),
                    kind,
                    command_or_script: Some(cmd.to_string()),
                });
            }
        }
    }

    // 3. Walk directory tree for concrete test files AND independent fallback boundaries in parallel
    let mut fallback = FallbackTestInventory::default();
    let mut fallback_seen = HashSet::new();

    for check in &inventory.checks {
        if check.kind == VerificationCheckKind::UnitTest
            || check.kind == VerificationCheckKind::IntegrationTest
            || check.kind == VerificationCheckKind::EndToEndTest
        {
            if fallback.package_test_scopes.len() < limits.max_fallback_boundaries {
                if fallback_seen.insert(check.owning_scope_id.clone()) {
                    fallback
                        .package_test_scopes
                        .push(check.owning_scope_id.clone());
                }
            } else {
                fallback.truncated = true;
            }
        }
    }

    for (_, root_dir) in &configured_roots {
        let root_scope = format!("dir:{}", root_dir);
        if fallback.directory_test_scopes.len() < limits.max_fallback_boundaries {
            if fallback_seen.insert(root_scope.clone()) {
                fallback.directory_test_scopes.push(root_scope);
            }
        } else {
            fallback.truncated = true;
        }
    }

    let walker = WalkBuilder::new(repo_root)
        .hidden(true)
        .git_ignore(true)
        .require_git(false)
        .sort_by_file_path(|a, b| a.cmp(b))
        .build();

    for res in walker {
        let entry = match res {
            Ok(e) => e,
            Err(err) => {
                issues.push(TestDiscoveryIssue {
                    kind: "walker_error".to_string(),
                    path: None,
                    message: err.to_string(),
                });
                continue;
            }
        };
        if !entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
            continue;
        }
        let path = entry.path();
        let canon = match canonicalize_repo_path(path, repo_root) {
            Ok(c) => c,
            Err(err) => {
                issues.push(TestDiscoveryIssue {
                    kind: "canonicalization_error".to_string(),
                    path: Some(path.to_string_lossy().to_string()),
                    message: err.to_string(),
                });
                continue;
            }
        };

        if canon.starts_with(".git/")
            || canon.starts_with(".fdx/")
            || canon.starts_with("node_modules/")
            || canon.starts_with("target/")
        {
            continue;
        }

        // Test file detection
        let mut is_jsts_test = is_js_ts_test_file(path);
        if !is_jsts_test {
            for (cfg_dir, pat) in &static_custom_patterns {
                if pat.matches(&canon) {
                    is_jsts_test = true;
                    break;
                }
                if !cfg_dir.is_empty() && cfg_dir != "." {
                    if let Some(rel) = canon.strip_prefix(cfg_dir.as_str()) {
                        let rel_clean = rel.trim_start_matches('/');
                        if pat.matches(rel_clean) {
                            is_jsts_test = true;
                            break;
                        }
                    }
                }
            }
        }
        if !is_jsts_test {
            for (cfg_dir, re) in &static_custom_regexes {
                if re.is_match(&canon) {
                    is_jsts_test = true;
                    break;
                }
                if !cfg_dir.is_empty() && cfg_dir != "." {
                    if let Some(rel) = canon.strip_prefix(cfg_dir.as_str()) {
                        let rel_clean = rel.trim_start_matches('/');
                        if re.is_match(rel_clean) {
                            is_jsts_test = true;
                            break;
                        }
                    }
                }
            }
        }

        let mut is_rs_test = false;
        let mut is_bench = false;

        if path.extension().and_then(|e| e.to_str()) == Some("rs") {
            match fs::read_to_string(path) {
                Ok(content) => {
                    let (rs_test, rs_bench) = is_rust_test_or_bench(path, &content);
                    is_rs_test = rs_test;
                    is_bench = rs_bench;
                }
                Err(err) => {
                    issues.push(TestDiscoveryIssue {
                        kind: "read_error".to_string(),
                        path: Some(canon.clone()),
                        message: err.to_string(),
                    });
                }
            }
        }

        if is_jsts_test || is_rs_test {
            let owning_package_id = resolve_owning_package_id(
                &canon,
                repo_root,
                &build_snapshot,
                &fallback_build_inv.package_dirs,
                is_rs_test,
            );

            // Independent fallback collection (does NOT stop when exact test enumeration truncates)
            if let Some(ref pkg_id) = owning_package_id {
                if fallback.package_test_scopes.len() < limits.max_fallback_boundaries {
                    if fallback_seen.insert(pkg_id.clone()) {
                        fallback.package_test_scopes.push(pkg_id.clone());
                    }
                } else {
                    fallback.truncated = true;
                }
            }

            if let Some(parent) = Path::new(&canon).parent() {
                let parent_str = parent.to_string_lossy().to_string();
                if !parent_str.is_empty() {
                    let dir_scope = format!("dir:{}", parent_str);
                    if fallback.directory_test_scopes.len() < limits.max_fallback_boundaries {
                        if fallback_seen.insert(dir_scope.clone()) {
                            fallback.directory_test_scopes.push(dir_scope);
                        }
                    } else {
                        fallback.truncated = true;
                    }
                }
            }

            // Exact test enumeration (bounded by max_discovered_tests)
            if inventory.tests.len() < limits.max_discovered_tests {
                let ecosystem = if is_rs_test { "cargo" } else { "npm" };
                let stable_id = format!("test:{}:{}", ecosystem, canon);

                if seen_tests.insert(stable_id.clone()) {
                    let kind = if is_bench {
                        VerificationCheckKind::Custom
                    } else if canon.contains("/e2e/")
                        || canon.contains("/e2e.")
                        || canon.contains(".e2e.")
                    {
                        VerificationCheckKind::EndToEndTest
                    } else if canon.contains("/tests/") || canon.contains("tests/") {
                        VerificationCheckKind::IntegrationTest
                    } else {
                        VerificationCheckKind::UnitTest
                    };

                    inventory.tests.push(DiscoveredTest {
                        stable_id,
                        canonical_path: canon,
                        owning_package_id,
                        kind,
                    });
                }
            } else {
                inventory.truncated = true;
            }
        }
    }

    fallback.errors = issues.clone();
    inventory.fallback = fallback;

    if issues.is_empty() {
        inventory.state = DiscoveryState::Complete;
    } else {
        inventory.state = DiscoveryState::Incomplete { issues };
    }

    inventory
}
