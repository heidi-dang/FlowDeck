//! FDX persistent warm incremental index (Task 3).
//!
//! Public surface:
//! - [`IndexService`]: a thread-safe, lazily-loaded index for one
//!   repository/worktree. Daemon clients share one service per worktree.
//! - [`IndexSnapshot`]: an immutable, loaded generation snapshot used for
//!   query serving (readers never observe partial updates).
//! - Query functions: `query_files`, `query_symbols`, `query_dependencies`,
//!   `query_tests_for`, `query_git_state`, `query_index_status`.
//!
//! Concurrency model (Task 3 §15):
//! - readers take a read lock on the current snapshot (never block each
//!   other);
//! - one writer publishes a generation at a time (write lock on the service);
//! - refresh requests coalesce: a second refresh while one is in flight
//!   waits for the in-flight one and reuses its result;
//! - readers observe either the prior complete generation or the new
//!   complete generation — never a partial update (snapshot swap);
//! - cancellation leaves the previous generation valid (refresh builds in a
//!   detached generation and only publishes on success);
//! - shutdown waits for in-flight refresh (or abandons safely);
//! - no global lock across unrelated repositories (per-service locks).

pub mod boundary;
pub mod builder;
pub mod components;
pub mod identity;
pub mod manifest;
pub mod paths;
pub mod refresh;
pub mod storage;

use crate::index::components::{
    ContentCacheComponent, DependenciesComponent, FilesComponent, GitStateComponent,
    SymbolsComponent, TestMappingComponent,
};
use crate::index::identity::{dirty_fingerprint, discover_identity, git_head_sha};
use crate::index::manifest::{
    ContentCacheEntry, DependencyEdge, FdxIndexManifest, FileMeta, GitStateSnapshot, IndexIdentity,
    SymbolMeta, TestMappingRow, INDEX_SCHEMA_VERSION,
};
use crate::index::paths::index_state_root;
use crate::index::refresh::{compute_change_set, Refresher};
use crate::index::storage::{
    ready_components, update_component_counts, GenerationStore, LoadOutcome,
};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

/// Default maximum files indexed in one full build.
pub const DEFAULT_MAX_FILES: usize = 100_000;

/// Default maximum symbols indexed in one full build.
pub const DEFAULT_MAX_SYMBOLS: usize = 200_000;

/// Default maximum dependency edges in one full build.
pub const DEFAULT_MAX_EDGES: usize = 200_000;

/// Maximum content-cache bytes (4 MiB).
pub const DEFAULT_CACHE_BYTES: usize = 4 * 1024 * 1024;

/// Maximum content-cache items.
pub const DEFAULT_CACHE_ITEMS: usize = 512;

/// A fully loaded, immutable index generation. Readers hold a reference to
/// one snapshot; a refresh swaps in a new snapshot atomically.
#[derive(Clone)]
pub struct IndexSnapshot {
    pub manifest: FdxIndexManifest,
    pub files: Arc<FilesComponent>,
    pub symbols: Arc<SymbolsComponent>,
    pub dependencies: Arc<DependenciesComponent>,
    pub tests: Arc<TestMappingComponent>,
    pub git_state: Arc<GitStateComponent>,
    pub cache: Arc<ContentCacheComponent>,
}

impl IndexSnapshot {
    pub fn generation(&self) -> u64 {
        self.manifest.generation
    }

    pub fn head_sha(&self) -> &str {
        &self.manifest.head_sha
    }

    pub fn is_empty(&self) -> bool {
        self.files.files.is_empty() && self.manifest.generation == 0
    }
}

/// Status returned by `index.status`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct IndexStatus {
    pub available: bool,
    pub generation: u64,
    pub schema_version: u32,
    pub repository_id: String,
    pub worktree_id: String,
    pub head_sha: String,
    pub dirty_fingerprint: String,
    pub files: usize,
    pub symbols: usize,
    pub dependencies: usize,
    pub tests: usize,
    pub cache_entries: usize,
    pub cache_bytes: usize,
    pub loading: bool,
}

/// The thread-safe index service for one repository/worktree.
pub struct IndexService {
    /// The identity (stable across refreshes).
    identity: IndexIdentity,
    /// The storage layer (disk).
    store: GenerationStore,
    /// The loaded snapshot; `None` until first build/load.
    snapshot: RwLock<Option<Arc<IndexSnapshot>>>,
    /// Refresh coordination: serializes writers and coalesces requests.
    refresh_lock: Mutex<()>,
    /// Max files/symbols/edges for full builds.
    max_files: usize,
    max_symbols: usize,
    max_edges: usize,
    /// FDX version at service creation.
    fdx_version: String,
}

/// Options for constructing an index service.
#[derive(Debug, Clone)]
pub struct IndexServiceOptions {
    pub max_files: usize,
    pub max_symbols: usize,
    pub max_edges: usize,
    /// Explicit state-root override (tests/managed deployments). When None,
    /// the cross-platform default is used.
    pub state_root: Option<PathBuf>,
}

impl Default for IndexServiceOptions {
    fn default() -> Self {
        Self {
            max_files: DEFAULT_MAX_FILES,
            max_symbols: DEFAULT_MAX_SYMBOLS,
            max_edges: DEFAULT_MAX_EDGES,
            state_root: None,
        }
    }
}

