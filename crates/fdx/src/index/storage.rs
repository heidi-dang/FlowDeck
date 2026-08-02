//! Crash-safe generation-based storage for the FDX index.
//!
//! Write lifecycle (Task 3 §6, hardened for Task 3D):
//!
//! 1. acquire a repository/worktree-scoped cross-process writer lock
//!    (`index.lock`, OS file lock released automatically on process death);
//! 2. build a new generation in a sibling temporary directory;
//! 3. write every component + the manifest;
//! 4. validate the manifest and component checksums;
//! 5. fsync the generation directory;
//! 6. atomically publish the new generation (rename tmp → final, never over
//!    an existing valid final on Windows);
//! 7. update the CURRENT pointer last, with bounded retry so a temporarily
//!    held file handle cannot leave the pointer missing;
//! 8. retain the previous valid generation until activation succeeds;
//! 9. clean stale temporary generations and abandoned pointer files.
//!
//! Load lifecycle (Task 3D §4/§5 — strict, fail-closed, self-recovering):
//!
//! 1. read CURRENT (missing or malformed is handled, never fatal);
//! 2. validate the referenced generation: manifest → schema compatibility →
//!    identity verification → required component presence → checksum
//!    validation → strict deserialization → semantic validation → counts;
//! 3. quarantine any generation that fails validation (retaining diagnostic
//!    evidence, never retried);
//! 4. scan remaining generations newest to oldest;
//! 5. select the newest fully valid generation;
//! 6. atomically repair CURRENT to point at it;
//! 7. return the recovered snapshot; rebuild only when nothing valid remains.
//!
//! Malformed components are NEVER converted into empty/default collections:
//! a generation that fails any validation step is rejected wholesale.
//!
//! Windows-safe publication (§6): CURRENT replacement uses a temp pointer +
//! atomic rename with bounded retry (file handles can temporarily prevent
//! replacement); a reader observes either the previous valid generation or
//! the new complete generation — never a missing, partial, or corrupt
//! pointer state.
//!
//! Cross-process coordination (§3): every writer (CLI vs CLI, CLI vs daemon,
//! daemon vs daemon, rebuild vs refresh, invalidate vs refresh) serializes on
//! the worktree-scoped OS file lock. Readers never take the lock: they read
//! CURRENT + a fully-published generation, both of which are atomic.
//!
//! Legacy identity migration (§9): state directories created by older 64-bit
//! identity segments are detected, ownership is verified against the stored
//! canonical roots, and the state is adopted (migrated) or preserved as
//! quarantine evidence. Identity verification at load is the hard guarantee
//! that a manifest from another repository can never be loaded.

use crate::index::builder::CLASS_TEST;
use crate::index::identity::normalize_root_for_compare;
use crate::index::manifest::{
    ComponentCounts, ContentCacheEntry, DependencyEdge, FdxIndexManifest, FileMeta,
    GitStateSnapshot, IndexIdentity, SymbolMeta, TestMappingRow, IDENTITY_SEGMENT_LEN,
    INDEX_SCHEMA_VERSION, MIN_READABLE_SCHEMA_VERSION,
};
use crate::index::paths::{
    current_pointer, ensure_state_root, ensure_state_version, generation_dir, quarantine_dir,
    worktree_dir,
};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};

/// Lock file name stored in the worktree state directory.
pub const LOCK_FILE: &str = "index.lock";

/// Maximum time to block waiting for the cross-process lock.
pub const LOCK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// How many previous valid generations to retain after a successful publish.
pub const RETAIN_GENERATIONS: usize = 1;

/// One named component file inside a generation directory.
pub const COMPONENT_FILES: [&str; 6] = [
    "files.json",
    "symbols.json",
    "dependencies.json",
    "test-mapping.json",
    "git-state.json",
    "content-cache.json",
];

/// The manifest file name inside a generation directory.
pub const MANIFEST_FILE: &str = "manifest.json";

/// Environment variable enabling deterministic fault-injection barriers in
/// the publication path (test-only; unset in production). When set to a
/// directory, `publish` signals each phase and blocks until the test writes
/// `<dir>/go-<phase>` (or 30s elapses). This gives real process-level crash
/// tests explicit synchronization points instead of timing races.
pub const BARRIER_ENV: &str = "FDX_TEST_BARRIER";

/// Block at a named publication phase when the barrier environment variable
/// is set. No-op in production.
fn barrier(phase: &str) {
    let Ok(dir) = std::env::var(BARRIER_ENV) else {
        return;
    };
    let dir = PathBuf::from(dir);
    let _ = std::fs::create_dir_all(&dir);
    let reached = dir.join(format!("phase-{phase}"));
    let _ = std::fs::write(&reached, "reached");
    let go = dir.join(format!("go-{phase}"));
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    while !go.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let _ = std::fs::remove_file(&reached);
}

/// Result of loading a persisted generation.
#[derive(Debug)]
pub enum LoadOutcome {
    /// A valid generation was loaded and activated.
    Loaded(FdxIndexManifest),
    /// No persisted generation exists yet.
    Empty,
    /// A persisted generation exists but is corrupt; it was quarantined.
    /// `last_valid` is the most recent *valid* manifest found before the
    /// corrupt one (if any).
    Corrupt {
        quarantined: Vec<PathBuf>,
        last_valid: Option<FdxIndexManifest>,
    },
    /// The newest generation has a newer schema than this binary supports;
    /// it is left in place (evidence for the newer binary), and no valid
    /// older generation exists.
    FutureSchema {
        generation: u64,
        schema_version: u32,
    },
    /// Recovery failed: a valid generation was found (or none), but the
    /// post-scan repair could not be completed — repairing the CURRENT
    /// pointer or clearing a stale one failed. `last_valid` is the newest
    /// valid manifest found (if any); the error is surfaced instead of
    /// pretending the load fully recovered.
    RecoveryFailed {
        error: String,
        last_valid: Option<FdxIndexManifest>,
    },
    /// The cross-process writer lock could not be acquired (another writer is
    /// mid-publication or the state dir is unavailable). No mutation or
    /// recovery was attempted — the caller decides how to proceed.
    LockBusy(String),
}

/// Cross-process writer lock for one worktree state directory.
///
/// Backed by an OS file lock (flock on Unix, LockFileEx on Windows via `fs2`)
/// on `<worktree>/index.lock`:
/// - visible across processes (CLI vs CLI, CLI vs daemon, daemon vs daemon);
/// - scoped to the worktree identity (no global lock across repositories);
/// - bounded acquisition ([`LOCK_TIMEOUT`]);
/// - the OS releases the lock on process death, so a stale lock can never
///   block and a live owner's lock is never deleted;
/// - owner evidence (PID) is recorded for diagnostics.
#[derive(Debug)]
pub struct WriterLock {
    file: Option<std::fs::File>,
    path: PathBuf,
}

impl WriterLock {
    /// Acquire the exclusive writer lock for `worktree`, blocking up to
    /// [`LOCK_TIMEOUT`]. Returns `WouldBlock` when the lock stays held.
    pub fn acquire(worktree: &Path) -> std::io::Result<WriterLock> {
        let path = worktree.join(LOCK_FILE);
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)?;
        let owner = format!("pid={}\n", std::process::id());
        let contended = fs2::lock_contended_error();
        let deadline = std::time::Instant::now() + LOCK_TIMEOUT;
        loop {
            use fs2::FileExt;
            match file.try_lock_exclusive() {
                Ok(()) => {
                    // Owner evidence (best effort; the OS holds the real
                    // lock, so a leftover file can never block anyone).
                    let _ = std::fs::write(&path, &owner);
                    return Ok(WriterLock {
                        file: Some(file),
                        path,
                    });
                }
                Err(e) if is_contended(&e, &contended) => {
                    if std::time::Instant::now() >= deadline {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::WouldBlock,
                            format!(
                                "timed out waiting for index writer lock at {} (currently held by {})",
                                path.display(),
                                read_owner(&path).unwrap_or_else(|| "unknown owner".to_string())
                            ),
                        ));
                    }
                    std::thread::sleep(std::time::Duration::from_millis(15));
                }
                Err(e) => return Err(e),
            }
        }
    }

    /// Try to acquire without blocking (tests/diagnostics).
    #[allow(dead_code)]
    pub fn try_acquire(worktree: &Path) -> std::io::Result<WriterLock> {
        let path = worktree.join(LOCK_FILE);
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)?;
        use fs2::FileExt;
        match file.try_lock_exclusive() {
            Ok(()) => {
                let _ = std::fs::write(&path, format!("pid={}\n", std::process::id()));
                Ok(WriterLock {
                    file: Some(file),
                    path,
                })
            }
            Err(e) => Err(e),
        }
    }

    /// The lock file path (observability/tests).
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Whether an fs2 lock error means "held by someone else" (contended).
fn is_contended(e: &std::io::Error, contended: &std::io::Error) -> bool {
    match (e.raw_os_error(), contended.raw_os_error()) {
        (Some(a), Some(b)) => a == b,
        _ => e.kind() == std::io::ErrorKind::WouldBlock,
    }
}

impl Drop for WriterLock {
    fn drop(&mut self) {
        if let Some(f) = &self.file {
            let _ = fs2::FileExt::unlock(f);
        }
        // The lock file remains on disk: it is advisory and re-acquired on
        // demand. No stale-lock cleanup is required because the OS releases
        // the underlying lock when the owning process exits.
    }
}

