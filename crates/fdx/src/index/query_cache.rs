//! Content-addressed query-result cache (v2).
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
//! ## Two-level atomic generation storage (P1-1 remediation)
//!
//! v1 published each cache entry as a reader-visible file during Phase B2,
//! which created a window in which a reader could observe a PARTIAL batch
//! (some entries published, others not) and — worse — could observe cache
//! entries whose artifacts had not yet been revalidated. v2 replaces
//! reader-visible per-key files with an atomic generation pointer:
//!
//!   <state>/query-cache-v2/
//!     objects/<sha256-hex>        # immutable content-addressed payloads
//!     generations/gen-<N>.json    # full-snapshot generation manifests
//!     CURRENT                     # current generation sequence number
//!     tmp/                        # in-progress temp files (RAII-owned)
//!     quarantine/                 # corrupt objects moved here
//!     commit.lock                 # O_EXCL cross-process commit lock
//!
//! A batch is committed in three steps, in this exact order:
//!   1. **stage** — write each payload as a content-addressed object under
//!      `objects/`. Objects are immutable and INVISIBLE to readers: they are
//!      only reachable through a manifest named by `CURRENT`.
//!   2. **manifest** — write `gen-<N+1>.json` as a FULL SNAPSHOT of every
//!      committed mapping (positives `key→{digest,created_at}`, negatives
//!      `key→{digest,committed_at}`) with an integrity SHA-256, via
//!      tmp + fsync + rename.
//!   3. **flip** — atomically rename `CURRENT.tmp` → `CURRENT`. A reader
//!      observes either the old generation or the new one — never a partial
//!      batch.
//!
//! Readers validate every referenced object digest + JSON on load, quarantine
//! corrupt objects, and fail CLOSED to the newest valid retained generation.
//! Legacy v1 directories (`query-cache/`, `negative-cache/`) are never served
//! and are removed by [`QueryCache::clear`].
//!
//! Bounds: a fixed maximum number of committed mappings and a fixed maximum
//! total bytes, enforced by evicting least-recently-used committed mappings
//! (by `created_at`/`committed_at`) on write. GC reclaims unreferenced
//! objects, stale generations, and abandoned temp files after a grace period.

use std::collections::{BTreeMap, HashSet};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

/// Domain string that prefixes every cache key (contract). Bumping this
/// invalidates all caches from older builds. Bumped to `-v2` when the storage
/// layout changed to two-level atomic generations.
pub const CACHE_DOMAIN: &str = "flowdeck-fdx-query-cache-v2";

/// Legacy v1 positive-cache directory. NEVER served by v2; removed by
/// [`QueryCache::clear`].
pub const QUERY_CACHE_DIR: &str = "query-cache";

/// Legacy v1 negative-cache directory. NEVER served by v2; removed by
/// [`QueryCache::clear`].
pub const NEGATIVE_CACHE_DIR: &str = "negative-cache";

/// v2 storage root (under the worktree state dir).
pub const V2_DIR: &str = "query-cache-v2";

/// Content-addressed object store (immutable payloads).
pub const OBJECTS_DIR: &str = "objects";

/// Full-snapshot generation manifests.
pub const GENERATIONS_DIR: &str = "generations";

/// The atomic generation pointer file.
pub const CURRENT_FILE: &str = "CURRENT";

/// In-flight temp files (owned by [`OwnedTemp`]).
pub const TMP_DIR: &str = "tmp";

/// Corrupt objects moved here for diagnostics.
pub const QUARANTINE_DIR: &str = "quarantine";

/// O_EXCL cross-process commit lock.
pub const COMMIT_LOCK_FILE: &str = "commit.lock";

/// Manifest schema version.
pub const SCHEMA_VERSION: u32 = 2;

/// Default maximum number of committed cache mappings per worktree.
pub const DEFAULT_MAX_ITEMS: usize = 512;

/// Default maximum total cached bytes per worktree (8 MiB).
pub const DEFAULT_MAX_BYTES: usize = 8 * 1024 * 1024;

/// Protocol version used in cache keys. Bumped only when the batch protocol
/// version changes in a way that changes result semantics.
pub const BATCH_PROTOCOL_VERSION: u32 = 1;

/// TTL for negative cache entries. A negative entry is only valid for this
/// many seconds after it was committed; beyond it, the query re-runs.
pub const NEGATIVE_TTL_SECS: u64 = 30;

/// How many generations back a reader walks to recover from a corrupt
/// `CURRENT` manifest before failing closed (empty cache).
const RETAINED_GENERATIONS: u64 = 8;

/// Age after which an unreferenced object / stale generation is considered
/// abandoned by a crashed writer and is swept by GC. Live commits complete in
/// milliseconds, so a 5-minute grace cannot race a concurrent committer.
const ORPHAN_GRACE: Duration = Duration::from_secs(300);

/// Age after which a leftover temp file is swept.
const TMP_GRACE: Duration = Duration::from_secs(60);

/// Age after which a `commit.lock` is considered abandoned by a crashed
/// committer and is broken (removed) by the next committer.
const LOCK_STALE_GRACE: Duration = Duration::from_secs(30);

/// Sleep between commit-lock contention retries.
const LOCK_RETRY_SLEEP: Duration = Duration::from_millis(5);

/// Worst-case commit-lock wait budget (600 × 5 ms = 3 s).
const LOCK_RETRY_BUDGET: usize = 600;

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

/// A positive cache mapping: the content digest plus the commit time (used as
/// the LRU recency anchor).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct PositiveEntry {
    /// SHA-256 hex digest of the object payload.
    pub digest: String,
    /// Epoch seconds when this mapping was committed (LRU recency).
    pub created_at: u64,
}

/// A negative cache mapping: the content digest plus the commit time (the TTL
/// anchor).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct NegativeEntry {
    /// SHA-256 hex digest of the object payload.
    pub digest: String,
    /// Epoch seconds when this mapping was committed (TTL anchor).
    pub committed_at: u64,
}

/// A full-snapshot generation manifest. `positives` and `negatives` are the
/// COMPLETE set of committed mappings at this generation (not a delta), so a
/// reader needs only the manifest named by `CURRENT` to serve every entry.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct GenerationManifest {
    /// Must equal [`SCHEMA_VERSION`].
    pub schema_version: u32,
    /// Monotonic generation sequence number (matches the `gen-<N>.json` name).
    pub generation: u64,
    /// The generation this snapshot extends (None for the first generation).
    pub base_generation: Option<u64>,
    /// Epoch seconds when this generation was committed.
    pub created_at: u64,
    /// Positive (definitive-result) mappings, keyed by cache key.
    pub positives: BTreeMap<String, PositiveEntry>,
    /// Negative (definitive-empty) mappings, keyed by cache key.
    pub negatives: BTreeMap<String, NegativeEntry>,
    /// SHA-256 over the canonical serialization of every other field.
    pub integrity: String,
}

impl GenerationManifest {
    /// An empty manifest for a given generation (used when no base exists).
    fn empty(generation: u64) -> Self {
        let mut m = GenerationManifest {
            schema_version: SCHEMA_VERSION,
            generation,
            base_generation: None,
            created_at: unix_secs(),
            positives: BTreeMap::new(),
            negatives: BTreeMap::new(),
            integrity: String::new(),
        };
        m.integrity = compute_integrity(&m);
        m
    }
}

