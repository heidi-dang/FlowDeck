//! Typed uncertainty scope model for build and configuration boundaries.

use serde::{Deserialize, Serialize};

/// Smallest proven affected boundary for build/configuration uncertainty.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", content = "identity", rename_all = "snake_case")]
pub enum UncertaintyScope {
    File(String),
    Config(String),
    Package(String),
    Workspace(String),
    BuildTarget(String),
    Repository,
}

impl UncertaintyScope {
    pub fn as_str(&self) -> String {
        match self {
            Self::File(f) => format!("file:{}", f),
            Self::Config(c) => format!("config:{}", c),
            Self::Package(p) => format!("package:{}", p),
            Self::Workspace(w) => format!("workspace:{}", w),
            Self::BuildTarget(t) => format!("target:{}", t),
            Self::Repository => "repository".to_string(),
        }
    }
}
