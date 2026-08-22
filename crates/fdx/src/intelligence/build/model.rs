//! Core models and data structures for build and configuration graph federation.

use crate::protocol::{EdgeKind, EvidenceStrength, NodeKind};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PackageEcosystem {
    Npm,
    Cargo,
    Unknown,
}

impl PackageEcosystem {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Npm => "npm",
            Self::Cargo => "cargo",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BuildTargetKind {
    Script,
    Binary,
    Library,
    Test,
    Example,
    Custom,
}

impl BuildTargetKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Script => "script",
            Self::Binary => "bin",
            Self::Library => "lib",
            Self::Test => "test",
            Self::Example => "example",
            Self::Custom => "custom",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfigKind {
    TsConfig,
    CargoToml,
    PackageJson,
    PnpmWorkspace,
    Custom,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Workspace {
    pub stable_id: String,
    pub root_path: String,
    pub manifest_path: String,
    pub ecosystem: PackageEcosystem,
    pub members: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageDependency {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_req: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default)]
    pub is_workspace_dep: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_package_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Package {
    pub stable_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub manifest_path: String,
    pub directory: String,
    pub ecosystem: PackageEcosystem,
    pub dependencies: Vec<PackageDependency>,
    pub build_targets: Vec<String>,
    pub config_files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BuildTarget {
    pub stable_id: String,
    pub package_id: String,
    pub name: String,
    pub target_kind: BuildTargetKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_or_path: Option<String>,
    pub reads_configs: Vec<String>,
    pub generates_artifacts: Vec<String>,
    pub depends_on_targets: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConfigFile {
    pub stable_id: String,
    pub canonical_path: String,
    pub config_kind: ConfigKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extends: Option<String>,
    pub references: Vec<String>,
    pub configures_packages: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GeneratedArtifact {
    pub stable_id: String,
    pub canonical_path: String,
    pub generated_by: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExternalDependency {
    pub stable_id: String,
    pub ecosystem: PackageEcosystem,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BuildNode {
    pub stable_id: String,
    pub kind: NodeKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canonical_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BuildEdge {
    pub stable_id: String,
    pub from_node: String,
    pub to_node: String,
    pub kind: EdgeKind,
    pub provider: String,
    pub provider_id: String,
    pub provider_fingerprint: String,
    pub strength: EvidenceStrength,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BuildTopology {
    pub workspaces: Vec<Workspace>,
    pub packages: Vec<Package>,
    pub targets: Vec<BuildTarget>,
    pub configs: Vec<ConfigFile>,
    pub artifacts: Vec<GeneratedArtifact>,
    pub external_dependencies: Vec<ExternalDependency>,
    pub nodes: Vec<BuildNode>,
    pub edges: Vec<BuildEdge>,
}
