//! Semantic provider abstraction and SCIP evidence ingestion.
//!
//! Milestone 3 architectural boundary. The separation is:
//!
//! ```text
//! provider discovery   — locate an installed indexer (never download)
//! provider fingerprint — stable identity of executable + config + SCIP version
//! provider health      — can the provider run? (health.rs)
//! provider execution   — bounded, shell-free subprocess (provider.rs)
//! SCIP parsing         — generic bounded decoder (scip/)
//! EvidenceGraph ingest — transactional provider-owned publication (ingest.rs)
//! routing              — adaptive intent-aware source selection (router.rs)
//! ```
//!
//! Core invariant: semantic evidence may improve precision, but unavailable,
//! stale, incomplete, failed, or unsupported semantic evidence must never be
//! interpreted as negative evidence.

pub mod fallback;
pub mod health;
pub mod ingest;
pub mod limits;
pub mod provider;
pub mod query;
pub mod registry;
pub mod router;
pub mod scip;
pub mod state;

use serde::{Deserialize, Serialize};

/// Supported semantic languages for Milestone 3.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum LanguageId {
    #[serde(rename = "typescript")]
    TypeScript,
    #[serde(rename = "javascript")]
    JavaScript,
    #[serde(rename = "rust")]
    Rust,
}

impl LanguageId {
    pub fn as_str(self) -> &'static str {
        match self {
            LanguageId::TypeScript => "typescript",
            LanguageId::JavaScript => "javascript",
            LanguageId::Rust => "rust",
        }
    }

    /// Parse from a language identifier or SCIP \`Document.language\` value.
    pub fn from_str_opt(s: &str) -> Option<LanguageId> {
        match s.to_ascii_lowercase().as_str() {
            "typescript" | "ts" | "tsx" => Some(LanguageId::TypeScript),
            "javascript" | "js" | "jsx" | "mjs" | "cjs" => Some(LanguageId::JavaScript),
            "rust" | "rs" => Some(LanguageId::Rust),
            _ => None,
        }
    }

    /// The SCIP \`Language\` enum string this language maps to.
    pub fn scip_language_str(self) -> &'static str {
        match self {
            LanguageId::TypeScript => "TypeScript",
            LanguageId::JavaScript => "JavaScript",
            LanguageId::Rust => "Rust",
        }
    }

    /// File extensions this language is associated with (used by fallbacks).
    pub fn extensions(self) -> &'static [&'static str] {
        match self {
            LanguageId::TypeScript => &["ts", "tsx"],
            LanguageId::JavaScript => &["js", "jsx", "mjs", "cjs"],
            LanguageId::Rust => &["rs"],
        }
    }
}

impl std::fmt::Display for LanguageId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_id_parses_scip_and_common_identifiers() {
        assert_eq!(
            LanguageId::from_str_opt("TypeScript"),
            Some(LanguageId::TypeScript)
        );
        assert_eq!(
            LanguageId::from_str_opt("typescript"),
            Some(LanguageId::TypeScript)
        );
        assert_eq!(
            LanguageId::from_str_opt("JavaScript"),
            Some(LanguageId::JavaScript)
        );
        assert_eq!(LanguageId::from_str_opt("Rust"), Some(LanguageId::Rust));
        assert_eq!(LanguageId::from_str_opt("python"), None);
        assert_eq!(LanguageId::from_str_opt(""), None);
    }

    #[test]
    fn language_id_serde_is_stable() {
        assert_eq!(
            serde_json::to_string(&LanguageId::TypeScript).unwrap(),
            "\"typescript\""
        );
        assert_eq!(
            serde_json::to_string(&LanguageId::JavaScript).unwrap(),
            "\"javascript\""
        );
        assert_eq!(
            serde_json::to_string(&LanguageId::Rust).unwrap(),
            "\"rust\""
        );
    }
}
