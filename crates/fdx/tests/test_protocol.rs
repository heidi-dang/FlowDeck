use fdx::protocol::{
    canonicalize_repo_path, AssuranceCeiling, AssuranceLevel, EdgeKind, EvidenceProviderKind,
    EvidenceRef, EvidenceStrength, FreshnessMetadata, GraphCompatibility, ImpactScope,
    NegotiateRequest, NegotiateResponse, NodeKind, PathCanonicalizationError, QueryIntent,
    RiskSeverity, Uncertainty, UnknownTrigger, FDX_ATTESTATION_PREDICATE_VERSION,
    FDX_GRAPH_SCHEMA_VERSION, FDX_PROTOCOL_VERSION, FDX_SELECTION_POLICY_VERSION,
};
use std::path::Path;

#[test]
fn test_version_constants() {
    assert_eq!(FDX_PROTOCOL_VERSION, 2);
    assert_eq!(FDX_GRAPH_SCHEMA_VERSION, 8);
    assert_eq!(FDX_SELECTION_POLICY_VERSION, 1);
    assert_eq!(FDX_ATTESTATION_PREDICATE_VERSION, 1);
}

#[test]
fn test_evidence_strength_ordering() {
    assert!(EvidenceStrength::Precise > EvidenceStrength::Observed);
    assert!(EvidenceStrength::Observed > EvidenceStrength::Structural);
    assert!(EvidenceStrength::Structural > EvidenceStrength::Heuristic);
    assert!(EvidenceStrength::Heuristic > EvidenceStrength::Unknown);
}

#[test]
fn test_assurance_level_ordering() {
    assert!(AssuranceLevel::Exact > AssuranceLevel::Conservative);
    assert!(AssuranceLevel::Conservative > AssuranceLevel::Degraded);
    assert!(AssuranceLevel::Degraded > AssuranceLevel::Unverified);
}

#[test]
fn test_unknown_triggers_exhaustive_escalation() {
    let triggers = [
        UnknownTrigger::DynamicImport,
        UnknownTrigger::Reflection,
        UnknownTrigger::Eval,
        UnknownTrigger::RuntimePluginLoading,
        UnknownTrigger::DependencyInjection,
        UnknownTrigger::LockfileChange,
        UnknownTrigger::BuildConfigChange,
        UnknownTrigger::CompilerConfigChange,
        UnknownTrigger::SchemaChange,
        UnknownTrigger::GeneratedArtifactChange,
        UnknownTrigger::UnsupportedLanguage,
        UnknownTrigger::StaleSemanticProvider,
        UnknownTrigger::ProviderMismatch,
        UnknownTrigger::ExternalContractChange,
        UnknownTrigger::TestOrderDependency,
    ];

    for trigger in triggers {
        let (scope, severity) = trigger.escalation_policy();
        assert!(scope >= ImpactScope::Package || scope == ImpactScope::Target);
        assert!(severity >= RiskSeverity::Low);

        let uncertainty = Uncertainty::from_trigger(trigger, Some("test uncertainty".to_string()));
        assert_eq!(uncertainty.trigger, trigger);
        assert_eq!(uncertainty.scope, scope);
        assert_eq!(uncertainty.severity, severity);
        assert_eq!(uncertainty.details.as_deref(), Some("test uncertainty"));
    }
}

#[test]
fn test_path_canonicalization() {
    let root = Path::new("/workspace/project");

    // Valid relative path
    assert_eq!(
        canonicalize_repo_path(Path::new("src/auth/jwt.ts"), root).unwrap(),
        "src/auth/jwt.ts"
    );

    // Absolute path inside root
    assert_eq!(
        canonicalize_repo_path(Path::new("/workspace/project/src/index.ts"), root).unwrap(),
        "src/index.ts"
    );

    // Redundant separators & curdirs
    assert_eq!(
        canonicalize_repo_path(Path::new("./src/./models/../models/user.ts"), root).unwrap(),
        "src/models/user.ts"
    );

    // Escape root jail
    assert_eq!(
        canonicalize_repo_path(Path::new("../../etc/passwd"), root),
        Err(PathCanonicalizationError::EscapesRoot(
            "../../etc/passwd".to_string()
        ))
    );

    // Empty path
    assert_eq!(
        canonicalize_repo_path(Path::new(""), root),
        Err(PathCanonicalizationError::EmptyPath)
    );
}