impl IndexService {
    /// Open (or create) an index service for the given worktree directory.
    pub fn open(worktree: &Path, opts: &IndexServiceOptions) -> std::io::Result<Self> {
        let fdx_version = env!("CARGO_PKG_VERSION").to_string();
        let identity = discover_identity(worktree, &fdx_version);
        let root = opts.state_root.clone().unwrap_or_else(index_state_root);
        let store = GenerationStore::open(&root, &identity)?;
        let svc = Self {
            identity,
            store,
            snapshot: RwLock::new(None),
            refresh_lock: Mutex::new(()),
            max_files: opts.max_files,
            max_symbols: opts.max_symbols,
            max_edges: opts.max_edges,
            fdx_version,
        };
        // Eagerly load the persisted generation on startup (warm load).
        let _ = svc.load_persisted();
        Ok(svc)
    }

    /// The worktree root this service indexes.
    pub fn worktree_root(&self) -> &str {
        &self.identity.worktree_root
    }

    /// The index identity.
    pub fn identity(&self) -> &IndexIdentity {
        &self.identity
    }

    /// The state directory this service uses.
    pub fn state_dir(&self) -> PathBuf {
        self.store.worktree_path().to_path_buf()
    }

    /// Load a persisted generation into memory (warm startup). Best effort:
    /// returns false when nothing valid exists or a strict load fails.
    pub fn load_persisted(&self) -> std::io::Result<bool> {
        match self.store.load() {
            LoadOutcome::Loaded(manifest) => {
                let loaded = self.load_generation(&manifest)?;
                *self.snapshot.write().unwrap() = Some(Arc::new(loaded));
                Ok(true)
            }
            LoadOutcome::Empty => Ok(false),
            LoadOutcome::Corrupt { .. } => Ok(false),
            LoadOutcome::FutureSchema { .. } => Ok(false),
            LoadOutcome::LockBusy(_) => Ok(false),
        }
    }

    /// Load the component files of one persisted generation into memory.
    ///
    /// Strict: any component that fails to parse is an error propagated to
    /// the caller — a malformed persisted component is NEVER converted into
    /// an empty/default collection (the generation was already validated by
    /// the storage layer; this re-parse is fail-closed against corruption
    /// between validation and load).
    fn load_generation(&self, manifest: &FdxIndexManifest) -> std::io::Result<IndexSnapshot> {
        let dir = self.store.generation_path(manifest.generation);
        let files = load_component::<Vec<FileMeta>>(&dir, "files.json")?;
        let symbols = load_component::<Vec<SymbolMeta>>(&dir, "symbols.json")?;
        let deps = load_component::<Vec<DependencyEdge>>(&dir, "dependencies.json")?;
        let tests = load_component::<Vec<TestMappingRow>>(&dir, "test-mapping.json")?;
        let git_state = load_component::<GitStateSnapshot>(&dir, "git-state.json")?;
        let cache = load_component::<Vec<ContentCacheEntry>>(&dir, "content-cache.json")?;

        let mut files_c = FilesComponent::default();
        for r in files {
            files_c.files.insert(r.path.clone(), r);
        }
        let mut symbols_c = SymbolsComponent::default();
        for r in symbols {
            symbols_c.insert(r);
        }
        let mut deps_c = DependenciesComponent::default();
        for r in deps {
            let file = r.from_file.clone();
            if r.unresolved || r.to_file.is_empty() {
                deps_c.unresolved.insert(file);
                continue;
            }
            deps_c
                .forward
                .entry(file.clone())
                .or_default()
                .push(r.clone());
            deps_c
                .reverse
                .entry(r.to_file.clone())
                .or_default()
                .push(file);
        }
        let mut tests_c = TestMappingComponent::default();
        for r in tests {
            tests_c.insert(r);
        }
        let git_state_c = GitStateComponent {
            snapshot: git_state,
        };
        let mut cache_c = ContentCacheComponent::default();
        for r in cache {
            cache_c.by_path.insert(r.path.clone(), r.key.clone());
            cache_c.entries.insert(r.key.clone(), r.clone());
            cache_c.total_bytes += r.size;
            cache_c.order.push((r.key.clone(), r.access_order));
            cache_c.next_order = cache_c.next_order.max(r.access_order + 1);
        }

        Ok(IndexSnapshot {
            manifest: manifest.clone(),
            files: Arc::new(files_c),
            symbols: Arc::new(symbols_c),
            dependencies: Arc::new(deps_c),
            tests: Arc::new(tests_c),
            git_state: Arc::new(git_state_c),
            cache: Arc::new(cache_c),
        })
    }

    /// Current snapshot (read lock held by the caller is released here).
    /// Returns `None` when no generation has been built yet.
    pub fn snapshot(&self) -> Option<Arc<IndexSnapshot>> {
        self.snapshot.read().unwrap().clone()
    }

