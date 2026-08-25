use fdx::intelligence::capabilities::{
    local_capabilities, require_supported_capability_contract, CAPABILITY_CONTRACT_VERSION,
};
use fdx::protocol::{
    NegotiateRequest, NegotiateResponse, FDX_GRAPH_SCHEMA_VERSION,
    FDX_SUPPORTED_ATTESTATION_PREDICATE_VERSIONS,
};

#[test]
fn local_capabilities_are_deterministic_and_explicitly_local() {
    let first = local_capabilities();
    let second = local_capabilities();
    assert_eq!(first, second);
    assert!(!first.network_access);
    assert!(!first.telemetry);
    assert_eq!(first.capability_contract_version, 1);
    assert_eq!(first.graph_schema.minimum_readable, 1);
    assert_eq!(
        first.graph_schema.maximum_writable,
        FDX_GRAPH_SCHEMA_VERSION
    );
    assert!(first.graph_schema.can_read);
    assert!(first.graph_schema.can_write);
    assert!(first.graph_schema.can_verify);
    assert_eq!(first.verification_predicate_versions, vec!["v1", "v2"]);
    assert_eq!(first.calibration_contract_versions, vec![2]);
    assert_eq!(first.policy_contract_versions, vec![1]);
    assert!(first.scip.compiled_in);
    assert!(first.tree_sitter.compiled_in);
    assert!(first.native_execution.available);

    let first_json = serde_json::to_vec(&first).unwrap();
    let second_json = serde_json::to_vec(&second).unwrap();
    assert_eq!(first_json, second_json);
}

#[test]
fn capability_contract_rejects_future_or_legacy_authority() {
    assert!(require_supported_capability_contract(CAPABILITY_CONTRACT_VERSION).is_ok());
    let legacy = require_supported_capability_contract(0).unwrap_err();
    assert!(legacy.contains("unsupported capability contract version"));
    let future =
        require_supported_capability_contract(CAPABILITY_CONTRACT_VERSION + 1).unwrap_err();
    assert!(future.contains("unsupported capability contract version"));
}

#[test]
fn capabilities_cli_emits_local_machine_readable_contract_and_rejects_future_version() {
    let binary = env!("CARGO_BIN_EXE_fdx");
    let output = std::process::Command::new(binary)
        .args(["capabilities", "--format", "json"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["capability_contract_version"], 1);
    assert_eq!(
        value["verification_predicate_versions"],
        serde_json::json!(["v1", "v2"])
    );
    assert_eq!(value["network_access"], false);
    assert_eq!(value["telemetry"], false);

    let unsupported = std::process::Command::new(binary)
        .args([
            "capabilities",
            "--contract-version",
            "2",
            "--format",
            "json",
        ])
        .output()
        .unwrap();
    assert!(!unsupported.status.success());
    assert!(String::from_utf8_lossy(&unsupported.stderr)
        .contains("unsupported capability contract version"));
}

#[test]
fn negotiation_keeps_v1_default_and_adds_m12_capability_lists() {
    let response = NegotiateResponse::negotiate(&NegotiateRequest {
        protocol: 99,
        capabilities: vec![],
    });
    assert_eq!(response.attestation_predicate_version, 1);
    assert_eq!(
        response.attestation_predicate_versions,
        FDX_SUPPORTED_ATTESTATION_PREDICATE_VERSIONS
    );
    assert_eq!(
        response.capability_contract_version,
        CAPABILITY_CONTRACT_VERSION
    );
    assert_eq!(response.calibration_contract_versions, vec![2]);
    assert_eq!(response.policy_contract_versions, vec![1]);
    assert_eq!(response.graph_schema_version, FDX_GRAPH_SCHEMA_VERSION);
}
