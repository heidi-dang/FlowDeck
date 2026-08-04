# FDX Performance Daemon — Implementation Plan

**Developer:** Dev 3
**Program:** FDX and Tool Performance
**Frozen FlowDeck harness:** v1.0.3
**Branch:** `feat/fdx-performance-daemon` (baseline `5809fcf1230ff349ff0d7f5b53ed75403f44573b`)
**Status:** Planned (Task 1 complete — baseline measured and recorded)

---

## 1. Current Architecture (as measured)

FDX today is a stateless native CLI. Every `fdx-*` tool call:

1. Spawns a fresh `fdx` process (`execFileSync` in `src/tools/fdx-shared.ts#runFdx`).
2. Cold-starts: process bootstrap + clap parse (~2.6 ms — the `--version` p50).
3. Executes the query with **no persistent state, no cache, no index**.
4. Returns JSON/text on stdout; process exits.
5. If the native binary is unavailable, TypeScript fallbacks run **in-process** (no spawn, but reduced capability).

### Measured baseline (deterministic fixture: repo root at release SHA, 15 iterations)

| Command | p50 | p95 | Output (p50) | Cost driver |
|---|---|---|---|---|
| `version` (startup) | 2.62 ms | 3.2 ms | — | process + clap |
| `ls` | 2.98 ms | 3.48 ms | 1.8 KB | startup-bound |
| `git status` | 9.09 ms | 11.39 ms | 48 B | startup + git |
| `tree` (depth 2) | 18.19 ms | 18.41 ms | 24.7 KB | walk |
| `read` (prototype) | 20 ms | 30.86 ms | 20.8 KB | read + parse |
| `batch` | 40 ms | 41.4 ms | 31 KB | multi-file read |
| `grep` | 62.39 ms | 68.24 ms | 5.2 KB | scan src/ |
| `outline` | 96.34 ms | 113.43 ms | 81.2 KB | scan 25+ files |
| `impact` | 121.77 ms | 135.27 ms | 444 B | scan + symbols |
| `search` | **834.31 ms** | 882.37 ms | 857 B | full tree-sitter re-scan |

**Spawn model:** 8 tool calls in a realistic flow = 8 native spawns, 1201.6 ms total. The TS in-process fallback (`nativeReadFallback`) measures 0.05 ms p50 — proving **process spawn is the dominant fixed overhead** whenever the native binary is used.

**Key observations**
- `search` re-scans the entire `src/` tree on every call (834 ms) — the single biggest waste; a tree-sitter incremental index eliminates the repeat cost.
- `impact`/`outline` re-scan per call (96–124 ms) — indexable.
- `ls`/`version`/`git-status` are startup-bound (~3–11 ms) — a resident daemon amortizes spawn to a ~0.1 ms round-trip.
- No daemon, no cache, no batching, no cancellation, no output bounding exists today.

Full data: `docs/architecture/performance/baseline-2026-08-01.json`.

## 2. Performance Targets (release-gated, must be re-measured)

| Metric | Target |
|---|---|
| Warm metadata query p95 | < 40 ms |
| Warm symbol/search p95 | < 100 ms |
| Cached query p95 | < 10 ms |
| Batched request p95 | < 200 ms |
| Client scheduling overhead p95 | < 20 ms |
| Redundant FDX calls (vs baseline) | −40% |
| Repeated full scans (warm) | eliminated |
| Native/fallback parity | 100% |
| Cross-worktree contamination | 0 |
| Unbounded output/memory | 0 |
| Daemon crash recovery (fault tests) | 100% |
| Cancellation ack p95 | < 250 ms |
| Done threshold | ≥ 9.5/10 |

## 3. Target Architecture

