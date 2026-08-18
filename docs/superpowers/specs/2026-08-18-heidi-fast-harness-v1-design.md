# Heidi Fast Harness v1 — Architecture & Performance Design Specification

**Status:** APPROVED  
**Date:** 2026-08-18  
**Scope:** Heidi Execution Architecture, FlowDeck Runtime Performance, Routing, Context Management, Caching, and Telemetry  
**Target:** FlowDeck v2.1+ Core Architecture  

---

## 1. Executive Summary & Goals

FlowDeck currently provides rich multi-agent orchestration, governance, recovery, and code intelligence. However, the existing execution pattern assumes a heavy "direct-first" approach where Heidi acts as a monolithic executor before attempting delegation, carries an expansive (~3,000 token) permanent prompt, incurs synchronous filesystem I/O on hot paths (token usage reparsing, synchronous audit log appends), and runs sequential tool operations.

**Heidi Fast Harness v1** transforms Heidi into a **route-first, high-throughput, lean-context coordinator**:
1. **Immediate Task Classification:** Classify user intent deterministically before running deep repository discovery.
2. **Fast Direct vs Specialist Routing:** Trivial fixes execute immediately in FAST_DIRECT mode without planning overhead; complex or domain-specific tasks delegate to specialists on turn 1.
3. **Lean Permanent Context:** Reduce the always-on coordinator prompt by >= 60% (target 70-80%) by lazy-loading specialist directories, workflow catalogs, and stage rules.
4. **Concurrent Reads & Compact Tool Packets:** Parallelize independent repository reads (fdx-read, fdx-grep, fdx-search, fdx-outline) and summarize tool outputs before returning them to context.
5. **Hot State & Policy Fast-Path:** Cache repository metadata, parsed config, and read-only governance authorizations, while maintaining full policy evaluation for writes and destructive operations.
6. **Asynchronous/Indexed Bookkeeping:** Move token accounting to an in-memory index and buffer non-critical audit events off the execution hot path.
7. **Deterministic Tool Repair:** Mechanically normalize common schema variants, aliases, and argument shapes without consuming extra model turns.
8. **Preserve Invariants:** Retain all v2.0.9+ safety rules, terminal turn confirmation, bounded recovery, manual supersede, and Phase 9 DSH boundaries.

---

## 2. Target Execution Architecture

```
                                  +-------------------+
                                  |    User Prompt    |
                                  +---------+---------+
                                            |
                                            v
                               +-------------------------+
                               |     HeidiFastRouter     |
                               | (Deterministic & Fast)  |
                               +------------+------------+
                                            |
         +-----------------+----------------+-----------------+------------------+
         |                 |                |                 |                  |
         v                 v                v                 v                  v
  +-------------+   +--------------+ +---------------+  +-------------+   +---------------+
  | FAST_DIRECT |   |  SPECIALIST  | | PARALLEL_SPEC |  |  STANDARD   |   |     DEEP      |
  | (Inspect -> |   | (Turn 1      | | (Concurrent   |  | (Scoped     |   | (Full Matrix, |
  |  Edit ->    |   |  Delegation) | |  Specialists) |  |  Plan ->    |   |  Architecture |
  |  Verify)    |   |              | |               |  |  Exec ->    |   |  & Review)    |
  +------+------+   +-------+------+ +-------+-------+  |  Verify)    |   +-------+-------+
         |                  |                |          +------+------+           |
         |                  +--------+-------+                 |                  |
         |                           |                         |                  |
         |                           v                         |                  |
         |             +----------------------------+          |                  |
         |             | Specialist Execution Engine|          |                  |
         |             +-------------+--------------+          |                  |
         |                           |                         |                  |
         +---------------------------+-------------------------+------------------+
                                     |
                                     v
                       +----------------------------+
                       |    Integrate & Validate    |
                       | (Scoped Focused -> Gates)  |
                       +-------------+--------------+
                                     |
                                     v
                       +----------------------------+
                       |      Completion Decision   |
                       +----------------------------+
```

---

## 3. Core Modules & Responsibilities

### 3.1 HeidiFastRouter (src/services/heidi-fast-router.ts)
Classifies user tasks before prompt construction or tool dispatch.
- **Execution Classes:**
  - FAST_DIRECT: Single-file bug fix, minor config edit, typos, small refactor, focused doc change.
  - SPECIALIST: Dedicated domain task requiring one specialist (e.g. @debug-specialist for failing test root causes, @security-auditor for security audit, @frontend-coder for UI components).
  - PARALLEL_SPECIALISTS: Multi-domain tasks with disjoint file ownership (e.g. backend API + frontend UI).
  - STANDARD: Multi-file feature or refactor requiring scoped planning and validation.
  - DEEP: Architectural migration, breaking API redesign, release qualification.
  - Domain subcategories: SECURITY, UI, RELEASE.
- **Classification Engine:** Deterministic keyword/pattern matcher + file pattern hints + lightweight structural signals. Rejects heavy speculative LLM calls on turn 0.

### 3.2 HeidiPerformanceTracker (src/services/heidi-performance.ts)
Lightweight, microsecond-accurate telemetry for execution spans:
- Wall-clock time, time-to-first-provider-request, TTFT, completion latency.
- Turn counts, input/output token metrics, context size.
- Tool metrics: counts, parallel vs sequential breakdown, before/after hook overhead.
- Runtime metrics: config cache latency, governance latency, token indexing latency, audit buffering latency, FDX latency, delegation startup latency, integration/verification latency.
- **Privacy & Safety:** Strips chain-of-thought, credentials, API keys, and sensitive prompts from trace output. Overhead ceiling: < 1 ms p50 per span operation.

