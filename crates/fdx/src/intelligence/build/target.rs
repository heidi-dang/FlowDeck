//! Static parser and provider for Cargo workspaces, crates, targets, and path dependencies.

use crate::intelligence::build::discover::discover_build_files;
use crate::intelligence::build::model::*;
use crate::intelligence::build::provider::{
    hash_files, BuildConfigProvider, BuildIngestResult, BuildProviderScope,
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
struct ParsedCargoToml {
    is_workspace: bool,
    workspace_members: Vec<String>,
    package_name: Option<String>,
    package_version: Option<String>,
    build_script: Option<String>,
    path_deps: Vec<(String, String)>, // (dep_name, relative_path)
    external_deps: Vec<(String, Option<String>)>, // (dep_name, version_opt)
    bins: Vec<String>,
    has_lib: bool,
    tests: Vec<String>,
    examples: Vec<String>,
}

fn extract_quoted_string(line: &str) -> Option<String> {
    let mut quote_char = None;
    let mut start = None;

    for (i, c) in line.char_indices() {
        if c == '"' || c == '\'' {
            if let Some(q) = quote_char {
                if q == c {
                    return Some(line[start.unwrap()..i].to_string());
                }
            } else {
                quote_char = Some(c);
                start = Some(i + 1);
            }
        }
    }
    None
}

fn parse_array_elements(mut text: &str) -> Vec<String> {
    let mut items = Vec::new();
    if let Some(open) = text.find('[') {
        text = &text[open + 1..];
    }
    if let Some(close) = text.rfind(']') {
        text = &text[..close];
    }

    for part in text.split(',') {
        if let Some(s) = extract_quoted_string(part) {
            if !s.is_empty() {
                items.push(s);
            }
        }
    }
    items
}

fn parse_cargo_toml_content(content: &str) -> Result<ParsedCargoToml, String> {
    let mut parsed = ParsedCargoToml::default();
    let mut current_section = "";
    let mut multiline_key = "";
    let mut multiline_buf = String::new();
    let mut in_multiline_array = false;

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.starts_with('#') || line.is_empty() {
            continue;
        }

        if in_multiline_array {
            multiline_buf.push_str(line);
            multiline_buf.push(' ');
            if line.contains(']') {
                in_multiline_array = false;
                if multiline_key == "members" {
                    parsed
                        .workspace_members
                        .extend(parse_array_elements(&multiline_buf));
                }
                multiline_buf.clear();
                multiline_key = "";
            }
            continue;
        }

        if line.starts_with('[') && line.ends_with(']') {
            let section = line.trim_matches('[').trim_matches(']').trim();
            current_section = section;
            if section == "workspace" {
                parsed.is_workspace = true;
            } else if section == "lib" {
                parsed.has_lib = true;
            }
            continue;
        }

        if let Some(eq_idx) = line.find('=') {
            let key = line[..eq_idx].trim();
            let val = line[eq_idx + 1..].trim();

            if val.starts_with('[') && !val.contains(']') {
                in_multiline_array = true;
                multiline_key = key;
                multiline_buf.push_str(val);
                multiline_buf.push(' ');
                continue;
            }

            match current_section {
                "workspace" => {
                    if key == "members" {
                        parsed.workspace_members.extend(parse_array_elements(val));
                    }
                }
                "package" => {
                    if key == "name" {
                        parsed.package_name = extract_quoted_string(val);
                    } else if key == "version" {
                        parsed.package_version = extract_quoted_string(val);
                    } else if key == "build" {
                        parsed.build_script = extract_quoted_string(val);
                    }
                }
                "bin" | "[bin]" => {
                    if key == "name" {
                        if let Some(bin_name) = extract_quoted_string(val) {
                            parsed.bins.push(bin_name);
                        }
                    }
                }
                "test" | "[test]" => {
                    if key == "name" {
                        if let Some(test_name) = extract_quoted_string(val) {
                            parsed.tests.push(test_name);
                        }
                    }
                }
                "example" | "[example]" => {
                    if key == "name" {
                        if let Some(ex_name) = extract_quoted_string(val) {
                            parsed.examples.push(ex_name);
                        }
                    }
                }
                s if s.starts_with("dependencies")
                    || s.starts_with("dev-dependencies")
                    || s.starts_with("build-dependencies")
                    || s.starts_with("workspace.dependencies") =>
                {
                    let dep_name = key.trim_matches('"').trim_matches('\'').to_string();
                    if val.starts_with('{') {
                        if let Some(path_idx) = val.find("path") {
                            let after_path = &val[path_idx + 4..];
                            if let Some(eq) = after_path.find('=') {
                                if let Some(path_str) = extract_quoted_string(&after_path[eq + 1..])
                                {
                                    parsed.path_deps.push((dep_name.clone(), path_str));
                                }
                            }
                        } else {
                            // Non-path inline table
                            let ver = extract_quoted_string(val);
                            parsed.external_deps.push((dep_name, ver));
                        }
                    } else {
                        // Simple version string: serde = "1.0"
                        let ver = extract_quoted_string(val);
                        parsed.external_deps.push((dep_name, ver));
                    }
                }
                _ => {}
            }
        }
    }

    Ok(parsed)
}

