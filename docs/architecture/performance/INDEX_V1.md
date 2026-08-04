# FDX Index Protocol v1 (INDEX_V1)

**Developer: Dev 3 — FDX and Tool Performance**
**Frozen FlowDeck harness: v1.0.3**
**Task 3: Persistent Warm Incremental FDX Index**

This document defines the versioned per-repository, per-worktree persistent
index served by `fdxd` and the one-shot `fdx index` CLI. It complements
`PROTOCOL_V1.md` (the daemon wire protocol) and records the compatibility,
lifecycle, concurrency, security, and performance contracts.

## Scope and non-goals

In scope:

- versioned persistent file-metadata, symbol, dependency, test-mapping,
  git-state, and recent-content-cache indexes;
- crash-safe generation storage with atomic publication;
- incremental refresh driven by git state and filesystem metadata;
- daemon methods (`index.*`, `*.query`) plus one-shot CLI equivalents;
- bounded, deterministic queries.

Task 3 deliberately does **not** deliver:

- general query-result caching (beyond the bounded recent-content cache);
- operation batching multiplexing (the daemon `batch` method is protocol
  v1 infrastructure from Task 2, unchanged);
- scheduler queues or adaptive optimization;
- Windows named-pipe transport (Task 2 protocol covers stdio + unix socket;
  named-pipe parity is out of scope);
- machine-level system service installation.

## Index manifest

Every persisted generation contains a `manifest.json`:

```jsonc
{
  "schema_version": 3,
  "fdx_version": "0.1.0",
  "repository_id": "<sha256-16>",
  "worktree_id": "<sha256-16>",
  "repository_root_hash": "<sha256-16>",
  "repository_root": "<canonical root path>",
  "worktree_root": "<canonical worktree path>",
  "head_sha": "<git HEAD, 40 hex>",
  "dirty_fingerprint": "<sha256-64 of git status --porcelain>",
  "config_hash": "<sha256-16 of FlowDeck/FDX config files>",
  "ignore_hash": "<sha256-16 of .gitignore/.ignore/.fdignore>",
  "generation": 1,
  "created_at": "ISO-8601",
  "updated_at": "ISO-8601",
  "components": {
    "files": "Ready|Unavailable|Quarantined",
    "symbols": "Ready|Unavailable|Quarantined",
    "dependencies": "Ready|Unavailable|Quarantined",
    "test_mapping": "Ready|Unavailable|Quarantined",
    "git_state": "Ready|Unavailable|Quarantined",
    "content_cache": "Ready|Unavailable|Quarantined"
  },
  "component_counts": {
    "files": 0,
    "symbols": 0,
    "dependencies": 0,
    "test_mapping": 0,
    "git_state": 1,
    "content_cache": 0
  },
  "checksums": {
    "files.json": "<sha256-hex>",
    "symbols.json": "<sha256-hex>",
    "dependencies.json": "<sha256-hex>",
    "test-mapping.json": "<sha256-hex>",
    "git-state.json": "<sha256-hex>",
    "content-cache.json": "<sha256-hex>"
  }
}
```

The manifest is written **last** in a generation directory and is the commit
point: a generation is published only when its manifest exists and all listed
component checksums verify.

## Repository and worktree identity

- `repository_id` = SHA-256 (16 hex) of the git common dir
  (`git rev-parse --git-common-dir`). Every worktree of one repository shares
  this id; different repositories never collide (256-bit hash input).
- `worktree_id` = SHA-256 (16 hex) of the canonicalized worktree root. Two
  worktrees of the same repository have distinct worktree ids.
- `repository_root_hash` = SHA-256 of the canonicalized repository root path.

Guarantees:

- Two worktrees never share mutable index state (distinct worktree dirs).
- Different users never share writable state (user-scoped state root).
- Branch changes invalidate only affected layers: a HEAD change triggers a
  tree-derived rebuild; the git-state snapshot is always refreshed.
- Dirty changes are represented independently from HEAD (dirty fingerprint +
  `git-state.json`).
- Path normalization is deterministic across platforms (forward slashes for
  relative keys; canonicalized absolute paths hashed for identity).
- Raw repository paths never appear in global file names — only short hashes.

## State directory rules

Resolution order:

