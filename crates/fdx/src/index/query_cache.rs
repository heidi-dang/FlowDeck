//! Content-addressed query-result cache (Dev 3 Task 4, Phase 3).
//!
//! Caches the serialized result of read-only query operations (read, grep,
//! search, outline, impact, testsFor) under the worktree state directory so a
//! repeat of the same query against the same repository state is served
//! without re-execution.
//!
//! The cache key is a SHA-256 over a frozen contract — domain string +
//! repository/worktree identity + repository HEAD SHA + dirty fingerprint +
//! index generation + protocol/tool versions + operation type + canonical
//! parameters + configuration fingerprint. Any change in repository state,
//! index generation, tool version, or query parameters flips the key.
//!
//! Storage layout (inside the existing FDX index hierarchy — no second cache
//! DB, worktree-isolated):
//!
//!   <state-root>/fdx-index/<repository_id>/<worktree_id>/query-cache/<key>
//!   <state-root>/fdx-index/<repository_id>/<worktree_id>/negative-cache/<key>
//!
//! The cache is NOT generation-scoped: the generation number is part of the
//! key, so stale entries are never served and never need explicit cleanup on
//! refresh — they are simply unreachable and get evicted by the LRU bound.
//!
//! Bounds: a fixed maximum number of entries and a fixed maximum total bytes,
//! enforced by evicting least-recently-used entries (by mtime) on write.

use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Domain string that prefixes every cache key (contract). Bumping this
/// invalidates all caches from older builds.
pub const CACHE_DOMAIN: &str = "flowdeck-fdx-query-cache-v1";

/// Sub-directory (under the worktree state dir) for positive cache entries.
pub const QUERY_CACHE_DIR: &str = "query-cache";

/// Sub-directory (under the worktree state dir) for negative cache entries.
pub const NEGATIVE_CACHE_DIR: &str = "negative-cache";

/// Default maximum number of cache entries per worktree.
pub const DEFAULT_MAX_ITEMS: usize = 512;

/// Default maximum total cached bytes per worktree (8 MiB).
pub const DEFAULT_MAX_BYTES: usize = 8 * 1024 * 1024;

/// Protocol version used in cache keys. Bumped only when the batch protocol
/// version changes in a way that changes result semantics.
pub const BATCH_PROTOCOL_VERSION: u32 = 1;

/// TTL for negative cache entries (Phase 4). A negative entry is only valid
/// for this many seconds; beyond it, the query re-runs.
pub const NEGATIVE_TTL_SECS: u64 = 30;

/// Configuration fingerprint = sha256(config_hash ‖ ignore_hash).
///
/// `config_hash` and `ignore_hash` are the same values the index manifest
/// records (see [`crate::index::identity`]), so the fingerprint is stable
/// across processes for the same configuration.
pub fn configuration_fingerprint(config_hash: &str, ignore_hash: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(config_hash.as_bytes());
    hasher.update(ignore_hash.as_bytes());
    let digest = hasher.finalize();
    digest
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()
}

/// The content-addressed cache key (contract, exact):
///
///   sha256_hex(CACHE_DOMAIN ‖ repository_id ‖ worktree_id ‖ repository_sha ‖
///             dirty_fingerprint ‖ index_generation ‖ protocol_version ‖
///             tool_version ‖ operation_type ‖ canonical_parameters ‖
///             configuration_fingerprint)
///
/// Every input is length-delimited by NUL to prevent ambiguous
/// concatenation, and `canonical_parameters` is sorted-key deterministic JSON
/// so equivalent parameter objects hash identically regardless of field
/// order.
#[allow(clippy::too_many_arguments)]
// All 10 inputs are mandated by the frozen cache-key contract; bundling them
// into a struct would just move the argument list to a constructor.
pub fn query_cache_key(
    repository_id: &str,
    worktree_id: &str,
    repository_sha: &str,
    dirty_fingerprint: &str,
    index_generation: u64,
    protocol_version: u32,
    tool_version: &str,
    operation_type: &str,
    canonical_parameters: &str,
    configuration_fingerprint: &str,
) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    for part in [
        CACHE_DOMAIN,
        repository_id,
        worktree_id,
        repository_sha,
        dirty_fingerprint,
        &index_generation.to_string(),
        &protocol_version.to_string(),
        tool_version,
        operation_type,
        canonical_parameters,
        configuration_fingerprint,
    ] {
        hasher.update(part.as_bytes());
        hasher.update(b"\0");
    }
    let digest = hasher.finalize();
    digest
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()
}