/// The disk-backed query cache for one worktree.
///
/// All operations are best-effort: a read that races a refresh may miss, and
/// a write that fails (disk full, permissions) is ignored — the cache must
/// never fail a query. The LRU bound is enforced on write: committed mappings
/// beyond `max_items` or `max_bytes` are evicted oldest-first.
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

    /// The v2 storage root (created lazily on write).
    pub fn root_dir(&self) -> PathBuf {
        self.state_dir.join(V2_DIR)
    }

    /// Content-addressed object store.
    pub fn objects_dir(&self) -> PathBuf {
        self.root_dir().join(OBJECTS_DIR)
    }

    /// Generation manifests.
    pub fn generations_dir(&self) -> PathBuf {
        self.root_dir().join(GENERATIONS_DIR)
    }

    /// In-flight temp files.
    pub fn tmp_dir(&self) -> PathBuf {
        self.root_dir().join(TMP_DIR)
    }

    /// Corrupt objects.
    pub fn quarantine_dir(&self) -> PathBuf {
        self.root_dir().join(QUARANTINE_DIR)
    }

    /// The atomic generation pointer file.
    pub fn current_path(&self) -> PathBuf {
        self.root_dir().join(CURRENT_FILE)
    }

    /// The cross-process commit lock file.
    pub fn lock_path(&self) -> PathBuf {
        self.root_dir().join(COMMIT_LOCK_FILE)
    }

    /// The legacy v1 positive-cache directory (never served; removed on
    /// [`clear`](Self::clear)).
    pub fn query_dir(&self) -> PathBuf {
        self.state_dir.join(QUERY_CACHE_DIR)
    }

    /// The path of the generation manifest the next successful publish would
    /// write (current generation + 1). Used by tests to deterministically
    /// block a commit at the manifest-write stage.
    pub fn next_generation_path(&self) -> PathBuf {
        let seq = read_current(&self.current_path()).unwrap_or(0);
        self.generations_dir().join(gen_file_name(seq + 1))
    }

    /// The legacy v1 negative-cache directory (never served; removed on
    /// [`clear`](Self::clear)).
    pub fn negative_dir(&self) -> PathBuf {
        self.state_dir.join(NEGATIVE_CACHE_DIR)
    }

    /// The worktree state directory this cache lives under. Artifacts (full
    /// payloads spilled by output-bounded responses) are stored next to the
    /// cache namespaces so they share the worktree lifecycle.
    pub fn state_dir(&self) -> &Path {
        &self.state_dir
    }

    /// Look up a cached value. Returns None on miss. The value is only served
    /// if it is reachable through the generation named by `CURRENT` AND its
    /// object passes digest + JSON validation.
    pub fn get(&self, key: &str) -> Option<Vec<u8>> {
        self.read_entry(key, false)
    }

    /// Store a value under `key`, then enforce the LRU bound. Best-effort:
    /// failures are swallowed so a cache write never fails a query. The value
    /// becomes visible only through an atomic generation flip.
    pub fn put(&self, key: &str, value: &[u8]) {
        let mut tx = self.begin();
        if tx.stage_write(key, false, value).is_err() {
            return;
        }
        if tx.publish().is_err() {
            return;
        }
        tx.enforce_lru();
    }

    /// Look up a negative cache entry. A negative entry is only valid for
    /// `NEGATIVE_TTL_SECS` after it was committed; expired entries are a miss
    /// (the next query re-runs).
    pub fn get_negative(&self, key: &str) -> Option<Vec<u8>> {
        self.read_entry(key, true)
    }

    /// Store a negative cache entry (definitive-empty result). The commit
    /// time is the TTL anchor. Same atomic-generation rules as the positive
    /// cache.
    pub fn put_negative(&self, key: &str, value: &[u8]) {
        let mut tx = self.begin();
        if tx.stage_write(key, true, value).is_err() {
            return;
        }
        if tx.publish().is_err() {
            return;
        }
        tx.enforce_lru();
    }

    /// Remove every cache entry (positive and negative) and the v2 root.
    /// Used by `index.invalidate` — a full invalidation must drop cached
    /// results. Also removes legacy v1 namespaces so they never linger.
    pub fn clear(&self) -> io::Result<()> {
        for dir in [self.root_dir(), self.query_dir(), self.negative_dir()] {
            if dir.exists() {
                std::fs::remove_dir_all(&dir)?;
            }
        }
        Ok(())
    }

    /// Begin a transactional batch of cache writes. Entries are staged as
    /// invisible content-addressed objects and become visible ONLY on
    /// [`publish`](CacheTransaction::publish), at which point a single atomic
    /// generation flip makes the whole batch visible (or nothing). LRU
    /// maintenance runs once after a successful commit — never during
    /// staging — so a failed transaction cannot evict live entries.
    pub fn begin(&self) -> CacheTransaction<'_> {
        CacheTransaction {
            cache: self,
            staged: Vec::new(),
        }
    }

    /// Read a single entry through the `CURRENT` generation pointer.
    fn read_entry(&self, key: &str, negative: bool) -> Option<Vec<u8>> {
        if !valid_cache_key(key) {
            return None;
        }
        let seq = read_current(&self.current_path())?;
        let manifest = self.load_valid_manifest(seq)?;
        let digest = if negative {
            let e = manifest.negatives.get(key)?;
            if negative_expired(e.committed_at, unix_secs()) {
                return None;
            }
            e.digest.clone()
        } else {
            manifest.positives.get(key)?.digest.clone()
        };
        if !valid_digest(&digest) {
            return None;
        }
        let obj_path = self.objects_dir().join(&digest);
        let data = std::fs::read(&obj_path).ok()?;
        if sha256_hex(&data) != digest {
            self.quarantine_object(&digest);
            return None;
        }
        if serde_json::from_slice::<serde_json::Value>(&data).is_err() {
            self.quarantine_object(&digest);
            return None;
        }
        Some(data)
    }

    /// Load the newest VALID manifest reachable from `seq`, walking the
    /// generation chain backwards up to [`RETAINED_GENERATIONS`] steps. A
    /// corrupt manifest is quarantined and the walk continues to its
    /// predecessor; a missing manifest (e.g. a crash between the manifest
    /// write and the `CURRENT` flip) also continues to its predecessor.
    /// Returns None when no valid manifest is found (fail closed — the cache
    /// is treated as empty).
    fn load_valid_manifest(&self, seq: u64) -> Option<GenerationManifest> {
        let mut current = seq;
        for _ in 0..RETAINED_GENERATIONS {
            let path = self.generations_dir().join(gen_file_name(current));
            match std::fs::read(&path) {
                Ok(bytes) => match validate_manifest(&bytes, current) {
                    Ok(m) => return Some(m),
                    Err(_) => {
                        let _ = self.quarantine_manifest(current);
                    }
                },
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(_) => break, // genuine I/O error: fail closed
            }
            current = current.saturating_sub(1);
            if current == 0 {
                break;
            }
        }
        None
    }

    /// Move a corrupt object out of the object store for diagnostics.
    fn quarantine_object(&self, digest: &str) {
        let src = self.objects_dir().join(digest);
        let qdir = self.quarantine_dir();
        if std::fs::create_dir_all(&qdir).is_ok() {
            let _ = std::fs::rename(&src, qdir.join(digest));
        } else {
            let _ = std::fs::remove_file(&src);
        }
    }

    /// Move a corrupt generation manifest out of the generations dir.
    fn quarantine_manifest(&self, seq: u64) -> io::Result<()> {
        let src = self.generations_dir().join(gen_file_name(seq));
        let qdir = self.quarantine_dir();
        std::fs::create_dir_all(&qdir)?;
        std::fs::rename(&src, qdir.join(gen_file_name(seq)))
    }

    /// Acquire the cross-process commit lock (O_EXCL). Retries on contention;
    /// breaks a lock older than [`LOCK_STALE_GRACE`] (a crashed committer).
    /// Returns an [`OwnedTemp`] guard that removes the lock file on drop.
    fn acquire_commit_lock(&self) -> Result<OwnedTemp, String> {
        let lock_path = self.lock_path();
        if let Some(parent) = lock_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create cache root: {e}"))?;
        }
        let mut attempts = 0usize;
        loop {
            match std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&lock_path)
            {
                Ok(_) => return Ok(OwnedTemp::adopt(lock_path)),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                    if lock_is_stale(&lock_path) {
                        // A crashed committer left it behind: break it.
                        if std::fs::remove_file(&lock_path).is_ok() {
                            continue;
                        }
                    }
                    attempts += 1;
                    if attempts >= LOCK_RETRY_BUDGET {
                        return Err("timed out waiting for the cache commit lock".into());
                    }
                    std::thread::sleep(LOCK_RETRY_SLEEP);
                }
                Err(e) => {
                    return Err(format!("failed to create cache commit lock: {e}"));
                }
            }
        }
    }

    /// Write a generation manifest atomically (tmp + fsync + rename).
    fn write_manifest_atomic(&self, manifest: &GenerationManifest) -> Result<(), String> {
        let bytes = serde_json::to_vec(manifest)
            .map_err(|e| format!("failed to serialize generation manifest: {e}"))?;
        let gen_dir = self.generations_dir();
        std::fs::create_dir_all(&gen_dir)
            .map_err(|e| format!("failed to create generations dir: {e}"))?;
        let final_path = gen_dir.join(gen_file_name(manifest.generation));
        let mut tmp =
            OwnedTemp::create_exclusive_in(&gen_dir, &format!("gen-{}", manifest.generation))?;
        tmp.write_all_and_sync(&bytes)?;
        match std::fs::rename(tmp.path(), &final_path) {
            Ok(()) => {
                tmp.disarm();
                Ok(())
            }
            Err(e) => Err(format!(
                "failed to rename generation manifest {}: {e}",
                final_path.display()
            )),
        }
    }

    /// Atomically flip the `CURRENT` pointer to `seq` (tmp + fsync + rename).
    fn flip_current(&self, seq: u64) -> Result<(), String> {
        let root = self.root_dir();
        std::fs::create_dir_all(&root).map_err(|e| format!("failed to create cache root: {e}"))?;
        let mut tmp = OwnedTemp::create_exclusive_in(&root, CURRENT_FILE)?;
        tmp.write_all_and_sync(format!("{seq}\n").as_bytes())?;
        match std::fs::rename(tmp.path(), self.current_path()) {
            Ok(()) => {
                tmp.disarm();
                sync_cache_dir(&root).map_err(|e| format!("failed to fsync cache root: {e}"))
            }
            Err(e) => Err(format!("failed to flip CURRENT: {e}")),
        }
    }

    /// Finalize a commit: write the manifest, fsync the generations dir, then
    /// flip `CURRENT`. The commit lock is held for the whole sequence and
    /// released on drop. Returns a structured [`PublishFailure`] on any
    /// failure (the pointer is never flipped on failure, so readers observe
    /// the previous generation).
    fn finalize_commit(
        &self,
        manifest: &GenerationManifest,
        lock: OwnedTemp,
    ) -> Result<(), PublishFailure> {
        let mut durability_issues: Vec<String> = Vec::new();
        if let Err(e) = self.write_manifest_atomic(manifest) {
            return Err(PublishFailure {
                primary_error: e,
                outcomes: Vec::new(),
                cleanup_issues: Vec::new(),
                durability_issues,
                unpublished_objects: Vec::new(),
            });
        }
        if let Err(e) = sync_cache_dir(&self.generations_dir()) {
            durability_issues.push(format!("failed to fsync generations dir: {e}"));
            return Err(PublishFailure {
                primary_error: "generation manifest not durable".into(),
                outcomes: Vec::new(),
                cleanup_issues: Vec::new(),
                durability_issues,
                unpublished_objects: Vec::new(),
            });
        }
        if let Err(e) = self.flip_current(manifest.generation) {
            durability_issues.push(format!("failed to flip CURRENT: {e}"));
            return Err(PublishFailure {
                primary_error: "CURRENT pointer not flipped".into(),
                outcomes: Vec::new(),
                cleanup_issues: Vec::new(),
                durability_issues,
                unpublished_objects: Vec::new(),
            });
        }
        // Lock released on drop (removes commit.lock). A removal failure is
        // only a stale-lock annoyance for the next committer (age-break).
        drop(lock);
        Ok(())
    }

    /// Count committed positive and negative mappings from the `CURRENT`
    /// manifest. Test/diagnostic helper (not part of the serving path).
    #[doc(hidden)]
    pub fn debug_entry_count(&self) -> (usize, usize) {
        let seq = read_current(&self.current_path()).unwrap_or(0);
        if seq == 0 {
            return (0, 0);
        }
        match self.load_valid_manifest(seq) {
            Some(m) => (m.positives.len(), m.negatives.len()),
            None => (0, 0),
        }
    }

    /// Run LRU maintenance over the committed mappings and GC unreferenced
    /// objects. Must be called ONLY after the enclosing batch's global commit
    /// decision succeeds — never during staging, never before the
    /// post-activation probe (P1-1). Best-effort.
    pub fn enforce_lru(&self) {
        let Ok(lock) = self.acquire_commit_lock() else {
            return;
        };
        let seq = read_current(&self.current_path()).unwrap_or(0);
        if seq == 0 {
            drop(lock);
            return;
        }
        let Some(mut manifest) = self.load_valid_manifest(seq) else {
            drop(lock);
            return;
        };
        let now = unix_secs();
        let mut changed = false;
        // Evict least-recently-used committed mappings until both bounds hold.
        loop {
            let (count, bytes) = self.committed_stats(&manifest);
            if count <= self.max_items && bytes <= self.max_bytes {
                break;
            }
            evict_lru_mapping(&mut manifest);
            changed = true;
        }
        // Prune expired negatives during maintenance (they are never served,
        // but keeping them wastes manifest space).
        if prune_expired_negatives(&mut manifest, now) {
            changed = true;
        }
        if changed {
            // The new generation number advances from CURRENT (read under the
            // lock), so it is unique and visible after the pointer flip. Its
            // base is the newest VALID manifest (which may be older than the
            // CURRENT sequence if that manifest was corrupt).
            let new_seq = seq + 1;
            let mut next = manifest.clone();
            next.generation = new_seq;
            next.base_generation = Some(manifest.generation);
            next.created_at = now;
            next.integrity = String::new();
            next.integrity = compute_integrity(&next);
            let _ = self.finalize_commit(&next, lock);
        } else {
            drop(lock);
        }
        self.gc();
    }

    /// Sum of committed mappings and the total bytes of their referenced
    /// objects (deduplicated by digest).
    fn committed_stats(&self, manifest: &GenerationManifest) -> (usize, usize) {
        let mut count = 0usize;
        let mut bytes = 0usize;
        let mut seen: HashSet<&str> = HashSet::new();
        for digest in manifest
            .positives
            .values()
            .map(|e| e.digest.as_str())
            .chain(manifest.negatives.values().map(|e| e.digest.as_str()))
        {
            count += 1;
            if seen.insert(digest) {
                bytes += self
                    .objects_dir()
                    .join(digest)
                    .metadata()
                    .map(|m| m.len() as usize)
                    .unwrap_or(0);
            }
        }
        (count, bytes)
    }

    /// Collect the set of object digests reachable from the retained
    /// generation chain (current + predecessors, up to `RETAINED_GENERATIONS`).
    fn reachable_objects(&self) -> HashSet<String> {
        let mut reachable = HashSet::new();
        let seq = read_current(&self.current_path()).unwrap_or(0);
        if seq == 0 {
            return reachable;
        }
        let mut current = seq;
        for _ in 0..RETAINED_GENERATIONS {
            let path = self.generations_dir().join(gen_file_name(current));
            let Ok(bytes) = std::fs::read(&path) else {
                break;
            };
            match validate_manifest(&bytes, current) {
                Ok(m) => {
                    for digest in m
                        .positives
                        .values()
                        .map(|e| e.digest.clone())
                        .chain(m.negatives.values().map(|e| e.digest.clone()))
                    {
                        reachable.insert(digest);
                    }
                    current = m.base_generation.unwrap_or(0);
                    if current == 0 {
                        break;
                    }
                }
                Err(_) => {
                    current = current.saturating_sub(1);
                }
            }
        }
        reachable
    }

    /// Reclaim unreferenced objects, stale generations, and abandoned temp
    /// files. Best-effort; never deletes an object younger than the orphan
    /// grace period, so a just-committed generation's objects are protected.
    fn gc(&self) {
        let now = unix_secs();
        let reachable = self.reachable_objects();
        // Objects: delete unreferenced ones older than the grace period.
        if let Ok(entries) = std::fs::read_dir(self.objects_dir()) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if reachable.contains(&name) {
                    continue;
                }
                if !valid_cache_key(&name) {
                    continue;
                }
                if file_older_than(&entry.path(), now, ORPHAN_GRACE) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        // Stale generations: keep the retained chain plus a safety margin.
        let seq = read_current(&self.current_path()).unwrap_or(0);
        let keep_floor = seq.saturating_sub(RETAINED_GENERATIONS + 4);
        if let Ok(entries) = std::fs::read_dir(self.generations_dir()) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if let Some(n) = parse_generation_file(&name) {
                    if n < keep_floor && file_older_than(&entry.path(), now, ORPHAN_GRACE) {
                        let _ = std::fs::remove_file(entry.path());
                    }
                }
            }
        }
        // Abandoned temp files.
        if let Ok(entries) = std::fs::read_dir(self.tmp_dir()) {
            for entry in entries.flatten() {
                if file_older_than(&entry.path(), now, TMP_GRACE) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
}

/// Marker embedded in every temp file name (also used by the GC sweep).
const TMP_MARKER: &str = ".tmp-";

/// One staged cache write inside a [`CacheTransaction`]. Staging writes the
/// payload as an immutable content-addressed object under `objects/`; the
/// object is INVISIBLE to readers until a manifest referencing it is named by
/// `CURRENT`. Publication is a single atomic generation flip.
struct StagedCacheEntry {
    /// The cache key (64-hex SHA-256).
    key: String,
    /// True for a negative (definitive-empty) entry.
    negative: bool,
    /// Content hash of the staged bytes.
    digest: String,
}

/// A transactional group of cache writes. Staging is invisible (content-
/// addressed objects, no LRU); [`publish`](Self::publish) commits the whole
/// batch with a single atomic generation flip; [`enforce_lru`](Self::enforce_lru)
/// must be called separately, only after the enclosing batch's global commit
/// decision succeeds (P1-1).
///
/// Publication is all-or-nothing (P1-1): either `CURRENT` flips to a manifest
/// containing every staged mapping, or it does not flip at all. A reader can
/// never observe a partial batch. Objects staged but not committed are
/// unreferenced orphans reclaimed by GC after the grace period.
pub struct CacheTransaction<'a> {
    cache: &'a QueryCache,
    staged: Vec<StagedCacheEntry>,
}