/// Read the recorded owner evidence from a lock file (best effort).
fn read_owner(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

/// Monotonic per-process counter for unique temp names.
fn tmp_counter() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

/// Exclusive OS lock on `<tmp>/OWNER.lock` held for the duration of a
/// temp-build.
///
/// Cleanup skips temp build dirs whose OWNER.lock is live-held, so a racing
/// writer can never delete a live build; on process death the OS releases
/// the lock and the dir becomes collectable. `release()` (or Drop) drops the
/// handle first and then removes the marker file, so the renamed final
/// generation never contains OWNER.lock and Windows can remove the file.
struct TmpOwnerLock {
    path: PathBuf,
    file: Option<std::fs::File>,
}

impl TmpOwnerLock {
    fn acquire(tmp: &Path) -> std::io::Result<TmpOwnerLock> {
        use fs2::FileExt;
        let path = tmp.join("OWNER.lock");
        let f = std::fs::File::create(&path)?;
        f.try_lock_exclusive().map_err(|e| {
            std::io::Error::new(
                e.kind(),
                format!("cannot claim temp build dir {}: {e}", tmp.display()),
            )
        })?;
        Ok(TmpOwnerLock {
            path,
            file: Some(f),
        })
    }

    /// Release the lock and drop the marker file.
    fn release(&mut self) {
        self.file.take();
        let _ = std::fs::remove_file(&self.path);
    }
}

impl Drop for TmpOwnerLock {
    fn drop(&mut self) {
        self.release();
    }
}

/// The storage layer: knows how to persist and load index generations.
pub struct GenerationStore {
    /// Resolved state root (contains `fdx-index/...`). Retained for
    /// observability/debugging.
    #[allow(dead_code)]
    state_root: PathBuf,
    /// Worktree directory holding all generations for this identity.
    worktree: PathBuf,
    /// Expected identity, verified against every manifest on load so a
    /// generation from another repository (or a wrong directory selection)
    /// can never be loaded.
    repository_id: String,
    worktree_id: String,
    repository_root_hash: String,
    /// Canonical roots (path-based ownership checks for legacy migration).
    repository_root: String,
    worktree_root: String,
}

impl GenerationStore {
    /// Create a store for the given identity, ensuring the state tree exists
    /// and migrating legacy (64-bit identity) state where ownership matches.
    pub fn open(state_root: &Path, identity: &IndexIdentity) -> std::io::Result<Self> {
        let root = ensure_state_root(state_root)?;
        ensure_state_version(&root)?;
        let wt = worktree_dir(&root, &identity.repository_id, &identity.worktree_id);
        let store = Self {
            state_root: root.clone(),
            worktree: wt,
            repository_id: identity.repository_id.clone(),
            worktree_id: identity.worktree_id.clone(),
            repository_root_hash: identity.repository_root_hash.clone(),
            repository_root: identity.repository_root.clone(),
            worktree_root: identity.worktree_root.clone(),
        };
        // Legacy 64-bit identity migration (best effort, never mixes state).
        let _ = store.migrate_legacy_identity(&root);
        Ok(store)
    }

    /// Directory for a specific generation.
    pub fn generation_path(&self, generation: u64) -> PathBuf {
        generation_dir(&self.worktree, generation)
    }

    /// The worktree state dir (for tests/observability).
    pub fn worktree_path(&self) -> &Path {
        &self.worktree
    }

    /// Acquire the cross-process writer lock for this worktree.
    pub fn writer_lock(&self) -> std::io::Result<WriterLock> {
        WriterLock::acquire(&self.worktree)
    }

    /// Read the CURRENT pointer, distinguishing:
    /// - `Ok(Some(n))` — a valid pointer;
    /// - `Ok(None)` — no pointer file yet;
    /// - `Err` — the pointer exists but is malformed (recovery path).
    pub fn current_generation(&self) -> std::io::Result<Option<u64>> {
        let ptr = current_pointer(&self.worktree);
        match std::fs::read_to_string(&ptr) {
            Ok(s) => match s.trim().parse::<u64>() {
                Ok(n) => Ok(Some(n)),
                Err(_) => Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("CURRENT pointer is malformed at {}", ptr.display()),
                )),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// List persisted generations (from directory names), sorted ascending.
    pub fn persisted_generations(&self) -> Vec<u64> {
        let mut gens = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&self.worktree) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if let Some(num) = name.strip_prefix("gen-") {
                    if let Ok(n) = num.parse::<u64>() {
                        gens.push(n);
                    }
                }
            }
        }
        gens.sort_unstable();
        gens
    }

    /// Whether any persisted generation exists (used to skip migration when
    /// current-identity state is already present).
    fn has_generations(&self) -> bool {
        !self.persisted_generations().is_empty() || self.worktree.join("CURRENT").exists()
    }

    /// Remove every persisted generation and the CURRENT pointer (used by
    /// `index.invalidate` so a later refresh starts from a clean slate).
    ///
    /// The caller must hold the writer lock (see `IndexService::invalidate`),
    /// which provides the lock ordering: lock first, then delete. Deletions
    /// run in descending generation order (newest first) and every failure
    /// is propagated — a partial clear never reports success.
    pub fn clear_persisted(&self) -> std::io::Result<()> {
        let mut gens = self.persisted_generations();
        gens.sort_unstable();
        gens.reverse();
        for gen in gens {
            // remove_dir_all on a missing path is a no-op, so generations
            // already quarantined by a prior load do not fail here.
            std::fs::remove_dir_all(self.generation_path(gen))?;
        }
        let ptr = current_pointer(&self.worktree);
        remove_file_if_present(&ptr)?;
        let tmp_ptr = ptr.with_extension("tmp");
        remove_file_if_present(&tmp_ptr)?;
        Ok(())
    }

    /// Remove stale `.tmp` generation dirs and abandoned pointer files.
    ///
    /// Writer-locked: cleanup must never run while another writer is in its
    /// publication critical section (its `CURRENT.tmp`/rename would be
    /// removed) or while a live writer's temp build is in progress (its
    /// `OWNER.lock` is live-held and skipped). Called on refresh, including
    /// the no-change path, so interrupted writes never accumulate.
    pub fn cleanup_stale_tmp(&self) {
        // Best-effort: a busy lock only defers cleanup to the next pass.
        let _lock = match WriterLock::acquire(&self.worktree) {
            Ok(l) => l,
            Err(_) => return,
        };
        self.cleanup_stale_tmp_locked();
    }

    /// Cleanup while already holding the writer lock (called from publish's
    /// critical section, which serializes all writers).
    fn cleanup_stale_tmp_locked(&self) {
        if let Ok(entries) = std::fs::read_dir(&self.worktree) {
            for entry in entries.flatten() {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().into_owned();
                if !name.contains(".tmp") {
                    continue;
                }
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    // Candidate stale build dir. A live writer's temp build
                    // dir holds an exclusive OS lock on OWNER.lock for the
                    // whole build; if we can take the lock, the owner is
                    // gone (crashed) and the dir is collectable.
                    let owner_lock = path.join("OWNER.lock");
                    let live = match std::fs::OpenOptions::new().read(true).open(&owner_lock) {
                        Ok(f) => {
                            use fs2::FileExt;
                            // Any failure to acquire is treated as "live" —
                            // leaking a stale dir beats deleting a live one.
                            f.try_lock_exclusive().is_err()
                        }
                        Err(_) => false, // no OWNER.lock → legacy tmp dir → stale
                    };
                    if live {
                        continue;
                    }
                    let _ = std::fs::remove_dir_all(&path);
                } else {
                    // Abandoned pointer temp (`CURRENT.tmp`,
                    // `CURRENT.tmp-<pid>-<n>`) or stray file. Under the
                    // writer lock no live writer is mid-`set_current`, so
                    // these are always stale.
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
        let _ = std::fs::remove_file(current_pointer(&self.worktree).with_extension("tmp"));
    }

    /// Load and validate the current generation (or the newest valid one).
    ///
    /// Strict, fail-closed, and self-recovering:
    /// 1. acquire the cross-process writer lock — recovery mutates shared
    ///    state (quarantine renames, CURRENT repair) and must serialize with
    ///    concurrent writers, or two processes could repair/publish the same
    ///    pointer concurrently;
    /// 2. read CURRENT (missing or malformed is handled);
    /// 3. validate the referenced generation through the full chain
    ///    (manifest → schema → identity → presence → checksums → strict
    ///    deserialization → semantic validation → counts);
    /// 4. quarantine invalid generations (evidence retained, never retried);
    /// 5. scan remaining generations newest to oldest;
    /// 6. select the newest fully valid generation;
    /// 7. atomically repair CURRENT to point at it.
    pub fn load(&self) -> LoadOutcome {
        // Recovery mutates shared state, so it must serialize with other
        // writers (publish's critical section). A busy lock means the state
        // is being actively rewritten: report it instead of mutating.
        let _lock = match WriterLock::acquire(&self.worktree) {
            Ok(l) => l,
            Err(e) => return LoadOutcome::LockBusy(e.to_string()),
        };
        let pointer = match self.current_generation() {
            Ok(Some(n)) => Some(n),
            Ok(None) => None,
            Err(_) => {
                // Malformed CURRENT: quarantine the evidence and scan.
                let ptr = current_pointer(&self.worktree);
                let dst = ptr.with_extension("corrupt");
                let _ = std::fs::rename(&ptr, &dst);
                None
            }
        };

        let mut gens = self.persisted_generations();
        gens.reverse();
        let mut last_valid: Option<FdxIndexManifest> = None;
        let mut quarantined = Vec::new();
        let mut future: Option<(u64, u32)> = None;

        for gen in gens {
            let path = self.generation_path(gen);
            match read_valid_manifest(&path, gen, self) {
                Ok(manifest) => {
                    last_valid = Some(manifest);
                    break;
                }
                Err(e) => {
                    let msg = e.to_string();
                    if msg.contains("unsupported schema") {
                        // Leave future-schema generations in place (the newer
                        // binary that wrote them must be able to read them).
                        let sv = schema_from_err(&msg).unwrap_or(u32::MAX);
                        if future.is_none() {
                            future = Some((gen, sv));
                        }
                        continue;
                    }
                    let reason = msg;
                    let dst = self.quarantine(&path, gen, &reason);
                    quarantined.push(dst);
                }
            }
        }

        match last_valid {
            Some(manifest) => {
                // Repair CURRENT: it must point at the newest valid
                // generation (handles malformed/missing/stale pointers and
                // interrupted publication where a newer valid generation
                // exists but CURRENT was never updated).
                let need_repair = match pointer {
                    Some(p) => p != manifest.generation,
                    None => true,
                };
                if need_repair {
                    if let Err(e) = self.set_current(manifest.generation) {
                        return LoadOutcome::RecoveryFailed {
                            error: format!(
                                "failed to repair CURRENT pointer to generation {}: {e}",
                                manifest.generation
                            ),
                            last_valid: Some(manifest),
                        };
                    }
                }
                LoadOutcome::Loaded(manifest)
            }
            None => {
                // Nothing valid remains. If CURRENT pointed at a generation
                // that was quarantined or is missing, clear the pointer so a
                // later publish can republish gen 1 (a stale pointer would
                // otherwise look like a generation conflict).
                if let Some(_p) = pointer {
                    if let Err(e) = clear_pointer(self) {
                        return LoadOutcome::RecoveryFailed {
                            error: format!("failed to clear stale CURRENT pointer: {e}"),
                            last_valid: None,
                        };
                    }
                }
                if let Some((g, sv)) = future {
                    LoadOutcome::FutureSchema {
                        generation: g,
                        schema_version: sv,
                    }
                } else if quarantined.is_empty() {
                    LoadOutcome::Empty
                } else {
                    LoadOutcome::Corrupt {
                        quarantined,
                        last_valid: None,
                    }
                }
            }
        }
    }

    /// Atomically publish a new generation.
    ///
    /// `build` writes the generation into a UNIQUE per-process temporary
    /// sibling directory (so two racing processes can build the same
    /// generation number without clobbering each other) and returns the
    /// manifest. This function then:
    /// 1. claims the tmp dir with an OWNER.lock held for the whole build
    ///    (cleanup never deletes a live-owned build dir);
    /// 2. validates the manifest's schema and identity;
    /// 3. verifies every listed component checksum + required presence;
    /// 4. fsyncs the tmp dir;
    /// 5. acquires the cross-process writer lock and releases the owner lock;
    /// 6. detects a generation conflict (another writer already published
    ///    this or a newer generation — reject, never clobber);
    /// 7. publishes the final dir (reusing a validated existing final on
    ///    Windows instead of renaming over it);
    /// 8. atomically updates CURRENT with a unique temp pointer + bounded
    ///    retry;
    /// 9. retains the previous valid generation and cleans stale tmp dirs.
    ///
    /// The lock is held only for the critical publication section (conflict
    /// check → rename → CURRENT), never for the build, so a long build does
    /// not block other writers for longer than necessary.
    pub fn publish<F>(
        &self,
        generation: u64,
        identity: &IndexIdentity,
        _fdx_version: &str,
        _now_iso: &str,
        build: F,
    ) -> std::io::Result<FdxIndexManifest>
    where
        F: FnOnce(&Path) -> std::io::Result<FdxIndexManifest>,
    {
        // Build into a unique tmp dir (no lock required — builders of the
        // same generation never touch each other's tmp dirs). A same-named
        // leftover from a crashed predecessor (pid reuse) is safely reused:
        // we take over its (dead) OWNER.lock and overwrite its contents.
        let tmp = self.unique_tmp_dir(generation);
        std::fs::create_dir_all(&tmp)?;
        let mut owner = TmpOwnerLock::acquire(&tmp)?;
        barrier("build");

        // 1. Build components in the tmp dir.
        let manifest = build(&tmp)?;

        // 2. Validate schema + identity before anything is persisted.
        if manifest.schema_version > INDEX_SCHEMA_VERSION {
            owner.release();
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "index schema {} is newer than supported {}",
                    manifest.schema_version, INDEX_SCHEMA_VERSION
                ),
            ));
        }
        if let Err(e) = verify_manifest_identity(identity, &manifest) {
            owner.release();
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(e);
        }

        // 3. Write the manifest file last (the commit point of the
        //    generation), then verify all component checksums + presence +
        //    strict semantics.
        barrier("manifest");
        {
            let bytes = serde_json::to_vec_pretty(&manifest).map_err(std::io::Error::other)?;
            let mut f = std::fs::File::create(tmp.join(MANIFEST_FILE))?;
            f.write_all(&bytes)?;
            f.sync_all()?;
        }
        verify_checksums(&tmp, &manifest)?;
        validate_components(&tmp, &manifest)?;

        // 4. fsync the tmp dir contents.
        sync_dir(&tmp)?;

        // 5. Critical publication section — serialize with all other
        //    writers (CLI vs CLI, CLI vs daemon, daemon vs daemon).
        let _lock = WriterLock::acquire(&self.worktree)?;
        // We now hold the writer lock: no other process's cleanup can run,
        // so the build-ownership lock is redundant — release it so the
        // renamed final generation never carries OWNER.lock inside.
        owner.release();

        // Generation conflict detection under the lock: a concurrent writer
        // may have already published this or a newer generation.
        match self.current_generation() {
            Ok(Some(current)) if current >= generation => {
                let _ = std::fs::remove_dir_all(&tmp);
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    format!("generation conflict: {generation} already superseded by {current}"),
                ));
            }
            Ok(_) => {}
            Err(_) => {
                // Malformed pointer: load() recovers it; we can proceed.
            }
        }

        // 6. Publish the final dir. Never rename over an existing directory
        //    on Windows: if a final for this generation already exists, it is
        //    either a validated complete generation (reuse) or a corrupt one
        //    (replace after removal).
        let final_dir = generation_dir(&self.worktree, generation);
        if !final_dir.exists() {
            std::fs::rename(&tmp, &final_dir)?;
        } else if read_valid_manifest(&final_dir, generation, self).is_ok() {
            // A previous interrupted attempt reached the rename; the
            // generation is complete. Drop the tmp and reuse.
            let _ = std::fs::remove_dir_all(&tmp);
        } else {
            // Corrupt leftover final: remove and rename.
            let _ = std::fs::remove_dir_all(&final_dir);
            std::fs::rename(&tmp, &final_dir)?;
        }
        sync_dir(&self.worktree)?;

        // 7. Atomically update CURRENT (unique temp pointer; bounded retry
        //    for Windows file handles that temporarily prevent replacement).
        barrier("publish");
        self.set_current(generation)?;
        barrier("current");

        // 8. Retain previous valid generation, clean stale tmp dirs.
        self.retain_previous(&final_dir, generation);

        Ok(manifest)
    }

    /// A unique per-process temporary generation directory name, so racing
    /// writers building the same generation never clobber each other.
    fn unique_tmp_dir(&self, generation: u64) -> PathBuf {
        self.worktree.join(format!(
            "gen-{generation}.tmp-{}-{}",
            std::process::id(),
            tmp_counter()
        ))
    }

    /// A unique per-process temp sibling of `path` (used for the CURRENT
    /// pointer), so racing writers never share a temp path.
    fn unique_tmp_sibling(&self, path: &Path) -> PathBuf {
        path.with_extension(format!("tmp-{}-{}", std::process::id(), tmp_counter()))
    }

    /// Atomically set the CURRENT pointer with bounded retry. Uses a unique
    /// temp pointer + platform-native atomic replacement ([`winfs::atomic_replace`])
    /// so a reader always sees either the previous valid pointer or the new
    /// one — never a missing/partial pointer — and two racing writers never
    /// share a temp path. The replacement never deletes CURRENT first and
    /// preserves the previous pointer on failure.
    fn set_current(&self, generation: u64) -> std::io::Result<()> {
        let ptr = current_pointer(&self.worktree);
        let tmp_ptr = self.unique_tmp_sibling(&ptr);
        {
            let mut f = std::fs::File::create(&tmp_ptr)?;
            f.write_all(generation.to_string().as_bytes())?;
            f.sync_all()?;
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            match crate::index::winfs::atomic_replace(&tmp_ptr, &ptr) {
                Ok(()) => {
                    let _ = std::fs::remove_file(&tmp_ptr);
                    return sync_dir(&self.worktree);
                }
                Err(e) => {
                    // On Windows a reader may briefly hold the CURRENT file
                    // open (sharing violation). Retry until the deadline.
                    if std::time::Instant::now() < deadline {
                        std::thread::sleep(std::time::Duration::from_millis(10));
                        continue;
                    }
                    let _ = std::fs::remove_file(&tmp_ptr);
                    return Err(e);
                }
            }
        }
    }

    /// Remove stale `.tmp` generations and keep at most `RETAIN_GENERATIONS`
    /// old generations (besides the just-published one).
    fn retain_previous(&self, published: &Path, generation: u64) {
        let _ = published;
        // Clean stale tmp dirs + abandoned pointer files. The caller
        // (publish) holds the writer lock for the whole critical section,
        // so the lock-free variant is used here.
        self.cleanup_stale_tmp_locked();
        // Keep newest RETAIN_GENERATIONS + the current one.
        let mut gens = self.persisted_generations();
        gens.retain(|g| *g != generation);
        gens.sort_unstable();
        gens.reverse();
        for old in gens.iter().skip(RETAIN_GENERATIONS) {
            let _ = std::fs::remove_dir_all(self.generation_path(*old));
        }
    }

    /// Move a corrupt generation into quarantine, retaining evidence.
    fn quarantine(&self, path: &Path, generation: u64, reason: &str) -> PathBuf {
        let qroot = quarantine_dir(&self.worktree);
        let _ = std::fs::create_dir_all(&qroot);
        let dst = qroot.join(format!("gen-{generation}-{}", sanitize(reason)));
        if std::fs::rename(path, &dst).is_err() {
            // Fallback: copy evidence marker alongside the original.
            let _ = std::fs::write(path.with_extension("corrupt"), format!("reason={reason}\n"));
            return path.to_path_buf();
        }
        // Write a diagnostic marker in quarantine.
        let _ = std::fs::write(
            dst.join("QUARANTINE.txt"),
            format!("reason={reason}\ngeneration={generation}\n"),
        );
        dst
    }

    /// Detect and migrate legacy (64-bit identity) state directories that
    /// belong to this repository/worktree.
    ///
    /// The legacy directory names ARE the old 16-hex hashes of the canonical
    /// roots, so ownership is verified by recomputing the legacy names for
    /// this repository + worktree (plus a manifest self-consistency check).
    /// On a match the legacy worktree directory is moved under the current
    /// identity path and its generation manifests are rewritten to the
    /// current identity (schema 2 + full-strength segments), preserving the
    /// index. Any failure leaves the legacy directory in place as quarantine
    /// evidence and falls back to a fresh build — state from different
    /// repositories is never mixed (post-migration loads are protected by
    /// full-strength identity verification).
    fn migrate_legacy_identity(&self, root: &Path) -> std::io::Result<()> {
        // Only migrate when no current-identity state exists yet.
        if self.has_generations() {
            return Ok(());
        }
        // Recompute the legacy (64-bit, 16-hex) dir names for THIS repo and
        // worktree using the exact old hashing algorithm.
        let repo_norm = normalize_root_for_compare(&self.repository_root);
        let wt_norm = normalize_root_for_compare(&self.worktree_root);
        let legacy_repo = crate::index::identity::legacy_segment(&["repo", &repo_norm]);
        let legacy_wt = crate::index::identity::legacy_segment(&["worktree", &wt_norm]);
        let legacy_wt_dir = root.join(&legacy_repo).join(&legacy_wt);
        if !legacy_wt_dir.is_dir() {
            return Ok(());
        }

        // Self-consistency: the legacy manifests must agree they live in this
        // (legacy) repository + worktree. A 64-bit collision would be caught
        // here because the manifest carries the same legacy ids.
        let mut manifests_ok = false;
        for gen in read_generation_numbers(&legacy_wt_dir) {
            let m_path = legacy_wt_dir.join(format!("gen-{gen}")).join(MANIFEST_FILE);
            if let Ok(text) = std::fs::read_to_string(&m_path) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                    if v["repository_id"].as_str() == Some(&legacy_repo)
                        && v["worktree_id"].as_str() == Some(&legacy_wt)
                    {
                        manifests_ok = true;
                        break;
                    }
                }
            }
        }
        if !manifests_ok {
            // No ownership evidence: preserve as-is (never adopt blindly).
            return Ok(());
        }

        // Adopt: move the legacy dir under the current identity path.
        if self.worktree.exists() {
            return Ok(()); // a concurrent process created it
        }
        if let Some(parent) = self.worktree.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if std::fs::rename(&legacy_wt_dir, &self.worktree).is_err() {
            // Cross-device or locked: copy, then remove best-effort.
            if let Err(e) = copy_dir_all(&legacy_wt_dir, &self.worktree) {
                let _ = std::fs::remove_dir_all(&self.worktree);
                let _ = std::fs::create_dir_all(quarantine_dir(&self.worktree));
                let _ = std::fs::write(
                    quarantine_dir(&self.worktree).join("legacy-migrate-copy-failed"),
                    format!("copy failed: {e}\n"),
                );
                return Err(e);
            }
            let _ = std::fs::remove_dir_all(&legacy_wt_dir);
        }

        // Rewrite each generation's manifest to the current identity and
        // validate. Any failure → quarantine evidence and rebuild.
        let mut ok = true;
        for gen in self.persisted_generations() {
            let dir = self.generation_path(gen);
            let manifest_path = dir.join(MANIFEST_FILE);
            let text = match std::fs::read_to_string(&manifest_path) {
                Ok(t) => t,
                Err(_) => {
                    ok = false;
                    break;
                }
            };
            let mut m: FdxIndexManifest = match serde_json::from_str(&text) {
                Ok(m) => m,
                Err(_) => {
                    ok = false;
                    break;
                }
            };
            m.repository_id = self.repository_id.clone();
            m.worktree_id = self.worktree_id.clone();
            m.repository_root_hash = self.repository_root_hash.clone();
            m.repository_root = self.repository_root.clone();
            m.worktree_root = self.worktree_root.clone();
            m.schema_version = INDEX_SCHEMA_VERSION;
            // The legacy manifest's dirty fingerprint predates the 64-hex
            // format contract; recompute it for the current worktree so the
            // migrated (schema v2) generation satisfies strict validation.
            m.dirty_fingerprint =
                crate::index::identity::dirty_fingerprint(Path::new(&self.worktree_root));
            m.component_counts = match compute_component_counts(&dir) {
                Ok(c) => c,
                Err(_) => {
                    ok = false;
                    break;
                }
            };
            // The git-state component embeds the worktree identity; rewrite
            // it to the current identity and refresh its checksum so the
            // migrated generation stays consistent.
            match rewrite_git_state_identity(&dir, &mut m, &self.worktree_id, gen) {
                Ok(()) => {}
                Err(_) => {
                    ok = false;
                    break;
                }
            }
            let bytes = match serde_json::to_vec_pretty(&m) {
                Ok(b) => b,
                Err(_) => {
                    ok = false;
                    break;
                }
            };
            if std::fs::write(&manifest_path, bytes).is_err() || verify_checksums(&dir, &m).is_err()
            {
                ok = false;
                break;
            }
        }

        if !ok {
            // Migration could not be completed safely: preserve evidence.
            let evidence = quarantine_dir(&self.worktree).join("legacy-migrate-incomplete");
            let _ = std::fs::create_dir_all(&evidence);
            let _ = std::fs::remove_dir_all(&self.worktree);
            let _ = std::fs::rename(&legacy_wt_dir, &evidence);
            return Ok(());
        }

        // Finish the pointer: prefer the newest valid generation.
        let mut gens = self.persisted_generations();
        gens.reverse();
        for gen in gens {
            if read_valid_manifest(&self.generation_path(gen), gen, self).is_ok() {
                let _ = self.set_current(gen);
                break;
            }
        }
        Ok(())
    }
}

