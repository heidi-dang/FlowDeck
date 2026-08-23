//! Static discovery of test files, package test targets, and verification checks.
//!
//! Strictly read-only: does not execute npm/pnpm/yarn/bun/cargo/vitest/jest or arbitrary code.

use crate::intelligence::build::discover::discover_build_files;
use crate::intelligence::build::snapshot::CurrentBuildSnapshot;
use crate::intelligence::testplan::bounds::get_active_test_plan_limits;
use crate::intelligence::testplan::model::*;
use crate::protocol::canonicalize_repo_path;
use ignore::WalkBuilder;
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::Path;

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

    // Check for inline #[cfg(test)] statically without executing rustc
    let has_cfg_test = content.contains("#[cfg(test)]");
    (has_cfg_test, false)
}

/// Discover tests and checks across the repository.
pub fn discover_tests_and_checks(repo_root: &Path) -> TestInventory {
    let limits = get_active_test_plan_limits();
    let mut inventory = TestInventory::default();
    let mut seen_tests = HashSet::new();
    let mut seen_checks = HashSet::new();

    let build_snapshot = CurrentBuildSnapshot::build(repo_root);

    // 1. Walk directory tree for test files
    let walker = WalkBuilder::new(repo_root)
        .hidden(true)
        .git_ignore(true)
        .require_git(false)
        .sort_by_file_path(|a, b| a.cmp(b))
        .build();

    for res in walker {
        let Ok(entry) = res else { continue };
        if !entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
            continue;
        }
        let path = entry.path();
        let Ok(canon) = canonicalize_repo_path(path, repo_root) else {
            continue;
        };

        if canon.starts_with(".git/")
            || canon.starts_with(".fdx/")
            || canon.starts_with("node_modules/")
            || canon.starts_with("target/")
        {
            continue;
        }

        let is_jsts_test = is_js_ts_test_file(path);
        let mut is_rs_test = false;
        let mut is_bench = false;

        if path.extension().and_then(|e| e.to_str()) == Some("rs") {
            let content = fs::read_to_string(path).unwrap_or_default();
            let (rs_test, rs_bench) = is_rust_test_or_bench(path, &content);
            is_rs_test = rs_test;
            is_bench = rs_bench;
        }

        if is_jsts_test || is_rs_test {
            if inventory.tests.len() >= limits.max_discovered_tests {
                inventory.truncated = true;
                break;
            }

            // Find owning package
            let owning_package_id = build_snapshot
                .contains_file_to_packages
                .get(&canon)
                .and_then(|pkgs| pkgs.first().cloned());

            let ecosystem = if is_rs_test { "cargo" } else { "npm" };
            let stable_id = format!("test:{}:{}", ecosystem, canon);

            if seen_tests.insert(stable_id.clone()) {
                let kind = if is_bench {
                    VerificationCheckKind::Custom
                } else if canon.contains("/e2e/") || canon.contains("/e2e.") {
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
        }
    }

    // 2. Discover package checks from package.json & Cargo.toml
    let build_files = discover_build_files(repo_root);

    for pkg_json_path in build_files.package_jsons {
        let full = repo_root.join(&pkg_json_path);
        let Ok(content) = fs::read_to_string(&full) else {
            continue;
        };
        let Ok(val) = serde_json::from_str::<Value>(&content) else {
            continue;
        };

        let pkg_dir = Path::new(&pkg_json_path).parent().unwrap_or(Path::new(""));
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

    for cargo_path in build_files.cargo_tomls {
        let pkg_dir = Path::new(&cargo_path).parent().unwrap_or(Path::new(""));
        let pkg_dir_str = pkg_dir.to_string_lossy();
        let pkg_id = format!(
            "pkg:cargo:{}",
            if pkg_dir_str.is_empty() {
                "."
            } else {
                &pkg_dir_str
            }
        );

        // Add standard cargo package verification checks: test, typecheck (cargo check), lint (cargo clippy)
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

    inventory
}