/// Result of publishing one staged cache entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CachePublishOutcome {
    /// This transaction introduced the mapping (or replaced a stale one).
    Created,
    /// An identical mapping already existed in the base generation — the
    /// transaction did not change the visible result.
    ReusedExisting,
}

impl CacheTransaction<'_> {
    /// Stage a write for `key`. The bytes are written to an immutable
    /// content-addressed object (RAII-owned temp, no-clobber hard-link). The
    /// entry is invisible and LRU is not touched.
    ///
    /// Same-key writes are deduplicated: staging the same key again replaces
    /// the previous stage (the displaced object is an orphan reclaimed by GC).
    pub fn stage_write(&mut self, key: &str, negative: bool, bytes: &[u8]) -> Result<(), String> {
        if !valid_cache_key(key) {
            return Err(format!("invalid cache key: {key:?}"));
        }
        let digest = sha256_hex(bytes);
        if let Some(pos) = self
            .staged
            .iter()
            .position(|e| e.key == key && e.negative == negative)
        {
            if self.staged[pos].digest == digest {
                return Ok(());
            }
            self.staged.remove(pos);
        }
        self.stage_object(&digest, bytes)?;
        self.staged.push(StagedCacheEntry {
            key: key.to_string(),
            negative,
            digest,
        });
        Ok(())
    }

    /// Write `bytes` as an immutable content-addressed object (no-clobber).
    /// An identical existing object is reused; a conflicting one fails closed.
    fn stage_object(&self, digest: &str, bytes: &[u8]) -> Result<(), String> {
        let objects_dir = self.cache.objects_dir();
        std::fs::create_dir_all(&objects_dir)
            .map_err(|e| format!("failed to create objects dir: {e}"))?;
        let final_path = objects_dir.join(digest);
        // Reuse an identical existing object (content-addressed dedup).
        if let Ok(existing) = std::fs::read(&final_path) {
            if sha256_hex(&existing) == digest {
                return Ok(());
            }
            return Err(format!(
                "cache object {} exists with different content",
                final_path.display()
            ));
        }
        let tmp_dir = self.cache.tmp_dir();
        std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("failed to create tmp dir: {e}"))?;
        let mut tmp = OwnedTemp::create_exclusive_in(&tmp_dir, digest)?;
        tmp.write_all_and_sync(bytes)?;
        let tmp_path = tmp.path().to_path_buf();
        // Publish with NO-CLOBBER: hard_link or AlreadyExists → verify winner.
        match std::fs::hard_link(&tmp_path, &final_path) {
            Ok(()) => {
                tmp.remove().map_err(|e| {
                    format!(
                        "failed to remove staged object temp {}: {e}",
                        tmp_path.display()
                    )
                })?;
                Ok(())
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                tmp.remove().map_err(|e| {
                    format!(
                        "failed to remove staged object temp {}: {e}",
                        tmp_path.display()
                    )
                })?;
                let existing = std::fs::read(&final_path).map_err(|e| {
                    format!("cache object {} unreadable: {e}", final_path.display())
                })?;
                if sha256_hex(&existing) == digest {
                    Ok(())
                } else {
                    Err(format!(
                        "cache object {} exists with different content",
                        final_path.display()
                    ))
                }
            }
            Err(e) => Err(format!(
                "failed to publish cache object {}: {e}",
                final_path.display()
            )),
        }
    }

    /// Commit every staged mapping with a single atomic generation flip.
    /// The commit lock serializes concurrent committers; the new manifest is a
    /// full snapshot of the base plus the staged mappings; `CURRENT` is
    /// flipped last. On success every staged mapping is visible; on failure
    /// nothing is visible (the pointer is never flipped).
    ///
    /// On failure, staged objects are content-addressed IMMUTABLE and are
    /// never unlinked by pathname — they are harmless orphans reclaimed by GC.
    /// Every independent failure — manifest write, durability fsync, pointer
    /// flip — is preserved in the returned [`PublishFailure`].
    pub fn publish(&mut self) -> Result<Vec<CachePublishOutcome>, PublishFailure> {
        if self.staged.is_empty() {
            return Ok(Vec::new());
        }
        let lock = match self.cache.acquire_commit_lock() {
            Ok(l) => l,
            Err(e) => {
                return Err(PublishFailure {
                    primary_error: e,
                    outcomes: Vec::new(),
                    cleanup_issues: Vec::new(),
                    durability_issues: Vec::new(),
                    unpublished_objects: self.unpublished_objects(),
                });
            }
        };
        let base_seq = read_current(&self.cache.current_path()).unwrap_or(0);
        let base = if base_seq == 0 {
            GenerationManifest::empty(0)
        } else {
            self.cache
                .load_valid_manifest(base_seq)
                .unwrap_or_else(|| GenerationManifest::empty(base_seq))
        };
        // The new manifest extends the newest VALID base (which may be older
        // than `base_seq` if the CURRENT manifest was corrupt/missing), so the
        // chain stays valid. The sequence number still advances from CURRENT.
        let base_generation = if base_seq == 0 {
            None
        } else {
            Some(base.generation)
        };
        let now = unix_secs();
        let new_seq = base_seq + 1;
        let mut positives = base.positives.clone();
        let mut negatives = base.negatives.clone();
        let mut outcomes = Vec::with_capacity(self.staged.len());
        for entry in &self.staged {
            if entry.negative {
                let reused = negatives
                    .get(&entry.key)
                    .map(|e| e.digest == entry.digest)
                    .unwrap_or(false);
                negatives.insert(
                    entry.key.clone(),
                    NegativeEntry {
                        digest: entry.digest.clone(),
                        committed_at: now,
                    },
                );
                outcomes.push(if reused {
                    CachePublishOutcome::ReusedExisting
                } else {
                    CachePublishOutcome::Created
                });
            } else {
                let reused = positives
                    .get(&entry.key)
                    .map(|e| e.digest == entry.digest)
                    .unwrap_or(false);
                positives.insert(
                    entry.key.clone(),
                    PositiveEntry {
                        digest: entry.digest.clone(),
                        created_at: now,
                    },
                );
                outcomes.push(if reused {
                    CachePublishOutcome::ReusedExisting
                } else {
                    CachePublishOutcome::Created
                });
            }
        }
        let mut manifest = GenerationManifest {
            schema_version: SCHEMA_VERSION,
            generation: new_seq,
            base_generation,
            created_at: now,
            positives,
            negatives,
            integrity: String::new(),
        };
        manifest.integrity = compute_integrity(&manifest);
        match self.cache.finalize_commit(&manifest, lock) {
            Ok(()) => {
                self.staged.clear();
                Ok(outcomes)
            }
            Err(mut f) => {
                f.outcomes = outcomes;
                f.unpublished_objects = self.unpublished_objects();
                Err(f)
            }
        }
    }

    /// The digests of objects staged but not yet committed (for the failure
    /// report).
    fn unpublished_objects(&self) -> Vec<String> {
        self.staged.iter().map(|s| s.digest.clone()).collect()
    }

    /// Run LRU maintenance over the committed mappings. Must be called ONLY
    /// after the enclosing batch's global commit decision succeeds.
    pub fn enforce_lru(&self) {
        self.cache.enforce_lru();
    }

    /// Discard every staged entry WITHOUT publishing anything. In v2 staged
    /// objects are content-addressed and unreferenced by any manifest, so they
    /// are harmless orphans reclaimed by GC after the grace period — there is
    /// nothing reader-visible to remove. Returns removal failures (none in
    /// practice; `OwnedTemp` RAII prevents temp leaks in-process).
    pub fn abort(&mut self) -> Vec<String> {
        let issues = Vec::new();
        self.staged.clear();
        issues
    }
}