/// List generation numbers in a directory (for the legacy migration scan).
fn read_generation_numbers(dir: &Path) -> Vec<u64> {
    let mut gens = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(num) = name.strip_prefix("gen-") {
                if let Ok(n) = num.parse::<u64>() {
                    gens.push(n);
                }
            }
        }
    }
    gens.sort_unstable();
    gens
}

/// Verify a manifest's identity matches the expected identity. Path-based
/// ownership (canonical roots) plus full-strength hash segments: a manifest
/// from another repository can never pass.
fn verify_manifest_identity(
    expected: &IndexIdentity,
    manifest: &FdxIndexManifest,
) -> std::io::Result<()> {
    if manifest.repository_id != expected.repository_id {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "repository identity mismatch: manifest {} != expected {}",
                manifest.repository_id, expected.repository_id
            ),
        ));
    }
    if manifest.worktree_id != expected.worktree_id {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "worktree identity mismatch",
        ));
    }
    if manifest.repository_root_hash != expected.repository_root_hash {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "repository root hash mismatch",
        ));
    }
    if !normalize_root_for_compare(&manifest.repository_root)
        .eq(&normalize_root_for_compare(&expected.repository_root))
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "repository root path mismatch",
        ));
    }
    if !normalize_root_for_compare(&manifest.worktree_root)
        .eq(&normalize_root_for_compare(&expected.worktree_root))
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "worktree root path mismatch",
        ));
    }
    Ok(())
}

/// Read and validate a generation's manifest through the full validation
/// chain: parse → generation match → schema compatibility → identity →
/// presence → checksums → strict deserialization → semantics → counts.
fn read_valid_manifest(
    path: &Path,
    generation: u64,
    store: &GenerationStore,
) -> std::io::Result<FdxIndexManifest> {
    let manifest_path = path.join(MANIFEST_FILE);
    let text = std::fs::read_to_string(&manifest_path).map_err(|e| {
        std::io::Error::new(
            e.kind(),
            format!("generation {generation}: missing/unreadable manifest: {e}"),
        )
    })?;
    let manifest: FdxIndexManifest = serde_json::from_str(&text).map_err(|e| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("generation {generation}: manifest parse error: {e}"),
        )
    })?;
    if manifest.generation != generation {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "generation {generation}: manifest claims generation {}",
                manifest.generation
            ),
        ));
    }
    if manifest.schema_version > INDEX_SCHEMA_VERSION {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "generation {generation}: unsupported schema {}",
                manifest.schema_version
            ),
        ));
    }
    if manifest.schema_version < MIN_READABLE_SCHEMA_VERSION {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "generation {generation}: unsupported old schema {}",
                manifest.schema_version
            ),
        ));
    }
    // Identity verification: never load another repository's state.
    let expected = IndexIdentity {
        repository_id: store.repository_id.clone(),
        worktree_id: store.worktree_id.clone(),
        repository_root_hash: store.repository_root_hash.clone(),
        repository_root: store.repository_root.clone(),
        worktree_root: store.worktree_root.clone(),
    };
    verify_manifest_identity(&expected, &manifest)?;
    // Required presence + checksums.
    verify_checksums(path, &manifest)?;
    // Schema v2 manifests must carry a well-formed dirty fingerprint (the
    // producer derives it from the worktree's git status via identity_hash).
    // Legacy v1 manifests are exempt: they were written before the format
    // contract existed.
    if manifest.schema_version >= 2 && !is_lower_hex(&manifest.dirty_fingerprint, 64) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "generation {generation}: invalid dirty fingerprint {:?}",
                manifest.dirty_fingerprint
            ),
        ));
    }
    // Strict deserialization + semantic validation + counts.
    validate_components(path, &manifest)?;
    Ok(manifest)
}

/// Extract the schema version from an "unsupported schema N" error message.
fn schema_from_err(msg: &str) -> Option<u32> {
    msg.rsplit(' ').next()?.trim().parse().ok()
}

/// Verify the manifest's checksum map is EXACTLY the required component set
/// and that every listed checksum matches the on-disk component bytes.
///
/// The set must be exact in both directions: a component whose checksum entry
/// was dropped from the manifest would otherwise bypass integrity verification
/// entirely, and an entry for an unknown component is not part of the
/// validated contract (tampered or corrupt manifest).
fn verify_checksums(dir: &Path, manifest: &FdxIndexManifest) -> std::io::Result<()> {
    let gen = manifest.generation;
    for name in COMPONENT_FILES {
        if !manifest.checksums.contains_key(name) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("generation {gen}: missing checksum for required component {name}"),
            ));
        }
    }
    for name in manifest.checksums.keys() {
        if !COMPONENT_FILES.contains(&name.as_str()) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("generation {gen}: checksum for unknown component {name}"),
            ));
        }
    }
    // Required presence + hash verification for every component.
    for name in COMPONENT_FILES {
        let file = dir.join(name);
        if !file.is_file() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("generation {gen}: missing required component {name}"),
            ));
        }
        let expected = &manifest.checksums[name];
        let text = std::fs::read(&file).map_err(|e| {
            std::io::Error::new(
                e.kind(),
                format!("checksum: component {name} unreadable: {e}"),
            )
        })?;
        let actual = sha256_hex(&text);
        if actual != *expected {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("checksum mismatch for {name}: expected {expected}, got {actual}"),
            ));
        }
    }
    Ok(())
}

