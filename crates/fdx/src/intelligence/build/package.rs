//! Static parser and provider for package.json and npm/pnpm/yarn/bun workspaces.

use crate::intelligence::build::discover::discover_build_files;
use crate::intelligence::build::model::*;
use crate::intelligence::build::provider::{
    hash_files, BuildConfigProvider, BuildIngestResult, BuildProviderScope,
};
use crate::intelligence::build::scope::UncertaintyScope;
use crate::intelligence::build::uncertainty::BuildUncertainty;
use crate::protocol::{AssuranceLevel, EdgeKind, EvidenceStrength, NodeKind};
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

fn parse_pnpm_workspace_packages(content: &str) -> Vec<String> {
    let mut in_packages_section = false;
    let mut patterns = Vec::new();

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') || trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with("packages:") {
            in_packages_section = true;
            continue;
        }
        if in_packages_section {
            if !line.starts_with(' ') && !line.starts_with('\t') && !trimmed.starts_with('-') {
                in_packages_section = false;
                continue;
            }
            if let Some(stripped) = trimmed.strip_prefix('-') {
                let pat = stripped.trim().trim_matches('\'').trim_matches('"');
                if !pat.is_empty() {
                    patterns.push(pat.to_string());
                }
            }
        }
    }

    patterns
}

