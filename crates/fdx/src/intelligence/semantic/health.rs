//! Provider health and freshness states.
//!
//! Health and freshness are deliberately separate dimensions:
//!
//! - `ProviderHealth` describes whether the provider *itself* can run right
//!   now (executable present, configured correctly, previous run healthy).
//! - `ProviderFreshness` describes whether the *evidence* the provider
//!   produced corresponds to the current repository/configuration state.
//!
//! Examples:
//!
//! - executable installed + old SCIP index  → `Available` / `Stale`
//! - provider missing                       → `Missing` / `Absent`
//! - provider crash                         → `Failed` / `Unknown`
//!
//! Never collapse the two dimensions into a single boolean: `Available/Stale`
//! and `Missing/Absent` are both meaningful, distinct states.

use serde::{Deserialize, Serialize};

/// Whether a semantic provider is able to execute.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderHealth {
    /// Executable discovered, command construction valid, provider can run.
    Available,
    /// Executable not found at the discovered/configured location.
    Missing,
    /// Executable found but required configuration or invocation is invalid.
    Misconfigured,
    /// Executable ran and exited non-zero or produced unusable output.
    Failed,
    /// Execution exceeded the configured deadline.
    TimedOut,
    /// Language/scope not supported by this FDX build.
    Unsupported,
}

impl ProviderHealth {
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderHealth::Available => "available",
            ProviderHealth::Missing => "missing",
            ProviderHealth::Misconfigured => "misconfigured",
            ProviderHealth::Failed => "failed",
            ProviderHealth::TimedOut => "timed_out",
            ProviderHealth::Unsupported => "unsupported",
        }
    }

    /// Parse the persisted lowercase string form.
    pub fn from_str_opt(s: &str) -> Option<ProviderHealth> {
        match s {
            "available" => Some(ProviderHealth::Available),
            "missing" => Some(ProviderHealth::Missing),
            "misconfigured" => Some(ProviderHealth::Misconfigured),
            "failed" => Some(ProviderHealth::Failed),
            "timed_out" => Some(ProviderHealth::TimedOut),
            "unsupported" => Some(ProviderHealth::Unsupported),
            _ => None,
        }
    }
}

/// Whether the evidence produced by a provider is current.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderFreshness {
    /// Current fingerprint matches and the last successful run matches the
    /// current workspace/config state.
    Fresh,
    /// Evidence corresponds to an older fingerprint, config, or source state.
    Stale,
    /// No run has succeeded; freshness cannot be established.
    Unknown,
    /// No evidence exists at all.
    Absent,
}

impl ProviderFreshness {
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderFreshness::Fresh => "fresh",
            ProviderFreshness::Stale => "stale",
            ProviderFreshness::Unknown => "unknown",
            ProviderFreshness::Absent => "absent",
        }
    }

    /// Parse the persisted lowercase string form.
    pub fn from_str_opt(s: &str) -> Option<ProviderFreshness> {
        match s {
            "fresh" => Some(ProviderFreshness::Fresh),
            "stale" => Some(ProviderFreshness::Stale),
            "unknown" => Some(ProviderFreshness::Unknown),
            "absent" => Some(ProviderFreshness::Absent),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_and_freshness_are_orthogonal_dimensions() {
        // AVAILABLE health + STALE freshness is a real combination: an
        // installed indexer with an old SCIP index.
        let installed = ProviderHealth::Available;
        assert_eq!(installed.as_str(), "available");
        assert_eq!(ProviderFreshness::Stale.as_str(), "stale");

        // MISSING health + ABSENT freshness: provider not installed.
        assert_eq!(ProviderHealth::Missing.as_str(), "missing");
        assert_eq!(ProviderFreshness::Absent.as_str(), "absent");

        // FAILED health + UNKNOWN freshness: crash leaves prior state unknown.
        assert_eq!(ProviderHealth::Failed.as_str(), "failed");
        assert_eq!(ProviderFreshness::Unknown.as_str(), "unknown");
    }

    #[test]
    fn health_round_trips_through_persisted_string() {
        for h in [
            ProviderHealth::Available,
            ProviderHealth::Missing,
            ProviderHealth::Misconfigured,
            ProviderHealth::Failed,
            ProviderHealth::TimedOut,
            ProviderHealth::Unsupported,
        ] {
            assert_eq!(ProviderHealth::from_str_opt(h.as_str()), Some(h));
        }
        assert_eq!(ProviderHealth::from_str_opt("bogus"), None);
    }

    #[test]
    fn freshness_round_trips_through_persisted_string() {
        for f in [
            ProviderFreshness::Fresh,
            ProviderFreshness::Stale,
            ProviderFreshness::Unknown,
            ProviderFreshness::Absent,
        ] {
            assert_eq!(ProviderFreshness::from_str_opt(f.as_str()), Some(f));
        }
        assert_eq!(ProviderFreshness::from_str_opt("bogus"), None);
    }

    #[test]
    fn serde_uses_stable_snake_case_names() {
        let h = serde_json::to_string(&ProviderHealth::TimedOut).unwrap();
        assert_eq!(h, "\"timed_out\"");
        let f = serde_json::to_string(&ProviderFreshness::Fresh).unwrap();
        assert_eq!(f, "\"fresh\"");
    }
}