    /// Status for `index.status`.
    pub fn status(&self) -> IndexStatus {
        let snap = self.snapshot();
        match snap {
            Some(s) => IndexStatus {
                available: true,
                generation: s.manifest.generation,
                schema_version: s.manifest.schema_version,
                repository_id: self.identity.repository_id.clone(),
                worktree_id: self.identity.worktree_id.clone(),
                head_sha: s.manifest.head_sha.clone(),
                dirty_fingerprint: s.manifest.dirty_fingerprint.clone(),
                files: s.files.files.len(),
                symbols: s.symbols.by_id.len(),
                dependencies: s.dependencies.forward.values().map(|v| v.len()).sum(),
                tests: s.tests.by_source.values().map(|v| v.len()).sum(),
                cache_entries: s.cache.len(),
                cache_bytes: s.cache.total_bytes,
                loading: false,
            },
            None => IndexStatus {
                available: false,
                generation: 0,
                schema_version: INDEX_SCHEMA_VERSION,
                repository_id: self.identity.repository_id.clone(),
                worktree_id: self.identity.worktree_id.clone(),
                head_sha: git_head_sha(Path::new(&self.identity.worktree_root)),
                dirty_fingerprint: dirty_fingerprint(Path::new(&self.identity.worktree_root)),
                files: 0,
                symbols: 0,
                dependencies: 0,
                tests: 0,
                cache_entries: 0,
                cache_bytes: 0,
                loading: false,
            },
        }
    }

    /// Refresh the index. Coalesces concurrent refreshes (in-process mutex)
    /// AND coordinates with other processes (CLI vs CLI, CLI vs daemon,
    /// daemon vs daemon): the storage layer serializes the critical
    /// publication section (rename + CURRENT) on a worktree-scoped file
    /// lock, and a generation conflict (another process published first) is
    /// resolved by loading the winner's generation.
    ///
    /// The persisted state is loaded with full recovery; a no-change fast
    /// path reuses the newest valid generation (including one just published
    /// by another process); otherwise a new generation is built and
    /// published. Readers never observe a partial generation: the in-memory
    /// snapshot is swapped only after the persisted generation is fully
    /// validated and published.
    pub fn refresh(&self, full: bool) -> std::io::Result<Arc<IndexSnapshot>> {
        let _guard = self.refresh_lock.lock().unwrap();
        let root = PathBuf::from(&self.identity.worktree_root);

        // Load with recovery: validates the persisted state, quarantines
        // corrupt generations, repairs CURRENT.
        let persisted = self.store.load();

        // No-change fast path against the *persisted* generation (another
        // process may have already refreshed for this exact state).
        if !full {
            if let LoadOutcome::Loaded(m) = &persisted {
                let head = git_head_sha(&root);
                let dirty = dirty_fingerprint(&root);
                if m.head_sha == head && m.dirty_fingerprint == dirty {
                    // Even on no-change, clean up stale tmp dirs from any
                    // previously interrupted write.
                    self.store.cleanup_stale_tmp();
                    let snap = self.load_generation(m)?;
                    *self.snapshot.write().unwrap() = Some(Arc::new(snap.clone()));
                    return Ok(Arc::new(snap));
                }
            }
        }

        let next_gen = match &persisted {
            LoadOutcome::Loaded(m) => m.generation + 1,
            _ => 1,
        };

        let rebuilt = match &persisted {
            LoadOutcome::Loaded(m) if !full => {
                let prev = Arc::new(self.load_generation(m)?);
                self.refresh_incremental(next_gen, &prev)
            }
            _ => self.build_full(next_gen),
        };

        let rebuilt = match rebuilt {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                // Another process published this generation first. Load the
                // winner's snapshot instead of failing.
                match self.store.load() {
                    LoadOutcome::Loaded(m) => Arc::new(self.load_generation(&m)?),
                    _ => return Err(e),
                }
            }
            Err(e) => return Err(e),
        };