impl BuildConfigProvider for PackageJsonProvider {
    fn id(&self) -> &'static str {
        PACKAGE_JSON_PROVIDER_ID
    }

    fn detect(&self, repo_root: &Path) -> bool {
        let files = discover_build_files(repo_root);
        !files.package_jsons.is_empty() || !files.pnpm_workspaces.is_empty()
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
        let files = discover_build_files(repo_root);
        let mut manifest_files = files.package_jsons.clone();
        manifest_files.extend(files.pnpm_workspaces.clone());
        manifest_files.sort();
        manifest_files.dedup();

        let fingerprint = hash_files(repo_root, &manifest_files, PACKAGE_JSON_PROVIDER_VERSION);

        let mut res = BuildIngestResult {
            fingerprint: fingerprint.clone(),
            ..Default::default()
        };

        // Check root workspace
        let mut workspace_patterns: Vec<String> = Vec::new();

        // 1. Check pnpm-workspace.yaml
        for pnpm_file in &files.pnpm_workspaces {
            let full = repo_root.join(pnpm_file);
            if let Ok(content) = std::fs::read_to_string(&full) {
                let pats = parse_pnpm_workspace_packages(&content);
                workspace_patterns.extend(pats);
            }
        }

        // 2. Check root package.json for workspaces
        let root_pkg_path = "package.json";
        if files.package_jsons.iter().any(|p| p == root_pkg_path) {
            let full = repo_root.join(root_pkg_path);
            if let Ok(content) = std::fs::read_to_string(&full) {
                if let Ok(val) = serde_json::from_str::<Value>(&content) {
                    if let Some(ws) = val.get("workspaces") {
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
        let ws_stable_id = "workspace:.".to_string();

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

        // Parse individual packages
        let mut name_to_package_id: HashMap<String, String> = HashMap::new();
        let mut parsed_packages: Vec<Package> = Vec::new();

        for pkg_json_path in &files.package_jsons {
            let full = repo_root.join(pkg_json_path);
            let content = match std::fs::read_to_string(&full) {
                Ok(c) => c,
                Err(e) => {
                    let dir = Path::new(pkg_json_path)
                        .parent()
                        .and_then(|p| p.to_str())
                        .unwrap_or(".");
                    let dir_str = if dir.is_empty() { "." } else { dir };
                    res.uncertainties.push(BuildUncertainty::new(
                        "package_read_error",
                        UncertaintyScope::Package(dir_str.to_string()),
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
                    let dir = Path::new(pkg_json_path)
                        .parent()
                        .and_then(|p| p.to_str())
                        .unwrap_or(".");
                    let dir_str = if dir.is_empty() { "." } else { dir };
                    if !is_monorepo || dir_str == "." {
                        return Err(format!("Malformed package.json in {}: {}", dir_str, e));
                    }
                    res.uncertainties.push(BuildUncertainty::new(
                        "malformed_package_json",
                        UncertaintyScope::Package(dir_str.to_string()),
                        PACKAGE_JSON_PROVIDER_ID,
                        format!("Malformed package.json in {}: {}", dir_str, e),
                        AssuranceLevel::Degraded,
                        true,
                    ));
                    continue;
                }
            };

            let dir = Path::new(pkg_json_path)
                .parent()
                .and_then(|p| p.to_str())
                .unwrap_or(".");
            let dir_str = if dir.is_empty() { "." } else { dir }.to_string();

            if is_monorepo && dir_str == "." && val.get("workspaces").is_some() {
                // Root monorepo manifest defines the workspace, not a member package
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

            name_to_package_id.insert(pkg_name.clone(), pkg_stable_id.clone());

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

                    res.targets.push(BuildTarget {
                        stable_id: target_id.clone(),
                        package_id: pkg_stable_id.clone(),
                        name: script_name.clone(),
                        target_kind,
                        command_or_path: cmd_str,
                        reads_configs: Vec::new(),
                        generates_artifacts: Vec::new(),
                        depends_on_targets: Vec::new(),
                    });

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
                    res.edges.push(BuildEdge {
                        stable_id: format!("edge:belongs_to:{}:{}", target_id, pkg_stable_id),
                        from_node: target_id,
                        to_node: pkg_stable_id.clone(),
                        kind: EdgeKind::BelongsTo,
                        provider: "build_native".to_string(),
                        provider_id: PACKAGE_JSON_PROVIDER_ID.to_string(),
                        provider_fingerprint: fingerprint.clone(),
                        strength: EvidenceStrength::Structural,
                        metadata: None,
                    });
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
            res.edges.push(BuildEdge {
                stable_id: format!("edge:defines:{}:{}", manifest_node_id, pkg_stable_id),
                from_node: manifest_node_id,
                to_node: pkg_stable_id.clone(),
                kind: EdgeKind::Defines,
                provider: "build_native".to_string(),
                provider_id: PACKAGE_JSON_PROVIDER_ID.to_string(),
                provider_fingerprint: fingerprint.clone(),
                strength: EvidenceStrength::Structural,
                metadata: None,
            });

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

            // Edge from workspace CONTAINS package
            res.edges.push(BuildEdge {
                stable_id: format!("edge:contains:{}:{}", ws_stable_id, pkg_stable_id),
                from_node: ws_stable_id.clone(),
                to_node: pkg_stable_id.clone(),
                kind: EdgeKind::Contains,
                provider: "build_native".to_string(),
                provider_id: PACKAGE_JSON_PROVIDER_ID.to_string(),
                provider_fingerprint: fingerprint.clone(),
                strength: EvidenceStrength::Structural,
                metadata: None,
            });

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

        // Resolve package dependencies and create dependency / external edges
        for mut pkg in parsed_packages {
            for dep in &mut pkg.dependencies {
                if let Some(target_pkg_id) = name_to_package_id.get(&dep.name) {
                    dep.target_package_id = Some(target_pkg_id.clone());
                    dep.is_workspace_dep = true;

                    // Package A DEPENDS_ON Package B
                    let edge_id = format!("edge:depends_on:{}:{}", pkg.stable_id, target_pkg_id);
                    res.edges.push(BuildEdge {
                        stable_id: edge_id,
                        from_node: pkg.stable_id.clone(),
                        to_node: target_pkg_id.clone(),
                        kind: EdgeKind::DependsOn,
                        provider: "build_native".to_string(),
                        provider_id: PACKAGE_JSON_PROVIDER_ID.to_string(),
                        provider_fingerprint: fingerprint.clone(),
                        strength: EvidenceStrength::Structural,
                        metadata: None,
                    });
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
                    res.edges.push(BuildEdge {
                        stable_id: edge_id,
                        from_node: pkg.stable_id.clone(),
                        to_node: ext_id,
                        kind: EdgeKind::Uses,
                        provider: "build_native".to_string(),
                        provider_id: PACKAGE_JSON_PROVIDER_ID.to_string(),
                        provider_fingerprint: fingerprint.clone(),
                        strength: EvidenceStrength::Structural,
                        metadata: None,
                    });
                }
            }

            if let Some(ws) = res.workspaces.first_mut() {
                ws.members.push(pkg.stable_id.clone());
            }
            res.packages.push(pkg);
        }

        Ok(res)
    }
}
