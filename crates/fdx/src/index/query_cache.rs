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
//!
//! Write safety (Phase 7 audit): every entry is written atomically — the
//! payload goes to a unique temp sibling file, is flushed and closed, then
//! atomically renamed over the final key. Readers therefore never observe a
//! partially written entry. On any failure the temp file is removed in a
//! cleanup step. Read safety: entries that fail JSON validation are
//! quarantined (moved to `quarantine/`) and treated as misses, so corrupt
//! data can never be served or poison the LRU accounting. Leftover temp files
//! from interrupted writers are swept by the LRU pass once they are older
//! than a short grace period.

use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

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

/// Sub-directory (under each namespace) for entries that failed JSON
/// validation. Quarantined entries are never served and never counted by the
/// LRU pass.
const QUARANTINE_DIR: &str = "quarantine";

/// Age after which a leftover temp file is considered abandoned by a crashed
/// writer and is swept. Live writes complete in milliseconds, so a 60-second
/// grace period cannot race a concurrent writer.
const STALE_TMP_GRACE: Duration = Duration::from_secs(60);

/// Unique temp-file counter (per process) so concurrent writers in the same
/// process never collide on temp names.
static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

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

    /// The worktree state directory this cache lives under. Artifacts (full
    /// payloads spilled by output-bounded responses) are stored next to the
    /// cache namespaces so they share the worktree lifecycle.
    pub fn state_dir(&self) -> &Path {
        &self.state_dir
    }

    /// Look up a cached value. Touches the entry mtime on hit so the LRU
    /// bound evicts least-recently-used entries. Returns None on miss.
    ///
    /// Entries that fail JSON validation are quarantined (moved to
    /// `quarantine/`) and treated as a miss — corrupt data is never served.
    pub fn get(&self, key: &str) -> Option<Vec<u8>> {
        let path = self.query_dir().join(key);
        let data = std::fs::read(&path).ok()?;
        if read_validate_quarantine(&path, &data, &self.query_dir()) {
            // Touch mtime for LRU ordering.
            let _ = std::fs::File::options()
                .write(true)
                .open(&path)
                .and_then(|f| f.set_modified(SystemTime::now()));
            Some(data)
        } else {
            None
        }
    }

    /// Store a value under `key`, then enforce the LRU bound. Best-effort:
    /// failures are swallowed so a cache write never fails a query. The value
    /// is written atomically (temp sibling + rename), so concurrent readers
    /// never observe a partial entry.
    pub fn put(&self, key: &str, value: &[u8]) {
        let dir = self.query_dir();
        if std::fs::create_dir_all(&dir).is_err() {
            return;
        }
        atomic_write(&dir.join(key), value);
        self.enforce_lru(&dir);
    }

    /// Look up a negative cache entry. A negative entry is only valid for
    /// `NEGATIVE_TTL_SECS` after it was written; expired entries are deleted
    /// so the next query re-runs. mtime is NOT touched on hit — negative
    /// entries have a fixed TTL, not an LRU-based lifetime. Corrupt entries
    /// are quarantined like positive ones.
    pub fn get_negative(&self, key: &str) -> Option<Vec<u8>> {
        let path = self.negative_dir().join(key);
        let data = std::fs::read(&path).ok()?;
        if !read_validate_quarantine(&path, &data, &self.negative_dir()) {
            return None;
        }
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
    /// `NEGATIVE_TTL_SECS`. Same atomic-write and LRU rules as the positive
    /// cache (unified safety rules).
    pub fn put_negative(&self, key: &str, value: &[u8]) {
        let dir = self.negative_dir();
        if std::fs::create_dir_all(&dir).is_err() {
            return;
        }
        atomic_write(&dir.join(key), value);
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

    /// Begin a transactional batch of cache writes. Entries are staged in
    /// transaction-private temp files and become visible ONLY on [`commit`],
    /// at which point all renames succeed (or are rolled back). LRU
    /// maintenance runs once after a successful commit — never during
    /// staging — so a failed transaction cannot evict live entries.
    pub fn begin(&self) -> CacheTransaction<'_> {
        CacheTransaction {
            cache: self,
            staged: Vec::new(),
        }
    }

    /// Restore cache entries to a captured prior state (from
    /// [`CacheTransaction::take_priors`]) with compare-and-swap semantics:
    /// write back the prior bytes atomically, or remove the entry when no
    /// prior existed — but only when the current entry still matches the
    /// generation this transaction published (P1-2). Used by the batch
    /// transaction to roll back published entries after a failed
    /// post-activation validation. Returns restore failures so an incomplete
    /// rollback is surfaced (P2-3).
    pub fn restore_priors(priors: &[(PathBuf, Option<Vec<u8>>, String)]) -> Vec<String> {
        CacheTransaction::restore_priors(priors)
    }

    /// Alias for callers that want the failure list under a distinct name.
    pub fn restore_priors_reported(priors: &[(PathBuf, Option<Vec<u8>>, String)]) -> Vec<String> {
        CacheTransaction::restore_priors(priors)
    }

    /// Read the raw bytes currently published at `key` WITHOUT touching mtime,
    /// quarantine or LRU. Used by the transaction to capture prior state so a
    /// commit failure can restore exactly what was there.
    fn read_raw(&self, key: &str, negative: bool) -> Option<Vec<u8>> {
        let path = if negative {
            self.negative_dir().join(key)
        } else {
            self.query_dir().join(key)
        };
        std::fs::read(&path).ok()
    }

    /// Evict least-recently-used entries from `dir` until both bounds hold.
    /// Best-effort. Applies to both the positive and negative cache dirs.
    /// Also sweeps abandoned temp files from interrupted writers.
    fn enforce_lru(&self, dir: &Path) {
        let read_dir = match std::fs::read_dir(dir) {
            Ok(rd) => rd,
            Err(_) => return,
        };

        // Collect (mtime, size, path) for every entry. Temp files and the
        // quarantine subdir are never cache entries.
        let mut entries: Vec<(SystemTime, u64, PathBuf)> = Vec::new();
        let now = SystemTime::now();
        for entry in read_dir.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            let file_name = entry.file_name().to_string_lossy().into_owned();
            if file_name.contains(TMP_MARKER) {
                // Abandoned temp file from a crashed writer: sweep once it is
                // older than the grace period (live writes are milliseconds).
                let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                if now
                    .duration_since(mtime)
                    .map(|d| d >= STALE_TMP_GRACE)
                    .unwrap_or(false)
                {
                    let _ = std::fs::remove_file(&path);
                }
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

/// Marker embedded in every temp file name (also used by the LRU sweep).
const TMP_MARKER: &str = ".tmp-";

/// One staged cache write inside a [`CacheTransaction`]: the new bytes live in
/// a transaction-private temp file; the prior published bytes (if any) are
/// captured so a compare-and-swap rollback can restore exactly what was there
/// — and only when the current entry still belongs to this transaction.
struct StagedCacheEntry {
    /// Final entry path (visible only after commit).
    final_path: PathBuf,
    /// Transaction-private temp holding the new bytes.
    staged_path: PathBuf,
    /// Prior published bytes captured before staging (None = no prior entry).
    prior: Option<Vec<u8>>,
    /// Hash of the bytes THIS transaction publishes (CAS generation token).
    published_hash: String,
    /// True once this entry was published during commit.
    published: bool,
}

/// A transactional group of cache writes. Staging is invisible (private temp
/// files, no LRU); [`publish`] hard-links staged temps into their final entry
/// paths with no-clobber semantics and does NOT run LRU; [`enforce_lru`] must
/// be called separately, only after the enclosing batch's global commit
/// decision succeeds (P1-1).
///
/// Publication is platform-neutral (P2-5): the staged temp is hard-linked into
/// the final path (fails when the destination exists, on every OS), so
/// concurrent same-key writers never silently replace each other — an
/// identical winner is reused, a conflicting winner fails closed.
///
/// Rollback is compare-and-swap (P1-2): a prior entry is restored only when
/// the current final entry still matches the generation this transaction
/// published. A newer concurrent writer's value is never overwritten or
/// deleted by a stale rollback.
pub struct CacheTransaction<'a> {
    cache: &'a QueryCache,
    staged: Vec<StagedCacheEntry>,
}

impl CacheTransaction<'_> {
    /// Stage a write for `key`. The bytes are written to a private temp file
    /// (RAII-guarded: a write/sync failure removes the temp so it cannot
    /// leak); the existing published entry (if any) is captured for rollback.
    /// The entry does NOT become visible and LRU is NOT touched here.
    ///
    /// Same-key writes are deduplicated: staging the same final path again
    /// replaces the earlier staged entry (last write wins within the
    /// transaction), so publication never depends on OS rename-replacement
    /// behavior.
    pub fn stage_write(&mut self, key: &str, negative: bool, bytes: &[u8]) -> Result<(), String> {
        let dir = if negative {
            self.cache.negative_dir()
        } else {
            self.cache.query_dir()
        };
        std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create cache dir: {e}"))?;
        let final_path = dir.join(key);
        // Deduplicate same-key writes within the transaction.
        self.staged.retain(|e| e.final_path != final_path);
        // Unique private temp in the same directory (same filesystem for the
        // final hard-link). The nonce makes it unguessable and exclusive.
        let mut attempts = 0;
        let staged_path = loop {
            if attempts >= 100 {
                return Err("too many cache temp collisions".into());
            }
            let candidate = dir.join(format!(
                "{key}{TMP_MARKER}{:x}-{attempts}",
                fast_cache_nonce()
            ));
            match std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&candidate)
            {
                Ok(mut file) => {
                    use std::io::Write;
                    let write_res = file.write_all(bytes).and_then(|_| file.sync_all());
                    drop(file);
                    if let Err(e) = write_res {
                        // RAII guard (P2-2): the temp is removed so a failed
                        // stage can never leak a private file.
                        let _ = std::fs::remove_file(&candidate);
                        return Err(format!("failed to stage cache entry: {e}"));
                    }
                    break candidate;
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    attempts += 1;
                    continue;
                }
                Err(e) => {
                    return Err(format!("failed to create staged cache entry: {e}"));
                }
            }
        };
        let prior = self.cache.read_raw(key, negative);
        let published_hash = sha256_hex(bytes);
        self.staged.push(StagedCacheEntry {
            final_path,
            staged_path,
            prior,
            published_hash,
            published: false,
        });
        Ok(())
    }

    /// Publish every staged entry with platform-neutral no-clobber semantics
    /// (hard-link into the final path; fails when the destination exists on
    /// every OS). An identical winner is reused; a conflicting winner fails
    /// closed. Parent directories are fsynced after publication (P2-4). LRU
    /// is NOT run here — call [`enforce_lru`] only after the enclosing
    /// batch's global commit decision succeeds (P1-1).
    pub fn publish(&mut self) -> Result<(), String> {
        let mut first_error: Option<String> = None;
        for entry in self.staged.iter_mut() {
            match std::fs::hard_link(&entry.staged_path, &entry.final_path) {
                Ok(()) => {
                    let _ = std::fs::remove_file(&entry.staged_path);
                    // Directory durability after publication (P2-4): a
                    // propagation failure marks the publish as not durable.
                    if let Some(parent) = entry.final_path.parent() {
                        if let Err(e) = sync_cache_dir(parent) {
                            first_error = Some(format!(
                                "failed to sync cache dir after publishing {}: {e}",
                                entry.final_path.display()
                            ));
                            entry.published = true;
                            break;
                        }
                    }
                    entry.published = true;
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    // The final path exists. Two cases:
                    // 1. It is the PRIOR entry captured at stage time — a
                    //    legitimate replacement owned by this transaction. We
                    //    atomically rename over it (POSIX replace / Windows
                    //    remove+rename are both fine because we verified the
                    //    prior generation matches).
                    // 2. A concurrent writer published a NEWER generation —
                    //    compare-and-swap: reuse an identical winner, fail
                    //    closed on a conflicting one.
                    let current = std::fs::read(&entry.final_path).ok();
                    let current_hash = current.as_deref().map(sha256_hex);
                    let prior_hash = entry.prior.as_deref().map(sha256_hex);
                    if current_hash.is_some() && current_hash == prior_hash {
                        // Still our prior generation: safe to replace.
                        match std::fs::rename(&entry.staged_path, &entry.final_path) {
                            Ok(()) => {
                                if let Some(parent) = entry.final_path.parent() {
                                    if let Err(e) = sync_cache_dir(parent) {
                                        first_error = Some(format!(
                                            "failed to sync cache dir after replacing {}: {e}",
                                            entry.final_path.display()
                                        ));
                                        entry.published = true;
                                        break;
                                    }
                                }
                                entry.published = true;
                            }
                            Err(rename_err) => {
                                let _ = std::fs::remove_file(&entry.staged_path);
                                first_error = Some(format!(
                                    "failed to replace cache entry {}: {rename_err}",
                                    entry.final_path.display()
                                ));
                                break;
                            }
                        }
                    } else if current_hash.is_some()
                        && current_hash == Some(entry.published_hash.clone())
                    {
                        // Identical winner already published concurrently: reuse.
                        let _ = std::fs::remove_file(&entry.staged_path);
                        entry.published = true;
                    } else {
                        // Conflicting concurrent winner: fail closed, never
                        // clobber another transaction's generation.
                        let _ = std::fs::remove_file(&entry.staged_path);
                        first_error = Some(format!(
                            "cache entry {} exists with different content",
                            entry.final_path.display()
                        ));
                        break;
                    }
                }
                Err(e) => {
                    first_error = Some(format!(
                        "failed to publish cache entry {}: {e}",
                        entry.final_path.display()
                    ));
                    break;
                }
            }
        }
        if let Some(err) = first_error {
            // Roll back everything published so far (CAS-restored to prior
            // state) and remove every staged temp so no private file leaks.
            self.rollback_published();
            for entry in &self.staged {
                let _ = std::fs::remove_file(&entry.staged_path);
            }
            return Err(err);
        }
        Ok(())
    }

    /// Run LRU maintenance over both namespaces. Must be called ONLY after the
    /// enclosing batch's global commit decision succeeds — never during
    /// staging, never before the post-activation probe (P1-1).
    pub fn enforce_lru(&self) {
        self.cache.enforce_lru(&self.cache.query_dir());
        self.cache.enforce_lru(&self.cache.negative_dir());
    }

    /// After a successful publish, return the captured prior state and the
    /// published generation token (content hash) of every entry, so a caller
    /// performing post-activation validation can restore replaced entries
    /// with compare-and-swap semantics (P1-2).
    pub fn take_priors(&mut self) -> Vec<(PathBuf, Option<Vec<u8>>, String)> {
        self.staged
            .iter()
            .map(|e| {
                (
                    e.final_path.clone(),
                    e.prior.clone(),
                    e.published_hash.clone(),
                )
            })
            .collect()
    }

    /// Compare-and-swap restore (P1-2): restore `priors` (from
    /// [`take_priors`]) only when the current final entry still matches the
    /// generation token (content hash) THIS transaction published. A newer
    /// concurrent writer's value is never overwritten or deleted.
    /// Returns a list of restore failures so an incomplete rollback can be
    /// surfaced distinctly (P2-3).
    pub fn restore_priors(priors: &[(PathBuf, Option<Vec<u8>>, String)]) -> Vec<String> {
        let mut issues = Vec::new();
        for (path, prior, published_hash) in priors {
            let current = std::fs::read(path).ok();
            match current {
                Some(bytes) if sha256_hex(&bytes) == *published_hash => {
                    let res = match prior {
                        Some(bytes) => atomic_write_checked(path, bytes),
                        None => std::fs::remove_file(path),
                    };
                    if let Err(e) = res {
                        issues.push(format!(
                            "failed to restore cache entry {}: {e}",
                            path.display()
                        ));
                    }
                    let _ = sync_cache_dir_opt(path);
                }
                _ => {
                    // Another writer owns the current generation (or the file
                    // is gone) — leave it untouched.
                }
            }
        }
        issues
    }

    /// Discard every staged entry WITHOUT publishing anything. Prior published
    /// entries are untouched (they were never overwritten during staging).
    pub fn abort(&mut self) {
        for entry in &self.staged {
            let _ = std::fs::remove_file(&entry.staged_path);
        }
        self.staged.clear();
    }

    /// Restore every entry this transaction already published (during a
    /// failed publish) with compare-and-swap semantics: restore the exact
    /// prior bytes or remove the entry, but ONLY when the current final entry
    /// still matches the generation this transaction published.
    fn rollback_published(&mut self) {
        for entry in self.staged.iter_mut() {
            if !entry.published {
                continue;
            }
            let current = std::fs::read(&entry.final_path).ok();
            match current {
                Some(bytes) if sha256_hex(&bytes) == entry.published_hash => {
                    match &entry.prior {
                        Some(prior) => {
                            atomic_write(&entry.final_path, prior);
                        }
                        None => {
                            let _ = std::fs::remove_file(&entry.final_path);
                        }
                    }
                    let _ = sync_cache_dir_opt(&entry.final_path);
                }
                _ => {
                    // A concurrent writer took over — never clobber.
                }
            }
            entry.published = false;
        }
    }
}

