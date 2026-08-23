//! Static parser and provider for package.json and npm/pnpm/yarn/bun workspaces.

use crate::intelligence::build::bounds::{get_active_build_limits, BuildBoundsCollector};
use crate::intelligence::build::discover::discover_build_files;
use crate::intelligence::build::model::*;
use crate::intelligence::build::provider::{
    hash_files, BuildConfigProvider, BuildIngestResult, BuildProviderScope, ProviderDetection,
};
use crate::intelligence::build::scope::UncertaintyScope;
use crate::intelligence::build::uncertainty::BuildUncertainty;
use crate::protocol::{
    canonicalize_repo_path, AssuranceLevel, EdgeKind, EvidenceStrength, NodeKind,
};
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;

pub const PACKAGE_JSON_PROVIDER_ID: &str = "builtin-package-json";
pub const PACKAGE_JSON_PROVIDER_VERSION: &str = "1.0.0";

pub struct PackageJsonProvider;

impl PackageJsonProvider {
    pub fn new() -> Self {
        Self
    }
}

impl Default for PackageJsonProvider {
    fn default() -> Self {
        Self::new()
    }
}

pub fn parse_pnpm_workspace_packages(content: &str) -> Result<Vec<String>, String> {
    let val: serde_yaml::Value = serde_yaml::from_str(content)
        .map_err(|e| format!("pnpm-workspace.yaml parse error: {}", e))?;

    let mut patterns = Vec::new();
    if let Some(pkgs) = val.get("packages") {
        if let Some(seq) = pkgs.as_sequence() {
            for item in seq {
                if let Some(s) = item.as_str() {
                    patterns.push(s.to_string());
                }
            }
        } else {
            return Err("packages field in pnpm-workspace.yaml is not a sequence".to_string());
        }
    }
    Ok(patterns)
}

pub fn matches_workspace_pattern(dir: &str, patterns: &[String]) -> Result<bool, String> {
    if patterns.is_empty() {
        return Ok(false);
    }
    let mut matched = false;
    for pat in patterns {
        let is_negated = pat.starts_with('!');
        let clean_pat = if is_negated { &pat[1..] } else { pat.as_str() };
        let glob_pat = glob::Pattern::new(clean_pat).map_err(|e| e.to_string())?;
        if glob_pat.matches(dir) {
            if is_negated {
                return Ok(false);
            } else {
                matched = true;
            }
        }
    }
    Ok(matched)
}

fn find_package_owned_files(
    repo_root: &Path,
    package_dirs: &[String],
) -> HashMap<String, Vec<String>> {
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    for d in package_dirs {
        map.insert(d.clone(), Vec::new());
    }

    let mut sorted_dirs = package_dirs.to_vec();
    sorted_dirs.sort_by_key(|d| std::cmp::Reverse(d.len()));

    let walker = ignore::WalkBuilder::new(repo_root)
        .hidden(true)
        .git_ignore(true)
        .require_git(false)
        .build();

    for res in walker {
        let Ok(entry) = res else { continue };
        if !entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
            continue;
        }
        let Ok(canon) = canonicalize_repo_path(entry.path(), repo_root) else {
            continue;
        };

        for pdir in &sorted_dirs {
            let is_match = pdir == "."
                || canon == *pdir
                || (canon.starts_with(pdir) && canon.as_bytes().get(pdir.len()) == Some(&b'/'));

            if is_match {
                if let Some(list) = map.get_mut(pdir) {
                    list.push(canon);
                }
                break;
            }
        }
    }

    map
}

