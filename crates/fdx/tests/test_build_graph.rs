use fdx::intelligence::build::model::*;
use fdx::protocol::{EdgeKind, EvidenceStrength, NodeKind};

#[test]
fn test_build_graph_node_and_edge_creation() {
    let ws_node = BuildNode {
        stable_id: "workspace:npm:.".to_string(),
        kind: NodeKind::Workspace,
        canonical_path: Some(".".to_string()),
        metadata: None,
    };
    assert_eq!(ws_node.stable_id, "workspace:npm:.");
    assert_eq!(ws_node.kind, NodeKind::Workspace);

    let pkg_node = BuildNode {
        stable_id: "pkg:npm:packages/web".to_string(),
        kind: NodeKind::Package,
        canonical_path: Some("packages/web".to_string()),
        metadata: Some(r#"{"name":"@app/web"}"#.to_string()),
    };
    assert_eq!(pkg_node.stable_id, "pkg:npm:packages/web");
    assert_eq!(pkg_node.kind, NodeKind::Package);

    let target_node = BuildNode {
        stable_id: "build:pkg:npm:packages/web:script:build".to_string(),
        kind: NodeKind::BuildTarget,
        canonical_path: Some("packages/web".to_string()),
        metadata: None,
    };
    assert_eq!(target_node.kind, NodeKind::BuildTarget);

    let edge = BuildEdge {
        stable_id: "edge:contains:workspace:npm:.:pkg:npm:packages/web".to_string(),
        from_node: "workspace:npm:.".to_string(),
        to_node: "pkg:npm:packages/web".to_string(),
        kind: EdgeKind::Contains,
        provider: "build_native".to_string(),
        provider_id: "builtin-package-json".to_string(),
        provider_fingerprint: "fp123".to_string(),
        strength: EvidenceStrength::Structural,
        metadata: None,
    };
    assert_eq!(edge.kind, EdgeKind::Contains);
    assert_eq!(edge.strength, EvidenceStrength::Structural);
}