/// SHA-256 hex digest of a byte slice (cache generation token).
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(bytes);
    digest
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()
}

/// Parent-directory fsync for cache operations. Returns the io result so
/// genuine failures (EIO, permission, ENOSPC) propagate (P2-4).
#[cfg(unix)]
fn sync_cache_dir(path: &Path) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        let dir = std::fs::File::open(parent)?;
        dir.sync_all()
    } else {
        Ok(())
    }
}

#[cfg(not(unix))]
fn sync_cache_dir(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Non-propagating variant for best-effort cleanup paths.
fn sync_cache_dir_opt(path: &Path) -> Option<std::io::Error> {
    sync_cache_dir(path).err()
}

/// Cheap unpredictable nonce for transaction temp names.
fn fast_cache_nonce() -> u64 {
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    t ^ ((std::process::id() as u64) << 32)
}

/// Validate that `data` parses as JSON. Corrupt entries are quarantined:
/// moved to `<namespace>/quarantine/<key>` so they are never served, never
/// counted by the LRU pass, and remain available for diagnostics. Returns
/// true when the entry is valid.
fn read_validate_quarantine(path: &Path, data: &[u8], namespace_dir: &Path) -> bool {
    if serde_json::from_slice::<serde_json::Value>(data).is_ok() {
        return true;
    }
    let key = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "unknown".into());
    let quarantine_dir = namespace_dir.join(QUARANTINE_DIR);
    if std::fs::create_dir_all(&quarantine_dir).is_ok() {
        let dest = quarantine_dir.join(key);
        let _ = std::fs::rename(path, &dest);
    } else {
        // No quarantine dir possible: drop the corrupt entry outright.
        let _ = std::fs::remove_file(path);
    }
    false
}

