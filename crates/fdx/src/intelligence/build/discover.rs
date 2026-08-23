//! Static read-only workspace and configuration discovery.

use crate::intelligence::build::bounds::{
    get_active_build_limits, get_test_walker_error, BuildLimits,
};
use crate::protocol::canonicalize_repo_path;
use ignore::WalkBuilder;
use std::path::Path;

pub const MAX_DISCOVERED_PACKAGES: usize = 500;
pub const MAX_DISCOVERED_CONFIGS: usize = 2000;
pub const MAX_DISCOVERED_PNPM_WORKSPACES: usize = 100;
pub const MAX_DISCOVERED_CARGO_TOMLS: usize = 500;
pub const MAX_DISCOVERED_BUILD_RS: usize = 500;
pub const MAX_DISCOVERED_TARGETS: usize = 5000;
pub const MAX_DISCOVERED_EDGES: usize = 50000;
pub const MAX_DISCOVERED_ARTIFACTS: usize = 10000;
pub const MAX_WORKSPACE_MEMBERS: usize = 500;

#[derive(Debug, Clone, Default)]
pub struct DiscoveredFiles {
    pub package_jsons: Vec<String>,
    pub package_jsons_truncated: bool,
    pub pnpm_workspaces: Vec<String>,
    pub pnpm_workspaces_truncated: bool,
    pub tsconfigs: Vec<String>,
    pub tsconfigs_truncated: bool,
    pub cargo_tomls: Vec<String>,
    pub cargo_tomls_truncated: bool,
    pub build_rss: Vec<String>,
    pub build_rss_truncated: bool,
    pub walker_errors: Vec<String>,
}

/// Static, bounded, gitignore-aware discovery of manifest and config files using active limits.
pub fn discover_build_files(repo_root: &Path) -> DiscoveredFiles {
    let limits = get_active_build_limits();
    discover_build_files_with_limits(repo_root, &limits)
}

/// Static, bounded discovery with explicit BuildLimits.
pub fn discover_build_files_with_limits(repo_root: &Path, limits: &BuildLimits) -> DiscoveredFiles {
    let mut files = DiscoveredFiles::default();

    if let Some(err) = get_test_walker_error() {
        files.walker_errors.push(err);
    }

    let walker = WalkBuilder::new(repo_root)
        .hidden(true)
        .git_ignore(true)
        .require_git(false)
        .build();

    for res in walker {
        let entry = match res {
            Ok(e) => e,
            Err(e) => {
                files.walker_errors.push(e.to_string());
                continue;
            }
        };
        if !entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
            continue;
        }
        let path = entry.path();
        let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

        let Ok(canon) = canonicalize_repo_path(path, repo_root) else {
            files
                .walker_errors
                .push(format!("Canonicalization failed for {}", path.display()));
            continue;
        };

        if file_name == "package.json" {
            if files.package_jsons.len() < limits.packages {
                files.package_jsons.push(canon);
            } else {
                files.package_jsons_truncated = true;
            }
        } else if file_name == "pnpm-workspace.yaml" || file_name == "pnpm-workspace.yml" {
            if files.pnpm_workspaces.len() < limits.workspace_members {
                files.pnpm_workspaces.push(canon);
            } else {
                files.pnpm_workspaces_truncated = true;
            }
        } else if file_name == "tsconfig.json"
            || (file_name.starts_with("tsconfig.") && file_name.ends_with(".json"))
            || (file_name.starts_with("tsconfig-") && file_name.ends_with(".json"))
        {
            if files.tsconfigs.len() < limits.configs {
                files.tsconfigs.push(canon);
            } else {
                files.tsconfigs_truncated = true;
            }
        } else if file_name == "Cargo.toml" {
            if files.cargo_tomls.len() < limits.packages {
                files.cargo_tomls.push(canon);
            } else {
                files.cargo_tomls_truncated = true;
            }
        } else if file_name == "build.rs" {
            if files.build_rss.len() < limits.packages {
                files.build_rss.push(canon);
            } else {
                files.build_rss_truncated = true;
            }
        }
    }

    files.package_jsons.sort();
    files.pnpm_workspaces.sort();
    files.tsconfigs.sort();
    files.cargo_tomls.sort();
    files.build_rss.sort();

    files
}

#[derive(Debug, Clone, Default)]
pub struct FallbackBuildInventory {
    pub package_dirs: Vec<String>,
    pub truncated: bool,
    pub walker_errors: Vec<String>,
}

/// Bounded-safe fallback inventory for conservative widening when exact topology or discovery is incomplete.
/// Scans the repository for all candidate package, config, and build boundary directories.
pub fn discover_fallback_build_inventory(repo_root: &Path) -> FallbackBuildInventory {
    let limits = get_active_build_limits();
    discover_fallback_build_inventory_with_limits(repo_root, &limits)
}

/// Bounded-safe fallback inventory with explicit limits.
pub fn discover_fallback_build_inventory_with_limits(
    repo_root: &Path,
    limits: &BuildLimits,
) -> FallbackBuildInventory {
    let mut inventory = FallbackBuildInventory::default();

    if let Some(err) = get_test_walker_error() {
        inventory.walker_errors.push(err);
    }

    let walker = WalkBuilder::new(repo_root)
        .hidden(true)
        .git_ignore(true)
        .require_git(false)
        .build();

    for res in walker {
        let entry = match res {
            Ok(e) => e,
            Err(e) => {
                inventory.walker_errors.push(e.to_string());
                continue;
            }
        };
        if !entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
            continue;
        }
        let path = entry.path();
        let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

        if file_name == "package.json" || file_name == "Cargo.toml" {
            match canonicalize_repo_path(path, repo_root) {
                Ok(canon) => {
                    let dir = Path::new(&canon)
                        .parent()
                        .and_then(|p| p.to_str())
                        .unwrap_or(".");
                    let dir_str = if dir.is_empty() { "." } else { dir }.to_string();
                    if !inventory.package_dirs.contains(&dir_str) {
                        if inventory.package_dirs.len() < limits.fallback_inventory_entries {
                            inventory.package_dirs.push(dir_str);
                        } else {
                            inventory.truncated = true;
                        }
                    }
                }
                Err(e) => {
                    inventory.walker_errors.push(format!(
                        "Canonicalization failed for {}: {}",
                        path.display(),
                        e
                    ));
                }
            }
        }
    }

    inventory.package_dirs.sort();
    inventory
}