/// Whether `s` is exactly `len` lowercase hex characters.
fn is_lower_hex(s: &str, len: usize) -> bool {
    s.len() == len
        && s.chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

/// Remove a file, treating a missing path as success but propagating any
/// other error (a failed removal must never be reported as success).
fn remove_file_if_present(path: &std::path::Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Clear the CURRENT pointer (and any abandoned temp pointer). Both
/// removals must succeed for the load to report a clean recovery.
fn clear_pointer(store: &GenerationStore) -> std::io::Result<()> {
    let ptr = current_pointer(&store.worktree);
    remove_file_if_present(&ptr)?;
    remove_file_if_present(&ptr.with_extension("tmp"))?;
    Ok(())
}

/// Strictly deserialize every component and validate semantics. Any failure
/// rejects the ENTIRE generation — malformed components are never converted
/// into empty/default collections.
fn validate_components(dir: &Path, manifest: &FdxIndexManifest) -> std::io::Result<()> {
    let gen = manifest.generation;
    let files: Vec<FileMeta> = load_typed(dir, "files.json", gen)?;
    let symbols: Vec<SymbolMeta> = load_typed(dir, "symbols.json", gen)?;
    let deps: Vec<DependencyEdge> = load_typed(dir, "dependencies.json", gen)?;
    let tests: Vec<TestMappingRow> = load_typed(dir, "test-mapping.json", gen)?;
    let git: GitStateSnapshot = load_typed(dir, "git-state.json", gen)?;
    let cache: Vec<ContentCacheEntry> = load_typed(dir, "content-cache.json", gen)?;

    // Indexed file set for reference validation.
    let mut known: HashSet<&str> = HashSet::new();
    let mut seen_paths: HashSet<&str> = HashSet::new();
    // path -> classification, used to verify test mappings reference real
    // test files.
    let mut class_of: HashMap<&str, &str> = HashMap::new();
    for f in &files {
        if f.path.is_empty()
            || f.path.starts_with('/')
            || f.path.starts_with("..")
            || f.path.contains('\\')
            || f.path.contains("//")
        {
            return Err(invalid(gen, format!("invalid file path {:?}", f.path)));
        }
        if !seen_paths.insert(f.path.as_str()) {
            return Err(invalid(gen, format!("duplicate file path {:?}", f.path)));
        }
        // Strict generation consistency: every persisted row must carry the
        // manifest's generation. A zero or stale stamp means the generation
        // was written by a mismatched/incomplete publisher.
        if f.generation != gen {
            return Err(invalid(
                gen,
                format!(
                    "file {:?} has generation {}, expected {gen}",
                    f.path, f.generation
                ),
            ));
        }
        known.insert(f.path.as_str());
        class_of.insert(f.path.as_str(), f.classification.as_str());
    }

    // Symbols: ids unique, names non-empty, files known, line range sane,
    // source hash well-formed, and parent pointers consistent (same file,
    // existing symbol, no self-parent, no cycles).
    let mut sym_ids: HashSet<&str> = HashSet::new();
    let mut sym_file: HashMap<&str, &str> = HashMap::new();
    for s in &symbols {
        if s.id.is_empty() || s.name.is_empty() || s.file.is_empty() {
            return Err(invalid(gen, format!("malformed symbol {:?}", s.id)));
        }
        if !sym_ids.insert(s.id.as_str()) {
            return Err(invalid(gen, format!("duplicate symbol id {:?}", s.id)));
        }
        sym_file.insert(s.id.as_str(), s.file.as_str());
        if !known.contains(s.file.as_str()) {
            return Err(invalid(
                gen,
                format!("symbol {:?} references unknown file {:?}", s.id, s.file),
            ));
        }
        if s.line_start < 1 {
            return Err(invalid(
                gen,
                format!("symbol {:?} has line_start {}", s.id, s.line_start),
            ));
        }
        if s.line_end < s.line_start {
            return Err(invalid(
                gen,
                format!("symbol {:?} has inverted line range", s.id),
            ));
        }
        if !is_lower_hex(&s.source_hash, 16) {
            return Err(invalid(
                gen,
                format!(
                    "symbol {:?} has malformed source_hash {:?}",
                    s.id, s.source_hash
                ),
            ));
        }
        if s.generation != gen {
            return Err(invalid(
                gen,
                format!(
                    "symbol {:?} has generation {}, expected {gen}",
                    s.id, s.generation
                ),
            ));
        }
        // Parent: empty (top-level) or an existing symbol in the SAME file.
        if !s.parent_id.is_empty() {
            if s.parent_id == s.id {
                return Err(invalid(gen, format!("symbol {:?} is its own parent", s.id)));
            }
            match sym_file.get(s.parent_id.as_str()) {
                None => {
                    return Err(invalid(
                        gen,
                        format!(
                            "symbol {:?} references unknown parent {:?}",
                            s.id, s.parent_id
                        ),
                    ));
                }
                Some(pf) if *pf != s.file => {
                    return Err(invalid(
                        gen,
                        format!(
                            "symbol {:?} parent {:?} is in another file",
                            s.id, s.parent_id
                        ),
                    ));
                }
                Some(_) => {}
            }
        }
    }
    // Parent chains must terminate: walk each chain and reject any cycle
    // (self-parents were already rejected above).
    let mut parent_of: HashMap<&str, &str> = HashMap::new();
    for s in &symbols {
        if !s.parent_id.is_empty() {
            parent_of.insert(s.id.as_str(), s.parent_id.as_str());
        }
    }
    let mut chain_ok: HashSet<&str> = HashSet::new();
    for s in &symbols {
        if s.parent_id.is_empty() {
            continue;
        }
        let mut cur = s.id.as_str();
        let mut seen: HashSet<&str> = HashSet::new();
        while let Some(&p) = parent_of.get(cur) {
            if !seen.insert(cur) {
                return Err(invalid(
                    gen,
                    format!("symbol parent cycle involving {:?}", s.id),
                ));
            }
            cur = p;
            if chain_ok.contains(cur) {
                break;
            }
        }
        chain_ok.insert(s.id.as_str());
    }

    // Dependencies: from_file known, to_file known unless unresolved, kinds
    // from the producer vocabulary, non-empty specifier, no duplicate edges.
    const DEP_KINDS: &[&str] = &["import", "require", "from", "use"];
    let mut seen_edges: HashSet<(&str, &str, &str, &str, bool)> = HashSet::new();
    for e in &deps {
        if e.from_file.is_empty() || !known.contains(e.from_file.as_str()) {
            return Err(invalid(
                gen,
                format!("dependency edge from unknown file {:?}", e.from_file),
            ));
        }
        if e.specifier.is_empty() {
            return Err(invalid(
                gen,
                format!("dependency edge from {:?} has empty specifier", e.from_file),
            ));
        }
        if !DEP_KINDS.contains(&e.kind.as_str()) {
            return Err(invalid(
                gen,
                format!(
                    "dependency edge from {:?} has unknown kind {:?}",
                    e.from_file, e.kind
                ),
            ));
        }
        if !e.unresolved && e.to_file.is_empty() {
            return Err(invalid(
                gen,
                format!("dependency edge from {:?} has empty target", e.from_file),
            ));
        }
        if e.unresolved && !e.to_file.is_empty() {
            return Err(invalid(
                gen,
                format!(
                    "unresolved dependency edge from {:?} carries a target",
                    e.from_file
                ),
            ));
        }
        if !e.unresolved && !known.contains(e.to_file.as_str()) {
            return Err(invalid(
                gen,
                format!(
                    "dependency edge from {:?} references unknown file {:?}",
                    e.from_file, e.to_file
                ),
            ));
        }
        if e.generation != gen {
            return Err(invalid(
                gen,
                format!(
                    "dependency edge from {:?} has generation {}, expected {gen}",
                    e.from_file, e.generation
                ),
            ));
        }
        if !seen_edges.insert((
            e.from_file.as_str(),
            e.to_file.as_str(),
            e.specifier.as_str(),
            e.kind.as_str(),
            e.unresolved,
        )) {
            return Err(invalid(
                gen,
                format!(
                    "duplicate dependency edge from {:?} -> {:?} ({:?}, {:?})",
                    e.from_file, e.to_file, e.specifier, e.kind
                ),
            ));
        }
    }

    // Test mapping: known source/test files, test file classified as a test,
    // basis from the producer vocabulary, unique per (source, test, basis).
    let mut seen_tests: HashSet<(&str, &str, &str)> = HashSet::new();
    for t in &tests {
        if t.source_file.is_empty() || t.test_file.is_empty() {
            return Err(invalid(
                gen,
                "test mapping with empty source/test path".to_string(),
            ));
        }
        if !known.contains(t.source_file.as_str()) {
            return Err(invalid(
                gen,
                format!(
                    "test mapping {:?} references unknown source {:?}",
                    t.test_file, t.source_file
                ),
            ));
        }
        if !known.contains(t.test_file.as_str()) {
            return Err(invalid(
                gen,
                format!(
                    "test mapping {:?} references unknown test file",
                    t.test_file
                ),
            ));
        }
        if class_of.get(t.test_file.as_str()) != Some(&CLASS_TEST) {
            return Err(invalid(
                gen,
                format!("test mapping {:?} references non-test file", t.test_file),
            ));
        }
        if t.basis != "direct_import" && t.basis != "naming" {
            return Err(invalid(
                gen,
                format!(
                    "test mapping {:?} has unknown basis {:?}",
                    t.test_file, t.basis
                ),
            ));
        }
        if !(0.0..=1.0).contains(&t.confidence) {
            return Err(invalid(
                gen,
                format!("test mapping confidence out of range: {}", t.confidence),
            ));
        }
        if !seen_tests.insert((
            t.source_file.as_str(),
            t.test_file.as_str(),
            t.basis.as_str(),
        )) {
            return Err(invalid(
                gen,
                format!(
                    "duplicate test mapping {:?} -> {:?} ({:?})",
                    t.test_file, t.source_file, t.basis
                ),
            ));
        }
    }

    // Git state: HEAD SHA format, worktree + generation consistency, and
    // canonical, disjoint, per-list-unique file sets.
    if !git.head_sha.is_empty() && !is_lower_hex(&git.head_sha, 40) {
        return Err(invalid(gen, format!("invalid HEAD SHA {:?}", git.head_sha)));
    }
    if git.worktree_id != manifest.worktree_id {
        return Err(invalid(gen, "git-state worktree id mismatch".to_string()));
    }
    // Strict: no zero bypass — the snapshot must carry the manifest
    // generation exactly.
    if git.generation != gen {
        return Err(invalid(
            gen,
            format!(
                "git-state generation mismatch: {}, expected {gen}",
                git.generation
            ),
        ));
    }
    // A file may appear in at most one of changed/deleted/untracked, and
    // every listed path must be canonical and repo-relative.
    let mut git_seen: HashSet<&str> = HashSet::new();
    let git_lists = [
        ("changed_files", &git.changed_files),
        ("deleted_files", &git.deleted_files),
        ("untracked_files", &git.untracked_files),
    ];
    for (list_name, list) in git_lists {
        for p in list {
            if p.is_empty()
                || p.starts_with('/')
                || p.starts_with("..")
                || p.contains('\\')
                || p.contains("//")
            {
                return Err(invalid(
                    gen,
                    format!("git-state {list_name} has invalid path {:?}", p),
                ));
            }
            if !git_seen.insert(p.as_str()) {
                return Err(invalid(
                    gen,
                    format!("git-state file {:?} listed more than once", p),
                ));
            }
        }
    }
    for (from, to) in &git.renamed_files {
        let bad = |p: &str| {
            p.is_empty()
                || p.starts_with('/')
                || p.starts_with("..")
                || p.contains('\\')
                || p.contains("//")
        };
        if bad(from) || bad(to) || from == to {
            return Err(invalid(
                gen,
                format!("git-state rename pair ({from:?}, {to:?}) is invalid"),
            ));
        }
    }

    // Content cache: keys/paths non-empty, canonical, unique, well-formed
    // keys, path present in the index, size consistent with content,
    // generation consistent with the manifest.
    let mut cache_keys: HashSet<&str> = HashSet::new();
    let mut cache_paths: HashSet<&str> = HashSet::new();
    for c in &cache {
        if c.key.is_empty() || c.path.is_empty() {
            return Err(invalid(
                gen,
                "content cache entry with empty key/path".to_string(),
            ));
        }
        if !known.contains(c.path.as_str()) {
            return Err(invalid(
                gen,
                format!("content cache entry {:?} is not in the index", c.path),
            ));
        }
        if !is_lower_hex(&c.key, 16) {
            return Err(invalid(
                gen,
                format!("content cache entry {:?} has malformed key", c.path),
            ));
        }
        if !cache_keys.insert(c.key.as_str()) {
            return Err(invalid(
                gen,
                format!("content cache duplicate key {:?}", c.key),
            ));
        }
        if !cache_paths.insert(c.path.as_str()) {
            return Err(invalid(
                gen,
                format!("content cache duplicate path {:?}", c.path),
            ));
        }
        if c.size != c.content.len() {
            return Err(invalid(
                gen,
                format!("content cache size mismatch for {:?}", c.path),
            ));
        }
        if c.generation != gen {
            return Err(invalid(
                gen,
                format!(
                    "content cache entry {:?} has generation {}, expected {gen}",
                    c.path, c.generation
                ),
            ));
        }
    }

    // Manifest component counts (schema v2+): reject silently-dropped rows.
    if manifest.schema_version >= 2 {
        let counts = compute_counts(manifest, &files, &symbols, &deps, &tests, &git, &cache);
        if counts != manifest.component_counts {
            return Err(invalid(
                gen,
                format!(
                    "component count mismatch: manifest {:?}, actual {:?}",
                    manifest.component_counts, counts
                ),
            ));
        }
    }

    Ok(())
}

/// Compute the expected component counts for a fully-parsed generation.
#[allow(clippy::too_many_arguments)]
fn compute_counts(
    manifest: &FdxIndexManifest,
    files: &[FileMeta],
    symbols: &[SymbolMeta],
    deps: &[DependencyEdge],
    tests: &[TestMappingRow],
    _git: &GitStateSnapshot,
    cache: &[ContentCacheEntry],
) -> ComponentCounts {
    let _ = manifest;
    ComponentCounts {
        files: files.len(),
        symbols: symbols.len(),
        dependencies: deps.len(),
        test_mapping: tests.len(),
        git_state: 1,
        content_cache: cache.len(),
    }
}

/// Parse a component file strictly into typed rows.
fn load_typed<T: serde::de::DeserializeOwned>(
    dir: &Path,
    name: &str,
    generation: u64,
) -> std::io::Result<T> {
    let text = std::fs::read_to_string(dir.join(name)).map_err(|e| {
        std::io::Error::new(
            e.kind(),
            format!("generation {generation}: component {name} unreadable: {e}"),
        )
    })?;
    serde_json::from_str(&text).map_err(|e| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("generation {generation}: component {name} parse error: {e}"),
        )
    })
}

fn invalid(generation: u64, msg: String) -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        format!("generation {generation}: {msg}"),
    )
}

/// Compute SHA-256 hex of bytes (used for component checksums).
pub fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(data);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Compute a checksum entry for a component file and register it in the
/// manifest. Returns the JSON-serialized value to store in the component
/// file, or an error.
pub fn write_component(
    dir: &Path,
    manifest: &mut FdxIndexManifest,
    name: &str,
    value: &serde_json::Value,
) -> std::io::Result<()> {
    let bytes = serde_json::to_vec_pretty(value).map_err(std::io::Error::other)?;
    let file = dir.join(name);
    {
        let mut f = std::fs::File::create(&file)?;
        f.write_all(&bytes)?;
        f.sync_all()?;
    }
    manifest
        .checksums
        .insert(name.to_string(), sha256_hex(&bytes));
    Ok(())
}

/// Serialize a component value and write it + register its checksum.
/// Generic convenience wrapper around [`write_component`].
pub fn write_component_serde<T: serde::Serialize>(
    dir: &Path,
    manifest: &mut FdxIndexManifest,
    name: &str,
    value: &T,
) -> std::io::Result<()> {
    let json = serde_json::to_value(value).map_err(std::io::Error::other)?;
    write_component(dir, manifest, name, &json)
}

/// Update the manifest's component counts from the in-memory components
/// (called by the index service after building a generation).
pub fn update_component_counts(
    manifest: &mut FdxIndexManifest,
    files: usize,
    symbols: usize,
    dependencies: usize,
    test_mapping: usize,
    content_cache: usize,
) {
    manifest.component_counts = ComponentCounts {
        files,
        symbols,
        dependencies,
        test_mapping,
        git_state: 1,
        content_cache,
    };
}

/// fsync a directory (best effort on platforms where it is unsupported).
pub fn sync_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        let f = std::fs::File::open(dir)?;
        f.sync_all()?;
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
    }
    Ok(())
}

/// Sanitize a reason string for use in a quarantine directory name.
fn sanitize(reason: &str) -> String {
    let mut out = String::new();
    for c in reason.chars().take(48) {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
            out.push(c);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        out.push_str("corrupt");
    }
    out
}

/// Build a manifest that is fully "Ready" (all components present).
/// Used by tests and by the index service when a complete build succeeds.
pub fn ready_components(manifest: &mut FdxIndexManifest, ready: &[&str]) {
    for name in ready {
        let status = match *name {
            "files" => &mut manifest.components.files,
            "symbols" => &mut manifest.components.symbols,
            "dependencies" => &mut manifest.components.dependencies,
            "test_mapping" => &mut manifest.components.test_mapping,
            "git_state" => &mut manifest.components.git_state,
            "content_cache" => &mut manifest.components.content_cache,
            _ => continue,
        };
        *status = crate::index::manifest::ComponentStatus::Ready;
    }
}

