use fdx::intelligence::build::package::parse_pnpm_workspace_packages;

#[test]
fn test_pnpm_yaml_parsing_and_negation() {
    let yaml_content = r#"
packages:
  - "packages/*"
  - "apps/**"
  - "!packages/ignored"
  - "!packages/legacy-*"
"#;

    let pats = parse_pnpm_workspace_packages(yaml_content).unwrap();
    assert_eq!(pats.len(), 4);
    assert_eq!(pats[0], "packages/*");
    assert_eq!(pats[2], "!packages/ignored");

    // Test malformed YAML fails parsing
    let malformed = "packages: [invalid yaml";
    let res = parse_pnpm_workspace_packages(malformed);
    assert!(res.is_err());
}
