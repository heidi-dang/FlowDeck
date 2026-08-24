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