/// Whether a directory name looks like a legacy (64-bit, 16 hex chars)
/// identity segment.
#[allow(dead_code)]
fn is_legacy_segment(name: &str) -> bool {
    name.len() == 16
        && name.chars().all(|c| c.is_ascii_hexdigit())
        && name.len() != IDENTITY_SEGMENT_LEN
}

/// Compute component counts by re-parsing a generation directory (used by
/// the legacy migration to rewrite manifests).
fn compute_component_counts(dir: &Path) -> std::io::Result<ComponentCounts> {
    let files: Vec<FileMeta> = load_typed(dir, "files.json", 0)?;
    let symbols: Vec<SymbolMeta> = load_typed(dir, "symbols.json", 0)?;
    let deps: Vec<DependencyEdge> = load_typed(dir, "dependencies.json", 0)?;
    let tests: Vec<TestMappingRow> = load_typed(dir, "test-mapping.json", 0)?;
    let _git: GitStateSnapshot = load_typed(dir, "git-state.json", 0)?;
    let cache: Vec<ContentCacheEntry> = load_typed(dir, "content-cache.json", 0)?;
    Ok(ComponentCounts {
        files: files.len(),
        symbols: symbols.len(),
        dependencies: deps.len(),
        test_mapping: tests.len(),
        git_state: 1,
        content_cache: cache.len(),
    })
}

/// Rewrite the worktree identity inside a generation's `git-state.json`
/// component (legacy migration) and refresh its checksum in the manifest.
fn rewrite_git_state_identity(
    dir: &Path,
    manifest: &mut FdxIndexManifest,
    worktree_id: &str,
    generation: u64,
) -> std::io::Result<()> {
    let mut git: GitStateSnapshot = load_typed(dir, "git-state.json", generation)?;
    git.worktree_id = worktree_id.to_string();
    git.generation = generation;
    let bytes = serde_json::to_vec_pretty(&git).map_err(std::io::Error::other)?;
    {
        let mut f = std::fs::File::create(dir.join("git-state.json"))?;
        f.write_all(&bytes)?;
        f.sync_all()?;
    }
    manifest
        .checksums
        .insert("git-state.json".to_string(), sha256_hex(&bytes));
    Ok(())
}

