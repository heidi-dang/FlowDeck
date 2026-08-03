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
/// a transaction-private temp file. Cache entries are content-addressed and
/// treated as IMMUTABLE: publication is a single atomic hard-link (never a
/// rename-over), and published finals are NEVER deleted or restored by a
/// rollback — they are harmless reusable immutable data, exactly like
/// artifacts. Rollback disposes only staged temps.
struct StagedCacheEntry {
    /// Final entry path (visible only after publish).
    final_path: PathBuf,
    /// The cache namespace directory containing the entry (for fsync).
    namespace_dir: PathBuf,
    /// Transaction-private temp holding the new bytes.
    staged_path: PathBuf,
    /// Content hash of the staged bytes (for winner identity comparison).
    content_hash: String,
    /// True once this entry was published (hard-linked) during publish.
    published: bool,
}

/// A transactional group of cache writes. Staging is invisible (private temp
/// files, no LRU); [`publish`] hard-links each staged temp into its final
/// entry path with atomic no-replace semantics and does NOT run LRU;
/// [`enforce_lru`] must be called separately, only after the enclosing batch's
/// global commit decision succeeds (P1-1).
///
/// Publication is atomic and race-free (P1-1): `hard_link` either creates the
/// final entry (we own it) or fails with `AlreadyExists` because another
/// writer already published — there is NO check-then-rename window. An
/// identical existing winner is classified `ReusedExisting` (never
/// rollback-owned, P1-2); a conflicting existing entry fails closed; a
/// published final is never replaced or deleted on rollback (immutable).
pub struct CacheTransaction<'a> {
    cache: &'a QueryCache,
    staged: Vec<StagedCacheEntry>,
}

/// Result of publishing one staged cache entry.
pub enum CachePublishOutcome {
    /// This transaction created the final entry (hard-linked it).
    Created,
    /// An identical winner already existed — the transaction does not own it
    /// and it is never rollback-owned.
    ReusedExisting,
}

