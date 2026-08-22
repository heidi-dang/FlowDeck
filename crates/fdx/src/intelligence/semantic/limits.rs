//! Hard upper limits for SCIP ingestion and provider execution.
//!
//! These values are the single source of truth. Every bound is documented and
//! exercised by tests. The goal: a malformed or malicious SCIP index or a
//! runaway provider subprocess must never be able to exhaust FDX memory,
//! disk, or wall-clock time.

use std::time::Duration;

/// Maximum size of an SCIP index file FDX will read from disk.
///
/// Real indexes for large monorepos can reach tens of MB; 512 MiB leaves
/// generous headroom while still bounding worst-case reads.
pub const MAX_SCIP_INDEX_BYTES: u64 = 512 * 1024 * 1024;

/// Maximum number of documents decodable from a single SCIP index.
pub const MAX_SCIP_DOCUMENTS: usize = 200_000;

/// Maximum total number of occurrences decodable from a single SCIP index
/// (summed across all documents).
pub const MAX_SCIP_OCCURRENCES: usize = 5_000_000;

/// Maximum total number of SymbolInformation entries decodable from a
/// single SCIP index (document symbols + external symbols).
pub const MAX_SCIP_SYMBOL_INFOS: usize = 1_500_000;

/// Maximum length (bytes) of a single SCIP relative path or symbol string.
pub const MAX_SCIP_STRING_BYTES: usize = 4096;

/// Maximum bytes of provider stdout FDX will capture.
pub const MAX_PROVIDER_STDOUT_BYTES: u64 = 8 * 1024 * 1024;

/// Maximum bytes of provider stderr FDX will capture.
pub const MAX_PROVIDER_STDERR_BYTES: u64 = 4 * 1024 * 1024;

/// Maximum wall-clock time a provider subprocess may run before FDX kills it.
pub const MAX_PROVIDER_RUNTIME: Duration = Duration::from_secs(600);

/// Maximum number of bytes of provider stderr retained for diagnostics after a
/// failure (the tail).
pub const MAX_PROVIDER_STDERR_TAIL_BYTES: usize = 16 * 1024;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_are_established() {
        // Documented constants: exact values are part of the bounded-ingestion
        // contract and must not drift silently.
        assert_eq!(MAX_SCIP_INDEX_BYTES, 512 * 1024 * 1024);
        assert_eq!(MAX_SCIP_DOCUMENTS, 200_000);
        assert_eq!(MAX_SCIP_OCCURRENCES, 5_000_000);
        assert_eq!(MAX_SCIP_SYMBOL_INFOS, 1_500_000);
        assert_eq!(MAX_PROVIDER_STDERR_TAIL_BYTES, 16 * 1024);
        assert_eq!(MAX_PROVIDER_RUNTIME.as_secs(), 600);
    }
}