/// Deterministic canonical JSON for a parameter object: object keys sorted
/// lexicographically at every level, so `{b:1,a:2}` and `{a:2,b:1}` hash to
/// the same key. Null/absent fields are dropped for compactness.
pub fn canonical_json(value: &serde_json::Value) -> String {
    fn rec(v: &serde_json::Value) -> String {
        match v {
            serde_json::Value::Object(map) => {
                let mut keys: Vec<&String> = map.keys().collect();
                keys.sort_unstable();
                let mut parts = Vec::with_capacity(keys.len());
                for k in keys {
                    let v = map.get(k).expect("key exists");
                    if v.is_null() {
                        continue;
                    }
                    parts.push(format!(
                        "{}:{}",
                        serde_json::to_string(k).expect("string key"),
                        rec(v)
                    ));
                }
                format!("{{{}}}", parts.join(","))
            }
            serde_json::Value::Array(arr) => {
                let parts: Vec<String> = arr.iter().map(rec).collect();
                format!("[{}]", parts.join(","))
            }
            other => serde_json::to_string(other).expect("scalar"),
        }
    }
    rec(value)
}

/// The disk-backed query cache for one worktree.
///
/// All operations are best-effort: a read that races a refresh may miss, and
/// a write that fails (disk full, permissions) is ignored — the cache must
/// never fail a query. The LRU bound is enforced on write: entries beyond
/// `max_items` or `max_bytes` are evicted oldest-first by mtime.
#[derive(Clone, Debug)]
pub struct QueryCache {
    /// The worktree state directory (`.../<repository_id>/<worktree_id>/`).
    state_dir: PathBuf,
    max_items: usize,
    max_bytes: usize,
}

impl QueryCache {
    /// Open the cache for a worktree state directory.
    pub fn new(state_dir: &Path) -> Self {
        Self {
            state_dir: state_dir.to_path_buf(),
            max_items: DEFAULT_MAX_ITEMS,
            max_bytes: DEFAULT_MAX_BYTES,
        }
    }

    /// The positive cache directory (created lazily on write).
    pub fn query_dir(&self) -> PathBuf {
        self.state_dir.join(QUERY_CACHE_DIR)
    }

    /// The negative cache directory (created lazily on write).
    pub fn negative_dir(&self) -> PathBuf {
        self.state_dir.join(NEGATIVE_CACHE_DIR)
    }

    /// Look up a cached value. Touches the entry mtime on hit so the LRU
    /// bound evicts least-recently-used entries. Returns None on miss.
    pub fn get(&self, key: &str) -> Option<Vec<u8>> {
        let path = self.query_dir().join(key);
        let data = std::fs::read(&path).ok()?;
        // Touch mtime for LRU ordering.
        let _ = std::fs::File::options()
            .write(true)
            .open(&path)
            .and_then(|f| f.set_modified(SystemTime::now()));
        Some(data)
    }

    /// Store a value under `key`, then enforce the LRU bound. Best-effort:
    /// failures are swallowed so a cache write never fails a query.
    pub fn put(&self, key: &str, value: &[u8]) {
        let dir = self.query_dir();
        if std::fs::create_dir_all(&dir).is_err() {
            return;
        }
        let path = dir.join(key);
        if std::fs::write(&path, value).is_err() {
            return;
        }
        self.enforce_lru(&dir);
    }