### 3.3 HeidiTaskState (src/services/heidi-task-state.ts)
Compact, structured task state tracker persisted outside the conversation context:
- Fields: taskID, goal, executionClass, owner, currentPhase, verifiedFacts, changedFiles, pendingChildren, failedHypotheses, blockers, verificationState, nextAction.
- Injected as a minimal structured state packet into provider context (< 200 tokens) instead of making the model reconstruct history from 50+ previous turns.

### 3.4 RepositoryHotContext (src/services/repository-hot-context.ts)
In-memory cache for stable repository facts:
- Project root, current Git HEAD SHA, current branch, detected languages, package manager, detected build/test/typecheck commands, layout summary, FlowDeck config snapshot, governance mode, FDX status.
- **Cache Invalidation:** Deterministic invalidation on Git HEAD change (commit/checkout), config file modification (.flowdeck.json, opencode.json), or package manifest change (package.json, Cargo.toml).

### 3.5 ConfigCache (src/services/config-cache.ts)
High-speed cached configuration resolver:
- Caches parsed FlowDeck config, governance mode, supervisor config, agent model mappings, and autonomy permissions.
- Avoids repeated synchronous disk reads and JSON/JSONC parsing during active turns.
- Invalidator watches mtimes or manual mutation events.

### 3.6 GovernanceFastPath (src/services/governance-fast-path.ts)
Accelerated authorization for safe, read-only operations:
- Whitelist of pure read tools: fdx-read, fdx-search, fdx-grep, fdx-outline, fdx-ls, safe read git inspection commands (git status, git diff, git log, git rev-parse).
- Skips full multi-rule evaluation for verified read-only tools on clean paths (< 2 ms p50).
- Automatically routes file writes, shell execution, deletions, and high-risk actions through full strict governance verification.

### 3.7 ReadBatchService (src/services/read-batch.ts)
Parallel repository inspection:
- Executes arrays of independent read operations (fdx-read, fdx-grep, fdx-search, fdx-outline) concurrently via Promise.all.
- Enforces max concurrency limits and per-call output truncations.
- Enforces strict serialization for any write operations.

### 3.8 ToolCallRepairService (src/services/tool-call-repair.ts)
Deterministic, rule-based repair of mechanical tool call anomalies:
- Normalizes argument aliases (e.g. path vs file_path, cmd vs command, subagent vs subagent_type).
- Normalizes path separators (converts Windows backslashes / trailing slashes where needed).
- Normalizes scalar vs array arguments (e.g. files: "foo.ts" -> files: ["foo.ts"]).
- Never infers missing semantic intent. If required fields are absent, fails closed cleanly.

### 3.9 Prompt Architecture & Lazy Loading (src/agents/orchestrator.ts)
- **Always-On Prompt (< 800 tokens):**
  - Heidi identity and role.
  - Route-first policy and execution class definitions.
  - Direct execution vs delegation boundary rules.
  - Single-level delegation invariant.
  - Verification & completion ownership.
  - Safety constraints (no reboot, no destructive commands, no credential leakage).
- **Lazy-Loaded Dynamic Sections:**
  - Specialist Directory (injected only if routing is not FAST_DIRECT).
  - Stage Workflow Catalog (injected only during STANDARD or DEEP execution).
  - Domain Workflows (Security, UI, Release injected only when relevant).
  - Planning Artifact Specifications.

### 3.10 Token Usage In-Memory Index (src/services/token-usage-store.ts)
- In-memory aggregation of token usage and reservations.
- Appends to JSONL durably in the background while keeping query paths O(1) without disk reads.

---

## 4. Performance & Invariant Requirements

| Metric / Requirement | Baseline / Legacy | Fast Harness v1 Target |
| :--- | :--- | :--- |
| **Always-On Coordinator Prompt** | ~2,933 tokens | < 900 tokens (>= 60% reduction) |
| **Routing Decision Turn** | Turn 2-5 (after deep exploration) | Turn 1 (Immediate) |
| **Read-Only Governance Overhead** | ~15-30 ms | < 5 ms p50 (< 2 ms target) |
| **Performance Tracing Overhead** | N/A | < 1 ms p50 per span |
| **Concurrent Independent Reads** | 1 at a time (sequential) | N parallel reads via ReadBatch |
| **Token Accounting Turn Overhead** | Reparsee full JSONL | In-memory index (O(1)) |
| **Destructive Command Guard** | 100% enforced | 100% enforced (Full Policy Path) |
| **Terminal Confirmation / Recovery** | Strict confirmation | 100% green, 0 spurious Continues |
| **Cross-Platform Compatibility** | Linux, macOS, Windows | Linux, macOS, Windows |

---

## 5. Security, Safety, and Recovery Invariants

1. **Destructive Operation Protection:** Any write, delete, rm, or dangerous shell command must undergo full governance and tool-guard checks. Fast paths apply exclusively to proven read-only actions.
2. **Deterministic Repair Non-Inference:** Tool-call repair strictly handles mechanical shape issues (e.g. parameter aliasing). It never guesses file paths, code, or commands.
3. **No CoT Telemetry Leaks:** Performance spans and traces never persist reasoning tokens, human chat secrets, or API keys.
4. **Single-Level Delegation Invariant:** Specialists cannot spawn child subagents. Heidi remains the sole top-level coordinator.
5. **Phase 9 DSH Seam Preservation:** Fast Harness v1 delegates tasks cleanly through existing task tools and OpenCode hooks, avoiding competing subagent supervisor lifecycles.