```
┌─────────────────────────── OpenCode / Bun runtime ───────────────────────────┐
│                                                                              │
│  fdx-* tools (TS)  ──►  fdx-client (fdx-shared)  ──►  request/response       │
│        │                       │                        │                    │
│        │                  scheduling, batching,        │                    │
│        │                  cancellation, fallback       │                    │
│        │                       │                        │                    │
└────────┼───────────────────────┼────────────────────────┼────────────────────┘
         │                       │                        │
         │  transport (stdio / TCP / named pipe,          │
         │  versioned JSON-RPC, capability handshake)     │
         ▼                       ▼                        ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  fdxd (native daemon, user-scoped, per-project or per-user)                   │
│                                                                              │
│  ┌──────────────┐  ┌──────────────────┐  ┌───────────────────────────────┐  │
│  │ lifecycle    │  │ request router   │  │ incremental index             │  │
│  │ (spawn on    │  │ (protocol v1,    │  │ (tree-sitter AST cache keyed  │  │
│  │  demand,     │  │  capability      │  │  by file mtime+size; watch or │  │
│  │  idle exit,  │  │  negotiation,    │  │  lazy refresh; workspace      │  │
│  │  crash        │  │  cancellation,  │  │  + cache tiers)               │  │
│  │  recovery)    │  │  batching)      │  └───────────────────────────────┘  │
│  └──────────────┘  └──────────────────┘  ┌───────────────────────────────┐  │
│                                          │ cache (metadata, symbol,      │  │
│                                          │  search; LRU + generation     │  │
│                                          │  invalidation)                │  │
│                                          └───────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Components

1. **`fdxd` daemon binary** — long-lived Rust process (new binary target in `crates/fdx`). User-scoped (spawned by the client on demand, idle-exits, never a system service without human approval). State: incremental index, caches, workspace registry.
2. **Versioned wire protocol** — JSON-RPC-style request/response over an OS transport. V1 handshake: `hello` (protocol version, capabilities), `ping`, `query`, `batch`, `cancel`, `shutdown`. Protocol version in the handshake; mismatch → client falls back to legacy spawn model (never breaks).
3. **Transport abstraction** — Unix domain socket (Unix/macOS), named pipe (Windows), with stdio fallback for one-shot mode. Cross-platform CI matrix enforces all three.
4. **Client library** — `src/tools/fdx-shared.ts` extension: daemon discovery (PID file / socket path), spawn-on-demand, request/response, batching, cancellation, fallback ladder (daemon → one-shot spawn → TS fallback).
5. **Incremental index** — tree-sitter AST cache keyed by file (mtime + size + hash); lazy refresh per workspace; query reuses cached parses; search/outline/impact read from index.
6. **Caches** — per-query-type: metadata cache (LRU), symbol cache, search cache. Generation-based invalidation on file change (mtime/size), not directory full-rescan.
7. **Batching** — client coalesces concurrent tool calls within a window (≤20 ms scheduling overhead p95) into a single `batch` request; response multiplexed by request id.
8. **Cancellation** — per-request token; daemon stops long scans (search), acks within 250 ms p95; client timeout + fallback.
9. **Output bounding** — hard byte cap per response (default 50 MB, configurable, matches current `FDX_MAX_BUFFER`); truncation metadata so callers can narrow scope. Never unbounded.
10. **Observability** — per-request timing, cache hit/miss, index stats; `report:self-host` consumes it; soak/crash tests enforce 100% recovery.
11. **Parity gate** — `verify-fdx-parity.mjs` extended: same query via daemon, one-shot, and TS fallback must produce identical output (0 contamination across workspaces, 100% parity).

## 4. Task Roadmap (12 tasks)

| # | Task | Deliverable | Exit criterion |
|---|---|---|---|
| 1 | Baseline & ownership map | this plan + `baseline-2026-08-01.json` + ownership declaration | baseline recorded, plan approved |
| 2 | Protocol & daemon skeleton | versioned protocol + runtime validation + cross-platform transport + lifecycle skeleton + health/capability handshake + client TS + tests | handshake works on all 3 OS, tests green |
| 3 | Indexing model | workspace model, file-change detection (mtime/size/watch), lazy refresh, index integrity | index refresh correct on change |
| 4 | Symbol + search index | AST cache, outline/impact/search over index | warm search p95 < 100 ms |
| 5 | Cache layer | metadata/symbol/search caches, LRU + generation invalidation | cached p95 < 10 ms |
| 6 | Client scheduling & batching | coalescing, multiplexed batch, scheduling overhead budget | batch p95 < 200 ms, sched < 20 ms |
| 7 | Cancellation & timeouts | request tokens, daemon cancel, client timeout ladder | ack p95 < 250 ms |
| 8 | Output bounding & resource caps | byte caps, memory limits, truncation metadata | 0 unbounded output/memory |
| 9 | Robustness & crash recovery | fault injection, daemon restart, cache rebuild, kill mid-query | 100% recovery, 0 contamination |
| 10 | Perf validation & regression | full target suite on all OS, soak, bench gate in CI | all targets met, ≥9.5/10 |
| 11 | Integration & fallback matrix | end-to-end via fdx-* tools, fallback ladder on daemon absence | tools work with daemon, one-shot, TS |
| 12 | Reporting & handoff | `report:self-host`, final docs, ownership release | report complete, ready |

## 5. Ownership Boundaries (with Dev 2)

- **Dev 3 owns:** `crates/fdx/**`, `src/tools/fdx*`, FDX batching/caching scripts, FDX daemon/cache/transport/parity/performance tests, `benchmark:fdx` + `test:fdx-*` + `report:self-host` npm scripts.
- **Dev 2 must relinquish:** FDX + tool-performance files listed above. Dev 3 will not edit Dev 1's SSE/live-UI files, orchestration/persistence tests (excluded from `test` script), or release workflows.
- On conflict → ownership arbitration via orchestrator; no silent edits of the other's files.

## 6. Constraints & Guards

- **No machine-level system service** — daemon is user-scoped, managed by FlowDeck, spawned on demand, idle-exits. Installing a permanent system service requires human approval.
- **Never break the release gate** — publish.yml + v1.0.3 registry contract must stay green; new scripts are additive.
- **No secrets** in daemon, transport, or logs (auth via filesystem perms / local socket, not tokens).
- **No unbounded memory** — index/cache have explicit caps; LRU eviction; tests assert RSS bounds.
- **Protocol evolution** — versioned; old clients keep working via fallback; never silently change wire format.
- **PR discipline** — first PR (Task 2) < 15 files, draft, unmerged; stack branches from reviewed head.
- **Do not touch:** `dist/`, `node_modules/`, `bun.lock`, `Cargo.lock` (lockfile update only via `cargo` when adding deps).

## 7. Test Matrix

- Unit: protocol encode/decode, cache eviction, index invalidation, batching, cancellation, output caps.
- Integration: daemon lifecycle (spawn/idle-exit/kill-recovery), handshake, batch multiplexing, cancel-mid-scan.
- Cross-platform: Unix socket / named pipe / stdio fallback on ubuntu/macos/windows (CI `test-matrix`).
- Parity: same query daemon vs one-shot vs TS fallback → identical bytes.
- Fault: kill daemon mid-query → client recovers, index rebuilds, 0 contamination.
- Soak: sustained mixed workload, RSS bounded, no fd leaks, no unbounded output.
- Perf: targets above, measured on clean CI + locally, regression gate in CI.

## 8. Risk Register

| Risk | Mitigation |
|---|---|
| Named pipe/transport differences across OS | Transport abstraction + CI matrix from Task 2 |
| Index invalidation misses (stale symbols) | mtime+size+hash key, lazy refresh, generation counters, parity tests |
| Daemon crash → stale PID/socket | PID file validation, socket reconnect, one-shot fallback, 100% recovery tests |
| Memory growth from index/cache | Explicit caps, LRU, soak test with RSS assertion |
| Protocol mismatch with older clients | Versioned handshake, fallback ladder, never break release gate |
| License risk from new deps (e.g. named-pipe crates) | Prefer stdlib/OS APIs where possible; audit deps before adding; keep `Cargo.lock` clean |
| Fallback parity drift | Extended parity gate in CI; same query 3 ways |

## 9. Success Criteria (Task 1 done)

- [x] Baseline measured and recorded (`docs/architecture/performance/baseline-2026-08-01.json`)
- [x] Ownership map complete (this doc + `docs/architecture/performance/OWNERSHIP.md`)
- [x] Implementation plan written
- [x] Branch pushed, draft PR open
- [ ] Plan approved by human → begin Task 2

## 10. Next Steps (Task 2 — Protocol & daemon skeleton)

1. Define protocol v1 (JSON-RPC-style, handshake with version + capabilities).
2. Runtime validation tool (`test:fdx-protocol`) to validate messages against the schema.
3. Cross-platform transport abstraction (unix socket / named pipe / stdio fallback).
4. Daemon lifecycle skeleton: spawn-on-demand, PID file, idle-exit, crash recovery.
5. Health/capability handshake (`hello`/`ping`).
6. Client TS: daemon discovery + fallback ladder.
7. Focused tests + draft PR (< 15 files), unmerged.