/// Structured failure from [`CacheTransaction::publish`]: the primary
/// publication error plus every independent cleanup and durability issue, so
/// an incomplete commit can be surfaced distinctly (P1-5/P2-3).
#[derive(Debug)]
pub struct PublishFailure {
    /// The primary publication error message.
    pub primary_error: String,
    /// Per-entry outcomes observed before the failure.
    pub outcomes: Vec<CachePublishOutcome>,
    /// Temp-file removal failures (empty when cleanup was complete).
    pub cleanup_issues: Vec<String>,
    /// Durability (fsync) failures.
    pub durability_issues: Vec<String>,
    /// Digests of objects staged but not committed (orphans for GC).
    pub unpublished_objects: Vec<String>,
}

impl std::fmt::Display for PublishFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.primary_error)
    }
}

/// RAII guard for an owned temp file: the file is removed on Drop unless
/// explicitly disarmed (e.g. after a successful rename that transfers
/// ownership). `remove()` is the explicit error-reporting path: ENOENT is
/// treated as "already completed" (a concurrent sweeper or a previous attempt
/// removed it), NOT an error.
pub(crate) struct OwnedTemp {
    path: PathBuf,
    armed: bool,
}

impl OwnedTemp {
    /// Adopt an already-created exclusive file at `path` (e.g. the commit
    /// lock). The file is removed on drop unless disarmed.
    pub(crate) fn adopt(path: PathBuf) -> Self {
        OwnedTemp { path, armed: true }
    }

