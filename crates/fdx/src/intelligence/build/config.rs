//! Static parser and provider for tsconfig.json inheritance and project references.

use crate::intelligence::build::bounds::BuildBoundsCollector;
use crate::intelligence::build::discover::{
    discover_build_files, MAX_DISCOVERED_ARTIFACTS, MAX_DISCOVERED_CONFIGS, MAX_DISCOVERED_EDGES,
};
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
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

pub const TSCONFIG_PROVIDER_ID: &str = "builtin-tsconfig";
pub const TSCONFIG_PROVIDER_VERSION: &str = "1.0.0";
pub const MAX_CONFIG_RECURSION_DEPTH: usize = 32;

pub struct TsConfigProvider;

impl TsConfigProvider {
    pub fn new() -> Self {
        Self
    }
}

impl Default for TsConfigProvider {
    fn default() -> Self {
        Self::new()
    }
}

/// Strip line/block comments and trailing commas for jsonc compatibility.
pub fn clean_jsonc(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    let mut in_string = false;
    let mut string_char = '"';
    let mut escape = false;

    while let Some(c) = chars.next() {
        if in_string {
            out.push(c);
            if escape {
                escape = false;
            } else if c == '\\' {
                escape = true;
            } else if c == string_char {
                in_string = false;
            }
            continue;
        }

        if c == '"' || c == '\'' {
            in_string = true;
            string_char = c;
            out.push('"'); // Normalize quotes
            continue;
        }

        if c == '/' {
            if let Some(&'/') = chars.peek() {
                // Line comment
                chars.next();
                for next_c in chars.by_ref() {
                    if next_c == '\n' {
                        out.push('\n');
                        break;
                    }
                }
                continue;
            } else if let Some(&'*') = chars.peek() {
                // Block comment
                chars.next();
                while let Some(next_c) = chars.next() {
                    if next_c == '*' {
                        if let Some(&'/') = chars.peek() {
                            chars.next();
                            break;
                        }
                    }
                }
                continue;
            }
        }

        out.push(c);
    }

    // Strip trailing commas before } or ]
    let mut cleaned = String::with_capacity(out.len());
    let bytes = out.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b',' {
            let mut j = i + 1;
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            if j < bytes.len() && (bytes[j] == b'}' || bytes[j] == b']') {
                i += 1;
                continue;
            }
        }
        cleaned.push(bytes[i] as char);
        i += 1;
    }

    cleaned
}

fn resolve_relative_config_path(
    base_file_path: &str,
    target_spec: &str,
    repo_root: &Path,
) -> Option<String> {
    if target_spec.is_empty() || (!target_spec.starts_with('.') && !target_spec.starts_with('/')) {
        return None;
    }
    let base_parent = Path::new(base_file_path).parent().unwrap_or(Path::new(""));
    let mut candidate = base_parent.join(target_spec);

    let full_candidate = repo_root.join(&candidate);
    if full_candidate.is_dir() {
        candidate = candidate.join("tsconfig.json");
    } else if !candidate.to_string_lossy().ends_with(".json") {
        candidate = PathBuf::from(format!("{}.json", candidate.to_string_lossy()));
    }

    canonicalize_repo_path(&candidate, Path::new("")).ok()
}

