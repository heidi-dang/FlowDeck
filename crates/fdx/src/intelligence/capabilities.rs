//! Milestone 12 local capability contract.
//!
//! This module reports compiled local support only. It performs no network access,
//! no update checks, and no telemetry. Consumers must reject an unknown capability
//! contract before using it for authority-bearing compatibility decisions.

use crate::intelligence::calibration::model::CALIBRATION_CONTRACT_VERSION;
use crate::intelligence::policy::model::POLICY_CONTRACT_VERSION;
use crate::protocol::{
    FDX_CAPABILITY_CONTRACT_VERSION, FDX_GRAPH_SCHEMA_VERSION, FDX_PROTOCOL_VERSION,
    FDX_SELECTION_POLICY_VERSION,
};
use serde::{Deserialize, Serialize};

pub const CAPABILITY_CONTRACT_VERSION: u32 = FDX_CAPABILITY_CONTRACT_VERSION;
pub const MINIMUM_READABLE_GRAPH_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VersionAuthority {
    pub minimum_readable: u32,
    pub maximum_writable: u32,
    pub can_read: bool,
    pub can_write: bool,
    pub can_verify: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalCapabilityState {
    pub compiled_in: bool,
    pub state: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeExecutionCapability {
    pub available: bool,
    pub mode: String,
    pub limitations: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalCapabilities {
    pub capability_contract_version: u32,
    pub fdx_protocol_version: u32,
    pub graph_schema: VersionAuthority,
    pub selection_policy_version: u32,
    pub verification_predicate_versions: Vec<String>,
    pub calibration_contract_versions: Vec<u32>,
    pub policy_contract_versions: Vec<u32>,
    pub assurance_levels: Vec<String>,
    pub scip: LocalCapabilityState,
    pub tree_sitter: LocalCapabilityState,
    pub native_execution: NativeExecutionCapability,
    pub platform: String,
    pub platform_limitations: Vec<String>,
    pub network_access: bool,
    pub telemetry: bool,
}

/// Return the canonical capability document for this local binary.
pub fn local_capabilities() -> LocalCapabilities {
    let platform = std::env::consts::OS.to_string();
    let platform_limitations = match std::env::consts::OS {
        "windows" => vec![
            "native process execution is supported; filesystem symlink and NOFOLLOW behavior is platform-dependent and remains fail-closed".to_string(),
            "release artifact paths use platform-specific executable suffixes".to_string(),
        ],
        "macos" => vec![
            "native process execution is supported; release qualification must be performed separately on macOS".to_string(),
        ],
        "linux" => vec![
            "native process execution is supported; release qualification applies only to the tested Linux target".to_string(),
        ],
        _ => vec![
            "native process execution is best-effort on this platform and authority-bearing path safety remains fail-closed".to_string(),
        ],
    };

    LocalCapabilities {
        capability_contract_version: CAPABILITY_CONTRACT_VERSION,
        fdx_protocol_version: FDX_PROTOCOL_VERSION,
        graph_schema: VersionAuthority {
            minimum_readable: MINIMUM_READABLE_GRAPH_SCHEMA_VERSION,
            maximum_writable: FDX_GRAPH_SCHEMA_VERSION,
            can_read: true,
            can_write: true,
            can_verify: true,
        },
        selection_policy_version: FDX_SELECTION_POLICY_VERSION,
        verification_predicate_versions: vec!["v1".to_string(), "v2".to_string()],
        calibration_contract_versions: vec![CALIBRATION_CONTRACT_VERSION],
        policy_contract_versions: vec![POLICY_CONTRACT_VERSION],
        assurance_levels: vec![
            "EXACT".to_string(),
            "CONSERVATIVE".to_string(),
            "UNVERIFIED".to_string(),
        ],
        scip: LocalCapabilityState {
            compiled_in: true,
            state: "local_optional".to_string(),
        },
        tree_sitter: LocalCapabilityState {
            compiled_in: true,
            state: "local_available".to_string(),
        },
        native_execution: NativeExecutionCapability {
            available: true,
            mode: "local_process".to_string(),
            limitations: platform_limitations.clone(),
        },
        platform,
        platform_limitations,
        network_access: false,
        telemetry: false,
    }
}

/// Validate a requested capabilities contract before it is used as compatibility authority.
pub fn require_supported_capability_contract(requested: u32) -> Result<LocalCapabilities, String> {
    if requested != CAPABILITY_CONTRACT_VERSION {
        return Err(format!(
            "unsupported capability contract version {requested}; this binary supports exactly {CAPABILITY_CONTRACT_VERSION}"
        ));
    }
    Ok(local_capabilities())
}