#[test]
fn test_capability_negotiation() {
    let req = NegotiateRequest {
        protocol: 2,
        capabilities: vec![
            "search".to_string(),
            "vci-v1".to_string(),
            "unsupported-feat".to_string(),
        ],
    };
    let resp = NegotiateResponse::negotiate(&req);

    assert_eq!(resp.protocol, 2);
    assert_eq!(resp.selected_capabilities, vec!["search"]);
    assert!(resp.server_capabilities.contains(&"search".to_string()));
    assert!(resp.server_capabilities.contains(&"impact-v2".to_string()));
    assert!(resp.server_capabilities.contains(&"why-v1".to_string()));
    assert!(!resp
        .server_capabilities
        .contains(&"unsupported-feat".to_string()));
    assert_eq!(resp.graph_schema_version, FDX_GRAPH_SCHEMA_VERSION);
}

#[test]
fn test_json_serialization_roundtrip() {
    let evidence_ref = EvidenceRef {
        provider: EvidenceProviderKind::Scip,
        provider_fingerprint: "scip-typescript-0.4.0".to_string(),
        strength: EvidenceStrength::Precise,
        source_identity: "src/auth/jwt.ts#verifyToken".to_string(),
        source_hash: Some("sha256:abc123def456".to_string()),
        freshness: FreshnessMetadata {
            recorded_at: 1710000000,
            source_mtime_ms: Some(1709999000),
            source_content_hash: Some("hash123".to_string()),
            is_stale: false,
        },
    };

    let json = serde_json::to_string(&evidence_ref).unwrap();
    let deserialized: EvidenceRef = serde_json::from_str(&json).unwrap();
    assert_eq!(evidence_ref, deserialized);
}

#[test]
fn test_graph_compatibility_defaults() {
    let compat = GraphCompatibility::default();
    assert_eq!(compat.graph_schema_version, FDX_GRAPH_SCHEMA_VERSION);
    assert_eq!(
        compat.selection_policy_version,
        FDX_SELECTION_POLICY_VERSION
    );
    assert!(!compat.provider_fingerprint.is_empty());
}

#[test]
fn test_node_edge_and_assurance_ceiling() {
    let node = NodeKind::Symbol;
    let edge = EdgeKind::Calls;
    let intent = QueryIntent::Impact;
    assert_eq!(node, NodeKind::Symbol);
    assert_eq!(edge, EdgeKind::Calls);
    assert_eq!(intent, QueryIntent::Impact);

    let ceiling = AssuranceCeiling::default();
    assert_eq!(ceiling.max_level, AssuranceLevel::Exact);
    assert!(ceiling.limiting_reasons.is_empty());
}

#[test]
fn test_path_jail_escaping() {
    let root = Path::new("/workspace/project");

    let result = canonicalize_repo_path(Path::new("/etc/passwd"), root);
    assert_eq!(
        result,
        Err(PathCanonicalizationError::EscapesRoot(
            "/etc/passwd".to_string()
        ))
    );
}

#[test]
fn test_capability_invariant_operations_exist() {
    // Every advertised operational capability must correspond to a real operation.
    let expected = vec![
        "read",
        "search",
        "outline",
        "impact-v1",
        "evidence-graph-v1",
        "semantic-status-v1",
        "impact-v2",
        "why-v1",
    ];
    let req = NegotiateRequest {
        protocol: 2,
        capabilities: expected.iter().map(|&s| s.to_string()).collect(),
    };
    let resp = NegotiateResponse::negotiate(&req);

    // Server should advertise exactly what it supports.
    assert_eq!(resp.server_capabilities.len(), expected.len());
    for &cap in &expected {
        assert!(
            resp.server_capabilities.contains(&cap.to_string()),
            "Missing capability: {}",
            cap
        );
    }
}

#[test]
fn test_empty_capability_request() {
    let req = NegotiateRequest {
        protocol: 2,
        capabilities: vec![],
    };
    let resp = NegotiateResponse::negotiate(&req);
    let expected = vec![
        "read",
        "search",
        "outline",
        "impact-v1",
        "evidence-graph-v1",
        "semantic-status-v1",
        "impact-v2",
        "why-v1",
    ];
    assert_eq!(resp.selected_capabilities, expected);
    // Server should still advertise all capabilities
    assert_eq!(resp.server_capabilities.len(), 8);
}