/// Atomically write `value` to `path`: write to a unique temp sibling file,
/// flush + close, then rename over the final key. On any failure the temp
/// file is removed (cleanup), so no partial or orphaned entry ever appears
/// under the final key. Concurrent readers see either the previous entry or
/// the complete new one — never a partial write.
fn atomic_write(path: &Path, value: &[u8]) {
    let dir = match path.parent() {
        Some(d) => d.to_path_buf(),
        None => return,
    };
    let key = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "entry".into());
    let tmp = dir.join(format!(
        "{key}{TMP_MARKER}{}-{}",
        std::process::id(),
        TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));

    let write_result: io::Result<()> = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(value)?;
        // Flush + close before the rename so readers never see partial data.
        f.sync_all()?;
        drop(f);
        match std::fs::rename(&tmp, path) {
            Ok(()) => Ok(()),
            // Windows refuses to rename over an existing file. Cache entries
            // are content-addressed, so an existing entry holds identical
            // bytes; removing it first is safe (best-effort fallback).
            Err(e) if cfg!(windows) && e.kind() == io::ErrorKind::AlreadyExists => {
                std::fs::remove_file(path)?;
                std::fs::rename(&tmp, path)?;
                Ok(())
            }
            Err(e) => Err(e),
        }
    })();

    if write_result.is_err() {
        // Cleanup in the failure path: never leave a partial temp behind.
        let _ = std::fs::remove_file(&tmp);
    }
}

