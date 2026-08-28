//! Static parser and provider for Cargo workspaces, crates, targets, and path dependencies.

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
use std::collections::HashMap;
use std::path::Path;

pub const CARGO_PROVIDER_ID: &str = "builtin-cargo";
pub const CARGO_PROVIDER_VERSION: &str = "1.0.0";

pub struct CargoProvider;

impl CargoProvider {
    pub fn new() -> Self {
        Self
    }
}

impl Default for CargoProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Default)]
struct WorkspaceDepSpec {
    path: Option<String>,
    version: Option<String>,
    package: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct ParsedCargoToml {
    is_workspace: bool,
    workspace_members: Vec<String>,
    workspace_exclude: Vec<String>,
    workspace_deps: HashMap<String, WorkspaceDepSpec>,
    package_name: Option<String>,
    package_version: Option<String>,
    build_script: Option<String>,
    path_deps: Vec<(String, String, Option<String>)>, // (dep_name, rel_path, package_rename)
    workspace_dep_refs: Vec<(String, Option<String>)>, // (dep_name, package_rename)
    external_deps: Vec<(String, Option<String>)>,     // (dep_name, version_opt)
    bins: Vec<(String, Option<String>)>,              // (name, path_opt)
    has_lib: bool,
    lib_path: Option<String>,
    tests: Vec<(String, Option<String>)>,
    examples: Vec<(String, Option<String>)>,
}

fn parse_cargo_toml_content(content: &str) -> Result<ParsedCargoToml, String> {
    let root_val: toml::Value =
        toml::from_str(content).map_err(|e| format!("TOML parse error: {}", e))?;

    let mut parsed = ParsedCargoToml::default();

    // 1. [workspace]
    if let Some(ws) = root_val.get("workspace").and_then(|w| w.as_table()) {
        parsed.is_workspace = true;
        if let Some(members) = ws.get("members").and_then(|m| m.as_array()) {
            for m in members {
                if let Some(s) = m.as_str() {
                    parsed.workspace_members.push(s.to_string());
                }
            }
        }
        if let Some(exclude) = ws.get("exclude").and_then(|e| e.as_array()) {
            for e in exclude {
                if let Some(s) = e.as_str() {
                    parsed.workspace_exclude.push(s.to_string());
                }
            }
        }
        if let Some(ws_deps) = ws.get("dependencies").and_then(|d| d.as_table()) {
            for (dep_key, dep_val) in ws_deps {
                let mut spec = WorkspaceDepSpec::default();
                if let Some(s) = dep_val.as_str() {
                    spec.version = Some(s.to_string());
                } else if let Some(t) = dep_val.as_table() {
                    spec.path = t.get("path").and_then(|p| p.as_str()).map(String::from);
                    spec.version = t.get("version").and_then(|v| v.as_str()).map(String::from);
                    spec.package = t.get("package").and_then(|p| p.as_str()).map(String::from);
                }
                parsed.workspace_deps.insert(dep_key.clone(), spec);
            }
        }
    }

    // 2. [package]
    if let Some(pkg) = root_val.get("package").and_then(|p| p.as_table()) {
        parsed.package_name = pkg.get("name").and_then(|n| n.as_str()).map(String::from);
        parsed.package_version = pkg
            .get("version")
            .and_then(|v| v.as_str())
            .map(String::from);
        if let Some(b) = pkg.get("build") {
            if let Some(s) = b.as_str() {
                parsed.build_script = Some(s.to_string());
            } else if let Some(b_val) = b.as_bool() {
                if !b_val {
                    parsed.build_script = Some("false".to_string());
                }
            }
        }
    }

    // 3. [lib]
    if let Some(lib_tbl) = root_val.get("lib").and_then(|l| l.as_table()) {
        parsed.has_lib = true;
        parsed.lib_path = lib_tbl
            .get("path")
            .and_then(|p| p.as_str())
            .map(String::from);
    }

    // 4. [[bin]]
    if let Some(bins_arr) = root_val.get("bin").and_then(|b| b.as_array()) {
        for b in bins_arr {
            if let Some(b_tbl) = b.as_table() {
                if let Some(name) = b_tbl.get("name").and_then(|n| n.as_str()) {
                    let path = b_tbl.get("path").and_then(|p| p.as_str()).map(String::from);
                    parsed.bins.push((name.to_string(), path));
                }
            }
        }
    }

    // 5. [[test]]
    if let Some(tests_arr) = root_val.get("test").and_then(|t| t.as_array()) {
        for t in tests_arr {
            if let Some(t_tbl) = t.as_table() {
                if let Some(name) = t_tbl.get("name").and_then(|n| n.as_str()) {
                    let path = t_tbl.get("path").and_then(|p| p.as_str()).map(String::from);
                    parsed.tests.push((name.to_string(), path));
                }
            }
        }
    }

    // 6. [[example]]
    if let Some(ex_arr) = root_val.get("example").and_then(|e| e.as_array()) {
        for ex in ex_arr {
            if let Some(ex_tbl) = ex.as_table() {
                if let Some(name) = ex_tbl.get("name").and_then(|n| n.as_str()) {
                    let path = ex_tbl
                        .get("path")
                        .and_then(|p| p.as_str())
                        .map(String::from);
                    parsed.examples.push((name.to_string(), path));
                }
            }
        }
    }

    // 7. Dependencies ([dependencies], [dev-dependencies], [build-dependencies], [target.*.dependencies])
    let mut dep_tables: Vec<&toml::map::Map<String, toml::Value>> = Vec::new();
    for section_name in ["dependencies", "dev-dependencies", "build-dependencies"] {
        if let Some(tbl) = root_val.get(section_name).and_then(|s| s.as_table()) {
            dep_tables.push(tbl);
        }
    }
    if let Some(targets_tbl) = root_val.get("target").and_then(|t| t.as_table()) {
        for (_target_key, target_val) in targets_tbl {
            if let Some(t_inner) = target_val.as_table() {
                for section_name in ["dependencies", "dev-dependencies", "build-dependencies"] {
                    if let Some(tbl) = t_inner.get(section_name).and_then(|s| s.as_table()) {
                        dep_tables.push(tbl);
                    }
                }
            }
        }
    }

    for tbl in dep_tables {
        for (dep_key, dep_val) in tbl {
            if let Some(ver_str) = dep_val.as_str() {
                parsed
                    .external_deps
                    .push((dep_key.clone(), Some(ver_str.to_string())));
            } else if let Some(dep_tbl) = dep_val.as_table() {
                let is_workspace_dep = dep_tbl
                    .get("workspace")
                    .and_then(|w| w.as_bool())
                    .unwrap_or(false);
                let pkg_rename = dep_tbl
                    .get("package")
                    .and_then(|p| p.as_str())
                    .map(String::from);

                if is_workspace_dep {
                    parsed
                        .workspace_dep_refs
                        .push((dep_key.clone(), pkg_rename));
                } else if let Some(path_str) = dep_tbl.get("path").and_then(|p| p.as_str()) {
                    parsed
                        .path_deps
                        .push((dep_key.clone(), path_str.to_string(), pkg_rename));
                } else {
                    let ver = dep_tbl
                        .get("version")
                        .and_then(|v| v.as_str())
                        .map(String::from);
                    parsed.external_deps.push((dep_key.clone(), ver));
                }
            }
        }
    }

    Ok(parsed)
}

fn matches_cargo_workspace(
    dir: &str,
    members: &[String],
    exclude: &[String],
) -> Result<bool, String> {
    if members.is_empty() {
        return Ok(false);
    }

    for ex_pat in exclude {
        let glob_pat = glob::Pattern::new(ex_pat).map_err(|e| e.to_string())?;
        if glob_pat.matches(dir) {
            return Ok(false);
        }
    }

    for m_pat in members {
        let glob_pat = glob::Pattern::new(m_pat).map_err(|e| e.to_string())?;
        if glob_pat.matches(dir) {
            return Ok(true);
        }
    }

    Ok(false)
}

fn find_cargo_owned_files(repo_root: &Path, crate_dirs: &[String]) -> HashMap<String, Vec<String>> {
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    for d in crate_dirs {
        map.insert(d.clone(), Vec::new());
    }

    let mut sorted_dirs = crate_dirs.to_vec();
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

impl BuildConfigProvider for CargoProvider {
    fn id(&self) -> &'static str {
        CARGO_PROVIDER_ID
    }

    fn detect_state(&self, repo_root: &Path) -> ProviderDetection {
        let files = discover_build_files(repo_root);
        if !files.walker_errors.is_empty() {
            return ProviderDetection::Indeterminate(format!(
                "Discovery walker errors: {}",
                files.walker_errors.join("; ")
            ));
        }
        if !files.cargo_tomls.is_empty() {
            ProviderDetection::Present
        } else {
            ProviderDetection::Absent
        }
    }

    fn scope(&self, repo_root: &Path) -> BuildProviderScope {
        let files = discover_build_files(repo_root);
        let mut manifest_files = files.cargo_tomls;
        manifest_files.extend(files.build_rss);
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
            CARGO_PROVIDER_VERSION,
        ))
    }

    fn ingest(&self, repo_root: &Path) -> Result<BuildIngestResult, String> {
        let limits = get_active_build_limits();
        let files = discover_build_files(repo_root);
        let mut bounds = BuildBoundsCollector::default();

        let mut all_manifests = files.cargo_tomls.clone();
        all_manifests.extend(files.build_rss.clone());
        all_manifests.sort();
        all_manifests.dedup();

        let global_fingerprint = hash_files(repo_root, &all_manifests, CARGO_PROVIDER_VERSION);

        let mut res = BuildIngestResult {
            fingerprint: global_fingerprint.clone(),
            ..Default::default()
        };

        if files.cargo_tomls_truncated
            || files.build_rss_truncated
            || !files.walker_errors.is_empty()
        {
            res.uncertainties.push(BuildUncertainty::new(
                "build_limit_reached",
                UncertaintyScope::Repository,
                CARGO_PROVIDER_ID,
                format!(
                    "Discovery limits reached or walker errors encountered (Cargo.toml limit {})",
                    limits.packages
                ),
                AssuranceLevel::Degraded,
                true,
            ));
        }

        let ws_stable_id = "workspace:cargo:.".to_string();
        let mut root_workspace_members = Vec::new();
        let mut root_workspace_exclude = Vec::new();
        let mut root_workspace_deps = HashMap::new();
        let mut has_root_workspace = false;

        let root_cargo_path = "Cargo.toml";
        if files.cargo_tomls.contains(&root_cargo_path.to_string()) {
            let full = repo_root.join(root_cargo_path);
            if let Ok(content) = std::fs::read_to_string(&full) {
                if let Ok(parsed_root) = parse_cargo_toml_content(&content) {
                    if parsed_root.is_workspace || !parsed_root.workspace_members.is_empty() {
                        has_root_workspace = true;
                        root_workspace_members = parsed_root.workspace_members;
                        root_workspace_exclude = parsed_root.workspace_exclude;
                        root_workspace_deps = parsed_root.workspace_deps;
                    }
                }
            }
        }

        res.workspaces.push(Workspace {
            stable_id: ws_stable_id.clone(),
            root_path: ".".to_string(),
            manifest_path: if files.cargo_tomls.contains(&"Cargo.toml".to_string()) {
                "Cargo.toml".to_string()
            } else {
                files
                    .cargo_tomls
                    .first()
                    .cloned()
                    .unwrap_or_else(|| "Cargo.toml".to_string())
            },
            ecosystem: PackageEcosystem::Cargo,
            members: Vec::new(),
        });

        res.nodes.push(BuildNode {
            stable_id: ws_stable_id.clone(),
            kind: NodeKind::Workspace,
            canonical_path: Some(".".to_string()),
            metadata: Some(
                serde_json::json!({ "ecosystem": "cargo", "is_workspace": has_root_workspace })
                    .to_string(),
            ),
        });

        // Edge: root Cargo.toml DEFINES Cargo workspace
        if files.cargo_tomls.contains(&"Cargo.toml".to_string()) {
            let root_file_node = "file:Cargo.toml".to_string();
            if !res.nodes.iter().any(|n| n.stable_id == root_file_node) {
                res.nodes.push(BuildNode {
                    stable_id: root_file_node.clone(),
                    kind: NodeKind::File,
                    canonical_path: Some("Cargo.toml".to_string()),
                    metadata: None,
                });
            }
            bounds.push_bounded_edge(
                &mut res.edges,
                &mut res.uncertainties,
                BuildEdge {
                    stable_id: format!("edge:defines:{}:{}", root_file_node, ws_stable_id),
                    from_node: root_file_node,
                    to_node: ws_stable_id.clone(),
                    kind: EdgeKind::Defines,
                    provider: "build_native".to_string(),
                    provider_id: CARGO_PROVIDER_ID.to_string(),
                    provider_fingerprint: global_fingerprint.clone(),
                    strength: EvidenceStrength::Structural,
                    metadata: None,
                },
                limits.edges,
                CARGO_PROVIDER_ID,
                UncertaintyScope::Workspace(ws_stable_id.clone()),
            );
        }

        let mut dir_to_package_id: HashMap<String, String> = HashMap::new();
        let mut name_to_package_id: HashMap<String, String> = HashMap::new();
        let mut parsed_crates: Vec<(String, String, ParsedCargoToml)> = Vec::new();
        let mut crate_dirs: Vec<String> = Vec::new();
        let mut crate_fingerprints: HashMap<String, String> = HashMap::new();

        for cargo_path in &files.cargo_tomls {
            let dir = Path::new(cargo_path)
                .parent()
                .and_then(|p| p.to_str())
                .unwrap_or(".");
            let dir_str = if dir.is_empty() { "." } else { dir }.to_string();

            let mut manifest_group = vec![cargo_path.clone()];
            let candidate_build_rs = if dir_str == "." {
                "build.rs".to_string()
            } else {
                format!("{}/build.rs", dir_str)
            };
            if files.build_rss.contains(&candidate_build_rs) {
                manifest_group.push(candidate_build_rs);
            }
            let scope_fp = hash_files(repo_root, &manifest_group, CARGO_PROVIDER_VERSION);
            crate_fingerprints.insert(dir_str.clone(), scope_fp);

            let full = repo_root.join(cargo_path);
            let content = match std::fs::read_to_string(&full) {
                Ok(c) => c,
                Err(e) => {
                    res.uncertainties.push(BuildUncertainty::new(
                        "cargo_read_error",
                        UncertaintyScope::Package(dir_str.clone()),
                        CARGO_PROVIDER_ID,
                        format!("Failed to read {}: {}", cargo_path, e),
                        AssuranceLevel::Degraded,
                        true,
                    ));
                    continue;
                }
            };

            let parsed = match parse_cargo_toml_content(&content) {
                Ok(p) => p,
                Err(e) => {
                    if dir_str == "." {
                        return Err(format!("Malformed Cargo.toml in {}: {}", dir_str, e));
                    }
                    res.uncertainties.push(BuildUncertainty::new(
                        "malformed_cargo_toml",
                        UncertaintyScope::Package(dir_str.clone()),
                        CARGO_PROVIDER_ID,
                        format!("Malformed Cargo.toml in {}: {}", dir_str, e),
                        AssuranceLevel::Degraded,
                        true,
                    ));
                    continue;
                }
            };

            if let Some(ref pkg_name) = parsed.package_name {
                let pkg_id = format!("pkg:cargo:{}", dir_str);
                dir_to_package_id.insert(dir_str.clone(), pkg_id.clone());
                name_to_package_id.insert(pkg_name.clone(), pkg_id);
                crate_dirs.push(dir_str.clone());
            }

            parsed_crates.push((dir_str, cargo_path.clone(), parsed));
        }

        // Connect ordinary source files under crate directories
        let owned_files_map = find_cargo_owned_files(repo_root, &crate_dirs);

        for (dir_str, cargo_path, parsed) in parsed_crates {
            let config_node_id = format!("config:{}", cargo_path);
            let file_node_id = format!("file:{}", cargo_path);
            let scope_fp = crate_fingerprints
                .get(&dir_str)
                .cloned()
                .unwrap_or_else(|| global_fingerprint.clone());

            // Node for Cargo.toml config
            res.nodes.push(BuildNode {
                stable_id: config_node_id.clone(),
                kind: NodeKind::Config,
                canonical_path: Some(cargo_path.clone()),
                metadata: Some(serde_json::json!({ "config_kind": "cargo_toml" }).to_string()),
            });

            // Node for Cargo.toml file
            res.nodes.push(BuildNode {
                stable_id: file_node_id.clone(),
                kind: NodeKind::File,
                canonical_path: Some(cargo_path.clone()),
                metadata: None,
            });

            // Edge: file DEFINES config
            bounds.push_bounded_edge(
                &mut res.edges,
                &mut res.uncertainties,
                BuildEdge {
                    stable_id: format!("edge:defines:{}:{}", file_node_id, config_node_id),
                    from_node: file_node_id,
                    to_node: config_node_id.clone(),
                    kind: EdgeKind::Defines,
                    provider: "build_native".to_string(),
                    provider_id: CARGO_PROVIDER_ID.to_string(),
                    provider_fingerprint: scope_fp.clone(),
                    strength: EvidenceStrength::Structural,
                    metadata: None,
                },
                limits.edges,
                CARGO_PROVIDER_ID,
                UncertaintyScope::Package(dir_str.clone()),
            );

            res.configs.push(ConfigFile {
                stable_id: config_node_id.clone(),
                canonical_path: cargo_path.clone(),
                config_kind: ConfigKind::CargoToml,
                extends: None,
                references: Vec::new(),
                configures_packages: Vec::new(),
            });

            let Some(pkg_name) = parsed.package_name else {
                continue;
            };

            let pkg_stable_id = format!("pkg:cargo:{}", dir_str);

            // Edge: config CONFIGURES package
            bounds.push_bounded_edge(
                &mut res.edges,
                &mut res.uncertainties,
                BuildEdge {
                    stable_id: format!("edge:configures:{}:{}", config_node_id, pkg_stable_id),
                    from_node: config_node_id.clone(),
                    to_node: pkg_stable_id.clone(),
                    kind: EdgeKind::Configures,
                    provider: "build_native".to_string(),
                    provider_id: CARGO_PROVIDER_ID.to_string(),
                    provider_fingerprint: scope_fp.clone(),
                    strength: EvidenceStrength::Structural,
                    metadata: None,
                },
                limits.edges,
                CARGO_PROVIDER_ID,
                UncertaintyScope::Package(dir_str.clone()),
            );

            // Package node
            res.nodes.push(BuildNode {
                stable_id: pkg_stable_id.clone(),
                kind: NodeKind::Package,
                canonical_path: Some(dir_str.clone()),
                metadata: Some(
                    serde_json::json!({
                        "name": pkg_name,
                        "version": parsed.package_version,
                        "directory": dir_str,
                        "ecosystem": "cargo",
                    })
                    .to_string(),
                ),
            });

            // Workspace membership check
            let is_member = if !has_root_workspace {
                dir_str == "."
            } else {
                match matches_cargo_workspace(
                    &dir_str,
                    &root_workspace_members,
                    &root_workspace_exclude,
                ) {
                    Ok(m) => m,
                    Err(e) => {
                        res.uncertainties.push(BuildUncertainty::new(
                            "unknown_workspace_membership",
                            UncertaintyScope::Workspace(ws_stable_id.clone()),
                            CARGO_PROVIDER_ID,
                            format!("Failed to match Cargo workspace for {}: {}", dir_str, e),
                            AssuranceLevel::Degraded,
                            true,
                        ));
                        false
                    }
                }
            };

            if is_member {
                let member_admitted = if let Some(ws) = res.workspaces.first_mut() {
                    bounds.push_bounded_workspace_member(
                        &mut ws.members,
                        &mut res.uncertainties,
                        pkg_stable_id.clone(),
                        limits.workspace_members,
                        CARGO_PROVIDER_ID,
                        UncertaintyScope::Workspace(ws_stable_id.clone()),
                    )
                } else {
                    false
                };

                if member_admitted {
                    // Edge: workspace CONTAINS package
                    bounds.push_bounded_edge(
                        &mut res.edges,
                        &mut res.uncertainties,
                        BuildEdge {
                            stable_id: format!("edge:contains:{}:{}", ws_stable_id, pkg_stable_id),
                            from_node: ws_stable_id.clone(),
                            to_node: pkg_stable_id.clone(),
                            kind: EdgeKind::Contains,
                            provider: "build_native".to_string(),
                            provider_id: CARGO_PROVIDER_ID.to_string(),
                            provider_fingerprint: scope_fp.clone(),
                            strength: EvidenceStrength::Structural,
                            metadata: None,
                        },
                        limits.edges,
                        CARGO_PROVIDER_ID,
                        UncertaintyScope::Workspace(ws_stable_id.clone()),
                    );
                }
            }

            // Ordinary source files CONTAINS edges
            if let Some(files_list) = owned_files_map.get(&dir_str) {
                for file_path in files_list {
                    let f_node_id = format!("file:{}", file_path);
                    if !res.nodes.iter().any(|n| n.stable_id == f_node_id) {
                        res.nodes.push(BuildNode {
                            stable_id: f_node_id.clone(),
                            kind: NodeKind::File,
                            canonical_path: Some(file_path.clone()),
                            metadata: None,
                        });
                    }

                    let edge_id = format!("edge:contains:{}:{}", pkg_stable_id, f_node_id);
                    if !res.edges.iter().any(|e| e.stable_id == edge_id) {
                        bounds.push_bounded_edge(
                            &mut res.edges,
                            &mut res.uncertainties,
                            BuildEdge {
                                stable_id: edge_id,
                                from_node: pkg_stable_id.clone(),
                                to_node: f_node_id,
                                kind: EdgeKind::Contains,
                                provider: "build_native".to_string(),
                                provider_id: CARGO_PROVIDER_ID.to_string(),
                                provider_fingerprint: scope_fp.clone(),
                                strength: EvidenceStrength::Structural,
                                metadata: None,
                            },
                            limits.edges,
                            CARGO_PROVIDER_ID,
                            UncertaintyScope::Package(dir_str.clone()),
                        );
                    }
                }
            }

            let mut target_ids = Vec::new();

            // Library target
            let lib_file = if let Some(ref lp) = parsed.lib_path {
                if dir_str == "." {
                    lp.clone()
                } else {
                    format!("{}/{}", dir_str, lp)
                }
            } else if dir_str == "." {
                "src/lib.rs".to_string()
            } else {
                format!("{}/src/lib.rs", dir_str)
            };

            if parsed.has_lib || repo_root.join(&lib_file).exists() {
                let lib_id = format!("build:{}:lib:{}", pkg_stable_id, pkg_name);
                target_ids.push(lib_id.clone());
                let admitted = bounds.push_bounded_target(
                    &mut res.targets,
                    &mut res.uncertainties,
                    BuildTarget {
                        stable_id: lib_id.clone(),
                        package_id: pkg_stable_id.clone(),
                        name: pkg_name.clone(),
                        target_kind: BuildTargetKind::Library,
                        command_or_path: Some(lib_file.clone()),
                        reads_configs: vec![config_node_id.clone()],
                        generates_artifacts: Vec::new(),
                        depends_on_targets: Vec::new(),
                    },
                    limits.targets,
                    CARGO_PROVIDER_ID,
                    UncertaintyScope::Package(dir_str.clone()),
                );

                if admitted {
                    res.nodes.push(BuildNode {
                        stable_id: lib_id.clone(),
                        kind: NodeKind::BuildTarget,
                        canonical_path: Some(lib_file),
                        metadata: Some(
                            serde_json::json!({ "target_kind": "lib", "name": pkg_name })
                                .to_string(),
                        ),
                    });
                    bounds.push_bounded_edge(
                        &mut res.edges,
                        &mut res.uncertainties,
                        BuildEdge {
                            stable_id: format!("edge:belongs_to:{}:{}", lib_id, pkg_stable_id),
                            from_node: lib_id,
                            to_node: pkg_stable_id.clone(),
                            kind: EdgeKind::BelongsTo,
                            provider: "build_native".to_string(),
                            provider_id: CARGO_PROVIDER_ID.to_string(),
                            provider_fingerprint: scope_fp.clone(),
                            strength: EvidenceStrength::Structural,
                            metadata: None,
                        },
                        limits.edges,
                        CARGO_PROVIDER_ID,
                        UncertaintyScope::Package(dir_str.clone()),
                    );
                }
            }

            // Binary targets
            let default_main = if dir_str == "." {
                "src/main.rs".to_string()
            } else {
                format!("{}/src/main.rs", dir_str)
            };
            let mut bins = parsed.bins.clone();
            if bins.is_empty() && repo_root.join(&default_main).exists() {
                bins.push((pkg_name.clone(), None));
            }

            for (bin_name, bin_path_opt) in bins {
                let main_file = if let Some(bp) = bin_path_opt {
                    if dir_str == "." {
                        bp
                    } else {
                        format!("{}/{}", dir_str, bp)
                    }
                } else {
                    default_main.clone()
                };

                let bin_id = format!("build:{}:bin:{}", pkg_stable_id, bin_name);
                target_ids.push(bin_id.clone());
                let admitted = bounds.push_bounded_target(
                    &mut res.targets,
                    &mut res.uncertainties,
                    BuildTarget {
                        stable_id: bin_id.clone(),
                        package_id: pkg_stable_id.clone(),
                        name: bin_name.clone(),
                        target_kind: BuildTargetKind::Binary,
                        command_or_path: Some(main_file.clone()),
                        reads_configs: vec![config_node_id.clone()],
                        generates_artifacts: Vec::new(),
                        depends_on_targets: Vec::new(),
                    },
                    limits.targets,
                    CARGO_PROVIDER_ID,
                    UncertaintyScope::Package(dir_str.clone()),
                );

                if admitted {
                    res.nodes.push(BuildNode {
                        stable_id: bin_id.clone(),
                        kind: NodeKind::BuildTarget,
                        canonical_path: Some(main_file.clone()),
                        metadata: Some(
                            serde_json::json!({ "target_kind": "bin", "name": bin_name })
                                .to_string(),
                        ),
                    });
                    bounds.push_bounded_edge(
                        &mut res.edges,
                        &mut res.uncertainties,
                        BuildEdge {
                            stable_id: format!("edge:belongs_to:{}:{}", bin_id, pkg_stable_id),
                            from_node: bin_id,
                            to_node: pkg_stable_id.clone(),
                            kind: EdgeKind::BelongsTo,
                            provider: "build_native".to_string(),
                            provider_id: CARGO_PROVIDER_ID.to_string(),
                            provider_fingerprint: scope_fp.clone(),
                            strength: EvidenceStrength::Structural,
                            metadata: None,
                        },
                        limits.edges,
                        CARGO_PROVIDER_ID,
                        UncertaintyScope::Package(dir_str.clone()),
                    );
                }
            }

            // Build script target
            let default_build_rs = if dir_str == "." {
                "build.rs".to_string()
            } else {
                format!("{}/build.rs", dir_str)
            };
            let has_build_script = match parsed.build_script.as_deref() {
                Some("false") => false,
                Some(_) => true,
                None => repo_root.join(&default_build_rs).exists(),
            };

            if has_build_script {
                let build_rs_file = match parsed.build_script.as_deref() {
                    Some(s) if s != "false" => {
                        if dir_str == "." {
                            s.to_string()
                        } else {
                            format!("{}/{}", dir_str, s)
                        }
                    }
                    _ => default_build_rs,
                };
                let build_rs_id = format!("build:{}:custom:build_rs", pkg_stable_id);
                target_ids.push(build_rs_id.clone());
                let admitted = bounds.push_bounded_target(
                    &mut res.targets,
                    &mut res.uncertainties,
                    BuildTarget {
                        stable_id: build_rs_id.clone(),
                        package_id: pkg_stable_id.clone(),
                        name: "build_rs".to_string(),
                        target_kind: BuildTargetKind::Custom,
                        command_or_path: Some(build_rs_file.clone()),
                        reads_configs: vec![config_node_id.clone()],
                        generates_artifacts: Vec::new(),
                        depends_on_targets: Vec::new(),
                    },
                    limits.targets,
                    CARGO_PROVIDER_ID,
                    UncertaintyScope::Package(dir_str.clone()),
                );

                if admitted {
                    res.nodes.push(BuildNode {
                        stable_id: build_rs_id.clone(),
                        kind: NodeKind::BuildTarget,
                        canonical_path: Some(build_rs_file.clone()),
                        metadata: Some(
                            serde_json::json!({ "target_kind": "custom", "name": "build_rs" })
                                .to_string(),
                        ),
                    });
                    bounds.push_bounded_edge(
                        &mut res.edges,
                        &mut res.uncertainties,
                        BuildEdge {
                            stable_id: format!("edge:belongs_to:{}:{}", build_rs_id, pkg_stable_id),
                            from_node: build_rs_id,
                            to_node: pkg_stable_id.clone(),
                            kind: EdgeKind::BelongsTo,
                            provider: "build_native".to_string(),
                            provider_id: CARGO_PROVIDER_ID.to_string(),
                            provider_fingerprint: scope_fp.clone(),
                            strength: EvidenceStrength::Structural,
                            metadata: None,
                        },
                        limits.edges,
                        CARGO_PROVIDER_ID,
                        UncertaintyScope::Package(dir_str.clone()),
                    );
                }
            }

            // Path dependencies (direct and via workspace.dependencies)
            let mut pkg_dependencies = Vec::new();
            let mut all_path_deps = parsed.path_deps.clone();

            for (ws_ref_name, rename_opt) in &parsed.workspace_dep_refs {
                if let Some(spec) = root_workspace_deps.get(ws_ref_name) {
                    if let Some(ref p) = spec.path {
                        let actual_name = spec
                            .package
                            .as_ref()
                            .or(rename_opt.as_ref())
                            .unwrap_or(ws_ref_name);
                        all_path_deps.push((actual_name.clone(), p.clone(), None));
                    } else {
                        parsed_crates_external_deps_push(
                            &mut res,
                            &mut bounds,
                            &pkg_stable_id,
                            &dir_str,
                            ws_ref_name,
                            spec.version.as_deref(),
                            &scope_fp,
                        );
                    }
                }
            }

            for (dep_name, rel_path, _pkg_rename) in &all_path_deps {
                let target_dir = if repo_root.join(rel_path).is_dir() {
                    rel_path.clone()
                } else {
                    let base_dir = Path::new(&dir_str);
                    let td = base_dir.join(rel_path);
                    canonicalize_repo_path(&td, Path::new("")).unwrap_or_else(|_| rel_path.clone())
                };

                let target_pkg_id = dir_to_package_id
                    .get(&target_dir)
                    .or_else(|| name_to_package_id.get(dep_name))
                    .cloned()
                    .unwrap_or_else(|| format!("pkg:cargo:{}", target_dir));

                pkg_dependencies.push(PackageDependency {
                    name: dep_name.clone(),
                    version_req: None,
                    path: Some(rel_path.clone()),
                    is_workspace_dep: true,
                    target_package_id: Some(target_pkg_id.clone()),
                });

                // Package A DEPENDS_ON Package B
                let edge_id = format!("edge:depends_on:{}:{}", pkg_stable_id, target_pkg_id);
                bounds.push_bounded_edge(
                    &mut res.edges,
                    &mut res.uncertainties,
                    BuildEdge {
                        stable_id: edge_id,
                        from_node: pkg_stable_id.clone(),
                        to_node: target_pkg_id,
                        kind: EdgeKind::DependsOn,
                        provider: "build_native".to_string(),
                        provider_id: CARGO_PROVIDER_ID.to_string(),
                        provider_fingerprint: scope_fp.clone(),
                        strength: EvidenceStrength::Structural,
                        metadata: None,
                    },
                    limits.edges,
                    CARGO_PROVIDER_ID,
                    UncertaintyScope::Package(dir_str.clone()),
                );
            }

            // External dependencies
            for (ext_name, ver_opt) in &parsed.external_deps {
                parsed_crates_external_deps_push(
                    &mut res,
                    &mut bounds,
                    &pkg_stable_id,
                    &dir_str,
                    ext_name,
                    ver_opt.as_deref(),
                    &scope_fp,
                );
            }

            res.packages.push(Package {
                stable_id: pkg_stable_id,
                name: pkg_name,
                version: parsed.package_version,
                manifest_path: cargo_path,
                directory: dir_str,
                ecosystem: PackageEcosystem::Cargo,
                dependencies: pkg_dependencies,
                build_targets: target_ids,
                config_files: vec![config_node_id],
            });
        }

        Ok(res)
    }
}

