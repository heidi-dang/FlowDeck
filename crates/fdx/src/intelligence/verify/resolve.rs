//! Verification check resolution and path containment.
//!
//! Resolves abstract PlannedChecks into ExecutionActions while enforcing:
//! 1. Deterministic package manager detection (fails closed on ambiguity).
//! 2. Strict CWD repository containment (rejects directory escapes and symlink escapes).
//! 3. Static verification action validation (never executes arbitrary display strings).

use crate::intelligence::testplan::model::PlannedCheck;
use crate::intelligence::verify::action::ExecutionAction;
use std::path::{Path, PathBuf};

/// Package manager detection outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PackageManagerResolution {
    Resolved(String),
    Ambiguous(Vec<String>),
    Missing,
}

/// Detect the active Node/JS package manager from static repository evidence.
pub fn detect_package_manager(repo_root: &Path) -> PackageManagerResolution {
    // 1. Check package.json packageManager field in root
    let root_pkg_json = repo_root.join("package.json");
    if root_pkg_json.exists() {
        if let Ok(content) = std::fs::read_to_string(&root_pkg_json) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(pm_field) = val.get("packageManager").and_then(|v| v.as_str()) {
                    let pm_name = pm_field.split('@').next().unwrap_or("").trim();
                    if ["npm", "pnpm", "yarn", "bun"].contains(&pm_name) {
                        return PackageManagerResolution::Resolved(pm_name.to_string());
                    }
                }
            }
        }
    }

    // 2. Inspect lockfiles
    let mut detected = Vec::new();
    if repo_root.join("pnpm-lock.yaml").exists() {
        detected.push("pnpm".to_string());
    }
    if repo_root.join("yarn.lock").exists() {
        detected.push("yarn".to_string());
    }
    if repo_root.join("bun.lock").exists() || repo_root.join("bun.lockb").exists() {
        detected.push("bun".to_string());
    }
    if repo_root.join("package-lock.json").exists() {
        detected.push("npm".to_string());
    }

    match detected.len() {
        0 => {
            if root_pkg_json.exists() {
                PackageManagerResolution::Resolved("npm".to_string())
            } else {
                PackageManagerResolution::Missing
            }
        }
        1 => PackageManagerResolution::Resolved(detected.pop().unwrap()),
        _ => PackageManagerResolution::Ambiguous(detected),
    }
}

/// Validate that a path is strictly contained within the canonical repository root.
pub fn validate_and_contain_path(repo_root: &Path, target: &Path) -> Result<PathBuf, String> {
    let canonical_root = std::fs::canonicalize(repo_root)
        .map_err(|e| format!("cannot canonicalize repo root: {}", e))?;

    let abs_target = if target.is_absolute() {
        target.to_path_buf()
    } else {
        repo_root.join(target)
    };

    let canonical_target = match std::fs::canonicalize(&abs_target) {
        Ok(p) => p,
        Err(_) => {
            // If the path doesn't exist yet, normalize parent
            let mut normalized = PathBuf::new();
            for comp in abs_target.components() {
                match comp {
                    std::path::Component::ParentDir => {
                        if !normalized.pop() {
                            return Err(format!("path escapes repository root: {:?}", target));
                        }
                    }
                    std::path::Component::Normal(c) => normalized.push(c),
                    std::path::Component::RootDir => normalized.push(std::path::Component::RootDir),
                    std::path::Component::Prefix(p) => {
                        normalized.push(std::path::Component::Prefix(p))
                    }
                    std::path::Component::CurDir => {}
                }
            }
            normalized
        }
    };

    if !canonical_target.starts_with(&canonical_root) {
        return Err(format!(
            "path {:?} escapes repository root {:?}",
            canonical_target, canonical_root
        ));
    }

    Ok(canonical_target)
}

/// Parse a Cargo package name from a package directory.
fn parse_cargo_package_name(pkg_dir: &Path) -> Option<String> {
    let cargo_toml = pkg_dir.join("Cargo.toml");
    if !cargo_toml.exists() {
        return None;
    }
    let content = std::fs::read_to_string(&cargo_toml).ok()?;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("name") && trimmed.contains('=') {
            let mut parts = trimmed.splitn(2, '=');
            parts.next();
            if let Some(val) = parts.next() {
                let name = val.trim().trim_matches('"').trim_matches('\'').trim();
                if !name.is_empty() {
                    return Some(name.to_string());
                }
            }
        }
    }
    None
}