impl CacheTransaction<'_> {
    /// Stage a write for `key`. The bytes are written to a private temp file
    /// (RAII-guarded: a write/sync failure removes the temp so it cannot
    /// leak); the entry is invisible and LRU is not touched.
    ///
    /// Same-key writes are deduplicated: staging the same final path again
    /// removes the displaced entry's temp file first (P2-1), so no private
    /// temp leaks.
    pub fn stage_write(&mut self, key: &str, negative: bool, bytes: &[u8]) -> Result<(), String> {
        let dir = if negative {
            self.cache.negative_dir()
        } else {
            self.cache.query_dir()
        };
        std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create cache dir: {e}"))?;
        let final_path = dir.join(key);
        // Deduplicate same-key writes: remove the displaced entry's temp
        // BEFORE discarding it (P2-1).
        self.staged.retain(|e| {
            e.final_path != final_path || {
                let _ = std::fs::remove_file(&e.staged_path);
                false
            }
        });
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
        self.staged.push(StagedCacheEntry {
            final_path,
            namespace_dir: dir,
            staged_path,
            content_hash: sha256_hex(bytes),
            published: false,
        });
        Ok(())
    }

    /// Publish every staged entry with a single ATOMIC hard-link per entry —
    /// there is no check-then-rename window (P1-1), so a concurrent writer can
    /// never be clobbered. An identical existing winner is reused
    /// (`ReusedExisting`, never rollback-owned, P1-2); a conflicting existing
    /// entry fails closed. The cache namespace directory is fsynced after each
    /// publication (P2-2 — the directory that actually changed). LRU is NOT
    /// run here.
    ///
    /// On failure, every remaining staged temp is removed; any removal failure
    /// is included in the returned report so an incomplete cleanup surfaces as
    /// ROLLBACK INCOMPLETE (P1-5/P2-3). Published finals are immutable and are
    /// never rolled back.
    pub fn publish(&mut self) -> Result<Vec<CachePublishOutcome>, PublishFailure> {
        let mut outcomes = Vec::with_capacity(self.staged.len());
        for entry in self.staged.iter_mut() {
            match std::fs::hard_link(&entry.staged_path, &entry.final_path) {
                Ok(()) => {
                    // We created the entry (atomic hard-link). Remove the temp
                    // name; a removal failure is recorded as incomplete
                    // cleanup (P2-4).
                    let temp_issue = std::fs::remove_file(&entry.staged_path).err().map(|e| {
                        format!(
                            "failed to remove staged temp {}: {e}",
                            entry.staged_path.display()
                        )
                    });
                    // Fsync the namespace directory that actually changed
                    // (P2-2). A failure makes the publish not durable.
                    let sync_issue = sync_cache_dir(&entry.namespace_dir).err().map(|e| {
                        format!(
                            "failed to sync cache dir {} after publishing {}: {e}",
                            entry.namespace_dir.display(),
                            entry.final_path.display()
                        )
                    });
                    entry.published = true;
                    outcomes.push(CachePublishOutcome::Created);
                    if let Some(issue) = temp_issue.or(sync_issue) {
                        return Err(PublishFailure {
                            message: format!(
                                "failed to publish cache entry {}: {issue}",
                                entry.final_path.display()
                            ),
                            temp_cleanup_issues: self.collect_temp_cleanup_issues(),
                            published_before_failure: outcomes.len(),
                        });
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    // Another writer already published this key. Read and
                    // verify the winner: identical → reuse (never owned);
                    // conflicting → fail closed (never replace).
                    let _ = std::fs::remove_file(&entry.staged_path);
                    match std::fs::read(&entry.final_path) {
                        Ok(existing) if sha256_hex(&existing) == entry.content_hash => {
                            outcomes.push(CachePublishOutcome::ReusedExisting);
                        }
                        Ok(_) => {
                            return Err(PublishFailure {
                                message: format!(
                                    "cache entry {} exists with different content",
                                    entry.final_path.display()
                                ),
                                temp_cleanup_issues: self.collect_temp_cleanup_issues(),
                                published_before_failure: outcomes.len(),
                            });
                        }
                        Err(read_err) => {
                            return Err(PublishFailure {
                                message: format!(
                                    "cache entry {} winner unreadable: {read_err}",
                                    entry.final_path.display()
                                ),
                                temp_cleanup_issues: self.collect_temp_cleanup_issues(),
                                published_before_failure: outcomes.len(),
                            });
                        }
                    }
                }
                Err(e) => {
                    return Err(PublishFailure {
                        message: format!(
                            "failed to publish cache entry {}: {e}",
                            entry.final_path.display()
                        ),
                        temp_cleanup_issues: self.collect_temp_cleanup_issues(),
                        published_before_failure: outcomes.len(),
                    });
                }
            }
        }
        Ok(outcomes)
    }

    /// Remove every un-published staged temp. Returns a list of removal
    /// failures so an incomplete cleanup is surfaced (P1-5/P2-3).
    fn collect_temp_cleanup_issues(&self) -> Vec<String> {
        let mut issues = Vec::new();
        for entry in &self.staged {
            if entry.published {
                continue;
            }
            if let Err(e) = std::fs::remove_file(&entry.staged_path) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    issues.push(format!(
                        "failed to remove staged temp {}: {e}",
                        entry.staged_path.display()
                    ));
                }
            }
        }
        issues
    }

    /// Run LRU maintenance over both namespaces. Must be called ONLY after the
    /// enclosing batch's global commit decision succeeds — never during
    /// staging, never before the post-activation probe (P1-1).
    pub fn enforce_lru(&self) {
        self.cache.enforce_lru(&self.cache.query_dir());
        self.cache.enforce_lru(&self.cache.negative_dir());
    }

    /// Discard every staged entry WITHOUT publishing anything. Published
    /// finals are immutable and never touched. Returns removal failures.
    pub fn abort(&mut self) -> Vec<String> {
        let issues = self.collect_temp_cleanup_issues();
        self.staged.clear();
        issues
    }
}

/// Structured failure from [`CacheTransaction::publish`]: the primary
/// publication error plus every staged-temp cleanup issue, so an incomplete
/// rollback can be surfaced as ROLLBACK INCOMPLETE (P1-5/P2-3).
#[derive(Debug)]
pub struct PublishFailure {
    /// The primary publication error message.
    pub message: String,
    /// Staged-temp removal failures (empty when cleanup was complete).
    pub temp_cleanup_issues: Vec<String>,
    /// How many entries were published before the failure.
    pub published_before_failure: usize,
}

impl std::fmt::Display for PublishFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
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

/// Directory fsync for cache operations. Contract (P2-2): the supplied path is
/// the DIRECTORY that actually changed (e.g. `<state>/query-cache`), and it is
/// opened and fsynced directly — not its parent. Returns the io result so
/// genuine failures (EIO, permission, ENOSPC) propagate (P2-4).
#[cfg(unix)]
fn sync_cache_dir(dir: &Path) -> std::io::Result<()> {
    let d = std::fs::File::open(dir)?;
    d.sync_all()
}

#[cfg(not(unix))]
fn sync_cache_dir(_dir: &Path) -> std::io::Result<()> {
    Ok(())
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
