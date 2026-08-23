//! Verification selection policy and rule definitions.

#[derive(Debug, Clone)]
pub struct VerificationPolicy {
    pub include_unit_tests: bool,
    pub include_integration_tests: bool,
    pub include_typecheck: bool,
    pub include_lint: bool,
    pub include_build: bool,
    pub mandatory_package_checks: bool,
}

impl Default for VerificationPolicy {
    fn default() -> Self {
        Self {
            include_unit_tests: true,
            include_integration_tests: true,
            include_typecheck: true,
            include_lint: true,
            include_build: true,
            mandatory_package_checks: true,
        }
    }
}