/// Resolve a PlannedCheck into an executable ExecutionAction.
pub fn resolve_check_action(repo_root: &Path, check: &PlannedCheck) -> ExecutionAction {
    let check_id = &check.check_id;

    // 1. check:pkg:npm:<pkg_dir>:<script>
    if let Some(rest) = check_id.strip_prefix("check:pkg:npm:") {
        let parts: Vec<&str> = rest.split(':').collect();
        if parts.len() == 2 {
            let pkg_rel = parts[0];
            let script_name = parts[1];
            let pkg_dir = if pkg_rel == "." || pkg_rel.is_empty() {
                PathBuf::from(".")
            } else {
                PathBuf::from(pkg_rel)
            };

            // Path containment validation
            if let Err(err) = validate_and_contain_path(repo_root, &pkg_dir) {
                return ExecutionAction::Unsupported {
                    check_id: check_id.clone(),
                    reason: err,
                };
            }

            match detect_package_manager(repo_root) {
                PackageManagerResolution::Resolved(pm) => ExecutionAction::NpmRunScript {
                    pkg_dir,
                    script_name: script_name.to_string(),
                    package_manager: pm,
                },
                PackageManagerResolution::Ambiguous(pms) => ExecutionAction::Unsupported {
                    check_id: check_id.clone(),
                    reason: format!("ambiguous package manager detection: {:?}", pms),
                },
                PackageManagerResolution::Missing => ExecutionAction::Unsupported {
                    check_id: check_id.clone(),
                    reason: "no Node package manager found for package script".to_string(),
                },
            }
        } else {
            ExecutionAction::Unsupported {
                check_id: check_id.clone(),
                reason: format!("malformed npm check id format: {}", check_id),
            }
        }
    }
    // 2. check:pkg:cargo:<pkg_dir>:<script>
    else if let Some(rest) = check_id.strip_prefix("check:pkg:cargo:") {
        let parts: Vec<&str> = rest.split(':').collect();
        if parts.len() == 2 {
            let pkg_rel = parts[0];
            let script_name = parts[1];
            let pkg_dir = if pkg_rel == "." || pkg_rel.is_empty() {
                PathBuf::from(".")
            } else {
                PathBuf::from(pkg_rel)
            };

            // Path containment validation
            if let Err(err) = validate_and_contain_path(repo_root, &pkg_dir) {
                return ExecutionAction::Unsupported {
                    check_id: check_id.clone(),
                    reason: err,
                };
            }

            let abs_pkg_dir = if pkg_dir == Path::new(".") {
                repo_root.to_path_buf()
            } else {
                repo_root.join(&pkg_dir)
            };
            let package_name = parse_cargo_package_name(&abs_pkg_dir);

            match script_name {
                "test" => ExecutionAction::CargoTestPackage {
                    pkg_dir,
                    package_name,
                },
                "check" => ExecutionAction::CargoCheckPackage {
                    pkg_dir,
                    package_name,
                },
                "clippy" => ExecutionAction::CargoClippyPackage {
                    pkg_dir,
                    package_name,
                },
                "build" => ExecutionAction::CargoBuildPackage {
                    pkg_dir,
                    package_name,
                },
                _ => ExecutionAction::Unsupported {
                    check_id: check_id.clone(),
                    reason: format!("unsupported cargo check script: {}", script_name),
                },
            }
        } else {
            ExecutionAction::Unsupported {
                check_id: check_id.clone(),
                reason: format!("malformed cargo check id format: {}", check_id),
            }
        }
    }
    // 3. test:npm:<file_path>
    else if let Some(rel_path) = check_id.strip_prefix("test:npm:") {
        let test_path = PathBuf::from(rel_path);
        // Find owning directory/package
        let pkg_dir = if let Some(parent) = test_path.parent() {
            // If parent contains package.json or is within a package dir
            let mut cur = parent.to_path_buf();
            while !cur.as_os_str().is_empty() && cur != Path::new(".") {
                if repo_root.join(&cur).join("package.json").exists() {
                    break;
                }
                cur = cur.parent().unwrap_or(Path::new("")).to_path_buf();
            }
            if cur.as_os_str().is_empty() {
                PathBuf::from(".")
            } else {
                cur
            }
        } else {
            PathBuf::from(".")
        };

        if let Err(err) = validate_and_contain_path(repo_root, &pkg_dir) {
            return ExecutionAction::Unsupported {
                check_id: check_id.clone(),
                reason: err,
            };
        }

        match detect_package_manager(repo_root) {
            PackageManagerResolution::Resolved(pm) => ExecutionAction::NpmRunTestFile {
                pkg_dir,
                test_file_rel: rel_path.to_string(),
                package_manager: pm,
            },
            PackageManagerResolution::Ambiguous(pms) => ExecutionAction::Unsupported {
                check_id: check_id.clone(),
                reason: format!("ambiguous package manager detection: {:?}", pms),
            },
            PackageManagerResolution::Missing => ExecutionAction::Unsupported {
                check_id: check_id.clone(),
                reason: "no Node package manager found for test file".to_string(),
            },
        }
    }
    // 4. test:cargo:<target>
    else if let Some(rel_path) = check_id.strip_prefix("test:cargo:") {
        let test_path = PathBuf::from(rel_path);
        let test_name = test_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(rel_path);

        let pkg_dir = if let Some(parent) = test_path.parent() {
            let mut cur = parent.to_path_buf();
            while !cur.as_os_str().is_empty() && cur != Path::new(".") {
                if repo_root.join(&cur).join("Cargo.toml").exists() {
                    break;
                }
                cur = cur.parent().unwrap_or(Path::new("")).to_path_buf();
            }
            if cur.as_os_str().is_empty() {
                PathBuf::from(".")
            } else {
                cur
            }
        } else {
            PathBuf::from(".")
        };

        if let Err(err) = validate_and_contain_path(repo_root, &pkg_dir) {
            return ExecutionAction::Unsupported {
                check_id: check_id.clone(),
                reason: err,
            };
        }

        let abs_pkg_dir = if pkg_dir == Path::new(".") {
            repo_root.to_path_buf()
        } else {
            repo_root.join(&pkg_dir)
        };
        let package_name = parse_cargo_package_name(&abs_pkg_dir);

        ExecutionAction::CargoTestTarget {
            pkg_dir,
            package_name,
            test_target: test_name.to_string(),
        }
    }
    // 5. Any other or custom check
    else {
        ExecutionAction::Unsupported {
            check_id: check_id.clone(),
            reason: format!("unsupported or non-executable check format: {}", check_id),
        }
    }
}
