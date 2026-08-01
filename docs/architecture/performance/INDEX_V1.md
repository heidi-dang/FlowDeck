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
  "schemaVersion": 1,
  "fdxVersion": "0.1.0",
  "repositoryId": "<sha256-16>",
  "worktreeId": "<sha256-16>",
  "repositoryRootHash": "<sha256-16>",
  "headSha": "<git HEAD, 40 hex>",
  "dirtyFingerprint": "<sha256-16 of git status --porcelain>",
  "configHash": "<sha256-16 of FlowDeck/FDX config files>",
  "ignoreHash": "<sha256-16 of .gitignore/.ignore/.fdignore>",
  "generation": 1,
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "components": {
    "files": "Ready|Unavailable|Quarantined",
    "symbols": "Ready|Unavailable|Quarantined",
    "dependencies": "Ready|Unavailable|Quarantined",
    "testMapping": "Ready|Unavailable|Quarantined",
    "gitState": "Ready|Unavailable|Quarantined",
    "contentCache": "Ready|Unavailable|Quarantined"
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

- `repositoryId` = SHA-256 (16 hex) of the git common dir
  (`git rev-parse --git-common-dir`). Every worktree of one repository shares
  this id; different repositories never collide (256-bit hash input).
- `worktreeId` = SHA-256 (16 hex) of the canonicalized worktree root. Two
  worktrees of the same repository have distinct worktree ids.
- `repositoryRootHash` = SHA-256 of the canonicalized repository root path.

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
missing component):

1. the corrupt generation is moved to `quarantine/` with a diagnostic marker
   (`QUARANTINE.txt` retaining the reason);
2. the most recent valid generation (if any) is activated;
3. if `CURRENT` pointed at the quarantined generation, it is repointed to the
   surviving generation;
4. a later refresh rebuilds the affected layer (or the whole tree-derived
   index) safely;
5. while rebuilding, clients fall back to one-shot/TypeScript behaviour via
   the existing fallback ladder — corrupt index data is never returned.

Unsupported **future** schemas are rejected (never read as valid); compatible
older schemas are migrated explicitly; when migration is impossible the
generation is rebuilt.

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

- `schemaVersion = 1` is the current format.
- Newer schemas are rejected (never read as valid) and quarantined.
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

Declared budgets (120-file synthetic fixture, verified by
`benchmark:fdx-index`; regressions fail the gate):

| Path | Budget (p95) |
|---|---|
| Cold full build | ≤ 30 s |
| Warm persisted load | ≤ 500 ms |
| No-change refresh | ≤ 1.5 s |
| One-file edit refresh | ≤ 3 s |
| Symbol lookup | ≤ 200 ms |
| Reverse-dependency lookup | ≤ 200 ms |
| Tests-for lookup | ≤ 200 ms |

Benchmark artifacts are bound to the exact implementation SHA; dirty-source
runs are rejected unless explicitly overridden and labeled.

## Operational diagnostics

- `index.status` reports generation, identity, component sizes, and loading
  state.
- Quarantine keeps `QUARANTINE.txt` evidence for corrupt generations.
- State root and generation directories are inspectable on disk.
- The benchmark report records SHA, branch, dirty flag, platform,
  architecture, CPU, memory, toolchain versions, fixture, and per-path
  latency distributions.
