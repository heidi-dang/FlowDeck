//! Static read-only workspace and configuration discovery.

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

/// Static, bounded, gitignore-aware discovery of manifest and config files.
pub fn discover_build_files(repo_root: &Path) -> DiscoveredFiles {
    let mut files = DiscoveredFiles::default();

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
            continue;
        };

        if file_name == "package.json" {
            if files.package_jsons.len() < MAX_DISCOVERED_PACKAGES {
                files.package_jsons.push(canon);
            } else {
                files.package_jsons_truncated = true;
            }
        } else if file_name == "pnpm-workspace.yaml" || file_name == "pnpm-workspace.yml" {
            if files.pnpm_workspaces.len() < MAX_DISCOVERED_PNPM_WORKSPACES {
                files.pnpm_workspaces.push(canon);
            } else {
                files.pnpm_workspaces_truncated = true;
            }
        } else if file_name == "tsconfig.json"
            || (file_name.starts_with("tsconfig.") && file_name.ends_with(".json"))
            || (file_name.starts_with("tsconfig-") && file_name.ends_with(".json"))
        {
            if files.tsconfigs.len() < MAX_DISCOVERED_CONFIGS {
                files.tsconfigs.push(canon);
            } else {
                files.tsconfigs_truncated = true;
            }
        } else if file_name == "Cargo.toml" {
            if files.cargo_tomls.len() < MAX_DISCOVERED_CARGO_TOMLS {
                files.cargo_tomls.push(canon);
            } else {
                files.cargo_tomls_truncated = true;
            }
        } else if file_name == "build.rs" {
            if files.build_rss.len() < MAX_DISCOVERED_BUILD_RS {
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