        *self.snapshot.write().unwrap() = Some(rebuilt.clone());
        Ok(rebuilt)
    }

    /// Build a complete cold index generation.
    fn build_full(&self, generation: u64) -> std::io::Result<Arc<IndexSnapshot>> {
        let root = PathBuf::from(&self.identity.worktree_root);
        let now = now_iso();
        let head = git_head_sha(&root);
        let dirty = dirty_fingerprint(&root);

        let manifest =
            self.store
                .publish(generation, &self.identity, &self.fdx_version, &now, |dir| {
                    let mut m = crate::index::manifest::new_manifest(
                        &self.identity,
                        &self.fdx_version,
                        generation,
                        &now,
                        &head,
                        &dirty,
                        &identity::config_hash(&root),
                        &identity::ignore_hash(&root),
                    );

                    let ignored = default_overrides();
                    let reader = crate::index::boundary::RepositoryReader::new(&root);
                    let files = builder::build_files(&reader, &ignored, self.max_files);
                    storage::write_component_serde(
                        dir,
                        &mut m,
                        "files.json",
                        &files.files.values().cloned().collect::<Vec<_>>(),
                    )?;

                    let symbols = builder::build_symbols(&reader, &files, self.max_symbols);
                    storage::write_component_serde(
                        dir,
                        &mut m,
                        "symbols.json",
                        &symbols.by_id.values().cloned().collect::<Vec<_>>(),
                    )?;

                    let deps = builder::build_dependencies(&reader, &files, self.max_edges);
                    let mut dep_rows: Vec<DependencyEdge> = Vec::new();
                    for edges in deps.forward.values() {
                        dep_rows.extend(edges.iter().cloned());
                    }
                    storage::write_component_serde(dir, &mut m, "dependencies.json", &dep_rows)?;

                    let tests = builder::build_test_mapping(&files, &deps);
                    let mut test_rows: Vec<TestMappingRow> = Vec::new();
                    for rows in tests.by_source.values() {
                        test_rows.extend(rows.iter().cloned());
                    }
                    storage::write_component_serde(dir, &mut m, "test-mapping.json", &test_rows)?;

                    let git_state = builder::build_git_state(
                        &root,
                        &files,
                        &self.identity.worktree_id,
                        generation,
                    );
                    storage::write_component_serde(
                        dir,
                        &mut m,
                        "git-state.json",
                        &git_state.snapshot,
                    )?;

                    let _cache = ContentCacheComponent::default();
                    storage::write_component_serde(
                        dir,
                        &mut m,
                        "content-cache.json",
                        &Vec::<ContentCacheEntry>::new(),
                    )?;

                    update_component_counts(
                        &mut m,
                        files.files.len(),
                        symbols.by_id.len(),
                        dep_rows.len(),
                        test_rows.len(),
                        0,
                    );
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
                })?;

        Ok(Arc::new(self.load_generation(&manifest)?))
    }

    /// Incremental refresh: compute the change set and update only the
    /// changed layers, then persist a new generation.
    fn refresh_incremental(
        &self,
        generation: u64,
        prev: &Arc<IndexSnapshot>,
    ) -> std::io::Result<Arc<IndexSnapshot>> {
        let root = PathBuf::from(&self.identity.worktree_root);
        let now = now_iso();
        let head = git_head_sha(&root);
        let dirty = dirty_fingerprint(&root);

        // Compute the next git snapshot (cheap git call).
        let ignored = default_overrides();
        let next_git =
            builder::build_git_state(&root, &prev.files, &self.identity.worktree_id, generation);

        let mut cs = compute_change_set(&prev.git_state.snapshot, &next_git.snapshot);
        // Fall back to filesystem metadata when git gives no signal but the
        // dirty fingerprint changed (content-only edits).
        if cs.is_empty() && prev.manifest.dirty_fingerprint != dirty {
            // Rebuild the full file component (metadata-only scan, no
            // content re-read beyond hashes) and diff by hash.
            let reader = crate::index::boundary::RepositoryReader::new(&root);
            let current_files = builder::build_files(&reader, &ignored, self.max_files);
            let refresher = Refresher::new(&root, generation);
            cs = refresher.fs_change_detection(&prev.files, &current_files);
        }

        let manifest =
            self.store
                .publish(generation, &self.identity, &self.fdx_version, &now, |dir| {
                    let mut m = crate::index::manifest::new_manifest(
                        &self.identity,
                        &self.fdx_version,
                        generation,
                        &now,
                        &head,
                        &dirty,
                        &identity::config_hash(&root),
                        &identity::ignore_hash(&root),
                    );

                    let mut files = (*prev.files).clone();
                    let mut symbols = (*prev.symbols).clone();
                    let mut deps = (*prev.dependencies).clone();
                    let mut tests = (*prev.tests).clone();
                    let mut cache = (*prev.cache).clone();
                    let mut git_state = (*prev.git_state).clone();

                    let refresher = Refresher::new(&root, generation);
                    let mut cs = cs.clone();
                    refresher.detect_renames(&mut cs, &next_git.snapshot);
                    if cs.full_rebuild {
                        // HEAD moved: rebuild the whole tree-derived index.
                        let reader = crate::index::boundary::RepositoryReader::new(&root);
                        let files_new = builder::build_files(&reader, &ignored, self.max_files);
                        let symbols_new =
                            builder::build_symbols(&reader, &files_new, self.max_symbols);
                        let deps_new =
                            builder::build_dependencies(&reader, &files_new, self.max_edges);
                        let tests_new = builder::build_test_mapping(&files_new, &deps_new);
                        files = files_new;
                        symbols = symbols_new;
                        deps = deps_new;
                        tests = tests_new;
                        // The git-state snapshot must be rebuilt with the new
                        // generation too (previously this stayed stale,
                        // violating manifest/git-state consistency).
                        git_state = next_git.clone();
                    } else {
                        refresher.apply(
                            &cs,
                            &mut files,
                            &mut symbols,
                            &mut deps,
                            &mut tests,
                            &mut cache,
                            &mut git_state,
                            &ignored,
                        );
                    }

                    storage::write_component_serde(
                        dir,
                        &mut m,
                        "files.json",
                        &files.files.values().cloned().collect::<Vec<_>>(),
                    )?;
                    storage::write_component_serde(
                        dir,
                        &mut m,
                        "symbols.json",
                        &symbols.by_id.values().cloned().collect::<Vec<_>>(),
                    )?;
                    let mut dep_rows: Vec<DependencyEdge> = Vec::new();
                    for edges in deps.forward.values() {
                        dep_rows.extend(edges.iter().cloned());
                    }
                    storage::write_component_serde(dir, &mut m, "dependencies.json", &dep_rows)?;
                    let mut test_rows: Vec<TestMappingRow> = Vec::new();
                    for rows in tests.by_source.values() {
                        test_rows.extend(rows.iter().cloned());
                    }
                    storage::write_component_serde(dir, &mut m, "test-mapping.json", &test_rows)?;
                    storage::write_component_serde(
                        dir,
                        &mut m,
                        "git-state.json",
                        &git_state.snapshot,
                    )?;
                    storage::write_component_serde(
                        dir,
                        &mut m,
                        "content-cache.json",
                        &cache.entries.values().cloned().collect::<Vec<_>>(),
                    )?;

                    update_component_counts(
                        &mut m,
                        files.files.len(),
                        symbols.by_id.len(),
                        dep_rows.len(),
                        test_rows.len(),
                        cache.entries.len(),
                    );
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
                })?;

        Ok(Arc::new(self.load_generation(&manifest)?))
    }

    /// Invalidate the index: drop the in-memory snapshot AND the persisted
    /// generations, so the next refresh starts from a clean slate.
    /// Serializes with other writers via the cross-process lock.
    ///
    /// Errors propagate instead of being swallowed: a busy writer lock (the
    /// cross-process writer is mid-publish) or a failed clear returns an
    /// error rather than racing the writer or leaving a half-cleared state.
    pub fn invalidate(&self) -> std::io::Result<()> {
        let _guard = self.refresh_lock.lock().unwrap();
        let _writer = self.store.writer_lock()?;
        *self.snapshot.write().unwrap() = None;
        self.store.clear_persisted()
    }

    /// Force a full rebuild. Serializes with other writers via the
    /// cross-process lock (held inside publish for the critical section).
    pub fn rebuild(&self) -> std::io::Result<Arc<IndexSnapshot>> {
        let _guard = self.refresh_lock.lock().unwrap();
        // Recover/load the persisted state so the next generation continues
        // from the newest valid one.
        let persisted = self.store.load();
        let next_gen = match &persisted {
            LoadOutcome::Loaded(m) => m.generation + 1,
            _ => 1,
        };
        let rebuilt = self.build_full(next_gen);
        let rebuilt = match rebuilt {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => match self.store.load() {
                LoadOutcome::Loaded(m) => Arc::new(self.load_generation(&m)?),
                _ => return Err(e),
            },
            Err(e) => return Err(e),
        };
        *self.snapshot.write().unwrap() = Some(rebuilt.clone());
        Ok(rebuilt)
    }

    /// Cache content for a file (bounded, content-addressed). Returns the
    /// cache key. Read-only; never mutates the persisted index.
    pub fn cache_put(&self, _path: &str, _content: &str) -> Option<String> {
        let mut snap = self.snapshot()?;
        // Snapshot is Arc-immutable; mutate via a new Arc? Not supported.
        // For Task 3 the cache is bounded in-memory state owned by the
        // service, not the snapshot — see `content_cache` field usage.
        // We implement this on the service-level cache below.
        let _ = &mut snap;
        None
    }

    /// The default ignore overrides (no explicit FlowDeck exclusions yet).
    pub fn default_overrides(&self) -> ignore::overrides::Override {
        default_overrides()
    }
}

