//! Tool capability metadata (Task 4).
//!
//! One canonical descriptor set, shared by the daemon (`capabilities.query`),
//! the batch executor (enforcement), the CLI, the TS client mirror, and the
//! fallback executor. Every value here is a contract: the batch executor
//! enforces `read_only`, `supports_batching`, and `maximum_output_bytes`;
//! clients use it to decide streaming/cancellation/caching behavior.
//!
//! Field naming is camelCase on the wire (mirrors the protocol convention).

use serde::{Deserialize, Serialize};

/// How a tool's results may be cached.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CachePolicy {
    /// Results are never cached (e.g. `index.refresh`).
    None,
    /// Cached for the duration of the current run/session only.
    Run,
    /// Cached on disk keyed by repository + worktree state (query cache).
    Repository,
}

/// Expected latency class (informational, drives client budget choices).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LatencyClass {
    Instant,
    Fast,
    Slow,
}

/// Capability metadata for one tool.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDescriptor {
    /// Tool name (matches the batch `op` tag or the hosted command name).
    pub name: String,
    /// True when the tool never mutates repository state.
    pub read_only: bool,
    pub supports_streaming: bool,
    pub supports_cancellation: bool,
    pub supports_batching: bool,
    pub cache_policy: CachePolicy,
    pub expected_latency_class: LatencyClass,
    /// Hard cap on the serialized result payload, in bytes.
    pub maximum_output_bytes: usize,
    /// True when a definitive-empty outcome may be negatively cached.
    pub negative_cache_eligible: bool,
}

impl ToolDescriptor {
    fn new(name: &str) -> Self {
        Self {
            name: name.to_string(),
            read_only: true,
            supports_streaming: false,
            supports_cancellation: false,
            supports_batching: true,
            cache_policy: CachePolicy::Repository,
            expected_latency_class: LatencyClass::Fast,
            maximum_output_bytes: 256 * 1024,
            negative_cache_eligible: false,
        }
    }
}

const KIB: usize = 1024;

/// The canonical descriptor registry. Ordered: batch ops first, then hosted
/// commands, then the capabilities query itself.
pub fn tool_descriptors() -> Vec<ToolDescriptor> {
    let mut out = Vec::new();

    // ── Batch read-only operations ──────────────────────────────────────────
    let mut read = ToolDescriptor::new("read");
    read.expected_latency_class = LatencyClass::Instant;
    read.maximum_output_bytes = 256 * KIB;
    out.push(read);

    let mut grep = ToolDescriptor::new("grep");
    grep.expected_latency_class = LatencyClass::Fast;
    grep.maximum_output_bytes = 256 * KIB;
    grep.negative_cache_eligible = true;
    out.push(grep);

    let mut search = ToolDescriptor::new("search");
    search.expected_latency_class = LatencyClass::Fast;
    search.maximum_output_bytes = 256 * KIB;
    search.negative_cache_eligible = true;
    out.push(search);

    let mut outline = ToolDescriptor::new("outline");
    outline.expected_latency_class = LatencyClass::Fast;
    outline.maximum_output_bytes = 256 * KIB;
    out.push(outline);

    let mut impact = ToolDescriptor::new("impact");
    impact.expected_latency_class = LatencyClass::Slow;
    impact.maximum_output_bytes = 256 * KIB;
    out.push(impact);

    let mut tests_for = ToolDescriptor::new("testsFor");
    tests_for.expected_latency_class = LatencyClass::Fast;
    tests_for.maximum_output_bytes = 128 * KIB;
    tests_for.negative_cache_eligible = true;
    out.push(tests_for);

    // ── Hosted commands (negotiated in `hello` capabilities) ────────────────
    let mut version = ToolDescriptor::new("version");
    version.expected_latency_class = LatencyClass::Instant;
    version.maximum_output_bytes = 8 * KIB;
    out.push(version);

    let mut ls = ToolDescriptor::new("ls");
    ls.expected_latency_class = LatencyClass::Fast;
    ls.maximum_output_bytes = 128 * KIB;
    out.push(ls);

    for name in [
        "files.query",
        "symbols.query",
        "dependencies.query",
        "testsFor.query",
        "gitState.query",
    ] {
        let mut d = ToolDescriptor::new(name);
        d.maximum_output_bytes = 128 * KIB;
        d.negative_cache_eligible = true;
        out.push(d);
    }

    {
        let mut d = ToolDescriptor::new("index.status");
        d.maximum_output_bytes = 8 * KIB;
        out.push(d);
    }

    for name in ["index.refresh", "index.rebuild", "index.invalidate"] {
        let mut d = ToolDescriptor::new(name);
        d.read_only = false;
        d.supports_batching = false;
        d.cache_policy = CachePolicy::None;
        d.expected_latency_class = LatencyClass::Slow;
        d.maximum_output_bytes = 8 * KIB;
        out.push(d);
    }

    // ── The capabilities query itself ───────────────────────────────────────
    let mut caps = ToolDescriptor::new("capabilities.query");
    caps.expected_latency_class = LatencyClass::Instant;
    caps.maximum_output_bytes = 128 * KIB;
    // Hosted command, not a batch operation: never eligible for batching.
    caps.supports_batching = false;
    out.push(caps);

    out
}