    /// Create a new exclusive temp file in `dir` with a unique name derived
    /// from `name` (callers pass hex digests / `gen-<N>` / `CURRENT`, which
    /// are filesystem-safe).
    pub(crate) fn create_exclusive_in(dir: &Path, name: &str) -> Result<Self, String> {
        let path = dir.join(format!(
            "{name}{TMP_MARKER}{}-{}",
            std::process::id(),
            TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .map_err(|e| format!("failed to create temp {}: {e}", path.display()))?;
        Ok(OwnedTemp { path, armed: true })
    }

    /// Write `bytes` and fsync the temp file.
    pub(crate) fn write_all_and_sync(&mut self, bytes: &[u8]) -> Result<(), String> {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .open(&self.path)
            .map_err(|e| format!("failed to open temp {}: {e}", self.path.display()))?;
        f.write_all(bytes)
            .map_err(|e| format!("failed to write temp: {e}"))?;
        f.sync_all()
            .map_err(|e| format!("failed to sync temp: {e}"))
    }

    /// The temp file path.
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    /// Disarm the guard (ownership transferred elsewhere).
    pub(crate) fn disarm(&mut self) {
        self.armed = false;
    }

    /// Explicit removal; ENOENT → Ok (already completed). Returns the io
    /// error on genuine failure so callers can surface cleanup issues.
    pub(crate) fn remove(mut self) -> io::Result<()> {
        self.armed = false;
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }
}

impl Drop for OwnedTemp {
    fn drop(&mut self) {
        if self.armed {
            let _ = std::fs::remove_file(&self.path);
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

/// Directory fsync for cache operations. The supplied path is the DIRECTORY
/// that actually changed, opened and fsynced directly — not its parent.
/// Returns the io result so genuine failures (EIO, permission, ENOSPC)
/// propagate.
#[cfg(unix)]
fn sync_cache_dir(dir: &Path) -> io::Result<()> {
    let d = std::fs::File::open(dir)?;
    d.sync_all()
}

#[cfg(not(unix))]
fn sync_cache_dir(_dir: &Path) -> io::Result<()> {
    Ok(())
}

/// Current epoch seconds.
fn unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Read the `CURRENT` generation sequence number. Missing/corrupt → None
/// (treated as an empty cache).
fn read_current(path: &Path) -> Option<u64> {
    let bytes = std::fs::read(path).ok()?;
    let text = std::str::from_utf8(&bytes).ok()?.trim();
    text.parse::<u64>().ok()
}

/// A valid cache KEY: non-empty, bounded length, no path separators or NUL.
/// Keys are stored only as manifest map keys (never as filenames), so they
/// must be path-safe but are not required to be hex.
fn valid_cache_key(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 256
        && !s.contains('/')
        && !s.contains('\\')
        && !s.contains('\0')
        && s != "."
        && s != ".."
}

/// A valid object DIGEST: exactly 64 lowercase hex chars. Digests are used as
/// object filenames, so this also prevents path traversal.
fn valid_digest(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Generation manifest file name for a sequence number.
fn gen_file_name(seq: u64) -> String {
    format!("gen-{seq}.json")
}

/// Parse a generation sequence number from a `gen-<N>.json` file name.
fn parse_generation_file(name: &str) -> Option<u64> {
    let rest = name.strip_prefix("gen-")?.strip_suffix(".json")?;
    rest.parse::<u64>().ok()
}

/// Whether a negative entry has expired relative to `now`.
fn negative_expired(committed_at: u64, now: u64) -> bool {
    now.saturating_sub(committed_at) >= NEGATIVE_TTL_SECS
}

/// Whether a file's mtime is older than `grace` relative to `now` (epoch
/// seconds).
fn file_older_than(path: &Path, now: u64, grace: Duration) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    let Ok(mtime) = meta.modified() else {
        return false;
    };
    let Ok(mtime_secs) = mtime.duration_since(SystemTime::UNIX_EPOCH) else {
        return false;
    };
    now.saturating_sub(mtime_secs.as_secs()) >= grace.as_secs()
}

/// Whether the commit lock is old enough to belong to a crashed committer.
fn lock_is_stale(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    let Ok(mtime) = meta.modified() else {
        return false;
    };
    let Ok(mtime_secs) = mtime.duration_since(SystemTime::UNIX_EPOCH) else {
        return false;
    };
    unix_secs().saturating_sub(mtime_secs.as_secs()) >= LOCK_STALE_GRACE.as_secs()
}

/// Compute the integrity SHA-256 over the canonical serialization of every
/// manifest field EXCEPT `integrity`. `BTreeMap` serializes keys in sorted
/// order, so the digest is deterministic.
fn compute_integrity(m: &GenerationManifest) -> String {
    let payload = serde_json::json!({
        "schema_version": m.schema_version,
        "generation": m.generation,
        "base_generation": m.base_generation,
        "created_at": m.created_at,
        "positives": m.positives,
        "negatives": m.negatives,
    });
    sha256_hex(payload.to_string().as_bytes())
}

/// Validate a manifest: schema version, generation match, integrity, and that
/// every key/digest is a well-formed cache key (path-traversal safe).
fn validate_manifest(bytes: &[u8], expected_seq: u64) -> Result<GenerationManifest, String> {
    let m: GenerationManifest =
        serde_json::from_slice(bytes).map_err(|e| format!("manifest parse error: {e}"))?;
    if m.schema_version != SCHEMA_VERSION {
        return Err(format!("unsupported schema version {}", m.schema_version));
    }
    if m.generation != expected_seq {
        return Err(format!(
            "manifest generation {} != expected {}",
            m.generation, expected_seq
        ));
    }
    let expected = compute_integrity(&m);
    if m.integrity != expected {
        return Err("manifest integrity mismatch".into());
    }
    for key in m.positives.keys().chain(m.negatives.keys()) {
        if !valid_cache_key(key) {
            return Err(format!("manifest contains invalid key: {key:?}"));
        }
    }
    for digest in m
        .positives
        .values()
        .map(|e| e.digest.as_str())
        .chain(m.negatives.values().map(|e| e.digest.as_str()))
    {
        if !valid_digest(digest) {
            return Err(format!("manifest contains invalid digest: {digest:?}"));
        }
    }
    Ok(m)
}

/// Evict the least-recently-used committed mapping (smallest recency, with a
/// deterministic lexicographic tie-break via `BTreeMap` iteration order).
fn evict_lru_mapping(m: &mut GenerationManifest) {
    let mut oldest: Option<(u64, bool, String)> = None; // (recency, is_negative, key)
    for (k, e) in &m.positives {
        let cand = (e.created_at, false, k.clone());
        if oldest.as_ref().map(|o| cand < *o).unwrap_or(true) {
            oldest = Some(cand);
        }
    }
    for (k, e) in &m.negatives {
        let cand = (e.committed_at, true, k.clone());
        if oldest.as_ref().is_none_or(|o| cand < *o) {
            oldest = Some(cand);
        }
    }
    if let Some((_, is_negative, key)) = oldest {
        if is_negative {
            m.negatives.remove(&key);
        } else {
            m.positives.remove(&key);
        }
    }
}

/// Remove negative mappings that have expired past the TTL. Returns true if
/// any were removed.
fn prune_expired_negatives(m: &mut GenerationManifest, now: u64) -> bool {
    let expired: Vec<String> = m
        .negatives
        .iter()
        .filter(|(_, e)| negative_expired(e.committed_at, now))
        .map(|(k, _)| k.clone())
        .collect();
    let changed = !expired.is_empty();
    for k in expired {
        m.negatives.remove(&k);
    }
    changed
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
            key(("repo2", "wt", "sha", "d", 3, 1, "0.1.0", "grep", "{}", "cfg"))
        );
        assert_ne!(
            k0,
            key(("repo", "wt2", "sha", "d", 3, 1, "0.1.0", "grep", "{}", "cfg"))
        );
        assert_ne!(
            k0,
            key(("repo", "wt", "sha2", "d", 3, 1, "0.1.0", "grep", "{}", "cfg"))
        );
        assert_ne!(
            k0,
            key(("repo", "wt", "sha", "d2", 3, 1, "0.1.0", "grep", "{}", "cfg"))
        );
        assert_ne!(
            k0,
            key(("repo", "wt", "sha", "d", 4, 1, "0.1.0", "grep", "{}", "cfg"))
        );
        assert_ne!(
            k0,
            key(("repo", "wt", "sha", "d", 3, 2, "0.1.0", "grep", "{}", "cfg"))
        );
        assert_ne!(
            k0,
            key(("repo", "wt", "sha", "d", 3, 1, "0.1.1", "grep", "{}", "cfg"))
        );
        assert_ne!(
            k0,
            key(("repo", "wt", "sha", "d", 3, 1, "0.1.0", "search", "{}", "cfg"))
        );
        assert_ne!(
            k0,
            key((
                "repo",
                "wt",
                "sha",
                "d",
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
            key(("repo", "wt", "sha", "d", 3, 1, "0.1.0", "grep", "{}", "cfg2"))
        );
    }

    #[test]
    fn key_is_domain_anchored() {
        let k = query_cache_key("r", "w", "s", "d", 1, 1, "v", "read", "{}", "c");
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

        let nested = json!({"outer": {"y": 1, "x": 2}, "n": 0});
        assert_eq!(canonical_json(&nested), r#"{"n":0,"outer":{"x":2,"y":1}}"#);
    }

    /// A deterministic 64-hex cache key for tests.
    fn key(n: u8) -> String {
        format!("{:064x}", n)
    }

    #[test]
    fn cache_put_get_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = QueryCache::new(tmp.path());
        assert_eq!(cache.get(&key(1)), None);
        cache.put(&key(1), br#"{"v":"value-one"}"#);
        assert_eq!(
            cache.get(&key(1)).as_deref(),
            Some(br#"{"v":"value-one"}"#.as_slice())
        );
        // v2 stores content-addressed objects + a generation manifest, not a
        // per-key file.
        assert!(cache
            .objects_dir()
            .join(sha256_hex(br#"{"v":"value-one"}"#))
            .exists());
        assert!(cache.current_path().exists());
        assert_eq!(cache.debug_entry_count(), (1, 0));
    }

    #[test]
    fn cache_get_miss_after_clear() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = QueryCache::new(tmp.path());
        cache.put(&key(1), br#"{"v":1}"#);
        cache.put_negative(&key(2), br#"{"n":1}"#);
        cache.clear().unwrap();
        assert_eq!(cache.get(&key(1)), None);
        assert_eq!(cache.get_negative(&key(2)), None);
        assert!(!cache.root_dir().exists());
    }

    #[test]
    fn lru_evicts_oldest_beyond_item_bound() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = QueryCache {
            state_dir: tmp.path().to_path_buf(),
            max_items: 3,
            max_bytes: usize::MAX,
        };
        cache.put(&key(1), b"1");
        cache.put(&key(2), b"2");
        cache.put(&key(3), b"3");
        // Reading does NOT touch recency in v2 (recency = commit order), so a
        // later commit evicts the least-recently-committed mapping.
        assert_eq!(cache.get(&key(1)).as_deref(), Some(b"1".as_slice()));
        cache.put(&key(4), b"4");
        // Bound is 3: the oldest committed mapping (key(1)) is evicted.
        assert_eq!(cache.get(&key(1)), None);
        assert_eq!(cache.get(&key(2)).as_deref(), Some(b"2".as_slice()));
        assert_eq!(cache.get(&key(3)).as_deref(), Some(b"3".as_slice()));
        assert_eq!(cache.get(&key(4)).as_deref(), Some(b"4".as_slice()));
        assert_eq!(cache.debug_entry_count().0, 3);
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
        cache.put(&key(1), big);
        assert_eq!(cache.get(&key(1)).as_deref(), Some(big));
        cache.put(&key(2), other); // 39 bytes total → evict one
        let big_present = cache.get(&key(1)).is_some();
        let other_present = cache.get(&key(2)).is_some();
        // Only one of them can fit; the other was evicted.
        assert!(big_present ^ other_present);
    }

    #[test]
    fn negative_entries_roundtrip_within_ttl() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = QueryCache::new(tmp.path());
        assert_eq!(cache.get_negative(&key(1)), None);
        cache.put_negative(&key(1), br#"{"empty":true}"#);
        assert_eq!(
            cache.get_negative(&key(1)).as_deref(),
            Some(br#"{"empty":true}"#.as_slice())
        );
        assert_eq!(cache.debug_entry_count(), (0, 1));
    }

    #[test]
    fn negative_entries_expire_after_ttl() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = QueryCache::new(tmp.path());
        cache.put_negative(&key(1), b"none-found");
        // Backdate the committed_at in the manifest beyond the TTL.
        let seq = read_current(&cache.current_path()).unwrap();
        let path = cache.generations_dir().join(gen_file_name(seq));
        let mut m: GenerationManifest =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let e = m.negatives.get_mut(&key(1)).unwrap();
        e.committed_at = unix_secs().saturating_sub(NEGATIVE_TTL_SECS + 5);
        m.integrity = String::new();
        m.integrity = compute_integrity(&m);
        std::fs::write(&path, serde_json::to_vec(&m).unwrap()).unwrap();
        assert_eq!(
            cache.get_negative(&key(1)),
            None,
            "expired negative entry is a miss"
        );
    }

    #[test]
    fn negative_entries_honor_lru_bounds() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = QueryCache {
            state_dir: tmp.path().to_path_buf(),
            max_items: 2,
            max_bytes: usize::MAX,
        };
        cache.put_negative(&key(1), b"1");
        cache.put_negative(&key(2), b"2");
        // Backdate key(2)'s committed_at so it is unambiguously the oldest.
        let seq = read_current(&cache.current_path()).unwrap();
        let path = cache.generations_dir().join(gen_file_name(seq));
        let mut m: GenerationManifest =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let e = m.negatives.get_mut(&key(2)).unwrap();
        e.committed_at = unix_secs().saturating_sub(60);
        m.integrity = String::new();
        m.integrity = compute_integrity(&m);
        std::fs::write(&path, serde_json::to_vec(&m).unwrap()).unwrap();
        cache.put_negative(&key(3), b"3");
        // Bound is 2: oldest negative entry (key(2)) is evicted.
        assert_eq!(cache.get_negative(&key(2)), None);
        assert_eq!(
            cache.get_negative(&key(3)).as_deref(),
            Some(b"3".as_slice())
        );
    }

    #[test]
    fn clear_drops_negative_entries_too() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = QueryCache::new(tmp.path());
        cache.put(&key(1), br#"{"p":1}"#);
        cache.put_negative(&key(2), br#"{"n":1}"#);
        cache.clear().unwrap();
        assert_eq!(cache.get(&key(1)), None);
        assert_eq!(cache.get_negative(&key(2)), None);
        assert!(!cache.root_dir().exists());
    }

    #[test]
    fn atomic_write_roundtrips_without_temp_leak() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = QueryCache::new(tmp.path());
        cache.put(&key(1), br#"{"v":1}"#);
        assert_eq!(
            cache.get(&key(1)).as_deref(),
            Some(br#"{"v":1}"#.as_slice())
        );
        // Overwrite: the new value replaces the old atomically.
        cache.put(&key(1), br#"{"v":2}"#);
        assert_eq!(
            cache.get(&key(1)).as_deref(),
            Some(br#"{"v":2}"#.as_slice())
        );
        // No temp files may remain after any write (success or failure path).
        let leftover = std::fs::read_dir(cache.tmp_dir())
            .map(|rd| rd.flatten().count())
            .unwrap_or(0);
        assert_eq!(leftover, 0, "writes must clean up their temp files");
    }

    #[test]
    fn corrupt_objects_are_quarantined_and_never_served() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = QueryCache::new(tmp.path());
        cache.put(&key(1), br#"{"v":1}"#);
        let digest = sha256_hex(br#"{"v":1}"#);

        // Corrupt the object on disk (simulates torn write / disk corruption).
        std::fs::write(cache.objects_dir().join(&digest), b"{\"v\": 1, BROKEN").unwrap();
        assert_eq!(
            cache.get(&key(1)),
            None,
            "corrupt object must be a miss, never served"
        );
        // Quarantined for diagnostics: moved out of the object store.
        assert!(!cache.objects_dir().join(&digest).exists());
        assert!(cache.quarantine_dir().join(&digest).exists());
    }

    #[test]
    fn object_without_current_is_a_miss() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = QueryCache::new(tmp.path());
        cache.put(&key(1), br#"{"v":1}"#);
        // Remove CURRENT: the object exists but is unreachable → miss.
        std::fs::remove_file(cache.current_path()).unwrap();
        assert_eq!(cache.get(&key(1)), None);
    }

    #[test]
    fn corrupt_current_fails_closed_to_prior_generation() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = QueryCache::new(tmp.path());
        cache.put(&key(1), br#"{"v":1}"#);
        cache.put(&key(2), br#"{"v":2}"#);
        // Corrupt the newest manifest (gen-2) → reader fails closed to gen-1.
        let seq = read_current(&cache.current_path()).unwrap();
        assert_eq!(seq, 2);
        let path = cache.generations_dir().join(gen_file_name(seq));
        std::fs::write(&path, b"not a manifest").unwrap();
        // key(2) (only in gen-2) is a miss; key(1) (in gen-1) still served.
        assert_eq!(cache.get(&key(2)), None);
        assert_eq!(
            cache.get(&key(1)).as_deref(),
            Some(br#"{"v":1}"#.as_slice())
        );
    }

    #[test]
    fn corrupt_manifest_is_quarantined() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = QueryCache::new(tmp.path());
        cache.put(&key(1), br#"{"v":1}"#);
        let seq = read_current(&cache.current_path()).unwrap();
        let path = cache.generations_dir().join(gen_file_name(seq));
        std::fs::write(&path, b"garbage").unwrap();
        assert_eq!(cache.get(&key(1)), None);
        assert!(cache.quarantine_dir().join(gen_file_name(seq)).exists());
    }

    #[test]
    fn legacy_v1_dirs_are_never_served() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = QueryCache::new(tmp.path());
        // Simulate a leftover v1 entry.
        std::fs::create_dir_all(cache.query_dir()).unwrap();
        std::fs::write(cache.query_dir().join(key(1)), br#"{"v":1}"#).unwrap();
        // v2 never reads the legacy dir.
        assert_eq!(cache.get(&key(1)), None);
        // clear() removes it.
        cache.clear().unwrap();
        assert!(!cache.query_dir().exists());
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
                    let k = format!("{:064x}", (t * 100 + i) % 7);
                    let value = format!(r#"{{"writer":{t},"i":{i}}}"#);
                    cache.put(&k, value.as_bytes());
                    if let Some(bytes) = cache.get(&k) {
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

    #[test]
    fn concurrent_identical_winners_are_reused() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = QueryCache::new(tmp.path());
        let cache = std::sync::Arc::new(cache);
        let value = br#"{"v":"identical"}"#;
        let mut handles = Vec::new();
        for _ in 0..8usize {
            let cache = cache.clone();
            handles.push(std::thread::spawn(move || {
                let mut tx = cache.begin();
                tx.stage_write(&key(9), false, value).unwrap();
                let outcomes = tx.publish().unwrap();
                // Every writer either created or reused the identical mapping.
                for o in outcomes {
                    assert!(matches!(
                        o,
                        CachePublishOutcome::Created | CachePublishOutcome::ReusedExisting
                    ));
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(cache.get(&key(9)).as_deref(), Some(value.as_slice()));
        assert_eq!(cache.debug_entry_count().0, 1);
    }

    #[test]
    fn partial_publish_is_atomic_with_two_cacheable_ops() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = QueryCache::new(tmp.path());
        // Stage two entries, then publish: both become visible atomically.
        let mut tx = cache.begin();
        tx.stage_write(&key(1), false, br#"{"a":1}"#).unwrap();
        tx.stage_write(&key(2), true, br#"{"b":2}"#).unwrap();
        let outcomes = tx.publish().unwrap();
        assert_eq!(outcomes.len(), 2);
        assert_eq!(
            cache.get(&key(1)).as_deref(),
            Some(br#"{"a":1}"#.as_slice())
        );
        assert_eq!(
            cache.get_negative(&key(2)).as_deref(),
            Some(br#"{"b":2}"#.as_slice())
        );
        assert_eq!(cache.debug_entry_count(), (1, 1));
    }

    #[test]
    fn abort_leaves_nothing_reader_visible() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = QueryCache::new(tmp.path());
        let mut tx = cache.begin();
        tx.stage_write(&key(1), false, br#"{"a":1}"#).unwrap();
        tx.abort();
        assert_eq!(cache.get(&key(1)), None);
        assert_eq!(cache.debug_entry_count(), (0, 0));
    }

    #[test]
    fn invalid_keys_are_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = QueryCache::new(tmp.path());
        // Path traversal / non-hex keys must never be staged or served.
        assert!(cache.begin().stage_write("../evil", false, b"x").is_err());
        assert_eq!(cache.get("../evil"), None);
        assert_eq!(cache.get("short"), None);
    }

    #[test]
    fn gc_reclaims_unreferenced_objects_after_grace() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = QueryCache::new(tmp.path());
        cache.put(&key(1), br#"{"v":1}"#);
        let digest = sha256_hex(br#"{"v":1}"#);
        // Orphan object (never referenced by any manifest).
        let orphan = sha256_hex(b"orphan");
        std::fs::write(cache.objects_dir().join(&orphan), b"orphan").unwrap();
        // Backdate the orphan so it is past the grace period.
        let path = cache.objects_dir().join(&orphan);
        let backdated = SystemTime::now() - Duration::from_secs(ORPHAN_GRACE.as_secs() + 10);
        std::fs::File::options()
            .write(true)
            .open(&path)
            .and_then(|f| f.set_modified(backdated))
            .unwrap();
        cache.enforce_lru();
        assert!(!cache.objects_dir().join(&orphan).exists());
        // The referenced object survives.
        assert!(cache.objects_dir().join(&digest).exists());
    }

    #[test]
    fn gc_sweeps_abandoned_temp_files_after_grace() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = QueryCache::new(tmp.path());
        cache.put(&key(1), br#"{"v":1}"#);
        // A leftover temp from a "crashed" writer, backdated beyond the grace
        // period: GC must sweep it.
        let stale_tmp = cache.tmp_dir().join(format!("dead{TMP_MARKER}999-0"));
        std::fs::write(&stale_tmp, b"partial").unwrap();
        let backdated = SystemTime::now() - Duration::from_secs(2 * 60);
        std::fs::File::options()
            .write(true)
            .open(&stale_tmp)
            .and_then(|f| f.set_modified(backdated))
            .expect("backdate temp mtime");
        // A fresh temp (a live concurrent writer) is NOT swept.
        let fresh_tmp = cache.tmp_dir().join(format!("k{TMP_MARKER}999-1"));
        std::fs::write(&fresh_tmp, b"in-flight").unwrap();
        cache.enforce_lru();
        assert!(!stale_tmp.exists(), "abandoned temp files are swept");
        assert!(fresh_tmp.exists(), "live temp files are left alone");
    }
}