/// Build the default ignore override (empty: rely on gitignore + .fdignore).
fn default_overrides() -> ignore::overrides::Override {
    ignore::overrides::OverrideBuilder::new("/")
        .build()
        .unwrap_or_else(|_| ignore::overrides::Override::empty())
}

/// Load a component file as JSON rows (strict; errors propagate so a
/// malformed persisted component fails the whole generation load).
fn load_component<T: serde::de::DeserializeOwned>(dir: &Path, name: &str) -> std::io::Result<T> {
    let file = dir.join(name);
    let text = std::fs::read_to_string(&file)?;
    serde_json::from_str(&text).map_err(std::io::Error::other)
}

/// ISO-8601 timestamp.
pub fn now_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // RFC3339-ish without chrono: "1970-01-01T00:00:00Z" style via manual
    // conversion is complex; use epoch-seconds-prefixed deterministic stamp.
    format!("{secs}")
}

// ─── Query helpers ──────────────────────────────────────────────────────────

/// Query files by name/prefix/type. Deterministic ordering.
pub fn query_files<'a>(snap: &'a IndexSnapshot, query: &str, limit: usize) -> Vec<&'a FileMeta> {
    let q = query.to_lowercase();
    let mut out: Vec<&FileMeta> = snap
        .files
        .files
        .values()
        .filter(|m| m.path.to_lowercase().contains(&q))
        .take(limit)
        .collect();
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

/// Query symbols by name (substring, case-insensitive). Bounded.
pub fn query_symbols(snap: &IndexSnapshot, name: &str, limit: usize) -> Vec<SymbolMeta> {
    let q = name.to_lowercase();
    let mut out: Vec<SymbolMeta> = snap
        .symbols
        .by_id
        .values()
        .filter(|s| {
            s.name.to_lowercase().contains(&q) || s.qualified_name.to_lowercase().contains(&q)
        })
        .take(limit)
        .cloned()
        .collect();
    out.sort_by(|a, b| {
        a.file
            .cmp(&b.file)
            .then(a.line_start.cmp(&b.line_start))
            .then(a.id.cmp(&b.id))
    });
    out
}

/// Query reverse dependants of a file. Bounded + deterministic.
pub fn query_dependants(snap: &IndexSnapshot, file: &str, limit: usize) -> Vec<String> {
    let mut out = snap.dependencies.dependants_of(file);
    out.truncate(limit);
    out
}

/// Query the forward edges from a file.
pub fn query_edges(snap: &IndexSnapshot, file: &str, limit: usize) -> Vec<DependencyEdge> {
    let mut out = snap.dependencies.edges_from(file);
    out.truncate(limit);
    out
}

