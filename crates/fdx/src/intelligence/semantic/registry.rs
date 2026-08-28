//! Provider registry: the concrete SCIP providers FDX knows about.

use crate::intelligence::semantic::provider::SemanticProvider;
use crate::intelligence::semantic::scip::rust::ScipRustProvider;
use crate::intelligence::semantic::scip::ts::ScipTypescriptProvider;
use crate::intelligence::semantic::LanguageId;

/// Registry of Milestone 3 providers. Discovery tolerates absence:
/// missing executables are reported through provider health/discovery,
/// never auto-downloaded.
#[derive(Debug, Default)]
pub struct ProviderRegistry {
    pub typescript: ScipTypescriptProvider,
    pub rust: ScipRustProvider,
}

impl ProviderRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn providers(&self) -> Vec<&dyn SemanticProvider> {
        vec![&self.typescript, &self.rust]
    }

    pub fn by_id(&self, id: &str) -> Option<&dyn SemanticProvider> {
        self.providers().into_iter().find(|p| p.id() == id)
    }

    pub fn for_language(&self, lang: LanguageId) -> Vec<&dyn SemanticProvider> {
        self.providers()
            .into_iter()
            .filter(|p| p.languages().contains(&lang))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_lists_both_providers() {
        let registry = ProviderRegistry::new();
        let ids: Vec<&str> = registry.providers().iter().map(|p| p.id()).collect();
        assert!(ids.contains(&"scip-typescript"));
        assert!(ids.contains(&"scip-rust"));
    }

    #[test]
    fn registry_routes_by_language() {
        let registry = ProviderRegistry::new();
        let rust_providers = registry.for_language(LanguageId::Rust);
        assert_eq!(rust_providers.len(), 1);
        assert_eq!(rust_providers[0].id(), "scip-rust");
        let ts_providers = registry.for_language(LanguageId::TypeScript);
        assert_eq!(ts_providers.len(), 1);
        assert_eq!(ts_providers[0].id(), "scip-typescript");
    }
}
