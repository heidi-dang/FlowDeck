use fdx::intelligence::attestation::model::*;

#[test]
fn test_predicate_version_and_uri_constants() {
    assert_eq!(IN_TOTO_STATEMENT_V1_TYPE, "https://in-toto.io/Statement/v1");
    assert_eq!(
        FDX_VERIFICATION_PREDICATE_V1_TYPE,
        "https://flowdeck.dev/attestation/vci/verification/v1"
    );
    assert_eq!(FDX_ATTESTATION_PREDICATE_VERSION, 1);
}

#[test]
fn test_source_context_workspace_clean_omitted_when_none() {
    let ctx = SourceContext {
        base_ref: Some("main".to_string()),
        head_ref: Some("HEAD".to_string()),
        changed_files_count: 3,
        impacted_targets_count: 1,
        workspace_clean: None,
    };

    let serialized = serde_json::to_string(&ctx).unwrap();
    assert!(!serialized.contains("workspace_clean"));
}