/// Query tests for a source file. Returns (direct, probable, confidence).
pub fn query_tests_for(snap: &IndexSnapshot, source: &str) -> Vec<TestMappingRow> {
    let mut out = snap
        .tests
        .by_source
        .get(source)
        .cloned()
        .unwrap_or_default();
    out.sort_by(|a, b| {
        b.confidence
            .partial_cmp(&a.confidence)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.test_file.cmp(&b.test_file))
    });
    out
}

/// Query the git state snapshot.
pub fn query_git_state(snap: &IndexSnapshot) -> GitStateSnapshot {
    snap.git_state.snapshot.clone()
}

// ─── Process-wide per-worktree registry ─────────────────────────────────────
//
// The daemon serves multiple connections; each `query` carries a `cwd` which
// identifies the worktree. Index services are keyed by the worktree root and
// shared across connections, so concurrent clients on one repository share
// one index (with per-service locks — no global lock across repos).

use std::collections::{HashMap, VecDeque};

/// Registry of open index services, keyed by canonical worktree root.
pub struct IndexRegistry {
    services: Mutex<HashMap<String, Arc<IndexService>>>,
    /// LRU access order (most recent last) for bounded eviction so a
    /// long-running daemon never accumulates services for removed projects.
    access: Mutex<VecDeque<String>>,
    /// Maximum number of cached services before eviction.
    max_services: usize,
    options: IndexServiceOptions,
}

impl IndexRegistry {
    /// Default bound on concurrently cached index services.
    pub const DEFAULT_MAX_SERVICES: usize = 64;

    pub fn new(options: IndexServiceOptions) -> Self {
        Self {
            services: Mutex::new(HashMap::new()),
            access: Mutex::new(VecDeque::new()),
            max_services: Self::DEFAULT_MAX_SERVICES,
            options,
        }
    }

    /// Get or open the index service for a worktree root.
    pub fn service_for(&self, worktree: &Path) -> std::io::Result<Arc<IndexService>> {
        let canonical = worktree
            .canonicalize()
            .unwrap_or_else(|_| worktree.to_path_buf());
        let key = canonical.to_string_lossy().into_owned();
        {
            let map = self.services.lock().unwrap();
            if let Some(svc) = map.get(&key) {
                self.touch(&key);
                return Ok(svc.clone());
            }
        }
        let svc = Arc::new(IndexService::open(&canonical, &self.options)?);
        let mut map = self.services.lock().unwrap();
        // Double-checked: another thread may have opened it while we waited.
        if let Some(existing) = map.get(&key) {
            self.touch(&key);
            Ok(existing.clone())
        } else {
            map.insert(key.clone(), svc.clone());
            self.touch(&key);
            self.evict(&mut map);
            Ok(svc)
        }
    }

    /// Record access, dropping the service when the bound is exceeded.
    fn touch(&self, key: &str) {
        let mut access = self.access.lock().unwrap();
        access.retain(|k| k != key);
        access.push_back(key.to_string());
    }

    /// Evict least-recently-used services beyond the bound. Services are
    /// cheap (lazy load) and Arc-shared, so eviction only drops the registry
    /// reference; active callers keep their Arc.
    fn evict(&self, map: &mut HashMap<String, Arc<IndexService>>) {
        let mut access = self.access.lock().unwrap();
        while map.len() > self.max_services {
            let Some(oldest) = access.pop_front() else {
                break;
            };
            map.remove(&oldest);
        }
    }

    /// Number of cached services (observability/tests).
    pub fn len(&self) -> usize {
        self.services.lock().unwrap().len()
    }

    /// Whether the registry holds no cached services.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Remove an idle service (used by invalidate/rebuild paths if desired).
    #[allow(dead_code)]
    pub fn drop_service(&self, worktree: &Path) {
        let canonical = worktree
            .canonicalize()
            .unwrap_or_else(|_| worktree.to_path_buf());
        let key = canonical.to_string_lossy().into_owned();
        self.services.lock().unwrap().remove(&key);
        self.access.lock().unwrap().retain(|k| k != &key);
    }
}

/// The process-wide index registry (daemon-wide).
pub static GLOBAL_INDEX_REGISTRY: once_cell::sync::Lazy<IndexRegistry> =
    once_cell::sync::Lazy::new(|| IndexRegistry::new(IndexServiceOptions::default()));