    /// Look up a negative cache entry. A negative entry is only valid for
    /// `NEGATIVE_TTL_SECS` after it was written; expired entries are deleted
    /// so the next query re-runs. mtime is NOT touched on hit — negative
    /// entries have a fixed TTL, not an LRU-based lifetime.
    pub fn get_negative(&self, key: &str) -> Option<Vec<u8>> {
        let path = self.negative_dir().join(key);
        let data = std::fs::read(&path).ok()?;
        let meta = std::fs::metadata(&path).ok()?;
        let written = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let age = SystemTime::now().duration_since(written).ok();
        let expired = age.is_none_or(|a| a.as_secs() >= NEGATIVE_TTL_SECS);
        if expired {
            let _ = std::fs::remove_file(&path);
            return None;
        }
        Some(data)
    }

    /// Store a negative cache entry (definitive-empty result). The mtime is
    /// the TTL anchor: `get_negative` rejects entries older than
    /// `NEGATIVE_TTL_SECS`. Same LRU bounds as the positive cache.
    pub fn put_negative(&self, key: &str, value: &[u8]) {
        let dir = self.negative_dir();
        if std::fs::create_dir_all(&dir).is_err() {
            return;
        }
        let path = dir.join(key);
        if std::fs::write(&path, value).is_err() {
            return;
        }
        self.enforce_lru(&dir);
    }

    /// Remove every cache entry (positive and negative). Used by
    /// `index.invalidate` — a full invalidation must drop cached results.
    pub fn clear(&self) -> io::Result<()> {
        for dir in [self.query_dir(), self.negative_dir()] {
            if dir.exists() {
                std::fs::remove_dir_all(&dir)?;
            }
        }
        Ok(())
    }

    /// Evict least-recently-used entries from `dir` until both bounds hold.
    /// Best-effort. Applies to both the positive and negative cache dirs.
    fn enforce_lru(&self, dir: &Path) {
        let read_dir = match std::fs::read_dir(dir) {
            Ok(rd) => rd,
            Err(_) => return,
        };

        // Collect (mtime, size, path) for every entry.
        let mut entries: Vec<(SystemTime, u64, PathBuf)> = Vec::new();
        for entry in read_dir.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            entries.push((mtime, meta.len(), path));
        }

        let mut total_bytes: u64 = entries.iter().map(|(_, s, _)| *s).sum();
        if entries.len() <= self.max_items && (total_bytes as usize) <= self.max_bytes {
            return;
        }