impl BuildConfigProvider for TsConfigProvider {
    fn id(&self) -> &'static str {
        TSCONFIG_PROVIDER_ID
    }

    fn detect_state(&self, repo_root: &Path) -> ProviderDetection {
        let files = discover_build_files(repo_root);
        if !files.walker_errors.is_empty() {
            return ProviderDetection::Indeterminate(format!(
                "Discovery walker errors: {}",
                files.walker_errors.join("; ")
            ));
        }
        if !files.tsconfigs.is_empty() {
            ProviderDetection::Present
        } else {
            ProviderDetection::Absent
        }
    }

    fn scope(&self, repo_root: &Path) -> BuildProviderScope {
        let files = discover_build_files(repo_root);
        BuildProviderScope {
            workspace_root: ".".to_string(),
            manifest_files: files.tsconfigs,
        }
    }

    fn passive_fingerprint(&self, repo_root: &Path) -> Result<String, String> {
        let scope = self.scope(repo_root);
        Ok(hash_files(
            repo_root,
            &scope.manifest_files,
            TSCONFIG_PROVIDER_VERSION,
        ))
    }

    fn ingest(&self, repo_root: &Path) -> Result<BuildIngestResult, String> {
        let files = discover_build_files(repo_root);
        let mut bounds = BuildBoundsCollector::default();

        let global_fingerprint = hash_files(repo_root, &files.tsconfigs, TSCONFIG_PROVIDER_VERSION);

        let mut res = BuildIngestResult {
            fingerprint: global_fingerprint.clone(),
            ..Default::default()
        };

        if files.tsconfigs_truncated || !files.walker_errors.is_empty() {
            res.uncertainties.push(BuildUncertainty::new(
                "build_limit_reached",
                UncertaintyScope::Repository,
                TSCONFIG_PROVIDER_ID,
                format!(
                    "Discovery limits reached or walker errors encountered (tsconfig limit {})",
                    MAX_DISCOVERED_CONFIGS
                ),
                AssuranceLevel::Degraded,
                true,
            ));
        }

        let mut extends_map: Vec<(String, String)> = Vec::new();
        let mut references_map: Vec<(String, String)> = Vec::new();
        let mut config_fingerprints: HashMap<String, String> = HashMap::new();

        for config_path in &files.tsconfigs {
            let scope_fp = hash_files(
                repo_root,
                std::slice::from_ref(config_path),
                TSCONFIG_PROVIDER_VERSION,
            );
            config_fingerprints.insert(config_path.clone(), scope_fp);
        }

        for config_path in &files.tsconfigs {
            let full = repo_root.join(config_path);
            let scope_fp = config_fingerprints
                .get(config_path)
                .cloned()
                .unwrap_or_else(|| global_fingerprint.clone());

            let raw_content = match std::fs::read_to_string(&full) {
                Ok(c) => c,
                Err(e) => {
                    res.uncertainties.push(BuildUncertainty::new(
                        "config_read_error",
                        UncertaintyScope::Config(config_path.clone()),
                        TSCONFIG_PROVIDER_ID,
                        format!("Failed to read {}: {}", config_path, e),
                        AssuranceLevel::Degraded,
                        true,
                    ));
                    continue;
                }
            };

            let cleaned = clean_jsonc(&raw_content);
            let val: Value = match serde_json::from_str(&cleaned) {
                Ok(v) => v,
                Err(e) => {
                    res.uncertainties.push(BuildUncertainty::new(
                        "malformed_tsconfig",
                        UncertaintyScope::Config(config_path.clone()),
                        TSCONFIG_PROVIDER_ID,
                        format!("Malformed tsconfig in {}: {}", config_path, e),
                        AssuranceLevel::Degraded,
                        true,
                    ));
                    continue;
                }
            };

            let config_stable_id = format!("config:{}", config_path);
            let file_stable_id = format!("file:{}", config_path);

            let mut extends_target = None;
            if let Some(ext_val) = val.get("extends").and_then(|e| e.as_str()) {
                if let Some(resolved) =
                    resolve_relative_config_path(config_path, ext_val, repo_root)
                {
                    extends_target = Some(format!("config:{}", resolved));
                    extends_map.push((config_path.clone(), resolved));
                } else {
                    res.uncertainties.push(BuildUncertainty::new(
                        "dynamic_config_expression",
                        UncertaintyScope::Config(config_path.clone()),
                        TSCONFIG_PROVIDER_ID,
                        format!(
                            "Unsupported or non-relative tsconfig extends '{}' in {}",
                            ext_val, config_path
                        ),
                        AssuranceLevel::Degraded,
                        true,
                    ));
                }
            }

            let mut refs = Vec::new();
            if let Some(refs_arr) = val.get("references").and_then(|r| r.as_array()) {
                for item in refs_arr {
                    if let Some(path_str) = item.get("path").and_then(|p| p.as_str()) {
                        if let Some(resolved) =
                            resolve_relative_config_path(config_path, path_str, repo_root)
                        {
                            let ref_target = format!("config:{}", resolved);
                            refs.push(ref_target);
                            references_map.push((config_path.clone(), resolved));
                        } else {
                            res.uncertainties.push(BuildUncertainty::new(
                                "dynamic_config_expression",
                                UncertaintyScope::Config(config_path.clone()),
                                TSCONFIG_PROVIDER_ID,
                                format!(
                                    "Unsupported or unresolvable project reference '{}' in {}",
                                    path_str, config_path
                                ),
                                AssuranceLevel::Degraded,
                                true,
                            ));
                        }
                    } else {
                        res.uncertainties.push(BuildUncertainty::new(
                            "malformed_config",
                            UncertaintyScope::Config(config_path.clone()),
                            TSCONFIG_PROVIDER_ID,
                            format!("Malformed project reference item in {}", config_path),
                            AssuranceLevel::Degraded,
                            true,
                        ));
                    }
                }
            }

            // Check outDir for generated artifacts
            if let Some(out_dir) = val
                .get("compilerOptions")
                .and_then(|co| co.get("outDir"))
                .and_then(|od| od.as_str())
            {
                let parent_dir = Path::new(config_path).parent().unwrap_or(Path::new(""));
                let artifact_dir = parent_dir.join(out_dir);
                if let Ok(canon_artifact) = canonicalize_repo_path(&artifact_dir, Path::new("")) {
                    let artifact_id = format!("artifact:{}", canon_artifact);
                    bounds.push_bounded_artifact(
                        &mut res.artifacts,
                        &mut res.uncertainties,
                        GeneratedArtifact {
                            stable_id: artifact_id.clone(),
                            canonical_path: canon_artifact.clone(),
                            generated_by: config_stable_id.clone(),
                        },
                        MAX_DISCOVERED_ARTIFACTS,
                        TSCONFIG_PROVIDER_ID,
                        UncertaintyScope::Config(config_path.clone()),
                    );

                    res.nodes.push(BuildNode {
                        stable_id: artifact_id.clone(),
                        kind: NodeKind::GeneratedArtifact,
                        canonical_path: Some(canon_artifact),
                        metadata: None,
                    });
                    // Config / target GENERATES artifact
                    bounds.push_bounded_edge(
                        &mut res.edges,
                        &mut res.uncertainties,
                        BuildEdge {
                            stable_id: format!(
                                "edge:generates:{}:{}",
                                config_stable_id, artifact_id
                            ),
                            from_node: config_stable_id.clone(),
                            to_node: artifact_id,
                            kind: EdgeKind::Generates,
                            provider: "build_native".to_string(),
                            provider_id: TSCONFIG_PROVIDER_ID.to_string(),
                            provider_fingerprint: scope_fp.clone(),
                            strength: EvidenceStrength::Structural,
                            metadata: None,
                        },
                        MAX_DISCOVERED_EDGES,
                        TSCONFIG_PROVIDER_ID,
                        UncertaintyScope::Config(config_path.clone()),
                    );
                }
            }

            // Node for config
            res.nodes.push(BuildNode {
                stable_id: config_stable_id.clone(),
                kind: NodeKind::Config,
                canonical_path: Some(config_path.clone()),
                metadata: Some(
                    serde_json::json!({
                        "config_kind": "tsconfig",
                        "path": config_path,
                    })
                    .to_string(),
                ),
            });

            // Node for underlying file
            res.nodes.push(BuildNode {
                stable_id: file_stable_id.clone(),
                kind: NodeKind::File,
                canonical_path: Some(config_path.clone()),
                metadata: None,
            });

            // Edge: file DEFINES config
            bounds.push_bounded_edge(
                &mut res.edges,
                &mut res.uncertainties,
                BuildEdge {
                    stable_id: format!("edge:defines:{}:{}", file_stable_id, config_stable_id),
                    from_node: file_stable_id,
                    to_node: config_stable_id.clone(),
                    kind: EdgeKind::Defines,
                    provider: "build_native".to_string(),
                    provider_id: TSCONFIG_PROVIDER_ID.to_string(),
                    provider_fingerprint: scope_fp.clone(),
                    strength: EvidenceStrength::Structural,
                    metadata: None,
                },
                MAX_DISCOVERED_EDGES,
                TSCONFIG_PROVIDER_ID,
                UncertaintyScope::Config(config_path.clone()),
            );

            // Link config to owning package
            let dir = Path::new(config_path)
                .parent()
                .and_then(|p| p.to_str())
                .unwrap_or(".");
            let dir_str = if dir.is_empty() { "." } else { dir };
            let pkg_stable_id = format!("pkg:npm:{}", dir_str);

            // Ensure package node exists
            res.nodes.push(BuildNode {
                stable_id: pkg_stable_id.clone(),
                kind: NodeKind::Package,
                canonical_path: Some(dir_str.to_string()),
                metadata: None,
            });

            // Edge: config CONFIGURES package
            bounds.push_bounded_edge(
                &mut res.edges,
                &mut res.uncertainties,
                BuildEdge {
                    stable_id: format!("edge:configures:{}:{}", config_stable_id, pkg_stable_id),
                    from_node: config_stable_id.clone(),
                    to_node: pkg_stable_id.clone(),
                    kind: EdgeKind::Configures,
                    provider: "build_native".to_string(),
                    provider_id: TSCONFIG_PROVIDER_ID.to_string(),
                    provider_fingerprint: scope_fp.clone(),
                    strength: EvidenceStrength::Structural,
                    metadata: None,
                },
                MAX_DISCOVERED_EDGES,
                TSCONFIG_PROVIDER_ID,
                UncertaintyScope::Config(config_path.clone()),
            );

            res.configs.push(ConfigFile {
                stable_id: config_stable_id,
                canonical_path: config_path.clone(),
                config_kind: ConfigKind::TsConfig,
                extends: extends_target,
                references: refs,
                configures_packages: vec![pkg_stable_id],
            });
        }

        // Add extends edges
        for (from_cfg, to_cfg) in &extends_map {
            let from_node = format!("config:{}", from_cfg);
            let to_node = format!("config:{}", to_cfg);
            let edge_id = format!("edge:extends:{}:{}", from_node, to_node);
            let scope_fp = config_fingerprints
                .get(from_cfg)
                .cloned()
                .unwrap_or_else(|| global_fingerprint.clone());

            bounds.push_bounded_edge(
                &mut res.edges,
                &mut res.uncertainties,
                BuildEdge {
                    stable_id: edge_id,
                    from_node,
                    to_node,
                    kind: EdgeKind::Extends,
                    provider: "build_native".to_string(),
                    provider_id: TSCONFIG_PROVIDER_ID.to_string(),
                    provider_fingerprint: scope_fp,
                    strength: EvidenceStrength::Structural,
                    metadata: None,
                },
                MAX_DISCOVERED_EDGES,
                TSCONFIG_PROVIDER_ID,
                UncertaintyScope::Config(from_cfg.clone()),
            );
        }

        // Add references edges
        for (from_cfg, to_cfg) in &references_map {
            let from_node = format!("config:{}", from_cfg);
            let to_node = format!("config:{}", to_cfg);
            let edge_id = format!("edge:references:{}:{}", from_node, to_node);
            let scope_fp = config_fingerprints
                .get(from_cfg)
                .cloned()
                .unwrap_or_else(|| global_fingerprint.clone());

            bounds.push_bounded_edge(
                &mut res.edges,
                &mut res.uncertainties,
                BuildEdge {
                    stable_id: edge_id,
                    from_node,
                    to_node,
                    kind: EdgeKind::References,
                    provider: "build_native".to_string(),
                    provider_id: TSCONFIG_PROVIDER_ID.to_string(),
                    provider_fingerprint: scope_fp,
                    strength: EvidenceStrength::Structural,
                    metadata: None,
                },
                MAX_DISCOVERED_EDGES,
                TSCONFIG_PROVIDER_ID,
                UncertaintyScope::Config(from_cfg.clone()),
            );
        }

        // Check for cycles in extends / references
        for config_path in &files.tsconfigs {
            let mut visited = HashSet::new();
            let mut current = config_path.clone();
            let mut depth = 0;

            while let Some((_, parent)) = extends_map.iter().find(|(c, _)| c == &current) {
                visited.insert(current.clone());
                if visited.contains(parent) {
                    res.uncertainties.push(BuildUncertainty::new(
                        "config_cycle_detected",
                        UncertaintyScope::Config(config_path.clone()),
                        TSCONFIG_PROVIDER_ID,
                        format!(
                            "Cycle detected in tsconfig extends chain at {}",
                            config_path
                        ),
                        AssuranceLevel::Degraded,
                        true,
                    ));
                    break;
                }
                depth += 1;
                if depth > MAX_CONFIG_RECURSION_DEPTH {
                    res.uncertainties.push(BuildUncertainty::new(
                        "config_depth_limit_reached",
                        UncertaintyScope::Config(config_path.clone()),
                        TSCONFIG_PROVIDER_ID,
                        format!(
                            "Max recursion depth exceeded in tsconfig chain at {}",
                            config_path
                        ),
                        AssuranceLevel::Degraded,
                        true,
                    ));
                    break;
                }
                current = parent.clone();
            }
        }

        Ok(res)
    }
}