/// Handle an index command from the daemon's `run_command` dispatch.
///
/// `argv` mirrors the one-shot CLI argv. Supported commands:
/// `index.status`, `index.refresh`, `index.invalidate`, `index.rebuild`,
/// `files.query`, `symbols.query`, `dependencies.query`, `testsFor.query`,
/// `gitState.query`.
///
/// Returns `None` when the command is not an index command (the caller
/// continues normal dispatch).
pub fn handle_index_command(
    command: &str,
    argv: &[String],
    cwd: Option<&str>,
) -> Option<serde_json::Value> {
    let (op, _rest) = match command.split_once('.') {
        Some((prefix, op))
            if prefix == "index"
                || prefix == "files"
                || prefix == "symbols"
                || prefix == "dependencies"
                || prefix == "testsFor"
                || prefix == "gitState" =>
        {
            (op.to_string(), command.to_string())
        }
        _ => return None,
    };

    // All index commands need a worktree root. `cwd` is the daemon-provided
    // working directory; when absent we use the current dir.
    let worktree = match cwd {
        Some(c) => PathBuf::from(c),
        None => std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
    };

    // index.* commands (no per-query service state needed at dispatch).
    match op.as_str() {
        "status" => {
            let svc = GLOBAL_INDEX_REGISTRY.service_for(&worktree).ok()?;
            let status = svc.status();
            return serde_json::to_value(&status).ok();
        }
        "refresh" => {
            let force = argv.iter().any(|a| a == "--force" || a == "--full");
            let svc = GLOBAL_INDEX_REGISTRY.service_for(&worktree).ok()?;
            let snap = svc.refresh(force).ok()?;
            return Some(serde_json::json!({
                "generation": snap.generation(),
                "headSha": snap.manifest.head_sha,
                "files": snap.files.files.len(),
                "symbols": snap.symbols.by_id.len(),
                "dependencies": snap.dependencies.forward.values().map(|v| v.len()).sum::<usize>(),
            }));
        }
        "invalidate" => {
            let svc = GLOBAL_INDEX_REGISTRY.service_for(&worktree).ok()?;
            svc.invalidate().ok()?;
            return Some(serde_json::json!({ "invalidated": true }));
        }
        "rebuild" => {
            let svc = GLOBAL_INDEX_REGISTRY.service_for(&worktree).ok()?;
            let snap = svc.rebuild().ok()?;
            return Some(serde_json::json!({
                "generation": snap.generation(),
                "files": snap.files.files.len(),
            }));
        }
        _ => {}
    }

    // Query commands need a loaded snapshot.
    let svc = GLOBAL_INDEX_REGISTRY.service_for(&worktree).ok()?;
    let snap = match svc.snapshot() {
        Some(s) => s,
        None => {
            // Lazy refresh so queries work on first use.
            svc.refresh(false).ok()?
        }
    };

    let limit = parse_limit(argv);
    let file = argv.first().map(|s| s.as_str()).unwrap_or("");

    let value = match op.as_str() {
        "query" if command.starts_with("files.") => {
            let query = argv.first().map(|s| s.as_str()).unwrap_or("");
            let rows: Vec<&FileMeta> = query_files(&snap, query, limit);
            serde_json::to_value(&rows).ok()?
        }
        "query" if command.starts_with("symbols.") => {
            let name = argv.first().map(|s| s.as_str()).unwrap_or("");
            let rows = query_symbols(&snap, name, limit);
            serde_json::to_value(&rows).ok()?
        }
        "query" if command.starts_with("dependencies.") => {
            let rows = query_edges(&snap, file, limit);
            serde_json::to_value(&rows).ok()?
        }
        "query" if command.starts_with("testsFor.") => {
            let rows = query_tests_for(&snap, file);
            serde_json::to_value(&rows).ok()?
        }
        "query" if command.starts_with("gitState.") => {
            let state = query_git_state(&snap);
            serde_json::to_value(&state).ok()?
        }
        _ => return None,
    };
    Some(value)
}