1. `FDX_INDEX_DIR` (explicit override — tests, managed deployments).
2. `$XDG_CACHE_HOME/fdx/fdx-index` (Linux).
3. `~/Library/Caches/fdx/fdx-index` (macOS).
4. `%LOCALAPPDATA%\fdx\fdx-index` (Windows).
5. `~/.cache/fdx/fdx-index` (fallback).

Layout:

```text
<state-root>/fdx-index/<repositoryId>/<worktreeId>/
  CURRENT                  # atomic pointer to the active generation number
  gen-<N>/                 # one complete generation
    manifest.json
    files.json
    symbols.json
    dependencies.json
    test-mapping.json
    git-state.json
    content-cache.json
  gen-<N>.tmp              # sibling temp build dir (never visible)
  quarantine/              # corrupt generations moved here with evidence
```

Rules:

- Private permissions where supported (`0700` on the state root on unix).
- Bounded path length: every generated segment is ≤16 hex chars.
- Unicode and spaces supported (only hashes appear in generated names).
- No hardcoded `/tmp`; no repository-local generated index unless explicitly
  configured.

## Component formats

- `files.json`: `FileMeta[]` — normalized relative path, kind, size,
  modification time, content hash (SHA-256, 16 hex), language,
  executable flag, classification (source|test|generated|binary|ignored),
  generation.
- `symbols.json`: `SymbolMeta[]` — stable symbol id (SHA-256 of qualified
  name + file), name, qualified name, kind, file, line range, exported flag,
  parent id, source hash, generation.
- `dependencies.json`: `DependencyEdge[]` — from file, resolved to file,
  specifier, kind (import|require|from|use), unresolved flag, generation.
  Reverse dependants are derived on load.
- `test-mapping.json`: `TestMappingRow[]` — source file, test file, basis
  (direct_import|naming|configured|package), confidence ∈ (0,1].
  Confidence is never implied to be exact when the mapping is heuristic.
- `git-state.json`: `GitStateSnapshot` — HEAD SHA, branch/detached, changed /
  renamed / deleted / untracked files, worktree id, generation.
- `content-cache.json`: `ContentCacheEntry[]` — content-addressed key
  (SHA-256), path, size, access order, bounded content.

## Generation lifecycle

Write lifecycle (crash-safe):

1. build a new generation in a sibling `gen-N.tmp` directory;
2. write every component file, computing per-component SHA-256 checksums;
3. write `manifest.json` last;
4. verify the manifest schema and all listed checksums;
5. fsync the temp directory;
6. atomically rename `gen-N.tmp` → `gen-N`;
7. atomically write the `CURRENT` pointer (temp file + rename);
8. retain the previous valid generation (`RETAIN_GENERATIONS = 1`);
9. clean stale `*.tmp` siblings.

The only valid generation is never mutated in place.

## Checksums and atomic publication

- Every component file's SHA-256 is recorded in the manifest.
- On load, the manifest is parsed, the schema is checked, and every listed
  component checksum is verified before the generation is activated.
- `CURRENT` is written via a temp file + atomic rename, so a crash never
  leaves a torn pointer.
- Readers observe either the prior complete generation or the new complete
  generation — never a partial update (snapshot swap under a read-write
  lock).

## Corruption handling

On detection (manifest parse error, schema mismatch, checksum mismatch,
missing component, malformed component, identity mismatch, count mismatch):

1. the corrupt generation is moved to `quarantine/` with a diagnostic marker
   (`QUARANTINE.txt` retaining the reason);
2. the loader scans remaining generations newest-to-oldest and selects the
   newest FULLY valid generation — a malformed component is never converted
   into an empty/default collection (fail-closed);
3. `CURRENT` is atomically repaired to the surviving generation (a stale,
   missing, or malformed pointer is handled);
4. a later refresh rebuilds the affected layer (or the whole tree-derived
   index) safely;
5. while rebuilding, clients fall back to one-shot/TypeScript behaviour via
   the existing fallback ladder — corrupt index data is never returned;
6. interrupted publication (a complete generation whose pointer was never
   updated) is detected and the pointer is repointed.

Unsupported **future** schemas are left in place for the newer binary and
never read as valid; legacy identity state is migrated (see below); when
migration is impossible the generation is rebuilt.

## Identity verification and migration (Task 3D)

