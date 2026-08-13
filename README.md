# FlowDeck

> Production-grade multi-agent orchestration for OpenCode.

[![npm version](https://img.shields.io/npm/v/@heidi-dang/flowdeck.svg)](https://www.npmjs.com/package/@heidi-dang/flowdeck)
[![CI](https://github.com/heidi-dang/FlowDeck/actions/workflows/ci.yml/badge.svg)](https://github.com/heidi-dang/FlowDeck/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

| Status | |
|---|---|
| **Version** | v2.0.0-alpha.4 (development) |
| **License** | [MIT](LICENSE) |
| **OpenCode** | >= 1.4.0 |
| **Node.js** | >= 20.0.0 |
| **OS** | Linux, macOS, Windows |
| **Rust toolchain** | Required for the FDX native CLI (optional — TypeScript fallbacks included) |
| **Skills** | **61 validated skills** |

---

## Table of Contents

- [What is FlowDeck?](#what-is-flowdeck)
- [Who is it for?](#who-is-it-for)
- [Why FlowDeck?](#why-flowdeck)
- [Installation](#installation)
- [Heidi — Persistent Engineering Agent](#heidi--persistent-engineering-agent)
- [Heidi Before vs After](#heidi-before-vs-after)
- [v2 Architecture](#v2-architecture)
- [Upgrading from Alpha Releases](#upgrading-from-alpha-releases)
- [Core Capabilities](#core-capabilities)
- [Production Orchestration Architecture](#production-orchestration-architecture)
- [Better Harness](#better-harness)
- [PR Monitor and CI Auto-Repair](#pr-monitor-and-ci-auto-repair)
- [FDX Rust-Native Code Intelligence](#fdx-rust-native-code-intelligence)
- [Tool Governance and Command Security](#tool-governance-and-command-security)
- [Durable SQLite and Event/Outbox Architecture](#durable-sqlite-and-eventoutbox-architecture)
- [CLI Reference](#cli-reference)
- [Slash-Command Workflow](#slash-command-workflow)
- [Configuration](#configuration)
- [Compatibility Matrix](#compatibility-matrix)
- [Verification and Production Gates](#verification-and-production-gates)
- [Security Model](#security-model)
- [Troubleshooting](#troubleshooting)
- [Development and Contribution](#development-and-contribution)
- [Release and Support Policy](#release-and-support-policy)
- [License and Maintainer](#license-and-maintainer)

---

## What is FlowDeck?

**FlowDeck** is a governed multi-agent orchestration platform for [OpenCode](https://opencode.ai). It layers structured orchestration, delegation policies, deterministic planning pipelines, tool-governance controls, an event-driven CI auto-repair system, and a Rust-native code intelligence CLI on top of OpenCode.

FlowDeck does **not** replace OpenCode's model access, session management, or core tool execution. It operates as a plugin that adds governed structure on top of a working OpenCode installation.

**Package**: [`@heidi-dang/flowdeck`](https://www.npmjs.com/package/@heidi-dang/flowdeck)

**v2.0.0-alpha.1** integrates the completed **Orchestration Master Plan** (Phases 0–12, 100% complete) into the plugin runtime: the durable SQLite-backed orchestration engine, delivery/outbox pipeline, completion engine, verification & evidence system, and production hardening suite are now part of the shipped product, not just an internal spec.

Created and maintained by [Heidi Dang](https://github.com/heidi-dang).

---

## Who is it for?

- **Teams running OpenCode in production** that need deterministic multi-agent delegation, bounded planning pipelines, and audit trails.
- **Engineers who want CI auto-repair** that detects failures, classifies root causes, and attempts bounded fixes without a human in the loop.
- **Developers who want fast code intelligence** through the Rust-native FDX CLI, with automatic TypeScript fallbacks when no binary is available.
- **Maintainers who need guardrails** — command authorization, read-only git policy, executable allowlists, and resource-bound enforcement.

---

## Why FlowDeck?

OpenCode is a powerful agent runtime, but production use requires structure: who may delegate to whom, when a write is allowed, how failures are repaired, and how concurrent agents coordinate. FlowDeck provides that structure as a single installable plugin, with a durable orchestration runtime underneath.

---

## Installation

### Recommended — guided migration installer

```bash
curl -fsSL https://raw.githubusercontent.com/heidi-dang/flowdeck/main/install.sh | bash
```

The installer performs a safe guided migration lifecycle:

1. **Discover** — finds all existing FlowDeck registrations, legacy packages, and conflicting state
2. **Explain** — shows a clear summary of what was found and what cleanup is recommended
3. **Confirm** — prompts before destructive cleanup (unless `--yes` or `--non-interactive`)
4. **Backup** — byte-for-byte backup of every affected config file (backup fails → abort)
5. **Remove** — removes only FlowDeck-owned registrations; preserves other plugins and settings
6. **Verify clean** — confirms no conflicting FlowDeck state remains before installing
7. **Install** — installs the exact requested version from npm
8. **Register** — ensures exactly one canonical FlowDeck registration (idempotent)
9. **Static verify** — package identity, config validation, agent registry, skills
10. **Runtime verify** — real OpenCode agent discovery (Heidi visible, primary mode, no legacy errors)
11. **Auto-repair** — automatically fixes known safe issues (duplicates, stale paths, missing registration)
12. **Doctor** — comprehensive environment diagnostics
13. **Report** — structured evidence-based success report with health status

If any mandatory stage fails, the installer **rolls back** all configuration changes automatically.

### Non-interactive install (CI / automation)

```bash
curl -fsSL https://raw.githubusercontent.com/heidi-dang/flowdeck/main/install.sh | bash -s -- --yes
```

Or:

```bash
curl -fsSL https://raw.githubusercontent.com/heidi-dang/flowdeck/main/install.sh | bash -s -- --non-interactive
```

Both flags skip the confirmation prompt but still perform discovery, backup, cleanup, and verification.

### Dry-run

```bash
curl -fsSL https://raw.githubusercontent.com/heidi-dang/flowdeck/main/install.sh | bash -s -- --dry-run
```

Shows what the installer would do without modifying any files.

### Doctor-only (audit without install)

```bash
curl -fsSL https://raw.githubusercontent.com/heidi-dang/flowdeck/main/install.sh | bash -s -- --doctor
```

### Alternative — npm

```bash
npx @heidi-dang/flowdeck install
npx flowdeck verify
npx flowdeck doctor
npx flowdeck clean-install        # atomic clean reinstall
npx flowdeck clean-install --yes  # non-interactive
npx flowdeck clean-install --dry-run
```

Stable installs use the v1 line and `latest`:

```bash
npx @heidi-dang/flowdeck@latest install
```

The current v2 development package is `2.0.0-alpha.4` and uses the `alpha` channel:

```bash
npx @heidi-dang/flowdeck@alpha install
```

### What the installer does NOT do

- Silently delete user configuration without confirmation
- Skip backups before destructive operations
- Report success when doctor or runtime checks fail
- Install on top of unresolved conflict state
- Modify unrelated OpenCode settings (models, MCP, themes, other plugins)

### Repair and rollback

**Automatic repair** handles known safe issues without user intervention:

| Issue | Repair action |
|---|---|
| Duplicate FlowDeck registration | Keeps canonical entry, removes extras |
| Missing canonical registration | Adds `@heidi-dang/flowdeck` registration |
| Stale FlowDeck path reference | Removes stale path, adds canonical package |

Repair is capped at 2 attempts per issue class. If repair cannot reach a healthy state, the installer rolls back and reports what remains broken.

**Rollback** restores all touched configuration files to their exact pre-install state. After rollback, the installer verifies backup hashes match the restored files.


---

## Heidi — Persistent Engineering Agent

Heidi is FlowDeck's default primary agent. In v2, Heidi has evolved from a governed orchestration agent into a **persistent engineering agent** with durable memory, cross-session recall, evidence-backed learning, and a scheduler for background work.

### Persistent memory

Heidi maintains three memory layers in a durable SQLite database:

| Memory layer | Purpose | Scope |
|---|---|---|
| **USER memory** | Preferences, corrections, environment facts | Cross-session, user-scoped |
| **AGENT memory** | Operational learnings, tool quirks, workflows | Cross-session, agent-scoped |
| **REPO memory** | Repository conventions, architecture decisions | Cross-session, repo-scoped |

Memory is versioned with provenance tracking. Every memory write records the source session, timestamp, and reasoning. Memory can be rolled back if a learning proves incorrect.

Memory is bounded by a projection system that prevents unbounded growth. Old or low-confidence memories are archived, not deleted.

### Cross-session recall

Heidi searches historical sessions using SQLite FTS5 full-text search:

- **`/fd-recall`** — search past sessions by keyword, phrase, or topic
- **Session archive** — every completed session is indexed for recall
- **Historical task search** — find what was done, when, and why
- **Context-efficient** — only relevant snippets are loaded into context

This means Heidi can answer questions like "what did we do about the auth refactor?" by searching actual session history, not guessing.

### Evidence-backed learning

After completing a task, Heidi reviews the work for learnings:

1. **Automatic review** — post-completion analysis identifies patterns and corrections
2. **Verified evidence** — each learning is backed by concrete evidence (test results, file changes, user feedback)
3. **Approval policy** — learnings require verification before being promoted to memory
4. **Learning history** — every learning decision is logged with reasoning
5. **Rollback** — incorrect learnings can be identified and rolled back

Heidi does **not** blindly edit herself. Every learning goes through verification.

### Learned skills

Beyond the 61 bundled skills, Heidi can create versioned learned skills:

- **`/fd-learn`** — capture a reusable workflow pattern as a skill
- **`/fd-learn-from-session`** — extract learnings from a completed session
- **Core skills protected** — bundled skills cannot be overwritten by learned skills
- **Capability-aware loading** — skills are loaded based on task requirements
- **Progressive disclosure** — skill details are loaded on demand, not all at once

### Governed tool pipelines

Heidi can execute bounded multi-tool workflows through registered FlowDeck tools:

- Tool pipelines are registered and validated before execution
- Each pipeline step has permission checks and budget limits
- Pipelines retain normal OpenCode permission model and tool budgets
- Audit logging records every pipeline execution

This is **not** unrestricted code execution. Pipelines operate within the same governance model as individual tool calls.

### Scheduled work

Heidi can schedule durable background jobs:

- **`/fd-schedule`** — create, list, and manage scheduled tasks
- **Durable jobs** — survive process restarts via SQLite persistence
- **Lease-based execution** — prevents concurrent execution of the same job
- **Run history** — every execution is logged with timing and outcome
- **OpenCode session execution** — jobs run in proper OpenCode sessions
- **Unknown-run protection** — prevents execution of jobs with unexpected state

### Delegation visibility

- **`/fd-agents`** — persistent view of all agents and their current activity
- **Ownership-scoped cancellation** — cancellation intent is tracked per ownership
- **Child activity tracking** — delegated tasks show status and progress

**Limitation:** Active child steering (redirecting a running child agent) is unsupported. OpenCode cannot guarantee observation of child state during execution. Cancellation intent is tracked, but real-time steering is not available.

---

## Heidi Before vs After

| Capability | Earlier Heidi | Heidi v2 |
|---|---|---|
| Task orchestration | Yes | Yes |
| Specialist delegation | Yes | Yes |
| Durable execution | Yes | Yes |
| User memory | Limited / no dedicated layer | Persistent (USER, AGENT, REPO) |
| Agent operational memory | Lessons only | Versioned memory with provenance |
| Cross-session search | Limited | SQLite FTS5 full-text search |
| Automatic learning | Limited / manual | Evidence-backed post-completion |
| Learned skills | Static bundled skills | Bundled + versioned learned skills |
| Scheduled work | No full runtime | Durable scheduler with leases |
| Tool pipelines | Repeated individual calls | Governed bounded pipelines |
| Delegation inspection | Limited | Persistent `/fd-agents` projection |
| Active child steering | Unsupported | **Unsupported** (documented limitation) |

---

---

## v2 Architecture

v2 unifies the development branches into a single integration line on top of the stable v1 runtime. The Master Plan's orchestration runtime (Phases 0–12, **100% complete** — 12 CLOSED, 1 SUPERSEDED) is fully integrated:

```
OpenCode (model access, sessions, core tools, UI)
  |
  +-- FlowDeck Plugin (src/index.ts)
        |
        +-- Orchestration (src/orchestration/)
        |     +-- Durable runtime with event sourcing
        |     +-- SQLite persistence + outbox delivery
        |     +-- Optimistic concurrency (UoW + versioned writers)
        |     +-- Replay-safe completion and bounded cancellation
        |
        +-- Configuration (src/config/)
        |     +-- JSON/JSONC schema validation
        |     +-- Agent model overrides
        |     +-- Governance settings (supervisor, guards, budgets)
        |
        +-- Agent Registry (src/agents/)
        |     +-- Heidi (default primary agent)
        |     +-- 12 specialist agents (depth-1 delegation, task:deny)
        |     +-- Canonical registry + capability contracts
        |
        +-- Commands (src/commands/)
        |     +-- 15 slash commands
        |     +-- Pipeline: task → review → execute → verify → done
        |
        +-- Hooks (src/hooks/)
        |     +-- Tool guard, guard rails, orchestrator guard
        |     +-- Session lifecycle, command reference guard
        |
        +-- Services (src/services/)
        |     +-- Command boundary + typed process outcomes
        |     +-- Governance wiring, loop detector, recovery layer
        |     +-- PR Monitor (event-driven CI auto-repair)
        |
        +-- Tools (src/tools/)
        |     +-- 28 registered tools
        |     +-- Executable allowlist + argument validation
        |     +-- Git read-only policy enforcement
        |
        +-- Skills (src/skills/)
        |     +-- 61 validated workflow patterns (SKILL.md)
        |
        +-- Better Harness (src/better-harness/)
        |     +-- Collectors, analyzers, scoring, evidence, SSE transport
        |
        +-- FDX Native (crates/fdx/)
              +-- 14 CLI subcommands
              +-- tree-sitter AST parsing (5 languages)
              +-- Dual-AST symbol diff engine
```

### Master Plan integration

| Area | What v2 ships | Evidence |
|---|---|---|
| Persistence Foundation | SQLite lifecycle, transactions, checksummed migrations, startup schema validation | `src/orchestration/persistence/` |
| Contract System | Contract families, versions, requirements, acceptance criteria, gates | `src/orchestration/contracts/` |
| Runtime State Model | Task runs, assignments, sessions, context items with optimistic versioning | `src/domain/orchestration/runtime/` |
| Event Store | Durable events, global sequencing, correlation tracking, replay service | `src/orchestration/services/event-service.ts` |
| Delivery Engine | Lease-based outbox worker, idempotent delivery, dead-letter notifications | `src/orchestration/services/outbox-worker.ts` |
| Verification & Evidence | SHA/staleness policies, rules, verification results persistence | `src/orchestration/verification/` |
| Completion Engine | Atomic completion evaluation + immutable completion decisions | `src/orchestration/completion/` |
| Orchestrator | Execution registry, task routing, delegation helpers | `src/orchestration/composition.ts` |
| Runtime Services | REST API, health checks, real metrics (JSON + Prometheus) | `src/orchestration/api/` |
| Production Hardening | Chaos, concurrency, fault, negative, performance, compliance suites | `tests/orchestration/` |

Phase 10 (UI Integration) is **SUPERSEDED** under the CLI/plugin product boundary — FlowDeck ships as an OpenCode plugin + CLI, and OpenCode Core owns UI rendering. Its architectural intent is satisfied by the machine-consumable REST API (`GET /api/v1/orchestration/...`) and typed data projections.

The authoritative completion report lives at [`docs/master-plan/completion-matrix.md`](docs/master-plan/completion-matrix.md) and is regenerated by `npm run verify:completion-matrix`.

## FlowDeck v1 vs v2

This is a product comparison of the stable v1 line and the current v2 foundation; future roadmap work is excluded.

| Capability | FlowDeck v1 | FlowDeck v2 |
|---|---|---|
| Product role | Governed OpenCode plugin | Authoritative autonomous execution runtime |
| Orchestration | Policy-driven delegation | Durable run/assignment/session orchestration |
| Runtime state | Durable foundations | Authoritative persisted orchestration state |
| Contracts | Governance/planning | Versioned requirements, criteria and gates |
| Sessions | Lifecycle/checkpoints | Durable sessions + restart reconstruction |
| Context | Context controls | Persisted context + bounded child context |
| Token governance | Tool/execution limits | Hierarchical run/child budgets |
| Token accounting | Basic execution accounting | Durable provider-reconciled accounting |
| Events | Event/outbox foundation | Ordered event store + consumer offsets + replay |
| Delivery | Transactional outbox | Lease/retry/recovery/dead-letter engine |
| Verification | Post-write/CI | SHA-bound verification + stale detection |
| Evidence | Audit records | Durable immutable evidence lifecycle |
| Completion | Pipeline-driven | Authoritative completion engine |
| Recovery | Checkpoint/resume | Full persisted runtime reconstruction |
| Health | Doctor diagnostics | Runtime health/readiness/liveness |
| Metrics | Operational diagnostics | JSON/Prometheus/OpenTelemetry |
| Integration | Plugin + CLI | Plugin + CLI + REST/projections |
| UI ownership | OpenCode | OpenCode remains UI owner |
| Code intelligence | FDX | FDX retained as deterministic intelligence layer |
| Production proof | CI/security gates | Master Plan + adversarial runtime gates |

### v2 autonomous execution runtime

The current v2 branch includes the implementation-backed execution foundations described in [`docs/v2/architecture.md`](docs/v2/architecture.md): deterministic routing decisions, durable SQLite execution plans, dependency waves, isolated Git worktrees, leases, controlled integration, adaptive budget handles layered on the existing token controller, immutable performance observations, bounded FDX persistence, structured runtime snapshots, and machine-readable B1–B14 benchmark output.

Routing remains conservative by configuration:

```jsonc
{ "routing": { "enabled": true, "mode": "shadow" } }
```

`shadow` observes and persists recommendations without controlling OpenCode. `enforce` is explicit and fail-closed; it requires the execution prerequisites and never silently changes the selected model/provider. See [`docs/v2/configuration.md`](docs/v2/configuration.md), [`docs/v2/recovery.md`](docs/v2/recovery.md), and [`docs/v2/security.md`](docs/v2/security.md).

The benchmark command is reproducible for the candidate branch and includes a same-revision serial reference for B1–B14. The recorded `0ac894959587e5a2dfc11a66766fc834a64d5226` baseline predates the v2 routing/execution surface, so the harness reports the historical comparison as unavailable rather than inventing a performance improvement. Validate generated output with `npm run verify:benchmark:v2`.

---

## Upgrading from Alpha Releases

The guided migration installer handles upgrades automatically. When upgrading from any previous FlowDeck version:

1. **Discovery** detects your existing registrations (v1, v2 alpha, legacy)
2. **Backup** preserves your current configuration
3. **Cleanup** removes old registrations while preserving unrelated settings
4. **Install** adds the new version
5. **Verification** confirms Heidi is healthy

Your `default_agent` setting is preserved. JSONC comments are preserved. Unrelated plugins are untouched.

For manual upgrades:

```bash
npx @heidi-dang/flowdeck@alpha clean-install --yes
npx flowdeck doctor
```

If something goes wrong:

```bash
npx flowdeck rollback
```

---

## Core Capabilities

| Layer | Description |
|---|---|
| **Agent Orchestration** | Heidi executes tasks directly and delegates to specialists only when delegation conditions are met. Depth-1 delegation prevents runaway agent chains. 13 specialized agents in total. |
| **Planning Pipeline** | Five-stage pipeline (`/fd-task` → `/fd-review` → `/fd-execute` → `/fd-verify` → `/fd-done`) enforces plan-before-execute discipline with artifact persistence and checkpoint/resume. |
| **Tool Governance** | Permission guards, delegation depth validation, loop detection, tool-call budgets, and structured audit logging with session scorecards. |
| **Durable Orchestration Runtime** | SQLite-backed event persistence, outbox delivery, optimistic concurrency, and replay-safe execution. |
| **Better Harness** | Evidence-based evaluation and repair of AI-produced code changes. |
| **PR Monitor** | Event-driven CI failure detection, root-cause classification, and bounded automated repair. |
| **FDX Native CLI** | Rust-native code intelligence with token-optimized output and TypeScript fallbacks for environments without the native binary. |
| **Skills Library** | **61 validated skills** stored as structured `SKILL.md` files with YAML frontmatter. |
| **Master Plan Runtime** | Durable orchestration runtime from the completed Master Plan (Phases 0–12, 100%) — event store, delivery engine, completion engine, verification & evidence, REST API, health checks, metrics. |
| **Session Lifecycle** | Start/end hooks, session checkpoints, idle-timeout notifications, and recovery via `/fd-resume`. |

FlowDeck is **not** a standalone AI platform. It requires OpenCode to provide model access, session infrastructure, and core tool execution.

---

## Production Orchestration Architecture

The v2 orchestration runtime is assembled by `createProductionOrchestrationRuntime` ([`src/orchestration/composition.ts`](src/orchestration/composition.ts)) — a fully wired services graph covering runs, contracts, assignments, completion decisions, verification, events, replay, delivery, and health. All persistence goes through SQLite with an event/outbox pattern (see below).

```
OpenCode (model access, sessions, core tools, UI)
  |
  +-- FlowDeck Plugin (src/index.ts)
        |
        +-- Orchestration (src/orchestration/)
        |     +-- Durable runtime with event sourcing
        |     +-- SQLite persistence + outbox delivery
        |     +-- Optimistic concurrency (UoW + versioned writers)
        |     +-- Replay-safe completion and bounded cancellation
        |
        +-- Configuration (src/config/)
        |     +-- JSON/JSONC schema validation
        |     +-- Agent model overrides
        |     +-- Governance settings (supervisor, guards, budgets)
        |
        +-- Agent Registry (src/agents/)
        |     +-- Heidi (default primary agent)
        |     +-- 12 specialist agents (depth-1 delegation, task:deny)
        |     +-- Canonical registry + capability contracts
        |
        +-- Commands (src/commands/)
        |     +-- 15 slash commands
        |     +-- Pipeline: task → review → execute → verify → done
        |
        +-- Hooks (src/hooks/)
        |     +-- Tool guard, guard rails, orchestrator guard
        |     +-- Session lifecycle, command reference guard
        |
        +-- Services (src/services/)
        |     +-- Command boundary + typed process outcomes
        |     +-- Governance wiring, loop detector, recovery layer
        |     +-- PR Monitor (event-driven CI auto-repair)
        |
        +-- Tools (src/tools/)
        |     +-- 28 registered tools
        |     +-- Executable allowlist + argument validation
        |     +-- Git read-only policy enforcement
        |
        +-- Skills (src/skills/)
        |     +-- 61 validated workflow patterns (SKILL.md)
        |
        +-- Better Harness (src/better-harness/)
        |     +-- Collectors, analyzers, scoring, evidence, SSE transport
        |
        +-- FDX Native (crates/fdx/)
              +-- 14 CLI subcommands
              +-- tree-sitter AST parsing (5 languages)
              +-- Dual-AST symbol diff engine
```

---

## Better Harness

Better Harness is FlowDeck's evidence-based evaluation and repair backend for AI-produced code changes. It collects customization, foundation, and session evidence, scores changes across multiple dimensions, and generates structured remediation plans.

- **Collectors** gather evidence about the workspace, project identity, and session activity.
- **Analyzers** evaluate the evidence against harness dimensions.
- **Scoring** produces per-dimension scores and an aggregate report.
- **SSE transport** streams run progress (queued → started → collecting → analyzing → completed) to connected clients.
- **Persistence** stores runs and reports durably.

Run the standalone server with:

```bash
npm run better-harness:serve
```

---

## PR Monitor and CI Auto-Repair

The FDX PR Monitor is an event-driven CI auto-repair system. It detects workflow failures, collects logs, classifies root causes, and attempts automated repair within a bounded retry budget.

### Architecture

```
GitHub Webhook (workflow_job:completed)
  │
  ▼
FailureCollector ──► FailureClassifier ──► RepairOrchestrator
  │                                              │
  ▼                                              ▼
CiFailureReport                           State Machine (IDLE → GREEN)
```

### Safety Protections

- **SHA-based dedup** — one repair per PR head SHA at a time
- **Circuit breaker** — maximum 3 repair attempts per head SHA
- **Stale head detection** — re-reads the PR before pushing; aborts if another commit landed
- **Fork PR protection** — same-repository-only push policy
- **Prohibited paths** — `.github/workflows/release.yml` and `.env` files cannot be modified
- **Flaky classification** — infrastructure and timeout failures are retried once before code repair
- **No auto-merge or release** — the monitor never merges or publishes

---

## FDX Rust-Native Code Intelligence

FlowDeck ships with a Rust-native code intelligence CLI (`fdx`) that provides fast, AST-aware file operations. When the binary is unavailable, every tool falls back to a TypeScript implementation — the system remains fully functional, though some operations (AST parsing, symbol-aware diff) degrade to simpler text-based equivalents.

### Available Commands (14)

| Command | Description | Rust Native | TS Fallback |
|---|---|---|---|
| `fdx read` | AST-aware file reading (prototype/deep/raw modes) | tree-sitter | text slice |
| `fdx search` | Identifier and symbol search | AST | substring grep |
| `fdx grep` | Regex pattern matching with context | regex | substring (no regex) |
| `fdx batch` | Multi-file read with glob expansion | glob + AST | per-file read |
| `fdx impact` | Cross-file dependency analysis | AST import scan | regex import scan |
| `fdx outline` | Project-wide symbol outline | AST | regex declarations |
| `fdx diff` | Symbol-aware git diff (dual-AST) | tree-sitter diff | plain git diff |
| `fdx git` | Read-only git operations | policy-enforced | same |
| `fdx ls` | Compact directory listing | structured | flat list |
| `fdx tree` | Gitignore-aware directory tree | tree | flat list |
| `fdx test` | Failures-only test runner wrapper | output filter | same |
| `fdx lint` | Failures-only lint wrapper | output filter | same |
| `fdx context` | Per-topic agent-output log | advisory lock | same |
| `fdx decisions` | Per-topic design-decision log | advisory lock | same |

### Native Fallbacks

- **`nativeImpactFallback`** — scans TypeScript/JavaScript import and require statements for dependency inference.
- **`nativeSearchFallback`** — honors `.gitignore` patterns during directory walk in addition to the hardcoded exclude list (`node_modules`, `.git`, `dist`, `target`, `.next`, `.cache`).
- **Bounded traversal** — directory walks are depth-limited and deterministic; search fast-rejection avoids scanning excluded roots.

---

## Tool Governance and Command Security

### Registered Tools (28)

`doctor`, `planning-state`, `codebase-state`, `repo-memory`, `hash-edit`, `codegraph`, `load-rules`, `list-rules`, `capture-lesson`, `review-lessons`, `fdx-context`, `fdx-decisions`, `fdx-validate`, `fdx-worktree`, `fdx-read`, `fdx-search`, `fdx-grep`, `fdx-batch`, `fdx-impact`, `fdx-outline`, `fdx-diff`, `fdx-git`, `fdx-ls`, `fdx-tree`, `fdx-test`, `fdx-lint`, `debug-audit`, `fdx-pr-monitor`.

### Command Boundary

All subprocess execution flows through a hardened command boundary (`src/services/command-boundary.ts`) that returns **typed outcomes**:

- `timeout` — the process exceeded its wall-clock budget
- `max_buffer_exceeded` — the process exceeded its output-buffer budget
- `executable_not_found` — the executable could not be resolved
- `parse_rejected` / `authorization_rejected` — structured validation failures at the boundary

Resource limits (timeout and buffer) are validated against hard bounds before any process is spawned. Pre-spawn rejection prevents zero-argument and unauthorized invocations.

### Enforcement

- **Executable allowlist** — only `fdx`, `git`, `npm`, `bun`, `vitest`, `oxlint`, `tsc`, `node` are permitted; absolute paths must match the allowlist basename; all invocations use `shell: false`.
- **Argument validation** — rejects NUL bytes, caps argument count (100), per-arg length (16KB), and total length (64KB).
- **Git read-only policy** — blocks mutating subcommands (`reset`, `clean`, `checkout`, `commit`, `merge`, `rebase`, `push`, `pull`) and dangerous config overrides.
- **Audit logging** — every governance decision (block, warn, approve) is recorded as a structured JSON event.

---

## Durable SQLite and Event/Outbox Architecture

The orchestration runtime persists to SQLite with an event/outbox pattern:

- **Event persistence** — orchestration events are appended to durable event streams.
- **Outbox delivery** — side effects are delivered via an outbox that is written transactionally with the domain change, then dispatched reliably.
- **Optimistic concurrency** — writes use versioned records with unit-of-work transactions; concurrent writers are rejected instead of silently overwritten.
- **Replay and recovery** — interrupted runs can be replayed from persisted events; cleanup closes SQLite resources deterministically (WAL/SHM removal included).
- **Schema management** — migrations are embedded and checksum-verified (53 tables, 66 indexes, 36 triggers).

---

## CLI Reference

| Command | Description |
|---|---|
| `flowdeck install` | Install plugin in OpenCode configuration |
| `flowdeck install --project` | Install in project-level `.opencode/` |
| `flowdeck install --local-repo` | Install from a local Git checkout |
| `flowdeck clean-install` | Atomic clean reinstall with discovery, backup, rollback, and runtime verification |
| `flowdeck update` | Update plugin registration reference |
| `flowdeck verify` | Verify package identity and OpenCode registration |
| `flowdeck doctor` | Run comprehensive diagnostics (exit code 0/1/2) |
| `flowdeck config validate` | Validate JSON/JSONC configuration syntax |
| `flowdeck migrate` | Migrate configuration from upstream (`@dv.nghiem/flowdeck`) |
| `flowdeck rollback` | Roll back configuration from a backup |
| `flowdeck uninstall` | Remove FlowDeck plugin registration safely |
| `flowdeck dry-run` | Show what would be done without modifying files |
| `flowdeck --help` | Show detailed help |

---

## Slash-Command Workflow

### Pipeline Commands

| Command | Description |
|---|---|
| `/fd-task <description>` | Pipeline entrypoint — researches the codebase, drafts task/architecture/affect/plan artifacts, confirms with the user |
| `/fd-review [--topic=<slug>]` | Two-lens review (premise challenge + design review) |
| `/fd-execute [--topic=<slug>] [--override]` | TDD implementation with a parallel worktree guard and per-step review |
| `/fd-verify [--topic=<slug>]` | Full verification: test suite, regression check, code review, security scan |
| `/fd-done [--topic=<slug>]` | Close a task — summarizes built vs required, commits, pushes on confirmation |

### Utility Commands

| Command | Description |
|---|---|
| `/fd-status [--topic=<slug> \| --all]` | Show pipeline stage, artifact status, and blockers |
| `/fd-resume [--yes]` | Restore from checkpoint.json (falls back to STATE.md) |
| `/fd-checkpoint` | (Internal) force-save session state |

---

## Configuration

FlowDeck reads configuration from `opencode.json` (or `opencode.jsonc`) in the OpenCode config directory:

- **Linux/macOS**: `~/.config/opencode/opencode.json`
- **Windows**: `%APPDATA%/opencode/opencode.json`
- **Project-level**: `.opencode/opencode.json` in the project directory
- **Override**: `OPENCODE_CONFIG_DIR` environment variable

The `install` command adds FlowDeck to the `plugin` array and sets `default_agent` to `heidi` when no default exists.

### PR Monitor Configuration

```json
{
  "governance": {
    "prMonitor": {
      "enabled": true,
      "mode": "auto_fix",
      "eventSource": "github_app",
      "maxConcurrentRepairs": 1,
      "maxAttemptsPerHeadSha": 3,
      "retryFlakyOnce": true,
      "push": {
        "enabled": true,
        "sameRepositoryOnly": true,
        "requireUnchangedHeadSha": true,
        "commitPrefix": "fix(ci):"
      },
      "validation": {
        "requiredGate": {
          "command": "node",
          "args": ["scripts/pre-push.mjs"]
        }
      },
      "prohibitedPaths": [".github/workflows/release.yml", ".env", ".env.*"],
      "autoMerge": false,
      "autoRelease": false
    }
  }
}
```

---

## Compatibility Matrix

| Component | Requirement |
|---|---|
| Node.js | >= 20.0.0 |
| OpenCode | >= 1.4.0 |
| Linux | Supported (tested on ubuntu-latest) |
| macOS | Supported (tested on macos-latest) |
| Windows | Supported (tested on windows-latest) |
| Rust toolchain | Optional — required only for the FDX native CLI; TypeScript fallbacks ship in the package |

The `@opencode-ai/plugin` and `@opencode-ai/sdk` packages are required peer/declared dependencies.

---

## Verification and Production Gates

Every release runs the full production gate matrix:

- Build, typecheck, lint (0 warnings, 0 errors)
- Full test suite across Linux, macOS, and Windows (3,688+ tests, 0 failures across 185+ files)
- Coverage check (weighted aggregate line coverage above the 80% threshold)
- Documentation and skills validation
- Orchestration framework, integration, and schema validation
- FDX Rust gates (fmt, clippy, tests) and native parity
- Production and full dependency audits (0 vulnerabilities)
- npm pack dry run, isolated tarball installation, packed CLI, and ESM import

Run the pre-push gate locally:

```bash
node scripts/pre-push.mjs
```

---

## Security Model

- FlowDeck governance operates within OpenCode's permission model — it is not an operating-system sandbox.
- All subprocess invocations use `shell: false` and argument arrays — no shell command injection.
- An executable allowlist restricts which binaries can be spawned.
- Git operations enforce a read-only policy — mutating commands are blocked at the validation layer.
- Timeout and output-buffer limits are enforced at the command boundary with typed failure outcomes.
- Users remain responsible for provider credentials and tool permissions.
- Report security vulnerabilities through GitHub Issues (private disclosure preferred).

---

## Troubleshooting

- **`flowdeck doctor` exits with a code other than 0** — read the diagnostics output; a non-zero exit indicates a failing check (see the exit-code contract: `0` healthy, `1` failure, `2` engine error).
- **The FDX binary is unavailable** — FlowDeck falls back to TypeScript implementations automatically; install the Rust toolchain to enable native speed.
- **Agent identity enforcement blocks a request** — set `runtimeAgent.enforcement` to `warn` or `off` in configuration if your workflow uses a different agent name.
- **A write is blocked by the plan-confirmed gate** — confirm the plan first (`STATE.md` with `plan_confirmed: true`) or use `/fd-task` to establish a plan.
- **SQLite cleanup warnings on Windows** — the runtime retries WAL/SHM removal with backoff; this is expected during heavy concurrency.

See [Troubleshooting](docs/wiki/Troubleshooting.md) for more.

---

## Development and Contribution

```bash
npm ci
npm run build
npm run lint           # oxlint --deny-warnings
npm run typecheck      # tsc --noEmit
npm test               # full suite
npm run test:coverage  # coverage check
npm run validate:skills
npm run validate:docs
node scripts/pre-push.mjs
```

### Rust Development

```bash
cargo build --manifest-path crates/fdx/Cargo.toml
cargo test --manifest-path crates/fdx/Cargo.toml --all
cargo clippy --manifest-path crates/fdx/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path crates/fdx/Cargo.toml --check
```

See [Development](docs/wiki/Development.md) for detailed contribution guidelines.

---

## Release and Support Policy

- FlowDeck follows [Semantic Versioning](https://semver.org/). Breaking changes are released in new major versions with migration guidance. v2.0.0-alpha.x is the development line for the 2.0 major; stable 1.x releases remain on `latest`.
- Bug fixes and security patches are backported to the current stable minor line as appropriate.
- The `latest` npm dist-tag always points to the newest stable release; `next` tracks the upcoming release; pre-release versions publish under `alpha`.
- Version history is maintained in [CHANGELOG.md](CHANGELOG.md) and in the [release notes](docs/releases/).

---

## License and Maintainer

MIT — see [LICENSE](LICENSE)

Created and maintained by [Heidi Dang](https://github.com/heidi-dang).