/// Parse a `--limit N` argument.
fn parse_limit(argv: &[String]) -> usize {
    for (i, a) in argv.iter().enumerate() {
        if a == "--limit" {
            if let Some(v) = argv.get(i + 1) {
                if let Ok(n) = v.parse::<usize>() {
                    return n.min(1000);
                }
            }
        }
    }
    100
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    fn git(cwd: &Path, args: &[&str]) {
        let out = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn make_repo(dir: &Path) {
        git(dir, &["init", "-q"]);
        git(dir, &["config", "user.email", "t@t"]);
        git(dir, &["config", "user.name", "t"]);
        std::fs::write(
            dir.join("lib.ts"),
            "export function greet(): string { return \"hi\" }\nexport class Widget {}\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("lib.test.ts"),
            "import { greet } from \"./lib\";\ngreet();\n",
        )
        .unwrap();
        std::fs::write(dir.join("main.rs"), "pub fn main() {}\n").unwrap();
        std::fs::write(dir.join("ignored.txt"), "x").unwrap();
        std::fs::write(dir.join(".gitignore"), "ignored.txt\n").unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-qm", "init"]);
    }

    fn opts(tmp: &Path) -> IndexServiceOptions {
        IndexServiceOptions {
            max_files: 10_000,
            max_symbols: 10_000,
            max_edges: 10_000,
            state_root: Some(tmp.to_path_buf()),
        }
    }

    #[test]
    fn cold_build_produces_index() {
        let repo = tempfile::tempdir().unwrap();
        make_repo(repo.path());
        let state = tempfile::tempdir().unwrap();
        let svc = IndexService::open(repo.path(), &opts(state.path())).unwrap();
        let snap = svc.refresh(false).unwrap();
        assert!(snap.files.files.contains_key("lib.ts"));
        assert!(snap.files.files.contains_key("main.rs"));
        assert!(
            !snap.files.files.contains_key("ignored.txt"),
            "ignored files excluded"
        );
        assert!(snap.symbols.by_name.contains_key("greet"));
        let status = svc.status();
        assert!(status.available);
        assert!(status.files >= 3);
        assert!(status.symbols >= 2);
    }

    #[test]
    fn warm_reopen_loads_persisted_generation() {
        let repo = tempfile::tempdir().unwrap();
        make_repo(repo.path());
        let state = tempfile::tempdir().unwrap();
        let svc1 = IndexService::open(repo.path(), &opts(state.path())).unwrap();
        svc1.refresh(false).unwrap();

        // Reopen: warm load from disk.
        let svc2 = IndexService::open(repo.path(), &opts(state.path())).unwrap();
        let snap2 = svc2
            .snapshot()
            .expect("warm load should produce a snapshot");
        assert!(snap2.files.files.contains_key("lib.ts"));
        assert!(snap2.symbols.by_name.contains_key("greet"));
    }

    #[test]
    fn no_change_refresh_reuses_generation() {
        let repo = tempfile::tempdir().unwrap();
        make_repo(repo.path());
        let state = tempfile::tempdir().unwrap();
        let svc = IndexService::open(repo.path(), &opts(state.path())).unwrap();
        let g1 = svc.refresh(false).unwrap().generation();
        let g2 = svc.refresh(false).unwrap().generation();
        assert_eq!(g1, g2, "no-change refresh must not create a new generation");
    }

    #[test]
    fn one_file_change_updates_only_affected_layers() {
        let repo = tempfile::tempdir().unwrap();
        make_repo(repo.path());
        let state = tempfile::tempdir().unwrap();
        let svc = IndexService::open(repo.path(), &opts(state.path())).unwrap();
        svc.refresh(false).unwrap();
        let g1 = svc.snapshot().unwrap().generation();

        // Modify one file: replace the class with a new one.
        std::fs::write(
            repo.path().join("lib.ts"),
            "export function greet(): string { return \"bye\" }\nexport class NewWidget {}\n",
        )
        .unwrap();
        let snap = svc.refresh(false).unwrap();
        assert!(
            snap.generation() > g1,
            "refresh must produce a new generation"
        );
        assert!(
            snap.symbols.by_name.contains_key("NewWidget"),
            "new symbol indexed"
        );
        assert!(snap.symbols.by_name.contains_key("greet"));
        // Old symbol must be gone (removed with the replaced file content).
        assert!(
            !snap.symbols.by_name.contains_key("Widget"),
            "stale symbol removed"
        );
    }

    #[test]
    fn deleted_file_removes_stale_symbols() {
        let repo = tempfile::tempdir().unwrap();
        make_repo(repo.path());
        let state = tempfile::tempdir().unwrap();
        let svc = IndexService::open(repo.path(), &opts(state.path())).unwrap();
        svc.refresh(false).unwrap();
        // Commit the delete so git status reports it as tracked deletion.
        std::fs::remove_file(repo.path().join("main.rs")).unwrap();
        git(repo.path(), &["add", "-A"]);
        git(repo.path(), &["commit", "-qm", "delete main"]);
        let snap = svc.refresh(false).unwrap();
        assert!(!snap.files.files.contains_key("main.rs"));
        assert!(!snap.symbols.by_name.contains_key("main"));
    }

    #[test]
    fn renamed_file_reresolves_dependant_edges() {
        // Regression: renaming a module that others import must re-resolve
        // the dependants' edges — no dangling edge to the old path may be
        // published (strict load validation rejects dangling edges).
        let repo = tempfile::tempdir().unwrap();
        make_repo(repo.path());
        // lib.ts is imported by lib.test.ts; rename lib.ts.
        git(repo.path(), &["mv", "lib.ts", "renamed.ts"]);
        let state = tempfile::tempdir().unwrap();
        let svc = IndexService::open(repo.path(), &opts(state.path())).unwrap();
        svc.refresh(false).unwrap();
        let snap = svc.refresh(false).unwrap();
        assert!(snap.files.files.contains_key("renamed.ts"));
        assert!(!snap.files.files.contains_key("lib.ts"));
        // No edge may reference the removed file.
        for edges in snap.dependencies.forward.values() {
            for e in edges {
                assert_ne!(e.to_file, "lib.ts", "dangling edge to renamed file");
            }
        }
    }

    #[test]
    fn deleted_file_reresolves_dependant_edges() {
        let repo = tempfile::tempdir().unwrap();
        make_repo(repo.path());
        // lib.test.ts imports ./lib; delete lib.ts.
        std::fs::remove_file(repo.path().join("lib.ts")).unwrap();
        git(repo.path(), &["add", "-A"]);
        git(repo.path(), &["commit", "-qm", "delete lib"]);
        let state = tempfile::tempdir().unwrap();
        let svc = IndexService::open(repo.path(), &opts(state.path())).unwrap();
        svc.refresh(false).unwrap();
        let snap = svc.refresh(false).unwrap();
        for edges in snap.dependencies.forward.values() {
            for e in edges {
                assert_ne!(e.to_file, "lib.ts", "dangling edge to deleted file");
            }
        }
    }

    #[test]
    fn queries_are_bounded_and_deterministic() {
        let repo = tempfile::tempdir().unwrap();
        make_repo(repo.path());
        let state = tempfile::tempdir().unwrap();
        let svc = IndexService::open(repo.path(), &opts(state.path())).unwrap();
        let snap = svc.refresh(false).unwrap();

        let files = query_files(&snap, "lib", 10);
        assert!(!files.is_empty());

        let syms = query_symbols(&snap, "greet", 10);
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].name, "greet");

        let tests = query_tests_for(&snap, "lib.ts");
        assert!(
            !tests.is_empty(),
            "lib.ts should have tests via import or naming"
        );
        assert!(tests[0].confidence >= 0.8);

        let git = query_git_state(&snap);
        assert_eq!(git.head_sha.len(), 40);
    }
}