- Repository and worktree identity segments use the full SHA-256 digest
  (256 bits). Every load verifies the manifest's identity (ids, root hash,
  canonical roots) against the expected identity, so a hash collision or
  incorrect directory selection cannot silently load another repository's
  state.
- Legacy 64-bit identity state directories are detected, ownership is
  verified, and the state is migrated (manifests rewritten to the current
  identity) or preserved as quarantine evidence; generations from different
  repositories are never mixed.

## Incremental detection

Refresh inputs (deterministic):

- git HEAD comparison (`git rev-parse HEAD` vs manifest `headSha`);
- dirty worktree status (`git status --porcelain` vs dirty fingerprint);
- filesystem metadata (size, mtime, content hash) where git is insufficient
  (plain directories, content-only edits not visible to status).

Handled events: creation, modification, deletion, rename, directory rename,
ignored files, generated files, symlinks, case-only rename, branch checkout,
merge, rebase, detached HEAD, index restart after missed watcher events.

Change-set computation (`refresh.rs`):

- HEAD changed → full rebuild of tree-derived layers (correct and safe for
  checkout/merge/rebase/commit).
- Files in `git status` that were previously clean → re-indexed.
- Newly untracked files → added.
- Deleted files → removed from every layer (metadata, symbols, edges, tests,
  cache).
- Renames (git `R` status or deterministic stem heuristic) → state moves,
  no stale entries.
- Content-only edits where git reports no change → filesystem metadata
  (content hash) reconciliation.
- Ignored files never enter the index (gitignore + `.fdignore`).

No-change refresh performs **no full content rebuild**: when HEAD and the
dirty fingerprint are unchanged, the current generation is reused (only stale
tmp cleanup runs).

## Watcher reconciliation

A filesystem watcher is an optimization, not the sole source of truth. Every
refresh reconciles against authoritative git + filesystem state, so missed
watcher events are discovered and indexed on the next refresh.

## Daemon methods

Advertised via negotiated capabilities (`HOSTED_COMMANDS`); protocol v1
unchanged:

- `index.status` — availability, generation, identity, component sizes.
- `index.refresh [--full]` — incremental (or forced full) update.
- `index.invalidate` — drop in-memory + persisted generations.
- `index.rebuild` — force a complete cold rebuild.
- `files.query [pattern] [--limit N]` — file metadata by path substring.
- `symbols.query [name] [--limit N]` — symbols by name/qualified substring.
- `dependencies.query <file> [--limit N]` — forward edges.
- `testsFor.query <file>` — direct + heuristic test mapping.
- `gitState.query` — the persisted git snapshot.

Older clients ignore the new commands; unsupported capabilities return
`E_UNSUPPORTED` and preserve the one-shot/TypeScript fallback ladder.

## One-shot CLI commands

`fdx index <subcommand>` maps deterministically to the same production
handlers used by `fdxd`:

```text
fdx index status
fdx index refresh [--full]
fdx index invalidate
fdx index rebuild
fdx index files.query --query <pattern> [--limit N]
fdx index symbols.query --query <name> [--limit N]
fdx index dependencies.query --file <file> [--limit N]
fdx index testsFor.query --file <file>
fdx index gitState.query
```

Output is structured JSON matching FDX conventions; exit codes: 0 success,
1 operational error, 2 usage error. Unknown subcommands return a bounded
structured error. Paths are validated so they cannot escape the selected
repository.

## Fallback ladder

`fdx index` native execution → (daemon unavailable) → one-shot native `fdx`
→ (native unavailable) → TypeScript fallback. A successful native result is
never reported as a fallback, and a fallback is never misreported as native
success.

## Schema compatibility

- `schema_version = 3` is the current format.
- Newer schemas are rejected (never read as valid) and left in place for the
  newer binary (fail-closed load; the service refuses to build over them).
- Compatible older schemas are migrated explicitly.
- Incompatible older schemas are rebuilt safely.

## Cancellation

The index refresh path is synchronous and short for typical fixtures; the
cancellation contract is: a cancelled or interrupted refresh never removes
the current valid generation. Daemon `cancel` acks arrive per protocol v1;
the previous generation remains valid until a new one publishes.

## Concurrency

- Readers take a read lock on the current snapshot — they never block each
  other.
- One writer publishes a generation at a time (per-service write lock).
- Concurrent refresh requests coalesce: a second refresh while one is in
  flight waits for and reuses the in-flight result.