/// Look up one descriptor by name.
pub fn tool_descriptor(name: &str) -> Option<ToolDescriptor> {
    tool_descriptors().into_iter().find(|d| d.name == name)
}

/// Serialize the full registry (used by `capabilities.query`).
pub fn capabilities_payload() -> serde_json::Value {
    serde_json::to_value(tool_descriptors()).unwrap_or_else(|_| serde_json::json!([]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_contains_batch_ops() {
        let descriptors = tool_descriptors();
        let names: Vec<&str> = descriptors.iter().map(|d| d.name.as_str()).collect();
        for op in ["read", "grep", "search", "outline", "impact", "testsFor"] {
            assert!(names.contains(&op), "missing batch op descriptor {op}");
        }
    }

    #[test]
    fn all_batch_ops_are_read_only_and_batchable() {
        for name in ["read", "grep", "search", "outline", "impact", "testsFor"] {
            let d = tool_descriptor(name).expect("descriptor");
            assert!(d.read_only, "{name} must be read_only");
            assert!(d.supports_batching, "{name} must support batching");
            assert!(d.maximum_output_bytes > 0, "{name} needs an output bound");
        }
    }

    #[test]
    fn mutation_commands_are_marked_non_read_only() {
        for name in ["index.refresh", "index.rebuild", "index.invalidate"] {
            let d = tool_descriptor(name).expect("descriptor");
            assert!(!d.read_only, "{name} mutates state");
            assert_eq!(d.cache_policy, CachePolicy::None);
        }
    }

    #[test]
    fn negative_cache_eligibility_is_explicit() {
        for name in ["grep", "search", "testsFor"] {
            assert!(
                tool_descriptor(name).unwrap().negative_cache_eligible,
                "{name} has definitive-empty outcomes and should be eligible"
            );
        }
        for name in ["read", "outline", "impact"] {
            assert!(
                !tool_descriptor(name).unwrap().negative_cache_eligible,
                "{name} has no definitive-empty outcome"
            );
        }
    }

    #[test]
    fn descriptors_serialize_camel_case() {
        let payload = capabilities_payload();
        let arr = payload.as_array().unwrap();
        let first = &arr[0];
        assert!(first.get("maximumOutputBytes").is_some());
        assert!(first.get("expectedLatencyClass").is_some());
        assert!(first.get("cachePolicy").is_some());
        let back: Vec<ToolDescriptor> = serde_json::from_value(payload).unwrap();
        assert_eq!(back.len(), tool_descriptors().len());
    }

    #[test]
    fn unknown_descriptor_returns_none() {
        assert!(tool_descriptor("does-not-exist").is_none());
    }
}