impl BuildConfigProvider for PackageJsonProvider {
    fn id(&self) -> &'static str {
        PACKAGE_JSON_PROVIDER_ID
    }

    fn detect_state(&self, repo_root: &Path) -> ProviderDetection {
        let files = discover_build_files(repo_root);
        if !files.walker_errors.is_empty() {
            return ProviderDetection::Indeterminate(format!(
                "Discovery walker errors: {}",
                files.walker_errors.join("; ")
            ));
        }
        if !files.package_jsons.is_empty() || !files.pnpm_workspaces.is_empty() {
            ProviderDetection::Present
        } else {
            ProviderDetection::Absent
        }
    }

    fn scope(&self, repo_root: &Path) -> BuildProviderScope {
        let files = discover_build_files(repo_root);
        let mut manifest_files = files.package_jsons;
        manifest_files.extend(files.pnpm_workspaces);
        manifest_files.sort();
        manifest_files.dedup();

        BuildProviderScope {
            workspace_root: ".".to_string(),
            manifest_files,
        }
    }

    fn passive_fingerprint(&self, repo_root: &Path) -> Result<String, String> {
        let scope = self.scope(repo_root);
        Ok(hash_files(
            repo_root,
            &scope.manifest_files,
            PACKAGE_JSON_PROVIDER_VERSION,
        ))
    }

    fn ingest(&self, repo_root: &Path) -> Result<BuildIngestResult, String> {
        let limits = get_active_build_limits();
        let files = discover_build_files(repo_root);
        let mut bounds = BuildBoundsCollector::default();

        let mut manifest_files = files.package_jsons.clone();
        manifest_files.extend(files.pnpm_workspaces.clone());
        manifest_files.sort();
        manifest_files.dedup();

        let global_fingerprint =
            hash_files(repo_root, &manifest_files, PACKAGE_JSON_PROVIDER_VERSION);

        let mut res = BuildIngestResult {
            fingerprint: global_fingerprint.clone(),
            ..Default::default()
        };

        if files.package_jsons_truncated
            || files.pnpm_workspaces_truncated
            || !files.walker_errors.is_empty()
        {
            res.uncertainties.push(BuildUncertainty::new(
                "build_limit_reached",
                UncertaintyScope::Repository,
                PACKAGE_JSON_PROVIDER_ID,
                format!(
                    "Discovery limits reached or walker errors encountered (package.json limit {}, pnpm limit {})",
                    limits.packages, limits.workspace_members
                ),
                AssuranceLevel::Degraded,
                true,
            ));
        }

        // Check root workspace
        let mut workspace_patterns: Vec<String> = Vec::new();
        let mut root_workspace_manifests: Vec<String> = Vec::new();

        // 1. Check pnpm-workspace.yaml
        for pnpm_file in &files.pnpm_workspaces {
            let full = repo_root.join(pnpm_file);
            match std::fs::read_to_string(&full) {
                Ok(content) => match parse_pnpm_workspace_packages(&content) {
                    Ok(pats) => {
                        workspace_patterns.extend(pats);
                        root_workspace_manifests.push(pnpm_file.clone());
                    }
                    Err(e) => {
                        res.uncertainties.push(BuildUncertainty::new(
                            "malformed_config",
                            UncertaintyScope::Workspace("workspace:npm:.".to_string()),
                            PACKAGE_JSON_PROVIDER_ID,
                            format!("Malformed {}: {}", pnpm_file, e),
                            AssuranceLevel::Degraded,
                            true,
                        ));
                    }
                },
                Err(e) => {
                    res.uncertainties.push(BuildUncertainty::new(
                        "package_read_error",
                        UncertaintyScope::Workspace("workspace:npm:.".to_string()),
                        PACKAGE_JSON_PROVIDER_ID,
                        format!("Failed to read {}: {}", pnpm_file, e),
                        AssuranceLevel::Degraded,
                        true,
                    ));
                }
            }
        }

        // 2. Check root package.json for workspaces
        let root_pkg_path = "package.json";
        if files.package_jsons.iter().any(|p| p == root_pkg_path) {
            let full = repo_root.join(root_pkg_path);
            if let Ok(content) = std::fs::read_to_string(&full) {
                if let Ok(val) = serde_json::from_str::<Value>(&content) {
                    if let Some(ws) = val.get("workspaces") {
                        root_workspace_manifests.push(root_pkg_path.to_string());
                        if let Some(arr) = ws.as_array() {
                            for item in arr {
                                if let Some(s) = item.as_str() {
                                    workspace_patterns.push(s.to_string());
                                }
                            }
                        } else if let Some(obj) = ws.as_object() {
                            if let Some(arr) = obj.get("packages").and_then(|p| p.as_array()) {
                                for item in arr {
                                    if let Some(s) = item.as_str() {
                                        workspace_patterns.push(s.to_string());
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        let is_monorepo = !workspace_patterns.is_empty();
        let ws_stable_id = "workspace:npm:.".to_string();

        res.workspaces.push(Workspace {
            stable_id: ws_stable_id.clone(),
            root_path: ".".to_string(),
            manifest_path: if is_monorepo && !files.pnpm_workspaces.is_empty() {
                files.pnpm_workspaces[0].clone()
            } else {
                root_pkg_path.to_string()
            },
            ecosystem: PackageEcosystem::Npm,
            members: Vec::new(),
        });

        res.nodes.push(BuildNode {
            stable_id: ws_stable_id.clone(),
            kind: NodeKind::Workspace,
            canonical_path: Some(".".to_string()),
            metadata: Some(
                serde_json::json!({ "ecosystem": "npm", "is_monorepo": is_monorepo }).to_string(),
            ),
        });

        // Explicit edge: root manifest -> workspace node
        for rmf in &root_workspace_manifests {
            let fnode = format!("file:{}", rmf);
            if !res.nodes.iter().any(|n| n.stable_id == fnode) {
                res.nodes.push(BuildNode {
                    stable_id: fnode.clone(),
                    kind: NodeKind::File,
                    canonical_path: Some(rmf.clone()),
                    metadata: None,
                });
            }
            bounds.push_bounded_edge(
                &mut res.edges,
                &mut res.uncertainties,
                BuildEdge {
                    stable_id: format!("edge:defines:{}:{}", fnode, ws_stable_id),
                    from_node: fnode,
                    to_node: ws_stable_id.clone(),
                    kind: EdgeKind::Defines,
                    provider: "build_native".to_string(),
                    provider_id: PACKAGE_JSON_PROVIDER_ID.to_string(),
                    provider_fingerprint: global_fingerprint.clone(),
                    strength: EvidenceStrength::Structural,
                    metadata: None,
                },
                limits.edges,
                PACKAGE_JSON_PROVIDER_ID,
                UncertaintyScope::Workspace(ws_stable_id.clone()),
            );
        }

        // Parse individual packages
        let mut name_to_package_id: HashMap<String, String> = HashMap::new();
        let mut parsed_packages: Vec<Package> = Vec::new();
        let mut package_dirs: Vec<String> = Vec::new();
        let mut pkg_fingerprints: HashMap<String, String> = HashMap::new();

        for pkg_json_path in &files.package_jsons {
            let dir = Path::new(pkg_json_path)
                .parent()
                .and_then(|p| p.to_str())
                .unwrap_or(".");
            let dir_str = if dir.is_empty() { "." } else { dir }.to_string();

            let full = repo_root.join(pkg_json_path);
            let content = match std::fs::read_to_string(&full) {
                Ok(c) => c,
                Err(e) => {
                    res.uncertainties.push(BuildUncertainty::new(
                        "package_read_error",
                        UncertaintyScope::Package(dir_str.clone()),
                        PACKAGE_JSON_PROVIDER_ID,
                        format!("Failed to read {}: {}", pkg_json_path, e),
                        AssuranceLevel::Degraded,
                        true,
                    ));
                    continue;
                }
            };

            let val: Value = match serde_json::from_str(&content) {
                Ok(v) => v,
                Err(e) => {
                    if !is_monorepo || dir_str == "." {
                        return Err(format!("Malformed package.json in {}: {}", dir_str, e));
                    }
                    res.uncertainties.push(BuildUncertainty::new(
                        "malformed_package_json",
                        UncertaintyScope::Package(dir_str.clone()),
                        PACKAGE_JSON_PROVIDER_ID,
                        format!("Malformed package.json in {}: {}", dir_str, e),
                        AssuranceLevel::Degraded,
                        true,
                    ));
                    continue;
                }
            };

            if is_monorepo && dir_str == "." && val.get("workspaces").is_some() {
                continue;
            }

            let pkg_name = val
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or(&dir_str)
                .to_string();
            let pkg_version = val
                .get("version")
                .and_then(|v| v.as_str())
                .map(String::from);
            let pkg_stable_id = format!("pkg:npm:{}", dir_str);

            let scope_fp = hash_files(
                repo_root,
                std::slice::from_ref(pkg_json_path),
                PACKAGE_JSON_PROVIDER_VERSION,
            );
            pkg_fingerprints.insert(dir_str.clone(), scope_fp.clone());

            name_to_package_id.insert(pkg_name.clone(), pkg_stable_id.clone());
            package_dirs.push(dir_str.clone());

            let mut pkg_deps = Vec::new();

            // Extract dependencies
            for dep_field in [
                "dependencies",
                "devDependencies",
                "peerDependencies",
                "optionalDependencies",
            ] {
                if let Some(deps_map) = val.get(dep_field).and_then(|d| d.as_object()) {
                    for (dep_name, dep_ver_val) in deps_map {
                        let ver_req = dep_ver_val.as_str().map(String::from);
                        let is_workspace_spec = ver_req
                            .as_deref()
                            .map(|v| v.starts_with("workspace:"))
                            .unwrap_or(false);
                        pkg_deps.push(PackageDependency {
                            name: dep_name.clone(),
                            version_req: ver_req,
                            path: None,
                            is_workspace_dep: is_workspace_spec,
                            target_package_id: None,
                        });
                    }
                }
            }

            // Extract script targets
            let mut script_target_ids = Vec::new();
            if let Some(scripts) = val.get("scripts").and_then(|s| s.as_object()) {
                for (script_name, script_cmd_val) in scripts {
                    let cmd_str = script_cmd_val.as_str().map(String::from);
                    let target_id = format!("build:{}:script:{}", pkg_stable_id, script_name);
                    script_target_ids.push(target_id.clone());

                    let target_kind = match script_name.as_str() {
                        "test" | "test:unit" | "test:e2e" => BuildTargetKind::Test,
                        _ => BuildTargetKind::Script,
                    };

                    bounds.push_bounded_target(
                        &mut res.targets,
                        &mut res.uncertainties,
                        BuildTarget {
                            stable_id: target_id.clone(),
                            package_id: pkg_stable_id.clone(),
                            name: script_name.clone(),
                            target_kind,
                            command_or_path: cmd_str,
                            reads_configs: Vec::new(),
                            generates_artifacts: Vec::new(),
                            depends_on_targets: Vec::new(),
                        },
                        limits.targets,
                        PACKAGE_JSON_PROVIDER_ID,
                        UncertaintyScope::Package(dir_str.clone()),
                    );

                    res.nodes.push(BuildNode {
                        stable_id: target_id.clone(),
                        kind: NodeKind::BuildTarget,
                        canonical_path: Some(dir_str.clone()),
                        metadata: Some(
                            serde_json::json!({
                                "script": script_name,
                                "package": pkg_name,
                            })
                            .to_string(),
                        ),
                    });

                    // Target BELONGS_TO package
                    bounds.push_bounded_edge(
                        &mut res.edges,
                        &mut res.uncertainties,
                        BuildEdge {
                            stable_id: format!("edge:belongs_to:{}:{}", target_id, pkg_stable_id),
                            from_node: target_id,
                            to_node: pkg_stable_id.clone(),
                            kind: EdgeKind::BelongsTo,
                            provider: "build_native".to_string(),
                            provider_id: PACKAGE_JSON_PROVIDER_ID.to_string(),
                            provider_fingerprint: scope_fp.clone(),
                            strength: EvidenceStrength::Structural,
                            metadata: None,
                        },
                        limits.edges,
                        PACKAGE_JSON_PROVIDER_ID,
                        UncertaintyScope::Package(dir_str.clone()),
                    );
                }
            }

            // Node for manifest file
            let manifest_node_id = format!("file:{}", pkg_json_path);
            res.nodes.push(BuildNode {
                stable_id: manifest_node_id.clone(),
                kind: NodeKind::File,
                canonical_path: Some(pkg_json_path.clone()),
                metadata: None,
            });

            // Edge from manifest to package
            bounds.push_bounded_edge(
                &mut res.edges,
                &mut res.uncertainties,
                BuildEdge {
                    stable_id: format!("edge:defines:{}:{}", manifest_node_id, pkg_stable_id),
                    from_node: manifest_node_id,
                    to_node: pkg_stable_id.clone(),
                    kind: EdgeKind::Defines,
                    provider: "build_native".to_string(),
                    provider_id: PACKAGE_JSON_PROVIDER_ID.to_string(),
                    provider_fingerprint: scope_fp.clone(),
                    strength: EvidenceStrength::Structural,
                    metadata: None,
                },
                limits.edges,
                PACKAGE_JSON_PROVIDER_ID,
                UncertaintyScope::Package(dir_str.clone()),
            );

            // Node for package
            res.nodes.push(BuildNode {
                stable_id: pkg_stable_id.clone(),
                kind: NodeKind::Package,
                canonical_path: Some(dir_str.clone()),
                metadata: Some(
                    serde_json::json!({
                        "name": pkg_name,
                        "version": pkg_version,
                        "directory": dir_str,
                        "ecosystem": "npm",
                    })
                    .to_string(),
                ),
            });

            // Workspace membership check
            let is_member = if !is_monorepo {
                true
            } else {
                match matches_workspace_pattern(&dir_str, &workspace_patterns) {
                    Ok(m) => m,
                    Err(e) => {
                        res.uncertainties.push(BuildUncertainty::new(
                            "unknown_workspace_membership",
                            UncertaintyScope::Workspace(ws_stable_id.clone()),
                            PACKAGE_JSON_PROVIDER_ID,
                            format!("Failed to match workspace pattern for {}: {}", dir_str, e),
                            AssuranceLevel::Degraded,
                            true,
                        ));
                        false
                    }
                }
            };

            if is_member {
                if let Some(ws) = res.workspaces.first_mut() {
                    bounds.push_bounded_workspace_member(
                        &mut ws.members,
                        &mut res.uncertainties,
                        pkg_stable_id.clone(),
                        limits.workspace_members,
                        PACKAGE_JSON_PROVIDER_ID,
                        UncertaintyScope::Workspace(ws_stable_id.clone()),
                    );
                }

                // Edge from workspace CONTAINS package
                bounds.push_bounded_edge(
                    &mut res.edges,
                    &mut res.uncertainties,
                    BuildEdge {
                        stable_id: format!("edge:contains:{}:{}", ws_stable_id, pkg_stable_id),
                        from_node: ws_stable_id.clone(),
                        to_node: pkg_stable_id.clone(),
                        kind: EdgeKind::Contains,
                        provider: "build_native".to_string(),
                        provider_id: PACKAGE_JSON_PROVIDER_ID.to_string(),
                        provider_fingerprint: scope_fp.clone(),
                        strength: EvidenceStrength::Structural,
                        metadata: None,
                    },
                    limits.edges,
                    PACKAGE_JSON_PROVIDER_ID,
                    UncertaintyScope::Workspace(ws_stable_id.clone()),
                );
            }

            parsed_packages.push(Package {
                stable_id: pkg_stable_id,
                name: pkg_name,
                version: pkg_version,
                manifest_path: pkg_json_path.clone(),
                directory: dir_str,
                ecosystem: PackageEcosystem::Npm,
                dependencies: pkg_deps,
                build_targets: script_target_ids,
                config_files: Vec::new(),
            });
        }

        // Ordinary source file ownership
        let owned_files_map = find_package_owned_files(repo_root, &package_dirs);
        for (pkg_dir, files_list) in owned_files_map {
            let pkg_id = format!("pkg:npm:{}", pkg_dir);
            let scope_fp = pkg_fingerprints
                .get(&pkg_dir)
                .cloned()
                .unwrap_or_else(|| global_fingerprint.clone());

            for file_path in files_list {
                let file_node_id = format!("file:{}", file_path);
                if !res.nodes.iter().any(|n| n.stable_id == file_node_id) {
                    res.nodes.push(BuildNode {
                        stable_id: file_node_id.clone(),
                        kind: NodeKind::File,
                        canonical_path: Some(file_path.clone()),
                        metadata: None,
                    });
                }

                let edge_id = format!("edge:contains:{}:{}", pkg_id, file_node_id);
                if !res.edges.iter().any(|e| e.stable_id == edge_id) {
                    bounds.push_bounded_edge(
                        &mut res.edges,
                        &mut res.uncertainties,
                        BuildEdge {
                            stable_id: edge_id,
                            from_node: pkg_id.clone(),
                            to_node: file_node_id,
                            kind: EdgeKind::Contains,
                            provider: "build_native".to_string(),
                            provider_id: PACKAGE_JSON_PROVIDER_ID.to_string(),
                            provider_fingerprint: scope_fp.clone(),
                            strength: EvidenceStrength::Structural,
                            metadata: None,
                        },
                        limits.edges,
                        PACKAGE_JSON_PROVIDER_ID,
                        UncertaintyScope::Package(pkg_dir.clone()),
                    );
                }
            }
        }

        // Resolve package dependencies and create dependency / external edges
        for mut pkg in parsed_packages {
            let scope_fp = pkg_fingerprints
                .get(&pkg.directory)
                .cloned()
                .unwrap_or_else(|| global_fingerprint.clone());

            for dep in &mut pkg.dependencies {
                if let Some(target_pkg_id) = name_to_package_id.get(&dep.name) {
                    dep.target_package_id = Some(target_pkg_id.clone());
                    dep.is_workspace_dep = true;

                    // Package A DEPENDS_ON Package B
                    let edge_id = format!("edge:depends_on:{}:{}", pkg.stable_id, target_pkg_id);
                    bounds.push_bounded_edge(
                        &mut res.edges,
                        &mut res.uncertainties,
                        BuildEdge {
                            stable_id: edge_id,
                            from_node: pkg.stable_id.clone(),
                            to_node: target_pkg_id.clone(),
                            kind: EdgeKind::DependsOn,
                            provider: "build_native".to_string(),
                            provider_id: PACKAGE_JSON_PROVIDER_ID.to_string(),
                            provider_fingerprint: scope_fp.clone(),
                            strength: EvidenceStrength::Structural,
                            metadata: None,
                        },
                        limits.edges,
                        PACKAGE_JSON_PROVIDER_ID,
                        UncertaintyScope::Package(pkg.directory.clone()),
                    );
                } else {
                    // External dependency
                    let ext_id = format!("ext:npm:{}", dep.name);
                    if !res
                        .external_dependencies
                        .iter()
                        .any(|e| e.stable_id == ext_id)
                    {
                        res.external_dependencies.push(ExternalDependency {
                            stable_id: ext_id.clone(),
                            ecosystem: PackageEcosystem::Npm,
                            name: dep.name.clone(),
                            version: dep.version_req.clone(),
                        });
                        res.nodes.push(BuildNode {
                            stable_id: ext_id.clone(),
                            kind: NodeKind::ExternalDependency,
                            canonical_path: None,
                            metadata: Some(
                                serde_json::json!({
                                    "ecosystem": "npm",
                                    "name": dep.name,
                                })
                                .to_string(),
                            ),
                        });
                    }

                    // Package USES ExternalDependency
                    let edge_id = format!("edge:uses:{}:{}", pkg.stable_id, ext_id);
                    bounds.push_bounded_edge(
                        &mut res.edges,
                        &mut res.uncertainties,
                        BuildEdge {
                            stable_id: edge_id,
                            from_node: pkg.stable_id.clone(),
                            to_node: ext_id,
                            kind: EdgeKind::Uses,
                            provider: "build_native".to_string(),
                            provider_id: PACKAGE_JSON_PROVIDER_ID.to_string(),
                            provider_fingerprint: scope_fp.clone(),
                            strength: EvidenceStrength::Structural,
                            metadata: None,
                        },
                        limits.edges,
                        PACKAGE_JSON_PROVIDER_ID,
                        UncertaintyScope::Package(pkg.directory.clone()),
                    );
                }
            }
            res.packages.push(pkg);
        }

        Ok(res)
    }
}