impl BuildConfigProvider for CargoProvider {
    fn id(&self) -> &'static str {
        CARGO_PROVIDER_ID
    }

    fn detect(&self, repo_root: &Path) -> bool {
        let files = discover_build_files(repo_root);
        !files.cargo_tomls.is_empty()
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
        let files = discover_build_files(repo_root);
        let mut all_manifests = files.cargo_tomls.clone();
        all_manifests.extend(files.build_rss.clone());
        all_manifests.sort();
        all_manifests.dedup();

        let fingerprint = hash_files(repo_root, &all_manifests, CARGO_PROVIDER_VERSION);

        let mut res = BuildIngestResult {
            fingerprint: fingerprint.clone(),
            ..Default::default()
        };

        let ws_stable_id = "workspace:.".to_string();
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
            metadata: Some(serde_json::json!({ "ecosystem": "cargo" }).to_string()),
        });

        let mut dir_to_package_id: HashMap<String, String> = HashMap::new();
        let mut name_to_package_id: HashMap<String, String> = HashMap::new();
        let mut parsed_crates: Vec<(String, String, ParsedCargoToml)> = Vec::new(); // (dir, manifest_path, parsed)

        for cargo_path in &files.cargo_tomls {
            let full = repo_root.join(cargo_path);
            let content = match std::fs::read_to_string(&full) {
                Ok(c) => c,
                Err(e) => {
                    let dir = Path::new(cargo_path)
                        .parent()
                        .and_then(|p| p.to_str())
                        .unwrap_or(".");
                    let dir_str = if dir.is_empty() { "." } else { dir };
                    res.uncertainties.push(BuildUncertainty::new(
                        "cargo_read_error",
                        UncertaintyScope::Package(dir_str.to_string()),
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
                    let dir = Path::new(cargo_path)
                        .parent()
                        .and_then(|p| p.to_str())
                        .unwrap_or(".");
                    let dir_str = if dir.is_empty() { "." } else { dir };
                    if dir_str == "." {
                        return Err(format!("Malformed Cargo.toml in {}: {}", dir_str, e));
                    }
                    res.uncertainties.push(BuildUncertainty::new(
                        "malformed_cargo_toml",
                        UncertaintyScope::Package(dir_str.to_string()),
                        CARGO_PROVIDER_ID,
                        format!("Malformed Cargo.toml in {}: {}", dir_str, e),
                        AssuranceLevel::Degraded,
                        true,
                    ));
                    continue;
                }
            };

            let dir = Path::new(cargo_path)
                .parent()
                .and_then(|p| p.to_str())
                .unwrap_or(".");
            let dir_str = if dir.is_empty() { "." } else { dir }.to_string();

            if let Some(ref pkg_name) = parsed.package_name {
                let pkg_id = format!("pkg:cargo:{}", dir_str);
                dir_to_package_id.insert(dir_str.clone(), pkg_id.clone());
                name_to_package_id.insert(pkg_name.clone(), pkg_id);
            }

            parsed_crates.push((dir_str, cargo_path.clone(), parsed));
        }

        for (dir_str, cargo_path, parsed) in parsed_crates {
            let config_node_id = format!("config:{}", cargo_path);
            let file_node_id = format!("file:{}", cargo_path);

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
            res.edges.push(BuildEdge {
                stable_id: format!("edge:defines:{}:{}", file_node_id, config_node_id),
                from_node: file_node_id,
                to_node: config_node_id.clone(),
                kind: EdgeKind::Defines,
                provider: "build_native".to_string(),
                provider_id: CARGO_PROVIDER_ID.to_string(),
                provider_fingerprint: fingerprint.clone(),
                strength: EvidenceStrength::Structural,
                metadata: None,
            });

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
            res.edges.push(BuildEdge {
                stable_id: format!("edge:configures:{}:{}", config_node_id, pkg_stable_id),
                from_node: config_node_id.clone(),
                to_node: pkg_stable_id.clone(),
                kind: EdgeKind::Configures,
                provider: "build_native".to_string(),
                provider_id: CARGO_PROVIDER_ID.to_string(),
                provider_fingerprint: fingerprint.clone(),
                strength: EvidenceStrength::Structural,
                metadata: None,
            });

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

            // Edge: workspace CONTAINS package
            res.edges.push(BuildEdge {
                stable_id: format!("edge:contains:{}:{}", ws_stable_id, pkg_stable_id),
                from_node: ws_stable_id.clone(),
                to_node: pkg_stable_id.clone(),
                kind: EdgeKind::Contains,
                provider: "build_native".to_string(),
                provider_id: CARGO_PROVIDER_ID.to_string(),
                provider_fingerprint: fingerprint.clone(),
                strength: EvidenceStrength::Structural,
                metadata: None,
            });

            if let Some(ws) = res.workspaces.first_mut() {
                ws.members.push(pkg_stable_id.clone());
            }

            let mut target_ids = Vec::new();

            // Check library target
            let lib_file = if dir_str == "." {
                "src/lib.rs".to_string()
            } else {
                format!("{}/src/lib.rs", dir_str)
            };
            if parsed.has_lib || repo_root.join(&lib_file).exists() {
                let lib_id = format!("build:{}:lib:{}", pkg_stable_id, pkg_name);
                target_ids.push(lib_id.clone());
                res.targets.push(BuildTarget {
                    stable_id: lib_id.clone(),
                    package_id: pkg_stable_id.clone(),
                    name: pkg_name.clone(),
                    target_kind: BuildTargetKind::Library,
                    command_or_path: Some(lib_file.clone()),
                    reads_configs: vec![config_node_id.clone()],
                    generates_artifacts: Vec::new(),
                    depends_on_targets: Vec::new(),
                });
                res.nodes.push(BuildNode {
                    stable_id: lib_id.clone(),
                    kind: NodeKind::BuildTarget,
                    canonical_path: Some(lib_file),
                    metadata: Some(
                        serde_json::json!({ "target_kind": "lib", "name": pkg_name }).to_string(),
                    ),
                });
                res.edges.push(BuildEdge {
                    stable_id: format!("edge:belongs_to:{}:{}", lib_id, pkg_stable_id),
                    from_node: lib_id,
                    to_node: pkg_stable_id.clone(),
                    kind: EdgeKind::BelongsTo,
                    provider: "build_native".to_string(),
                    provider_id: CARGO_PROVIDER_ID.to_string(),
                    provider_fingerprint: fingerprint.clone(),
                    strength: EvidenceStrength::Structural,
                    metadata: None,
                });
            }

            // Check binary targets
            let main_file = if dir_str == "." {
                "src/main.rs".to_string()
            } else {
                format!("{}/src/main.rs", dir_str)
            };
            let mut bins = parsed.bins.clone();
            if bins.is_empty() && repo_root.join(&main_file).exists() {
                bins.push(pkg_name.clone());
            }

            for bin_name in bins {
                let bin_id = format!("build:{}:bin:{}", pkg_stable_id, bin_name);
                target_ids.push(bin_id.clone());
                res.targets.push(BuildTarget {
                    stable_id: bin_id.clone(),
                    package_id: pkg_stable_id.clone(),
                    name: bin_name.clone(),
                    target_kind: BuildTargetKind::Binary,
                    command_or_path: Some(main_file.clone()),
                    reads_configs: vec![config_node_id.clone()],
                    generates_artifacts: Vec::new(),
                    depends_on_targets: Vec::new(),
                });
                res.nodes.push(BuildNode {
                    stable_id: bin_id.clone(),
                    kind: NodeKind::BuildTarget,
                    canonical_path: Some(main_file.clone()),
                    metadata: Some(
                        serde_json::json!({ "target_kind": "bin", "name": bin_name }).to_string(),
                    ),
                });
                res.edges.push(BuildEdge {
                    stable_id: format!("edge:belongs_to:{}:{}", bin_id, pkg_stable_id),
                    from_node: bin_id,
                    to_node: pkg_stable_id.clone(),
                    kind: EdgeKind::BelongsTo,
                    provider: "build_native".to_string(),
                    provider_id: CARGO_PROVIDER_ID.to_string(),
                    provider_fingerprint: fingerprint.clone(),
                    strength: EvidenceStrength::Structural,
                    metadata: None,
                });
            }

            // Check build.rs
            let build_rs_file = if dir_str == "." {
                "build.rs".to_string()
            } else {
                format!("{}/build.rs", dir_str)
            };
            if parsed.build_script.is_some() || repo_root.join(&build_rs_file).exists() {
                let build_rs_id = format!("build:{}:custom:build_rs", pkg_stable_id);
                target_ids.push(build_rs_id.clone());
                res.targets.push(BuildTarget {
                    stable_id: build_rs_id.clone(),
                    package_id: pkg_stable_id.clone(),
                    name: "build_rs".to_string(),
                    target_kind: BuildTargetKind::Custom,
                    command_or_path: Some(build_rs_file.clone()),
                    reads_configs: vec![config_node_id.clone()],
                    generates_artifacts: Vec::new(),
                    depends_on_targets: Vec::new(),
                });
                res.nodes.push(BuildNode {
                    stable_id: build_rs_id.clone(),
                    kind: NodeKind::BuildTarget,
                    canonical_path: Some(build_rs_file.clone()),
                    metadata: Some(
                        serde_json::json!({ "target_kind": "custom", "name": "build_rs" })
                            .to_string(),
                    ),
                });
                res.edges.push(BuildEdge {
                    stable_id: format!("edge:belongs_to:{}:{}", build_rs_id, pkg_stable_id),
                    from_node: build_rs_id,
                    to_node: pkg_stable_id.clone(),
                    kind: EdgeKind::BelongsTo,
                    provider: "build_native".to_string(),
                    provider_id: CARGO_PROVIDER_ID.to_string(),
                    provider_fingerprint: fingerprint.clone(),
                    strength: EvidenceStrength::Structural,
                    metadata: None,
                });
            }

            // Path dependencies
            let mut pkg_dependencies = Vec::new();
            for (dep_name, rel_path) in &parsed.path_deps {
                let base_dir = Path::new(&dir_str);
                let target_dir = base_dir.join(rel_path);
                let Ok(resolved_dir) = canonicalize_repo_path(&target_dir, Path::new("")) else {
                    continue;
                };

                let target_pkg_id = dir_to_package_id
                    .get(&resolved_dir)
                    .or_else(|| name_to_package_id.get(dep_name))
                    .cloned()
                    .unwrap_or_else(|| format!("pkg:cargo:{}", resolved_dir));

                pkg_dependencies.push(PackageDependency {
                    name: dep_name.clone(),
                    version_req: None,
                    path: Some(rel_path.clone()),
                    is_workspace_dep: true,
                    target_package_id: Some(target_pkg_id.clone()),
                });

                // Package A DEPENDS_ON Package B
                let edge_id = format!("edge:depends_on:{}:{}", pkg_stable_id, target_pkg_id);
                res.edges.push(BuildEdge {
                    stable_id: edge_id,
                    from_node: pkg_stable_id.clone(),
                    to_node: target_pkg_id,
                    kind: EdgeKind::DependsOn,
                    provider: "build_native".to_string(),
                    provider_id: CARGO_PROVIDER_ID.to_string(),
                    provider_fingerprint: fingerprint.clone(),
                    strength: EvidenceStrength::Structural,
                    metadata: None,
                });
            }

            // External dependencies
            for (ext_name, ver_opt) in &parsed.external_deps {
                let ext_id = format!("ext:cargo:{}", ext_name);
                if !res
                    .external_dependencies
                    .iter()
                    .any(|e| e.stable_id == ext_id)
                {
                    res.external_dependencies.push(ExternalDependency {
                        stable_id: ext_id.clone(),
                        ecosystem: PackageEcosystem::Cargo,
                        name: ext_name.clone(),
                        version: ver_opt.clone(),
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

                // Package USES ExternalDependency
                let edge_id = format!("edge:uses:{}:{}", pkg_stable_id, ext_id);
                res.edges.push(BuildEdge {
                    stable_id: edge_id,
                    from_node: pkg_stable_id.clone(),
                    to_node: ext_id,
                    kind: EdgeKind::Uses,
                    provider: "build_native".to_string(),
                    provider_id: CARGO_PROVIDER_ID.to_string(),
                    provider_fingerprint: fingerprint.clone(),
                    strength: EvidenceStrength::Structural,
                    metadata: None,
                });
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
