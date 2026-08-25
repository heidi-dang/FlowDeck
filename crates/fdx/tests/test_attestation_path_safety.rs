use fdx::intelligence::attestation::validate_run_id;

#[test]
fn test_path_traversal_run_ids_rejected() {
    assert!(validate_run_id("../secret").is_err());
    assert!(validate_run_id("foo/bar").is_err());
    assert!(validate_run_id("foo\\bar").is_err());
    assert!(validate_run_id(".hidden").is_err());
    assert!(validate_run_id("").is_err());
    assert!(validate_run_id("valid-run-id-123_456").is_ok());
}