- Duplicate refreshes do not duplicate work (single-flight).
- Readers observe either the prior complete generation or the new complete
  generation — never a partial update.
- Cancellation leaves the previous generation valid.
- Shutdown waits for in-flight refresh or abandons it safely; no temporary
  generations or locks are left behind.
- No global lock across unrelated repositories (per-service locks; the
  process-wide registry is a lookup map only).

### Cross-process writer coordination (Task 3D)

- All writers (CLI vs CLI, CLI vs daemon, daemon vs daemon, rebuild vs
  refresh, invalidate vs refresh) serialize on a repository/worktree-scoped
  OS file lock (`index.lock`, flock / LockFileEx) with bounded acquisition
  and PID owner evidence. The OS releases the lock on process death, so a
  stale lock can never block and a live owner's lock is never deleted.
- Generation conflicts are detected under the lock: a racing writer that
  already published the same or a newer generation is rejected
  (`AlreadyExists`) and reloads the winner's generation — never clobbering
  it. Builds run in unique per-process temporary directories so racing
  builders never corrupt each other's partial state.
- Readers never take the lock: they read CURRENT plus a fully-published
  generation, both atomic.

### Windows-safe publication

- CURRENT is replaced via a temporary pointer + atomic rename with bounded
  retry for temporarily held file handles. A reader observes either the
  previous valid generation or the new complete generation — never a
  missing, partial, or corrupt pointer state.
- Existing validated final generation directories are reused rather than
  renamed over (POSIX `rename` semantics are not assumed).
- Abandoned temporary pointer files are cleaned by every refresh.

## Query bounds

- All query results are bounded (`--limit`, default 100, hard cap 1000).
- Ordering is deterministic (sorted by path / file+line+id).
- Duplicate symbol names return multiple entries with distinct ids.
- Reverse-dependency and forward-edge lists are deduplicated and sorted.

## Content-cache limits

- Content-addressed (SHA-256 key).
- Maximum bytes: 4 MiB; maximum items: 512.
- LRU eviction with a deterministic monotonic access-order token.
- File-hash validation; invalidation on content change.
- No caching beyond the existing secret policy; no mutating operations;
  no unbounded output retention.

## Security and path controls

- Symlink traversal: `follow_links(false)`; `contains_path` rejects `..`
  escapes.
- State-directory permissions: `0700` on unix.
- Only short hashes in global file names (no raw repository paths).
- Ignore rules respected (`gitignore`, `.ignore`, `.fdignore`).
- Binary content is never read unbounded (classified by extension; hashing
  only for metadata).

## Cross-platform support

- Linux: XDG_CACHE_HOME / user cache.
- macOS: ~/Library/Caches.
- Windows: %LOCALAPPDATA% (socket lifecycle remains unix-only per Task 2;
  the index itself is cross-platform).
- Path normalization uses forward slashes; case-insensitive filesystems
  normalize identity hashes deterministically.

## Performance budgets

Declared budgets (medium frozen fixture ~400 files, verified by
`node scripts/bench-fdx-index.mjs`; the workflow runs on the exact SHA
against a committed baseline and fails on material regression — no
`--skip-budgets` / `--allow-dirty` for closure evidence):

| Path | Budget (p95) |
|---|---|
| Cold full build | ≤ 30 s |
| Warm persisted load | ≤ 1 s |
| No-change refresh | ≤ 2.5 s |
| One-file edit refresh | ≤ 5 s |
| Multi-file edit refresh | ≤ 8 s |
| Symbol lookup | ≤ 500 ms |
| Reverse-dependency lookup | ≤ 500 ms |
| Tests-for lookup | ≤ 500 ms |

The benchmark measures the fdx process RSS (not Node harness memory) and
records OS, architecture, CPU, memory, Rust/Node/bun versions, the full
40-char commit SHA, and a per-profile frozen-fixture SHA. Small, medium,
and large fixtures provide scale evidence.

## Operational diagnostics

- `index.status` reports generation, identity, component sizes, and loading
  state.
- Quarantine keeps `QUARANTINE.txt` evidence for corrupt generations.
- State root and generation directories are inspectable on disk.
- The benchmark report records SHA, branch, dirty flag, platform,
  architecture, CPU, memory, toolchain versions, fixture, and per-path
  latency distributions.
