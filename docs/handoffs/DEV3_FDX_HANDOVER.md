# Dev 3 FDX Handover Document
Archived at: archive/dev2-full-master-plan-ecbb226
Original commit: ecbb226db1150a2894e7fe46507d159a9fbb28ae

## 1. Archived Implementation Paths

### Core Files
- `crates/fdx/src/benchmark.rs`

### Daemon Module (`crates/fdx/src/daemon/`)
All files in the daemon module were archived:
- Daemon entry point and lifecycle management
- Unix socket listener and connection handling
- Protocol handshake implementation
- Request routing and response handling

### Index Module (`crates/fdx/src/index/`)
All files in the index module were archived:
- File metadata indexing
- Symbol indexing
- Dependency graph indexing
- Test mapping indexing
- Git snapshot indexing
- Content cache indexing

## 2. Potentially Reusable Ideas

### Persistent Daemon with Unix Socket Support
The daemon runs as a long-lived process listening on a Unix domain socket. This avoids repeated process spawning overhead and maintains in-memory state across requests.

### Protocol Version Handshake
Clients and server establish compatibility via version negotiation at connection time before any operations are sent.

### Health Diagnostics
Built-in health check endpoint for monitoring daemon status, memory usage, and index freshness.

### Incremental Indexing
Instead of full repository scans, the indexer tracks only changed files:
- File metadata index: mtime, size, permissions
- Symbol index: function/class definitions per file
- Dependency graph: import/require relationships
- Test mapping: test file to source file associations
- Git snapshot: current SHA and dirty tree fingerprint
- Content cache: parsed/compiled representations

### FDX Batching with Per-Operation Error Isolation
Multiple operations can be batched in a single request. If one operation fails, others continue with their results; errors are reported per-operation rather than failing the entire batch.

### Result Cache with SHA/Dirty-Tree Invalidation
Query results are cached using a key composed of:
- `repositoryId`
- `worktreeId`
- `headSha`
- `dirtyTreeFingerprint`
- `fdxVersion`
- `queryHash`

Cache entries are invalidated when any component of the key changes.

### Tool Scheduler with Queue Priorities
Operations enter priority queues based on urgency. The scheduler dispatches work to avoid overwhelming resources while maintaining responsiveness for high-priority requests.

## 3. Known Risks

1. **Experimental Status**: The implementation was prototype/experimental and not production-hardened. Significant testing and hardening would be required before production use.

2. **Daemon Idle Shutdown**: The daemon's idle timeout behavior (auto-shutdown after period of inactivity) needs thorough testing to ensure it doesn't terminate during legitimate long-running operations or lose in-flight state.

3. **Incremental Index Edge Cases**: The logic for determining which files need re-indexing has incomplete edge case coverage. Race conditions can occur when files change during indexing.

## 4. Status

**Reference Only** — This document captures the archived FDX implementation for historical context. Dev 3 will decide what, if anything, to adapt into PR #106 or subsequent work.

## 5. Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Unix socket on Linux/macOS | Low-latency IPC without network overhead; avoids TCP port management |
| Version handshake on connect | Allows protocol evolution while maintaining backward compatibility |
| Incremental index updates | Performance: only changed files are reindexed, not entire repository |
| Cache key includes SHA + dirty fingerprint | Ensures cache invalidation reflects actual repository state changes |
| Mutations never cached | Prevents stale data; queries that modify state always hit fresh computation |