fn parsed_crates_external_deps_push(
    res: &mut BuildIngestResult,
    bounds: &mut BuildBoundsCollector,
    pkg_stable_id: &str,
    dir_str: &str,
    ext_name: &str,
    version_opt: Option<&str>,
    fingerprint: &str,
) {
    let limits = get_active_build_limits();
    let ext_id = format!("ext:cargo:{}", ext_name);
    if !res
        .external_dependencies
        .iter()
        .any(|e| e.stable_id == ext_id)
    {
        res.external_dependencies.push(ExternalDependency {
            stable_id: ext_id.clone(),
            ecosystem: PackageEcosystem::Cargo,
            name: ext_name.to_string(),
            version: version_opt.map(String::from),
        });
        res.nodes.push(BuildNode {
            stable_id: ext_id.clone(),
            kind: NodeKind::ExternalDependency,
            canonical_path: None,
            metadata: Some(
                serde_json::json!({
                    "ecosystem": "cargo",
                    "name": ext_name,
                })
                .to_string(),
            ),
        });
    }

    let edge_id = format!("edge:uses:{}:{}", pkg_stable_id, ext_id);
    bounds.push_bounded_edge(
        &mut res.edges,
        &mut res.uncertainties,
        BuildEdge {
            stable_id: edge_id,
            from_node: pkg_stable_id.to_string(),
            to_node: ext_id,
            kind: EdgeKind::Uses,
            provider: "build_native".to_string(),
            provider_id: CARGO_PROVIDER_ID.to_string(),
            provider_fingerprint: fingerprint.to_string(),
            strength: EvidenceStrength::Structural,
            metadata: None,
        },
        limits.edges,
        CARGO_PROVIDER_ID,
        UncertaintyScope::Package(dir_str.to_string()),
    );
}