/// Checked variant of [`atomic_write`] that returns the io result so callers
/// can surface restore failures (P2-3). Same atomic sibling-write semantics.
fn atomic_write_checked(path: &Path, value: &[u8]) -> io::Result<()> {
    let dir = match path.parent() {
        Some(d) => d.to_path_buf(),
        None => return Err(io::Error::new(io::ErrorKind::InvalidInput, "no parent dir")),
    };
    let key = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "entry".into());
    let tmp = dir.join(format!(
        "{key}{TMP_MARKER}{}-{}",
        std::process::id(),
        TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));

    let result = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(value)?;
        f.sync_all()?;
        drop(f);
        match std::fs::rename(&tmp, path) {
            Ok(()) => Ok(()),
            Err(e) if cfg!(windows) && e.kind() == io::ErrorKind::AlreadyExists => {
                std::fs::remove_file(path)?;
                std::fs::rename(&tmp, path)?;
                Ok(())
            }
            Err(e) => Err(e),
        }
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
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
        cache.put("k1", br#"{"v":"value-one"}"#);
        assert_eq!(
            cache.get("k1").as_deref(),
            Some(br#"{"v":"value-one"}"#.as_slice())
        );
        // Entry lives under query-cache/, not generation-scoped.
        assert!(cache.query_dir().join("k1").exists());
        assert!(!tmp.path().join("gen-1").exists());
    }

    #[test]
    fn cache_get_miss_after_clear() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = QueryCache::new(tmp.path());
        cache.put("k1", br#"{"v":1}"#);
        cache.put_negative("neg", br#"{"n":1}"#);
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
            max_bytes: 20,
        };
        let big: &[u8] = br#"{"big":"0123456789"}"#; // 19 bytes
        let other: &[u8] = br#"{"other":"abcdef"}"#; // 20 bytes
        cache.put("big", big);
        assert_eq!(cache.get("big").as_deref(), Some(big));
        cache.put("other", other); // 39 bytes total → evict one
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
        cache.put_negative("k", br#"{"empty":true}"#);
        assert_eq!(
            cache.get_negative("k").as_deref(),
            Some(br#"{"empty":true}"#.as_slice())
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
        cache.put("pos", br#"{"p":1}"#);
        cache.put_negative("neg", br#"{"n":1}"#);
        cache.clear().unwrap();
        assert_eq!(cache.get("pos"), None);
        assert_eq!(cache.get_negative("neg"), None);
        assert!(!cache.query_dir().exists());
        assert!(!cache.negative_dir().exists());
    }

    #[test]
    fn atomic_write_roundtrips_without_temp_leak() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = QueryCache::new(tmp.path());
        cache.put("k", br#"{"v":1}"#);
        assert_eq!(cache.get("k").as_deref(), Some(br#"{"v":1}"#.as_slice()));
        // Overwrite: the new value replaces the old atomically.
        cache.put("k", br#"{"v":2}"#);
        assert_eq!(cache.get("k").as_deref(), Some(br#"{"v":2}"#.as_slice()));
        // No temp files may remain after any write (success or failure path).
        let leftover = std::fs::read_dir(cache.query_dir())
            .map(|rd| {
                rd.flatten()
                    .filter(|e| e.file_name().to_string_lossy().contains(TMP_MARKER))
                    .count()
            })
            .unwrap_or(0);
        assert_eq!(leftover, 0, "atomic writes must clean up their temp files");
    }

    #[test]
    fn corrupt_entries_are_quarantined_and_never_served() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = QueryCache::new(tmp.path());
        cache.put("good", br#"{"v":1}"#);

        // Corrupt the entry on disk (simulates a torn/interrupted legacy
        // write or disk corruption).
        std::fs::write(cache.query_dir().join("good"), b"{\"v\": 1, BROKEN").unwrap();
        assert_eq!(
            cache.get("good"),
            None,
            "corrupt entry must be a miss, never served"
        );
        // Quarantined for diagnostics: moved out of the namespace.
        assert!(!cache.query_dir().join("good").exists());
        let quarantined = cache.query_dir().join(QUARANTINE_DIR).join("good");
        assert!(quarantined.exists(), "corrupt entry is quarantined");

        // The negative namespace follows the same rule.
        cache.put_negative("neg", br#"{"empty":true}"#);
        std::fs::write(cache.negative_dir().join("neg"), b"not json at all").unwrap();
        assert_eq!(
            cache.get_negative("neg"),
            None,
            "corrupt negative entry is a miss"
        );
        assert!(cache
            .negative_dir()
            .join(QUARANTINE_DIR)
            .join("neg")
            .exists());

        // The quarantine dir never counts as a cache entry.
        assert_eq!(cache.get("good"), None);
    }

    #[test]
    fn stale_temp_files_are_swept_and_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = QueryCache::new(tmp.path());
        cache.put("k", br#"{"v":1}"#);

        // A leftover temp from a "crashed" writer, backdated beyond the grace
        // period: reads must ignore it and the LRU pass must sweep it.
        let stale_tmp = cache.query_dir().join(format!("k{TMP_MARKER}999-0"));
        std::fs::write(&stale_tmp, b"partial").unwrap();
        let backdated = SystemTime::now() - Duration::from_secs(2 * 60);
        std::fs::File::options()
            .write(true)
            .open(&stale_tmp)
            .and_then(|f| f.set_modified(backdated))
            .expect("backdate temp mtime");

        // Reads never see temp files (they are not under the final key).
        assert_eq!(cache.get("k").as_deref(), Some(br#"{"v":1}"#.as_slice()));

        // A fresh temp (a live concurrent writer) is NOT swept...
        let fresh_tmp = cache.query_dir().join(format!("k{TMP_MARKER}999-1"));
        std::fs::write(&fresh_tmp, b"in-flight").unwrap();
        cache.put("other", br#"{"v":2}"#); // triggers the LRU pass
        assert!(fresh_tmp.exists(), "live temp files are left alone");

        // ...but the stale one is gone after the sweep.
        assert!(!stale_tmp.exists(), "abandoned temp files are swept");
    }

    #[test]
    fn concurrent_read_write_never_serves_partial_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = QueryCache::new(tmp.path());
        let cache = std::sync::Arc::new(cache);

        let mut handles = Vec::new();
        for t in 0..4usize {
            let cache = cache.clone();
            handles.push(std::thread::spawn(move || {
                for i in 0..40usize {
                    let key = format!("key-{}-{}", t, i % 5);
                    let value = format!(r#"{{"writer":{t},"i":{i}}}"#);
                    cache.put(&key, value.as_bytes());
                    if let Some(bytes) = cache.get(&key) {
                        // Every observed entry must be complete, valid JSON.
                        serde_json::from_slice::<serde_json::Value>(&bytes)
                            .expect("readers never observe partial entries");
                    }
                }
            }));
        }
        for h in handles {
            h.join().expect("cache worker joined");
        }
    }
}