        // Evict oldest-first until under both bounds. Bounded at 512 entries,
        // so the O(n²) recount in the loop is negligible in practice.
        entries.sort_by_key(|(mtime, _, _)| *mtime);
        for (_, size, path) in entries {
            if std::fs::remove_file(&path).is_ok() {
                total_bytes = total_bytes.saturating_sub(size);
            }
            let remaining: usize = std::fs::read_dir(dir)
                .map(|rd| rd.flatten().filter(|e| e.metadata().is_ok()).count())
                .unwrap_or(0);
            if remaining <= self.max_items && (total_bytes as usize) <= self.max_bytes {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn configuration_fingerprint_is_deterministic() {
        let a = configuration_fingerprint("c1", "i1");
        let b = configuration_fingerprint("c1", "i1");
        assert_eq!(a, b);
        assert_ne!(a, configuration_fingerprint("c2", "i1"));
        assert_ne!(a, configuration_fingerprint("c1", "i2"));
        // 64 hex chars (full SHA-256).
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn key_flips_on_every_component() {
        let base = (
            "repo", "wt", "sha", "dirty", 3u64, 1u32, "0.1.0", "grep", "{}", "cfg",
        );
        let key = |b: (&str, &str, &str, &str, u64, u32, &str, &str, &str, &str)| {
            query_cache_key(b.0, b.1, b.2, b.3, b.4, b.5, b.6, b.7, b.8, b.9)
        };
        let k0 = key(base);
        assert_eq!(k0.len(), 64);
        assert_eq!(k0, key(base), "identical inputs → identical key");
        assert_ne!(
            k0,
            key(("repo2", "wt", "sha", "dirty", 3, 1, "0.1.0", "grep", "{}", "cfg"))
        );
        assert_ne!(
            k0,
            key(("repo", "wt2", "sha", "dirty", 3, 1, "0.1.0", "grep", "{}", "cfg"))
        );
        assert_ne!(
            k0,
            key(("repo", "wt", "sha2", "dirty", 3, 1, "0.1.0", "grep", "{}", "cfg"))
        );
        assert_ne!(
            k0,
            key(("repo", "wt", "sha", "dirty2", 3, 1, "0.1.0", "grep", "{}", "cfg"))
        );
        assert_ne!(
            k0,
            key(("repo", "wt", "sha", "dirty", 4, 1, "0.1.0", "grep", "{}", "cfg"))
        );
        assert_ne!(
            k0,
            key(("repo", "wt", "sha", "dirty", 3, 2, "0.1.0", "grep", "{}", "cfg"))
        );
        assert_ne!(
            k0,
            key(("repo", "wt", "sha", "dirty", 3, 1, "0.1.1", "grep", "{}", "cfg"))
        );
        assert_ne!(
            k0,
            key(("repo", "wt", "sha", "dirty", 3, 1, "0.1.0", "search", "{}", "cfg"))
        );
        assert_ne!(
            k0,
            key((
                "repo",
                "wt",
                "sha",
                "dirty",
                3,
                1,
                "0.1.0",
                "grep",
                "{\"a\":1}",
                "cfg"
            ))
        );
        assert_ne!(
            k0,
            key(("repo", "wt", "sha", "dirty", 3, 1, "0.1.0", "grep", "{}", "cfg2"))
        );
    }

    #[test]
    fn key_is_domain_anchored() {
        let k = query_cache_key("r", "w", "s", "d", 1, 1, "v", "read", "{}", "c");
        // Must start with the domain, so a domain bump invalidates everything.
        let digest_expected = {
            use sha2::{Digest, Sha256};
            let mut h = Sha256::new();
            for part in [
                CACHE_DOMAIN,
                "r",
                "w",
                "s",
                "d",
                "1",
                "1",
                "v",
                "read",
                "{}",
                "c",
            ] {
                h.update(part.as_bytes());
                h.update(b"\0");
            }
            let d = h.finalize();
            d.iter().map(|b| format!("{b:02x}")).collect::<String>()
        };
        assert_eq!(k, digest_expected);
    }

    #[test]
    fn canonical_json_sorts_keys_and_drops_nulls() {
        let a = json!({"b": 1, "a": 2, "z": null});
        let b = json!({"a": 2, "b": 1});
        let ca = canonical_json(&a);
        let cb = canonical_json(&b);
        assert_eq!(ca, cb);
        assert_eq!(ca, r#"{"a":2,"b":1}"#);

        // Nested objects are sorted too.
        let nested = json!({"outer": {"y": 1, "x": 2}, "n": 0});
        assert_eq!(canonical_json(&nested), r#"{"n":0,"outer":{"x":2,"y":1}}"#);
    }

    #[test]
    fn cache_put_get_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = QueryCache::new(tmp.path());
        assert_eq!(cache.get("k1"), None);
        cache.put("k1", b"value-one");
        assert_eq!(cache.get("k1").as_deref(), Some(b"value-one".as_slice()));
        // Entry lives under query-cache/, not generation-scoped.
        assert!(cache.query_dir().join("k1").exists());
        assert!(!tmp.path().join("gen-1").exists());
    }

    #[test]
    fn cache_get_miss_after_clear() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = QueryCache::new(tmp.path());
        cache.put("k1", b"v");
        cache.put("neg", b"n");
        cache.clear().unwrap();
        assert_eq!(cache.get("k1"), None);
        assert!(!cache.negative_dir().exists());
    }

    #[test]
    fn lru_evicts_oldest_beyond_item_bound() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = QueryCache {
            state_dir: tmp.path().to_path_buf(),
            max_items: 3,
            max_bytes: usize::MAX,
        };
        cache.put("a", b"1");
        cache.put("b", b"2");
        cache.put("c", b"3");
        // Touch "a" so it is most-recently-used.
        assert_eq!(cache.get("a").as_deref(), Some(b"1".as_slice()));
        cache.put("d", b"4");
        // Bound is 3: oldest (b, then c) must be evicted, a (touched) kept.
        assert_eq!(cache.get("a").as_deref(), Some(b"1".as_slice()));
        assert_eq!(cache.get("b"), None);
    }

    #[test]
    fn lru_evicts_beyond_byte_bound() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = QueryCache {
            state_dir: tmp.path().to_path_buf(),
            max_items: usize::MAX,
            max_bytes: 10,
        };
        cache.put("big", b"0123456789"); // exactly 10 bytes
        assert_eq!(cache.get("big").as_deref(), Some(b"0123456789".as_slice()));
        cache.put("other", b"abcdef"); // 16 bytes total → evict one
        let big_present = cache.get("big").is_some();
        let other_present = cache.get("other").is_some();
        // Only one of them can fit; the other was evicted.
        assert!(big_present ^ other_present);
    }

    #[test]
    fn negative_entries_roundtrip_within_ttl() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = QueryCache::new(tmp.path());
        assert_eq!(cache.get_negative("k"), None);
        cache.put_negative("k", b"none-found");
        assert_eq!(
            cache.get_negative("k").as_deref(),
            Some(b"none-found".as_slice())
        );
        // Negative entries live in negative-cache/, positive in query-cache/.
        assert!(cache.negative_dir().join("k").exists());
        assert!(!cache.query_dir().exists());
    }