/// Recursively copy a directory (fallback when rename fails, e.g. across
/// devices on the migration path).
fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let target = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else if ty.is_symlink() {
            let link = std::fs::read_link(entry.path())?;
            #[cfg(unix)]
            std::os::unix::fs::symlink(&link, &target)?;
            #[cfg(windows)]
            std::os::windows::fs::symlink_file(&link, &target)?;
            #[cfg(not(any(unix, windows)))]
            {
                let _ = &link;
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Unsupported,
                    "symlink copy unsupported",
                ));
            }
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::manifest::{new_manifest, IndexIdentity};

    fn identity(name: &str) -> IndexIdentity {
        let repo_root = format!("/tmp/repo-{name}");
        let wt_root = format!("/tmp/wt-{name}");
        IndexIdentity {
            repository_id: crate::index::manifest::identity_hash(&["repo", &repo_root]),
            worktree_id: crate::index::manifest::identity_hash(&["worktree", &wt_root]),
            repository_root_hash: crate::index::manifest::identity_hash(&["root", &repo_root]),
            repository_root: repo_root,
            worktree_root: wt_root,
        }
    }

    fn build_manifest(
        store: &GenerationStore,
        ident: &IndexIdentity,
        generation: u64,
        head: &str,
    ) -> FdxIndexManifest {
        store
            .publish(generation, ident, "0.1.0", "2026-01-01T00:00:00Z", |dir| {
                let mut m = new_manifest(
                    ident,
                    "0.1.0",
                    generation,
                    "2026-01-01T00:00:00Z",
                    head,
                    &"d".repeat(64),
                    "cfg",
                    "ign",
                );
                let _ = write_component_serde(
                    dir,
                    &mut m,
                    "files.json",
                    &serde_json::json!([{"path": "a.txt", "kind": "file", "size": 3, "modified": 0, "content_hash": "", "language": "", "executable": false, "classification": "source", "generation": generation}]),
                );
                let _ = write_component_serde(dir, &mut m, "symbols.json", &serde_json::json!([]));
                let _ = write_component_serde(
                    dir,
                    &mut m,
                    "dependencies.json",
                    &serde_json::json!([]),
                );
                let _ = write_component_serde(
                    dir,
                    &mut m,
                    "test-mapping.json",
                    &serde_json::json!([]),
                );
                let _ = write_component_serde(
                    dir,
                    &mut m,
                    "git-state.json",
                    &serde_json::json!({"head_sha": head, "branch": "", "detached": false, "changed_files": [], "renamed_files": [], "deleted_files": [], "untracked_files": [], "worktree_id": ident.worktree_id, "generation": generation}),
                );
                let _ = write_component_serde(
                    dir,
                    &mut m,
                    "content-cache.json",
                    &serde_json::json!([]),
                );
                update_component_counts(&mut m, 1, 0, 0, 0, 0);
                ready_components(
                    &mut m,
                    &[
                        "files",
                        "symbols",
                        "dependencies",
                        "test_mapping",
                        "git_state",
                        "content_cache",
                    ],
                );
                Ok(m)
            })
            .unwrap()
    }

    #[test]
    fn publish_and_reload_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let ident = identity("a");
        let store = GenerationStore::open(tmp.path(), &ident).unwrap();
        build_manifest(&store, &ident, 1, &"a".repeat(40));

        assert_eq!(store.current_generation().unwrap(), Some(1));

        // Reload: same store (same identity) should load gen 1.
        let store2 = GenerationStore::open(tmp.path(), &ident).unwrap();
        match store2.load() {
            LoadOutcome::Loaded(m) => {
                assert_eq!(m.generation, 1);
                assert_eq!(m.head_sha, "a".repeat(40));
            }
            other => panic!("expected Loaded, got {other:?}"),
        }
    }

    #[cfg(windows)]
    #[test]
    fn set_current_preserves_pointer_while_old_pointer_held_open() {
        use crate::index::winfs::open_pinned;
        let tmp = tempfile::tempdir().unwrap();
        let ident = identity("pinned");
        let store = GenerationStore::open(tmp.path(), &ident).unwrap();
        build_manifest(&store, &ident, 1, &"1".repeat(40));
        assert_eq!(store.current_generation().unwrap(), Some(1));

        // Pin CURRENT without FILE_SHARE_DELETE: an atomic pointer
        // replacement must fail with a sharing violation, retry to its
        // deadline, and leave the previous pointer (gen 1) fully intact.
        let ptr = current_pointer(store.worktree_path());
        let pinned = open_pinned(&ptr).unwrap();
        let err = store.set_current(2).unwrap_err();
        drop(pinned);

        assert_eq!(
            err.kind(),
            std::io::ErrorKind::PermissionDenied,
            "sharing violation must surface as PermissionDenied"
        );
        assert_eq!(
            store.current_generation().unwrap(),
            Some(1),
            "previous pointer preserved while old pointer held open"
        );

        // Once the pin is released the same publication succeeds.
        store.set_current(2).unwrap();
        assert_eq!(store.current_generation().unwrap(), Some(2));
    }

    #[test]
    fn different_worktrees_do_not_share_state() {
        let tmp = tempfile::tempdir().unwrap();
        let ident1 = identity("repo1");
        let store1 = GenerationStore::open(tmp.path(), &ident1).unwrap();
        build_manifest(&store1, &ident1, 1, &"a".repeat(40));
        let ident2 = IndexIdentity {
            worktree_id: crate::index::manifest::identity_hash(&["worktree", "/tmp/wt-other"]),
            worktree_root: "/tmp/wt-other".to_string(),
            ..ident1.clone()
        };
        let store2 = GenerationStore::open(tmp.path(), &ident2).unwrap();
        assert!(matches!(store2.load(), LoadOutcome::Empty));
    }

    #[test]
    fn corrupt_generation_is_quarantined_and_prior_retained() {
        let tmp = tempfile::tempdir().unwrap();
        let ident = identity("corrupt");
        let store = GenerationStore::open(tmp.path(), &ident).unwrap();
        // gen 1 valid
        build_manifest(&store, &ident, 1, &"1".repeat(40));
        // gen 2 corrupt: write a manifest with a wrong checksum
        let gen2 = store.generation_path(2);
        std::fs::create_dir_all(&gen2).unwrap();
        let mut m = new_manifest(
            &ident,
            "0.1.0",
            2,
            "t",
            &"2".repeat(40),
            &"d".repeat(64),
            "c",
            "i",
        );
        m.checksums
            .insert("files.json".to_string(), "deadbeef".to_string());
        std::fs::write(
            gen2.join(MANIFEST_FILE),
            serde_json::to_vec_pretty(&m).unwrap(),
        )
        .unwrap();
        std::fs::write(gen2.join("files.json"), b"[]").unwrap();
        store.set_current(2).unwrap();

        match store.load() {
            LoadOutcome::Loaded(m) => {
                assert_eq!(m.generation, 1, "should fall back to gen 1");
            }
            other => panic!("expected fallback load, got {other:?}"),
        }
        // CURRENT repointed to 1
        assert_eq!(store.current_generation().unwrap(), Some(1));
        // quarantine dir has evidence
        let q = quarantine_dir(store.worktree_path());
        assert!(q.exists());
    }

    #[test]
    fn stale_generation_row_rejects_each_component_type() {
        // Contract item 4: a persisted generation whose rows carry a
        // generation different from the manifest's must be rejected on
        // load — per component type. The manifest checksum is kept
        // consistent so the semantic (generation) validation is reached.
        let files_row = serde_json::json!([{"path": "a.txt", "kind": "file", "size": 3, "modified": 0, "content_hash": "", "language": "", "executable": false, "classification": "source", "generation": 99}]);
        let symbols_row = serde_json::json!([{"id": "sym1", "name": "x", "qualified_name": "", "kind": "function", "file": "a.txt", "line_start": 1, "line_end": 1, "exported": false, "parent_id": "", "source_hash": "aabbcc", "generation": 99}]);
        let deps_row = serde_json::json!([{"from_file": "a.txt", "to_file": "", "specifier": "lib", "kind": "import", "unresolved": true, "generation": 99}]);
        let git_row = serde_json::json!({"head_sha": "1111111111111111111111111111111111111111", "branch": "", "detached": false, "changed_files": [], "renamed_files": [], "deleted_files": [], "untracked_files": [], "worktree_id": "", "generation": 99});
        let cache_row = serde_json::json!([{"key": "k", "path": "a.txt", "size": 1, "access_order": 1, "content": "x", "generation": 99}]);
        // (component, corrupt rows, [files, symbols, deps, tests, cache] counts)
        let cases: &[(&str, serde_json::Value, [usize; 5])] = &[
            ("files.json", files_row, [1, 0, 0, 0, 0]),
            ("symbols.json", symbols_row, [1, 1, 0, 0, 0]),
            ("dependencies.json", deps_row, [1, 0, 1, 0, 0]),
            ("git-state.json", git_row, [1, 0, 0, 0, 0]),
            ("content-cache.json", cache_row, [1, 0, 0, 0, 1]),
        ];
        for (component, rows, counts) in cases {
            let tmp = tempfile::tempdir().unwrap();
            let ident = identity("genchk");
            let store = GenerationStore::open(tmp.path(), &ident).unwrap();
            build_manifest(&store, &ident, 1, &"1".repeat(40));

            let gen = store.generation_path(1);
            let mut m: FdxIndexManifest =
                serde_json::from_str(&std::fs::read_to_string(gen.join(MANIFEST_FILE)).unwrap())
                    .unwrap();
            let _ = write_component_serde(&gen, &mut m, component, rows);
            update_component_counts(
                &mut m, counts[0], counts[1], counts[2], counts[3], counts[4],
            );
            std::fs::write(
                gen.join(MANIFEST_FILE),
                serde_json::to_vec_pretty(&m).unwrap(),
            )
            .unwrap();

            let outcome = store.load();
            match outcome {
                LoadOutcome::Loaded(_) => panic!(
                    "component {component}: stale-generation rows must reject the generation"
                ),
                LoadOutcome::Corrupt { .. } | LoadOutcome::Empty => {}
                other => panic!("component {component}: unexpected outcome {other:?}"),
            }
        }
    }

    #[test]
    fn zero_generation_rows_are_rejected_no_bypass() {
        // Contract item 4: no zero bypass. Rows stamped 0 are as corrupt as
        // rows stamped with a stale generation — including git-state, which
        // previously skipped the check for generation 0.
        let tmp = tempfile::tempdir().unwrap();
        let ident = identity("zerogen");
        let store = GenerationStore::open(tmp.path(), &ident).unwrap();
        build_manifest(&store, &ident, 1, &"1".repeat(40));

        let gen = store.generation_path(1);
        let mut m: FdxIndexManifest =
            serde_json::from_str(&std::fs::read_to_string(gen.join(MANIFEST_FILE)).unwrap())
                .unwrap();
        let _ = write_component_serde(
            &gen,
            &mut m,
            "git-state.json",
            &serde_json::json!({"head_sha": "1111111111111111111111111111111111111111", "branch": "", "detached": false, "changed_files": [], "renamed_files": [], "deleted_files": [], "untracked_files": [], "worktree_id": "", "generation": 0}),
        );
        std::fs::write(
            gen.join(MANIFEST_FILE),
            serde_json::to_vec_pretty(&m).unwrap(),
        )
        .unwrap();

        match store.load() {
            LoadOutcome::Loaded(_) => panic!("zero-generation rows must be rejected"),
            LoadOutcome::Corrupt { .. } | LoadOutcome::Empty => {}
            other => panic!("unexpected outcome {other:?}"),
        }
    }

    /// Corrupt a generation's manifest (tamper a field) so load rejects it.
    fn tamper_manifest(
        store: &GenerationStore,
        generation: u64,
        field: &str,
        value: serde_json::Value,
    ) {
        let gen = store.generation_path(generation);
        let mut m: FdxIndexManifest =
            serde_json::from_str(&std::fs::read_to_string(gen.join(MANIFEST_FILE)).unwrap())
                .unwrap();
        match field {
            "dirty_fingerprint" => m.dirty_fingerprint = value.as_str().unwrap().to_string(),
            _ => panic!("unknown manifest field {field}"),
        }
        std::fs::write(
            gen.join(MANIFEST_FILE),
            serde_json::to_vec_pretty(&m).unwrap(),
        )
        .unwrap();
    }

    /// Open a fresh store with a published generation 1 and return it along
    /// with its identity. Each case runs on its own store because a rejected
    /// load quarantines the current generation (removing gen-1 from disk).
    fn fresh_store(name: &str) -> (tempfile::TempDir, IndexIdentity, GenerationStore) {
        let tmp = tempfile::tempdir().unwrap();
        let ident = identity(name);
        let store = GenerationStore::open(tmp.path(), &ident).unwrap();
        build_manifest(&store, &ident, 1, &"1".repeat(40));
        (tmp, ident, store)
    }

    /// Rewrite `files.json` in generation 1 with the given rows and refresh
    /// the manifest counts accordingly.
    fn seed_files(store: &GenerationStore, rows: &serde_json::Value) {
        let gen = store.generation_path(1);
        let mut m: FdxIndexManifest =
            serde_json::from_str(&std::fs::read_to_string(gen.join(MANIFEST_FILE)).unwrap())
                .unwrap();
        let _ = write_component_serde(&gen, &mut m, "files.json", rows);
        let n = rows.as_array().map(|a| a.len()).unwrap_or(0);
        update_component_counts(&mut m, n, 0, 0, 0, 0);
        std::fs::write(
            gen.join(MANIFEST_FILE),
            serde_json::to_vec_pretty(&m).unwrap(),
        )
        .unwrap();
    }

    /// Rewrite one component with the given rows, update counts, and assert
    /// the generation is rejected on load.
    fn assert_component_rejected(
        store: &GenerationStore,
        component: &str,
        rows: &serde_json::Value,
        counts: [usize; 5],
        label: &str,
    ) {
        let gen = store.generation_path(1);
        let mut m: FdxIndexManifest =
            serde_json::from_str(&std::fs::read_to_string(gen.join(MANIFEST_FILE)).unwrap())
                .unwrap();
        let _ = write_component_serde(&gen, &mut m, component, rows);
        update_component_counts(
            &mut m, counts[0], counts[1], counts[2], counts[3], counts[4],
        );
        std::fs::write(
            gen.join(MANIFEST_FILE),
            serde_json::to_vec_pretty(&m).unwrap(),
        )
        .unwrap();
        match store.load() {
            LoadOutcome::Loaded(_) => panic!("{label}: generation must be rejected"),
            LoadOutcome::Corrupt { .. } | LoadOutcome::Empty => {}
            other => panic!("{label}: unexpected outcome {other:?}"),
        }
    }

    /// Assert the generation still loads after a rewrite.
    fn assert_component_loaded(
        store: &GenerationStore,
        component: &str,
        rows: &serde_json::Value,
        counts: [usize; 5],
        label: &str,
    ) {
        let gen = store.generation_path(1);
        let mut m: FdxIndexManifest =
            serde_json::from_str(&std::fs::read_to_string(gen.join(MANIFEST_FILE)).unwrap())
                .unwrap();
        let _ = write_component_serde(&gen, &mut m, component, rows);
        update_component_counts(
            &mut m, counts[0], counts[1], counts[2], counts[3], counts[4],
        );
        std::fs::write(
            gen.join(MANIFEST_FILE),
            serde_json::to_vec_pretty(&m).unwrap(),
        )
        .unwrap();
        match store.load() {
            LoadOutcome::Loaded(_) => {}
            other => panic!("{label}: expected load, got {other:?}"),
        }
    }

    fn sym(id: &str, file: &str, parent: &str, hash: &str, ls: u64) -> serde_json::Value {
        serde_json::json!({"id": id, "name": id, "qualified_name": id, "kind": "function", "file": file, "line_start": ls, "line_end": ls, "exported": false, "parent_id": parent, "source_hash": hash, "generation": 1})
    }

    const VALID_HASH: &str = "0123456789abcdef";

    #[test]
    fn test_mapping_rows_are_validated_semantically() {
        // Contract item 5: test mappings must reference known files, map to a
        // file classified as a test, use the producer basis vocabulary, and
        // be unique per (source, test, basis).
        let base_files = serde_json::json!([
            {"path": "a.ts", "kind": "file", "size": 1, "modified": 0, "content_hash": "", "language": "ts", "executable": false, "classification": "source", "generation": 1},
            {"path": "a.test.ts", "kind": "file", "size": 1, "modified": 0, "content_hash": "", "language": "ts", "executable": false, "classification": "test", "generation": 1}
        ]);
        let ok = serde_json::json!([{"source_file": "a.ts", "test_file": "a.test.ts", "basis": "direct_import", "confidence": 1.0}]);

        // Sanity: a valid mapping (with the two-file index) loads.
        let (tmp, _ident, store) = fresh_store("tm-valid");
        seed_files(&store, &base_files);
        assert_component_loaded(
            &store,
            "test-mapping.json",
            &ok,
            [2, 0, 0, 1, 0],
            "valid mapping",
        );
        drop(tmp);

        // Unknown source file.
        let (tmp, _ident, store) = fresh_store("tm-unknown-source");
        seed_files(&store, &base_files);
        assert_component_rejected(
            &store,
            "test-mapping.json",
            &serde_json::json!([{"source_file": "nope.ts", "test_file": "a.test.ts", "basis": "direct_import", "confidence": 1.0}]),
            [2, 0, 0, 1, 0],
            "unknown source",
        );
        drop(tmp);

        // Unknown test file.
        let (tmp, _ident, store) = fresh_store("tm-unknown-test");
        seed_files(&store, &base_files);
        assert_component_rejected(
            &store,
            "test-mapping.json",
            &serde_json::json!([{"source_file": "a.ts", "test_file": "nope.test.ts", "basis": "direct_import", "confidence": 1.0}]),
            [2, 0, 0, 1, 0],
            "unknown test",
        );
        drop(tmp);

        // Unknown basis.
        let (tmp, _ident, store) = fresh_store("tm-unknown-basis");
        seed_files(&store, &base_files);
        assert_component_rejected(
            &store,
            "test-mapping.json",
            &serde_json::json!([{"source_file": "a.ts", "test_file": "a.test.ts", "basis": "package", "confidence": 1.0}]),
            [2, 0, 0, 1, 0],
            "unknown basis",
        );
        drop(tmp);

        // Duplicate (source, test, basis).
        let (tmp, _ident, store) = fresh_store("tm-duplicate");
        seed_files(&store, &base_files);
        assert_component_rejected(
            &store,
            "test-mapping.json",
            &serde_json::json!([
                {"source_file": "a.ts", "test_file": "a.test.ts", "basis": "naming", "confidence": 0.8},
                {"source_file": "a.ts", "test_file": "a.test.ts", "basis": "naming", "confidence": 0.8}
            ]),
            [2, 0, 0, 2, 0],
            "duplicate mapping",
        );
        drop(tmp);

        // Test file not classified as a test (separate store: the test
        // mapping must reference a file whose classification is "test").
        let source_test = serde_json::json!([
            {"path": "a.ts", "kind": "file", "size": 1, "modified": 0, "content_hash": "", "language": "ts", "executable": false, "classification": "source", "generation": 1},
            {"path": "a.test.ts", "kind": "file", "size": 1, "modified": 0, "content_hash": "", "language": "ts", "executable": false, "classification": "source", "generation": 1}
        ]);
        let (tmp, _ident, store) = fresh_store("tm-misclassified");
        seed_files(&store, &source_test);
        assert_component_rejected(
            &store,
            "test-mapping.json",
            &serde_json::json!([{"source_file": "a.ts", "test_file": "a.test.ts", "basis": "direct_import", "confidence": 1.0}]),
            [2, 0, 0, 1, 0],
            "test file misclassified",
        );
        drop(tmp);
    }

    #[test]
    fn content_cache_rows_are_validated_semantically() {
        // Contract item 6: cache entries must reference indexed files, carry
        // a well-formed 16-hex key, and be unique by key and by path.
        let entry = |key: &str, path: &str| serde_json::json!({"key": key, "path": path, "size": 1, "access_order": 1, "content": "x", "generation": 1});

        // Sanity: a valid entry for an indexed file loads.
        let (tmp, _ident, store) = fresh_store("cc-valid");
        assert_component_loaded(
            &store,
            "content-cache.json",
            &serde_json::json!([entry(VALID_HASH, "a.txt")]),
            [1, 0, 0, 0, 1],
            "valid cache entry",
        );
        drop(tmp);

        // Path not in the index.
        let (tmp, _ident, store) = fresh_store("cc-unknown-path");
        assert_component_rejected(
            &store,
            "content-cache.json",
            &serde_json::json!([entry(VALID_HASH, "nope.txt")]),
            [1, 0, 0, 0, 1],
            "unknown cache path",
        );
        drop(tmp);

        // Malformed key.
        let (tmp, _ident, store) = fresh_store("cc-malformed-key");
        assert_component_rejected(
            &store,
            "content-cache.json",
            &serde_json::json!([entry("zz", "a.txt")]),
            [1, 0, 0, 0, 1],
            "malformed key",
        );
        drop(tmp);

        // Duplicate key.
        let (tmp, _ident, store) = fresh_store("cc-duplicate-key");
        assert_component_rejected(
            &store,
            "content-cache.json",
            &serde_json::json!([entry(VALID_HASH, "a.txt"), entry(VALID_HASH, "a.txt")]),
            [1, 0, 0, 0, 2],
            "duplicate key",
        );
        drop(tmp);

        // Duplicate path with distinct keys.
        let (tmp, _ident, store) = fresh_store("cc-duplicate-path");
        assert_component_rejected(
            &store,
            "content-cache.json",
            &serde_json::json!([
                entry(VALID_HASH, "a.txt"),
                entry("0123456789abcdee", "a.txt")
            ]),
            [1, 0, 0, 0, 2],
            "duplicate path",
        );
        drop(tmp);
    }

    #[test]
    fn symbol_rows_are_validated_semantically() {
        // Contract item 7: symbols need sane line ranges, well-formed source
        // hashes, and parent pointers that stay in the same file, reference
        // an existing symbol, and never form cycles.
        // Sanity: top-level + child symbol with a valid parent loads.
        let (tmp, _ident, store) = fresh_store("sym-valid");
        assert_component_loaded(
            &store,
            "symbols.json",
            &serde_json::json!([
                sym("a", "a.txt", "", VALID_HASH, 1),
                sym("b", "a.txt", "a", VALID_HASH, 2)
            ]),
            [1, 2, 0, 0, 0],
            "valid parent",
        );
        drop(tmp);

        // line_start below 1.
        let (tmp, _ident, store) = fresh_store("sym-line-start-0");
        assert_component_rejected(
            &store,
            "symbols.json",
            &serde_json::json!([sym("a", "a.txt", "", VALID_HASH, 0)]),
            [1, 1, 0, 0, 0],
            "line_start 0",
        );
        drop(tmp);

        // Malformed source hash.
        let (tmp, _ident, store) = fresh_store("sym-bad-hash");
        assert_component_rejected(
            &store,
            "symbols.json",
            &serde_json::json!([sym("a", "a.txt", "", "not-a-hash", 1)]),
            [1, 1, 0, 0, 0],
            "bad source hash",
        );
        drop(tmp);

        // Self-parent.
        let (tmp, _ident, store) = fresh_store("sym-self-parent");
        assert_component_rejected(
            &store,
            "symbols.json",
            &serde_json::json!([sym("a", "a.txt", "a", VALID_HASH, 1)]),
            [1, 1, 0, 0, 0],
            "self parent",
        );
        drop(tmp);

        // Unknown parent.
        let (tmp, _ident, store) = fresh_store("sym-unknown-parent");
        assert_component_rejected(
            &store,
            "symbols.json",
            &serde_json::json!([sym("a", "a.txt", "ghost", VALID_HASH, 1)]),
            [1, 1, 0, 0, 0],
            "unknown parent",
        );
        drop(tmp);

        // Parent in another file (needs b.txt in the index).
        let two_files = serde_json::json!([
            {"path": "a.txt", "kind": "file", "size": 1, "modified": 0, "content_hash": "", "language": "", "executable": false, "classification": "source", "generation": 1},
            {"path": "b.txt", "kind": "file", "size": 1, "modified": 0, "content_hash": "", "language": "", "executable": false, "classification": "source", "generation": 1}
        ]);
        let (tmp, _ident, store) = fresh_store("sym-cross-file");
        seed_files(&store, &two_files);
        assert_component_rejected(
            &store,
            "symbols.json",
            &serde_json::json!([
                sym("a", "a.txt", "", VALID_HASH, 1),
                sym("b", "b.txt", "a", VALID_HASH, 2)
            ]),
            [2, 2, 0, 0, 0],
            "cross-file parent",
        );
        drop(tmp);

        // Parent cycle.
        let (tmp, _ident, store) = fresh_store("sym-cycle");
        assert_component_rejected(
            &store,
            "symbols.json",
            &serde_json::json!([
                sym("a", "a.txt", "b", VALID_HASH, 1),
                sym("b", "a.txt", "a", VALID_HASH, 2)
            ]),
            [1, 2, 0, 0, 0],
            "parent cycle",
        );
        drop(tmp);
    }

    #[test]
    fn dependency_rows_are_validated_semantically() {
        // Contract item 8: dependency edges carry a non-empty specifier, a
        // known kind, a consistent unresolved/target contract, and are
        // unique by (from, to, specifier, kind, unresolved).
        let edge = |from: &str, to: &str, spec: &str, kind: &str, unresolved: bool| serde_json::json!({"from_file": from, "to_file": to, "specifier": spec, "kind": kind, "unresolved": unresolved, "generation": 1});

        // Sanity: a resolved edge to an indexed file loads.
        let (tmp, _ident, store) = fresh_store("dep-valid-resolved");
        assert_component_loaded(
            &store,
            "dependencies.json",
            &serde_json::json!([edge("a.txt", "a.txt", "./a", "import", false)]),
            [1, 0, 1, 0, 0],
            "valid resolved edge",
        );
        drop(tmp);

        // Sanity: an unresolved edge with empty target loads.
        let (tmp, _ident, store) = fresh_store("dep-valid-unresolved");
        assert_component_loaded(
            &store,
            "dependencies.json",
            &serde_json::json!([edge("a.txt", "", "lodash", "import", true)]),
            [1, 0, 1, 0, 0],
            "valid unresolved edge",
        );
        drop(tmp);

        // Empty specifier.
        let (tmp, _ident, store) = fresh_store("dep-empty-specifier");
        assert_component_rejected(
            &store,
            "dependencies.json",
            &serde_json::json!([edge("a.txt", "", "", "import", true)]),
            [1, 0, 1, 0, 0],
            "empty specifier",
        );
        drop(tmp);

        // Unknown kind.
        let (tmp, _ident, store) = fresh_store("dep-unknown-kind");
        assert_component_rejected(
            &store,
            "dependencies.json",
            &serde_json::json!([edge("a.txt", "", "x", "relative", true)]),
            [1, 0, 1, 0, 0],
            "unknown kind",
        );
        drop(tmp);

        // Unresolved edge carrying a target.
        let (tmp, _ident, store) = fresh_store("dep-unresolved-with-target");
        assert_component_rejected(
            &store,
            "dependencies.json",
            &serde_json::json!([edge("a.txt", "a.txt", "x", "import", true)]),
            [1, 0, 1, 0, 0],
            "unresolved with target",
        );
        drop(tmp);

        // Duplicate edge.
        let (tmp, _ident, store) = fresh_store("dep-duplicate");
        assert_component_rejected(
            &store,
            "dependencies.json",
            &serde_json::json!([
                edge("a.txt", "a.txt", "./a", "import", false),
                edge("a.txt", "a.txt", "./a", "import", false)
            ]),
            [1, 0, 2, 0, 0],
            "duplicate edge",
        );
        drop(tmp);
    }

    #[test]
    fn git_state_rows_are_validated_semantically() {
        // Contract item 9: HEAD must be empty or 40 lowercase hex, worktree
        // must match the manifest, and the file lists must be canonical and
        // pairwise disjoint with unique entries; renames must be well-formed.
        let snap = |head: &str,
                    wt: &str,
                    changed: serde_json::Value,
                    renamed: serde_json::Value,
                    deleted: serde_json::Value,
                    untracked: serde_json::Value| {
            serde_json::json!({"head_sha": head, "branch": "", "detached": false, "changed_files": changed, "renamed_files": renamed, "deleted_files": deleted, "untracked_files": untracked, "worktree_id": wt, "generation": 1})
        };

        // Sanity: valid snapshot (empty lists) loads.
        let (tmp, ident, store) = fresh_store("git-valid");
        assert_component_loaded(
            &store,
            "git-state.json",
            &snap(
                &"1".repeat(40),
                &ident.worktree_id,
                serde_json::json!([]),
                serde_json::json!([]),
                serde_json::json!([]),
                serde_json::json!([]),
            ),
            [1, 0, 0, 0, 0],
            "valid git state",
        );
        drop(tmp);

        // Non-hex HEAD.
        let (tmp, ident, store) = fresh_store("git-non-hex-head");
        assert_component_rejected(
            &store,
            "git-state.json",
            &snap(
                &"z".repeat(40),
                &ident.worktree_id,
                serde_json::json!([]),
                serde_json::json!([]),
                serde_json::json!([]),
                serde_json::json!([]),
            ),
            [1, 0, 0, 0, 0],
            "non-hex head",
        );
        drop(tmp);

        // Uppercase hex HEAD.
        let (tmp, ident, store) = fresh_store("git-uppercase-head");
        assert_component_rejected(
            &store,
            "git-state.json",
            &snap(
                &"A".repeat(40),
                &ident.worktree_id,
                serde_json::json!([]),
                serde_json::json!([]),
                serde_json::json!([]),
                serde_json::json!([]),
            ),
            [1, 0, 0, 0, 0],
            "uppercase head",
        );
        drop(tmp);

        // Wrong worktree id.
        let (tmp, _ident, store) = fresh_store("git-wrong-worktree");
        assert_component_rejected(
            &store,
            "git-state.json",
            &snap(
                &"1".repeat(40),
                "deadbeef",
                serde_json::json!([]),
                serde_json::json!([]),
                serde_json::json!([]),
                serde_json::json!([]),
            ),
            [1, 0, 0, 0, 0],
            "worktree mismatch",
        );
        drop(tmp);

        // Same file in changed + deleted.
        let (tmp, ident, store) = fresh_store("git-overlap");
        assert_component_rejected(
            &store,
            "git-state.json",
            &snap(
                &"1".repeat(40),
                &ident.worktree_id,
                serde_json::json!(["a.txt"]),
                serde_json::json!([]),
                serde_json::json!(["a.txt"]),
                serde_json::json!([]),
            ),
            [1, 0, 0, 0, 0],
            "overlapping lists",
        );
        drop(tmp);

        // Non-canonical path.
        let (tmp, ident, store) = fresh_store("git-absolute-path");
        assert_component_rejected(
            &store,
            "git-state.json",
            &snap(
                &"1".repeat(40),
                &ident.worktree_id,
                serde_json::json!(["/abs/a.txt"]),
                serde_json::json!([]),
                serde_json::json!([]),
                serde_json::json!([]),
            ),
            [1, 0, 0, 0, 0],
            "absolute path",
        );
        drop(tmp);

        // Malformed rename pair.
        let (tmp, ident, store) = fresh_store("git-bad-rename");
        assert_component_rejected(
            &store,
            "git-state.json",
            &snap(
                &"1".repeat(40),
                &ident.worktree_id,
                serde_json::json!([]),
                serde_json::json!([["", "a.txt"]]),
                serde_json::json!([]),
                serde_json::json!([]),
            ),
            [1, 0, 0, 0, 0],
            "bad rename pair",
        );
        drop(tmp);
    }

    #[test]
    fn manifest_dirty_fingerprint_format_is_validated() {
        // Contract item 9 (fingerprint): schema v2 manifests must carry a
        // 64-hex dirty fingerprint; a tampered one rejects the generation.
        let tmp = tempfile::tempdir().unwrap();
        let ident = identity("fp");
        let store = GenerationStore::open(tmp.path(), &ident).unwrap();
        build_manifest(&store, &ident, 1, &"1".repeat(40));

        tamper_manifest(
            &store,
            1,
            "dirty_fingerprint",
            serde_json::json!("not-a-fingerprint"),
        );
        match store.load() {
            LoadOutcome::Loaded(_) => panic!("malformed dirty fingerprint must be rejected"),
            LoadOutcome::Corrupt { .. } | LoadOutcome::Empty => {}
            other => panic!("unexpected outcome {other:?}"),
        }
    }

    #[test]
    fn clear_persisted_removes_all_generations_and_pointer() {
        let tmp = tempfile::tempdir().unwrap();
        let ident = identity("clear-ok");
        let store = GenerationStore::open(tmp.path(), &ident).unwrap();
        build_manifest(&store, &ident, 1, &"1".repeat(40));
        build_manifest(&store, &ident, 2, &"2".repeat(40));
        assert_eq!(store.current_generation().unwrap(), Some(2));

        store.clear_persisted().unwrap();
        assert_eq!(store.persisted_generations(), Vec::<u64>::new());
        assert_eq!(store.current_generation().unwrap(), None);
    }

    #[cfg(unix)]
    #[test]
    fn clear_persisted_propagates_deletion_errors() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let ident = identity("clear-err");
        let store = GenerationStore::open(tmp.path(), &ident).unwrap();
        build_manifest(&store, &ident, 1, &"1".repeat(40));
        assert_eq!(store.current_generation().unwrap(), Some(1));

        // A read-only worktree dir makes both the generation removal and the
        // pointer removal fail; clear_persisted must report the error instead
        // of pretending the state was cleared.
        let wt = store.worktree_path().to_path_buf();
        let mut perms = std::fs::metadata(&wt).unwrap().permissions();
        perms.set_mode(0o555);
        std::fs::set_permissions(&wt, perms.clone()).unwrap();

        let err = store.clear_persisted().unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied);
        // No false success: the generation is still on disk.
        assert!(!store.persisted_generations().is_empty());

        // Restore so the temp dir can be cleaned up.
        perms.set_mode(0o755);
        std::fs::set_permissions(&wt, perms).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn load_reports_recovery_failed_when_pointer_repair_fails() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let ident = identity("recovery-repair");
        let store = GenerationStore::open(tmp.path(), &ident).unwrap();
        build_manifest(&store, &ident, 1, &"1".repeat(40));
        // Point CURRENT at a nonexistent generation so load must repair it
        // back to the valid gen 1.
        std::fs::write(store.worktree_path().join("CURRENT"), "7").unwrap();

        let wt = store.worktree_path().to_path_buf();
        let mut perms = std::fs::metadata(&wt).unwrap().permissions();
        perms.set_mode(0o555);
        std::fs::set_permissions(&wt, perms.clone()).unwrap();

        match store.load() {
            LoadOutcome::RecoveryFailed { error, last_valid } => {
                assert!(
                    error.contains("repair CURRENT"),
                    "error should describe the pointer repair: {error}"
                );
                let m = last_valid.expect("last_valid must carry the valid generation");
                assert_eq!(m.generation, 1);
            }
            other => panic!("expected RecoveryFailed, got {other:?}"),
        }

        perms.set_mode(0o755);
        std::fs::set_permissions(&wt, perms).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn load_reports_recovery_failed_when_stale_pointer_clear_fails() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let ident = identity("recovery-clear");
        let store = GenerationStore::open(tmp.path(), &ident).unwrap();
        build_manifest(&store, &ident, 1, &"1".repeat(40));
        // Corrupt the only generation so nothing valid remains, while CURRENT
        // still points at gen 1 (a stale pointer that must be cleared).
        tamper_manifest(
            &store,
            1,
            "dirty_fingerprint",
            serde_json::json!("not-a-fingerprint"),
        );

        let wt = store.worktree_path().to_path_buf();
        let mut perms = std::fs::metadata(&wt).unwrap().permissions();
        perms.set_mode(0o555);
        std::fs::set_permissions(&wt, perms.clone()).unwrap();

        match store.load() {
            LoadOutcome::RecoveryFailed { error, last_valid } => {
                assert!(
                    error.contains("clear stale CURRENT"),
                    "error should describe the pointer clear: {error}"
                );
                assert!(last_valid.is_none());
            }
            other => panic!("expected RecoveryFailed, got {other:?}"),
        }

        perms.set_mode(0o755);
        std::fs::set_permissions(&wt, perms).unwrap();
    }

    #[test]
    fn future_schema_is_rejected_and_left_in_place() {
        let tmp = tempfile::tempdir().unwrap();
        let ident = identity("future");
        let store = GenerationStore::open(tmp.path(), &ident).unwrap();
        // Manually write a gen with schema 999.
        let gen = store.generation_path(1);
        std::fs::create_dir_all(&gen).unwrap();
        let mut m = new_manifest(&ident, "0.1.0", 1, "t", "h", "d", "c", "i");
        m.schema_version = 999;
        std::fs::write(
            gen.join(MANIFEST_FILE),
            serde_json::to_vec_pretty(&m).unwrap(),
        )
        .unwrap();
        store.set_current(1).unwrap();

        // load() reports FutureSchema and leaves it in place.
        match store.load() {
            LoadOutcome::FutureSchema { generation, .. } => {
                assert_eq!(generation, 1);
            }
            other => panic!("expected FutureSchema, got {other:?}"),
        }
        assert!(store.generation_path(1).join(MANIFEST_FILE).exists());

        // publish() must reject the future schema too.
        let err = store
            .publish(2, &ident, "0.1.0", "t", |dir| {
                let mut m = new_manifest(&ident, "0.1.0", 2, "t", "h", "d", "c", "i");
                m.schema_version = 999;
                let _ = write_component_serde(dir, &mut m, "files.json", &serde_json::json!([]));
                Ok(m)
            })
            .unwrap_err();
        assert!(err.to_string().contains("newer than supported"));
    }

    #[test]
    fn stale_tmp_generations_are_cleaned() {
        let tmp = tempfile::tempdir().unwrap();
        let ident = identity("tmpclean");
        let store = GenerationStore::open(tmp.path(), &ident).unwrap();
        // Create a stale tmp dir
        let stale = store.worktree_path().join("gen-99.tmp");
        std::fs::create_dir_all(&stale).unwrap();
        std::fs::write(stale.join("x"), b"y").unwrap();

        build_manifest(&store, &ident, 1, &"0".repeat(40));

        assert!(!store.worktree_path().join("gen-99.tmp").exists());
    }

    #[test]
    fn retained_previous_generation_keeps_last_valid() {
        let tmp = tempfile::tempdir().unwrap();
        let ident = identity("retain");
        let store = GenerationStore::open(tmp.path(), &ident).unwrap();
        for g in [1, 2, 3] {
            build_manifest(&store, &ident, g, &"9".repeat(40));
        }
        let gens = store.persisted_generations();
        assert!(gens.contains(&3), "current gen present: {gens:?}");
        assert!(gens.contains(&2), "previous valid retained: {gens:?}");
        assert!(!gens.contains(&1), "older than retention dropped: {gens:?}");
        assert_eq!(store.current_generation().unwrap(), Some(3));
    }

    #[test]
    fn component_checksum_detects_tampering() {
        let tmp = tempfile::tempdir().unwrap();
        let ident = identity("tamper");
        let store = GenerationStore::open(tmp.path(), &ident).unwrap();
        build_manifest(&store, &ident, 1, &"0".repeat(40));
        // Tamper with the component file after publish.
        let mut f = std::fs::File::create(store.generation_path(1).join("files.json")).unwrap();
        f.write_all(br#"[{"path":"tampered"}]"#).unwrap();
        f.sync_all().unwrap();

        match store.load() {
            LoadOutcome::Corrupt { .. } => {}
            LoadOutcome::Empty => {}
            other => panic!("expected corrupt load, got {other:?}"),
        }
    }

    #[test]
    fn dropped_checksum_entry_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let ident = identity("dropchk");
        let store = GenerationStore::open(tmp.path(), &ident).unwrap();
        build_manifest(&store, &ident, 1, &"0".repeat(40));
        // Remove one component's checksum entry from an otherwise-valid
        // manifest: the exact-set rule must reject it (a dropped entry would
        // otherwise bypass integrity verification for that component).
        let gen = store.generation_path(1);
        let mut m: FdxIndexManifest =
            serde_json::from_str(&std::fs::read_to_string(gen.join(MANIFEST_FILE)).unwrap())
                .unwrap();
        m.checksums.remove("symbols.json");
        std::fs::write(
            gen.join(MANIFEST_FILE),
            serde_json::to_vec_pretty(&m).unwrap(),
        )
        .unwrap();

        match store.load() {
            LoadOutcome::Corrupt { .. } => {}
            LoadOutcome::Empty => {}
            other => panic!("expected corrupt load, got {other:?}"),
        }
    }

    #[test]
    fn unknown_checksum_key_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let ident = identity("unkchk");
        let store = GenerationStore::open(tmp.path(), &ident).unwrap();
        build_manifest(&store, &ident, 1, &"0".repeat(40));
        // Add a checksum entry for a file that is not a validated component:
        // the exact-set rule must reject the extra key.
        let gen = store.generation_path(1);
        let mut m: FdxIndexManifest =
            serde_json::from_str(&std::fs::read_to_string(gen.join(MANIFEST_FILE)).unwrap())
                .unwrap();
        m.checksums
            .insert("secret.json".to_string(), "deadbeef".to_string());
        std::fs::write(
            gen.join(MANIFEST_FILE),
            serde_json::to_vec_pretty(&m).unwrap(),
        )
        .unwrap();

        match store.load() {
            LoadOutcome::Corrupt { .. } => {}
            LoadOutcome::Empty => {}
            other => panic!("expected corrupt load, got {other:?}"),
        }
    }

    #[test]
    fn malformed_pointer_recovers_to_newest_valid() {
        let tmp = tempfile::tempdir().unwrap();
        let ident = identity("badptr");
        let store = GenerationStore::open(tmp.path(), &ident).unwrap();
        build_manifest(&store, &ident, 1, &"1".repeat(40));
        // Malformed CURRENT.
        let ptr = current_pointer(store.worktree_path());
        std::fs::write(&ptr, "not-a-number").unwrap();

        match store.load() {
            LoadOutcome::Loaded(m) => assert_eq!(m.generation, 1),
            other => panic!("expected recovery to gen 1, got {other:?}"),
        }
        assert_eq!(store.current_generation().unwrap(), Some(1));
    }

    #[test]
    fn interrupted_publication_repoints_to_newer_valid_generation() {
        let tmp = tempfile::tempdir().unwrap();
        let ident = identity("interrupted");
        let store = GenerationStore::open(tmp.path(), &ident).unwrap();
        build_manifest(&store, &ident, 1, &"1".repeat(40));
        // Simulate a crash after gen-2 rename but before CURRENT update.
        let gen2 = store.generation_path(2);
        std::fs::create_dir_all(&gen2).unwrap();
        let mut m = new_manifest(
            &ident,
            "0.1.0",
            2,
            "t",
            &"2".repeat(40),
            &"d".repeat(64),
            "c",
            "i",
        );
        let _ = write_component_serde(
            &gen2,
            &mut m,
            "files.json",
            &serde_json::json!([{"path": "a.txt", "kind": "file", "size": 3, "modified": 0, "content_hash": "", "language": "", "executable": false, "classification": "source", "generation": 2}]),
        );
        let _ = write_component_serde(&gen2, &mut m, "symbols.json", &serde_json::json!([]));
        let _ = write_component_serde(&gen2, &mut m, "dependencies.json", &serde_json::json!([]));
        let _ = write_component_serde(&gen2, &mut m, "test-mapping.json", &serde_json::json!([]));
        let _ = write_component_serde(
            &gen2,
            &mut m,
            "git-state.json",
            &serde_json::json!({"head_sha": "2222222222222222222222222222222222222222", "branch": "", "detached": false, "changed_files": [], "renamed_files": [], "deleted_files": [], "untracked_files": [], "worktree_id": ident.worktree_id, "generation": 2}),
        );
        let _ = write_component_serde(&gen2, &mut m, "content-cache.json", &serde_json::json!([]));
        update_component_counts(&mut m, 1, 0, 0, 0, 0);
        ready_components(
            &mut m,
            &[
                "files",
                "symbols",
                "dependencies",
                "test_mapping",
                "git_state",
                "content_cache",
            ],
        );
        std::fs::write(
            gen2.join(MANIFEST_FILE),
            serde_json::to_vec_pretty(&m).unwrap(),
        )
        .unwrap();

        // CURRENT still points at 1.
        assert_eq!(store.current_generation().unwrap(), Some(1));
        // load() must recover to the newer valid gen 2 and repoint.
        match store.load() {
            LoadOutcome::Loaded(m) => assert_eq!(m.generation, 2),
            other => panic!("expected recovery to gen 2, got {other:?}"),
        }
        assert_eq!(store.current_generation().unwrap(), Some(2));
    }

    #[test]
    fn malformed_component_with_valid_checksum_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let ident = identity("badcomp");
        let store = GenerationStore::open(tmp.path(), &ident).unwrap();
        build_manifest(&store, &ident, 1, &"1".repeat(40));
        // Corrupt symbols.json AND recompute its checksum in the manifest so
        // the checksum validation alone cannot catch it; strict
        // deserialization must.
        let gen = store.generation_path(1);
        let bytes = br#"[{"id": 42}]"#; // wrong shape: id is a number, not string
        std::fs::write(gen.join("symbols.json"), bytes).unwrap();
        let mut m: FdxIndexManifest =
            serde_json::from_str(&std::fs::read_to_string(gen.join(MANIFEST_FILE)).unwrap())
                .unwrap();
        m.checksums
            .insert("symbols.json".to_string(), sha256_hex(bytes));
        std::fs::write(
            gen.join(MANIFEST_FILE),
            serde_json::to_vec_pretty(&m).unwrap(),
        )
        .unwrap();

        match store.load() {
            LoadOutcome::Corrupt { .. } => {}
            LoadOutcome::Empty => {}
            other => panic!("expected corrupt load, got {other:?}"),
        }
    }

    #[test]
    fn count_mismatch_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let ident = identity("badcount");
        let store = GenerationStore::open(tmp.path(), &ident).unwrap();
        build_manifest(&store, &ident, 1, &"1".repeat(40));
        // Drop a row from files.json and recompute the checksum; the count
        // mismatch must be detected.
        let gen = store.generation_path(1);
        std::fs::write(gen.join("files.json"), b"[]").unwrap();
        let mut m: FdxIndexManifest =
            serde_json::from_str(&std::fs::read_to_string(gen.join(MANIFEST_FILE)).unwrap())
                .unwrap();
        m.checksums
            .insert("files.json".to_string(), sha256_hex(b"[]"));
        std::fs::write(
            gen.join(MANIFEST_FILE),
            serde_json::to_vec_pretty(&m).unwrap(),
        )
        .unwrap();

        match store.load() {
            LoadOutcome::Corrupt { .. } => {}
            LoadOutcome::Empty => {}
            other => panic!("expected corrupt load, got {other:?}"),
        }
    }

    #[test]
    fn wrong_repository_identity_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let ident = identity("mine");
        let store = GenerationStore::open(tmp.path(), &ident).unwrap();
        build_manifest(&store, &ident, 1, &"1".repeat(40));
        // Point a store for a DIFFERENT repository at the same state dir.
        let other = identity("other");
        let store2 = GenerationStore::open(tmp.path(), &other).unwrap();
        match store2.load() {
            LoadOutcome::Empty => {}
            LoadOutcome::Corrupt { .. } => {}
            other => panic!("expected empty/corrupt for wrong identity, got {other:?}"),
        }
    }

    #[test]
    fn writer_lock_excludes_concurrent_writers() {
        let tmp = tempfile::tempdir().unwrap();
        let ident = identity("lock");
        let store = GenerationStore::open(tmp.path(), &ident).unwrap();
        let _lock = store.writer_lock().unwrap();
        // A second acquisition must time out (would-block), not succeed.
        let err = WriterLock::try_acquire(store.worktree_path()).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::WouldBlock);
        drop(_lock);
        // After release, acquisition succeeds.
        let _lock2 = WriterLock::try_acquire(store.worktree_path()).unwrap();
    }

    #[test]
    fn legacy_identity_state_is_migrated_when_ownership_matches() {
        let tmp = tempfile::tempdir().unwrap();
        let ident = identity("legacy");
        // Build a legacy layout: 16-hex repo/wt dirs (computed from the
        // identity exactly as older builds did) with a schema-1 manifest.
        let repo_norm = normalize_root_for_compare(&ident.repository_root);
        let wt_norm = normalize_root_for_compare(&ident.worktree_root);
        let legacy_repo = crate::index::identity::legacy_segment(&["repo", &repo_norm]);
        let legacy_wt = crate::index::identity::legacy_segment(&["worktree", &wt_norm]);
        let legacy_dir = tmp.path().join(&legacy_repo).join(&legacy_wt);
        std::fs::create_dir_all(&legacy_dir).unwrap();
        let gen = legacy_dir.join("gen-1");
        std::fs::create_dir_all(&gen).unwrap();
        let mut m = new_manifest(&ident, "0.1.0", 1, "t", &"1".repeat(40), "d", "c", "i");
        m.schema_version = 1;
        m.repository_id = legacy_repo.to_string();
        m.worktree_id = legacy_wt.to_string();
        let files = serde_json::json!([{"path": "a.txt", "kind": "file", "size": 3, "modified": 0, "content_hash": "", "language": "", "executable": false, "classification": "source", "generation": 1}]);
        let git_state = serde_json::json!({"head_sha": "1111111111111111111111111111111111111111", "branch": "", "detached": false, "changed_files": [], "renamed_files": [], "deleted_files": [], "untracked_files": [], "worktree_id": legacy_wt, "generation": 1});
        let git_bytes = serde_json::to_vec(&git_state).unwrap();
        // Write a structurally valid set of components.
        std::fs::write(gen.join("files.json"), serde_json::to_vec(&files).unwrap()).unwrap();
        std::fs::write(gen.join("symbols.json"), b"[]").unwrap();
        std::fs::write(gen.join("dependencies.json"), b"[]").unwrap();
        std::fs::write(gen.join("test-mapping.json"), b"[]").unwrap();
        std::fs::write(gen.join("git-state.json"), &git_bytes).unwrap();
        std::fs::write(gen.join("content-cache.json"), b"[]").unwrap();
        m.component_counts = ComponentCounts {
            files: 1,
            symbols: 0,
            dependencies: 0,
            test_mapping: 0,
            git_state: 1,
            content_cache: 0,
        };
        // The checksum map must be the EXACT component set: every component
        // registered with the hash of the bytes written above.
        m.checksums.insert(
            "files.json".to_string(),
            sha256_hex(&serde_json::to_vec(&files).unwrap()),
        );
        m.checksums
            .insert("symbols.json".to_string(), sha256_hex(b"[]"));
        m.checksums
            .insert("dependencies.json".to_string(), sha256_hex(b"[]"));
        m.checksums
            .insert("test-mapping.json".to_string(), sha256_hex(b"[]"));
        m.checksums
            .insert("git-state.json".to_string(), sha256_hex(&git_bytes));
        m.checksums
            .insert("content-cache.json".to_string(), sha256_hex(b"[]"));
        std::fs::write(
            gen.join(MANIFEST_FILE),
            serde_json::to_vec_pretty(&m).unwrap(),
        )
        .unwrap();

        // Open a store with the CURRENT (full-strength) identity: the legacy
        // state must be migrated and loadable.
        let store = GenerationStore::open(tmp.path(), &ident).unwrap();
        match store.load() {
            LoadOutcome::Loaded(m) => {
                assert_eq!(m.generation, 1);
                assert_eq!(m.repository_id, ident.repository_id);
            }
            other => panic!("expected migrated load, got {other:?}"),
        }
        // The legacy dir is gone (moved into the current identity path).
        assert!(!legacy_dir.exists());
    }

    #[test]
    fn legacy_identity_state_is_not_mixed_with_other_repositories() {
        let tmp = tempfile::tempdir().unwrap();
        let ident_a = identity("a");
        let ident_b = identity("b");
        // Legacy dir for repository B exists; opening a store for repository
        // A must NOT adopt it.
        let legacy_wt = "fedcba9876543210";
        let legacy_dir = tmp.path().join("0123456789abcdef").join(legacy_wt);
        std::fs::create_dir_all(&legacy_dir).unwrap();
        let gen = legacy_dir.join("gen-1");
        std::fs::create_dir_all(&gen).unwrap();
        let mut m = new_manifest(&ident_b, "0.1.0", 1, "t", &"1".repeat(40), "d", "c", "i");
        m.schema_version = 1;
        m.repository_id = "0123456789abcdef".to_string();
        m.worktree_id = legacy_wt.to_string();
        std::fs::write(
            gen.join(MANIFEST_FILE),
            serde_json::to_vec_pretty(&m).unwrap(),
        )
        .unwrap();

        let store_a = GenerationStore::open(tmp.path(), &ident_a).unwrap();
        // Not adopted, not mixed: A sees no state and builds fresh.
        assert!(matches!(store_a.load(), LoadOutcome::Empty));
        assert!(
            legacy_dir.exists(),
            "foreign legacy state preserved as evidence"
        );
    }

    #[test]
    fn no_tmp_or_pointer_leftovers_after_publish() {
        let tmp = tempfile::tempdir().unwrap();
        let ident = identity("clean");
        let store = GenerationStore::open(tmp.path(), &ident).unwrap();
        build_manifest(&store, &ident, 1, &"1".repeat(40));
        build_manifest(&store, &ident, 2, &"2".repeat(40));
        let entries: Vec<String> = std::fs::read_dir(store.worktree_path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(
            !entries.iter().any(|e| e.ends_with(".tmp")),
            "no tmp dirs: {entries:?}"
        );
        assert!(!entries.iter().any(|e| e.contains("CURRENT.tmp")));
    }

    #[test]
    fn unique_temp_names_never_collide_and_pointer_is_atomic() {
        let tmp = tempfile::tempdir().unwrap();
        let ident = identity("unique");
        let store = GenerationStore::open(tmp.path(), &ident).unwrap();
        let ptr = current_pointer(store.worktree_path());
        // The unique temp-sibling and temp-dir names are distinct on every
        // call, so racing writers never share a temp path (pid + atomic
        // counter). Same-process colliders would be a cross-writer hazard.
        let sibs: Vec<PathBuf> = (0..8).map(|_| store.unique_tmp_sibling(&ptr)).collect();
        let dirs: Vec<PathBuf> = (0..8).map(|g| store.unique_tmp_dir(g)).collect();
        assert_eq!(
            sibs.iter().collect::<std::collections::HashSet<_>>().len(),
            sibs.len()
        );
        assert_eq!(
            dirs.iter().collect::<std::collections::HashSet<_>>().len(),
            dirs.len()
        );
        // set_current swaps in a new generation atomically and leaves no temp
        // pointer behind; a reader observes exactly one pointer value.
        build_manifest(&store, &ident, 1, &"1".repeat(40));
        store.set_current(1).unwrap();
        assert_eq!(store.current_generation().unwrap(), Some(1));
        let entries: Vec<String> = std::fs::read_dir(store.worktree_path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(!entries.iter().any(|e| e.contains("CURRENT.tmp")));
    }

    #[test]
    fn missing_component_is_rejected_not_emptied() {
        let tmp = tempfile::tempdir().unwrap();
        let ident = identity("missingcomp");
        let store = GenerationStore::open(tmp.path(), &ident).unwrap();
        build_manifest(&store, &ident, 1, &"1".repeat(40));
        // Remove a component file entirely (no checksum map entry can save it).
        std::fs::remove_file(store.generation_path(1).join("symbols.json")).unwrap();
        match store.load() {
            LoadOutcome::Corrupt { .. } => {}
            LoadOutcome::Empty => {}
            other => panic!("expected corrupt load, got {other:?}"),
        }
    }
}