    #[test]
    fn negative_entries_expire_after_ttl() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = QueryCache::new(tmp.path());
        cache.put_negative("k", b"none-found");
        // Backdate the mtime beyond the TTL (30s) — the entry must expire.
        let path = cache.negative_dir().join("k");
        let backdated = SystemTime::now() - std::time::Duration::from_secs(NEGATIVE_TTL_SECS + 5);
        std::fs::File::options()
            .write(true)
            .open(&path)
            .and_then(|f| f.set_modified(backdated))
            .expect("backdate mtime");
        assert_eq!(
            cache.get_negative("k"),
            None,
            "expired negative entry is a miss"
        );
        // Expired entries are removed, not left to accumulate.
        assert!(!path.exists());
    }

    #[test]
    fn negative_entries_honor_lru_bounds() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = QueryCache {
            state_dir: tmp.path().to_path_buf(),
            max_items: 2,
            max_bytes: usize::MAX,
        };
        cache.put_negative("a", b"1");
        cache.put_negative("b", b"2");
        // Negative reads never touch mtime, so make "b" unambiguously the
        // oldest entry by backdating it (deterministic eviction order).
        let b_path = cache.negative_dir().join("b");
        std::fs::File::options()
            .write(true)
            .open(&b_path)
            .and_then(|f| f.set_modified(SystemTime::now() - std::time::Duration::from_secs(60)))
            .expect("backdate mtime");
        cache.put_negative("c", b"3");
        // Bound is 2: oldest negative entry (b) is evicted.
        assert_eq!(cache.get_negative("b"), None);
        assert_eq!(cache.get_negative("c").as_deref(), Some(b"3".as_slice()));
    }

    #[test]
    fn clear_drops_negative_entries_too() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = QueryCache::new(tmp.path());
        cache.put("pos", b"p");
        cache.put_negative("neg", b"n");
        cache.clear().unwrap();
        assert_eq!(cache.get("pos"), None);
        assert_eq!(cache.get_negative("neg"), None);
        assert!(!cache.query_dir().exists());
        assert!(!cache.negative_dir().exists());
    }
}
