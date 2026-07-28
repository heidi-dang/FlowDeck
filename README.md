# FlowDeck — Heidi fork

> Structured multi-agent orchestration, governance, and CI lifecycle management for [OpenCode](https://opencode.ai)

**FlowDeck** extends OpenCode with a governed multi-agent orchestration layer, deterministic planning pipelines, tool-governance policies, audit logging, an event-driven CI auto-repair system, and a Rust-native code intelligence CLI. It does not replace OpenCode's model access, session management, or core tool execution — it operates as a plugin that layers structured orchestration on top.

**Package**: [`@heidi-dang/flowdeck`](https://www.npmjs.com/package/@heidi-dang/flowdeck)

| Status | |
|---|---|
| **Version** | v0.8.0-alpha.12 |
| **License** | [MIT](LICENSE) |
| **OpenCode** | >= 1.4.0 |
| **Node.js** | >= 18.0.0 |
| **OS** | Linux, macOS, Windows (WSL2) |
| **Rust toolchain** | Required for FDX native CLI (optional) |
| **CI** | [![CI](https://github.com/heidi-dang/FlowDeck/actions/workflows/ci.yml/badge.svg)](https://github.com/heidi-dang/FlowDeck/actions/workflows/ci.yml) |
| **Skills** | **61 skills** validated workflow patterns |

---

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Features](#features)
- [CLI Commands](#cli-commands)
- [Slash Commands](#slash-commands)
- [FDX Native CLI](#fdx-native-cli)
- [PR Monitor](#pr-monitor)
- [Tools (27)](#tools-27)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [Verification](#verification)
- [Development](#development)
- [Roadmap](#roadmap)
- [Security](#security)
- [License](#license)

---

## Overview

FlowDeck integrates with OpenCode as a plugin and provides eight layers of capability:

| Layer | Description |
|---|---|
| **Agent Orchestration** | Heidi (default primary) executes tasks directly and delegates to 12 specialists only when delegation conditions are met. Depth-1 delegation prevents runaway agent chains. |
| **Planning Pipeline** | Five-stage pipeline (`/fd-task` → `/fd-review` → `/fd-execute` → `/fd-verify` → `/fd-done`) enforces plan-before-execute discipline with artifact persistence and checkpoint/resume. |
| **Tool Governance** | Permission guards, delegation depth validation, loop detection, tool-call budgets, delegation budgets, and structured audit logging with session scorecards. |
| **Guard Rails** | Safety boundaries that block writes without a confirmed plan, auto-stash before merges, design-gate enforcement for UI-heavy tasks, and lockfile-based in-flight protection during `/fd-task`. |
| **CI Auto-Repair (PR Monitor)** | Event-driven system that detects CI failures, collects logs, classifies root causes, attempts automated repair, validates locally, and pushes fixes — all within a bounded retry budget. |
| **FDX Native CLI (Rust)** | High-performance code intelligence CLI with token-optimized output, AST-aware file reading, dual-AST symbol diffing, and TypeScript fallbacks for environments without the native binary. |
| **Skills Library** | 61 validated workflow patterns stored as structured SKILL.md files with YAML frontmatter, loaded on demand by agents during execution. |
| **Session Lifecycle** | Start/end hooks with scorecard generation, session checkpointing, idle-timeout notifications, and recovery via `/fd-resume`. |

FlowDeck is **not** a standalone AI platform. It requires OpenCode to provide model access, session infrastructure, and core tool execution.

---

## Quick Start

### Recommended — Atomic Clean Install

```bash
curl -fsSL https://raw.githubusercontent.com/heidi-dang/flowdeck/main/install.sh | bash
```

This performs a complete atomic lifecycle:
1. **Discovery** — finds all FlowDeck registrations in OpenCode config scopes
2. **Backup** — byte-for-byte backup of every affected file
3. **Cleanup** — safely removes old or legacy registrations
4. **Verify** — confirms the environment is clean before proceeding
5. **Install** — installs the exact latest npm release
6. **Static verification** — `flowdeck verify`, `doctor`, `config validate`
7. **Runtime verification** — runs real OpenCode agent discovery
8. **Rollback** — automatic if any stage fails

### Alternative — npm

```bash
npx @heidi-dang/flowdeck install
npx flowdeck verify
npx flowdeck doctor
```

---

## Features

### Agent Orchestration

- **Heidi (default primary)** — executes tasks directly by default, delegates to specialists only on specific triggers (complex features, bug fixes, read-only audits, parallel work).
- **13 specialized agents** — orchestrator, planner, architect, backend-coder, frontend-coder, devops, tester, reviewer, security-auditor, debug-specialist, researcher, mapper, and explore. Each has a defined role, model inheritance, tool permissions, and a capability contract registered in the canonical registry.
- **Depth-1 delegation** — specialist agents cannot spawn sub-tasks (`task: "deny"`), preventing runaway delegation chains.
- **Agent identity enforcement** — runtime agent-policy validation against expected agent names, with anti-fabrication identity markers injected into system prompts.

### Planning Pipeline

| Command | Stage | Purpose |
|---|---|---|
| `/fd-task` | 1 | Define requirements, research codebase, draft architecture + plan + affect analysis |
| `/fd-review` | 2 | Two-lens review (CEO challenges premise, eng reviews design) |
| `/fd-execute` | 3 | TDD implementation with parallel worktree guard and per-step review |
| `/fd-verify` | 4 | Full verification: tests, regression check, code review, security scan |
| `/fd-done` | 5 | Close task, summarize built vs required, commit, push |

Additional utilities: `/fd-status`, `/fd-resume`, `/fd-checkpoint`.

### Tool Governance

- **27 registered tools** — 14 FDX tools, doctor, planning-state, codebase-state, repo-memory, hash-edit, codegraph, load-rules, list-rules, capture-lesson, review-lessons, debug-audit, fdx-validate, fdx-worktree.
- **Executable allowlist** — `validateExecutable()` restricts subprocess execution to `fdx`, `git`, `npm`, `bun`, `vitest`, `oxlint`, `tsc`, `node`. Absolute paths must match the allowlist basename. All invocations use `shell: false`.
- **Argument validation** — `validateArgs()` rejects NUL bytes, caps argument count (100), per-arg length (16KB), and total length (64KB).
- **Git read-only policy** — `validateGitPolicy()` blocks mutating subcommands (`reset`, `clean`, `checkout`, `commit`, `merge`, `rebase`, `push`, `pull`), dangerous config overrides (`core.pager`, `sequence.editor`, `alias`), and mutating flags on `branch`, `tag`, and `stash`.
- **Delegation depth & budget** — `validateDelegationDepth()` prevents self-delegation, specialist-over-specialist chains, and exceeding configurable delegation budgets.
- **Audit logging** — every governance decision (block, warn, approve) is recorded as a structured JSON event in the audit log, queryable via `debug-audit` tool.

### Guard Rails

- **Plan-confirmed gate** — write/edit tools are blocked unless `STATE.md` exists with `plan_confirmed: true`.
- **Lockfile protection** — `/fd-task` creates `.fd-task-lock` during execution, temporarily bypassing the guard so artifact writes are allowed before STATE.md is fully initialized.
- **Auto-recover STATE.md** — if `STATE.md` is missing but the planning directory exists, `/fd-task` re-initializes STATE.md and config.json without overwriting existing artifacts.
- **Design gate** — UI-heavy tasks require approved design handoff (set via `/fd-review`) before `/fd-execute` proceeds.
- **Merge auto-stash** — `fdx-worktree merge` auto-stashes uncommitted changes (including untracked) before merging, then pops the stash on success.
- **Build/deploy guard** — bash commands classified as `publish` or `deploy` are blocked unless the plan is confirmed.

### Exit-Code Contract

All diagnostic paths produce deterministic exit codes from a single canonical implementation (`src/doctor/exit-code.mjs`):

| Code | Meaning | Condition |
|---|---|---|
| `0` | Healthy | No errors or warnings (or warnings in non-strict mode) |
| `1` | Failure | Any error, or any warning in strict mode |
| `2` | Engine error | Null/undefined report, invalid profile, engine crash |

The canonical function is re-exported through `scripts/doctor-service.mjs`, `src/index.ts`, `src/doctor/cli.mjs`, and `bin/flowdeck.js` — all paths converge to the same implementation.

---

## CLI Commands

| Command | Description |
|---|---|
| `flowdeck install` | Install plugin in OpenCode configuration |
| `flowdeck install --project` | Install in project-level `.opencode/` |
| `flowdeck install --local-repo` | Install from a local Git checkout |
| `flowdeck clean-install` | Atomic clean reinstall with discovery, backup, rollback, and runtime verification |
| `flowdeck verify` | Verify package identity and OpenCode registration |
| `flowdeck doctor` | Run comprehensive diagnostics (exit code 0/1/2 per contract) |
| `flowdeck config validate` | Validate JSON/JSONC configuration syntax |
| `flowdeck migrate` | Migrate configuration from upstream (`@dv.nghiem/flowdeck`) |
| `flowdeck update` | Update plugin registration reference |
| `flowdeck rollback` | Roll back configuration from a backup |
| `flowdeck uninstall` | Remove FlowDeck plugin registration safely |
| `flowdeck dry-run` | Show what would be done without modifying files |
| `flowdeck --help` | Show detailed help |

---

## Slash Commands

### Pipeline Commands

| Command | Description |
|---|---|
| `/fd-task <description>` | Pipeline entrypoint — auto-inits workspace, researches codebase, drafts task.md + architecture.md + affect.md + plan.md, confirms with user |
| `/fd-review [--topic=<slug>]` | Two-lens review (CEO premise challenge + eng design review), confirms or requests revisions |
| `/fd-execute [--topic=<slug>] [--override]` | TDD implementation with parallel worktree guard, per-step RED-GREEN-REFACTOR-COMMIT cycle, per-step review |
| `/fd-verify [--topic=<slug>]` | Full verification: test suite, regression check, code review, security scan; blocks `/fd-done` on failure |
| `/fd-done [--topic=<slug>]` | Close task — summarizes built vs required, commits, pushes on confirmation |

### Utility Commands

| Command | Description |
|---|---|
| `/fd-status [--topic=<slug> \| --all]` | Show pipeline stage, artifact status, blockers for active topic or all topics |
| `/fd-resume [--yes]` | Restore from checkpoint.json (falls back to STATE.md), confirms before continuing |
| `/fd-checkpoint` | (Internal) Force-save session state — normally written automatically on session.idle |

---

## FDX Native CLI

FlowDeck ships with a Rust-native code intelligence CLI (`fdx`) that provides fast, AST-aware file operations. When the binary is unavailable, every tool falls back to a TypeScript implementation — the system remains fully functional, though some operations (AST parsing, symbol-aware diff) degrade to simpler text-based equivalents.

### Available Commands

| Command | Description | Rust Native | TS Fallback |
|---|---|---|---|
| `fdx read` | AST-aware file reading (prototype/deep/raw modes) | ✅ tree-sitter | ✅ text slice |
| `fdx search` | Identifier and symbol search | ✅ AST | ✅ substring grep |
| `fdx grep` | Regex pattern matching with context | ✅ regex | ✅ substring (no regex) |
| `fdx batch` | Multi-file read with glob expansion | ✅ glob + AST | ✅ per-file read |
| `fdx impact` | Cross-file dependency analysis | ✅ AST import scan | ✅ regex import scan |
| `fdx outline` | Project-wide symbol outline | ✅ AST | ✅ regex declarations |
| `fdx diff` | Symbol-aware git diff (dual-AST) | ✅ tree-sitter diff | ✅ plain git diff |
| `fdx git` | Read-only git operations | ✅ policy-enforced | ✅ same |
| `fdx ls` | Compact directory listing | ✅ structured | ✅ flat list |
| `fdx tree` | Gitignore-aware directory tree | ✅ tree | ✅ flat list |
| `fdx test` | Failures-only test runner wrapper | ✅ output filter | ✅ same |
| `fdx lint` | Failures-only lint wrapper | ✅ output filter | ✅ same |
| `fdx context` | Per-topic agent-output log | ✅ advisory lock | ✅ same |
| `fdx decisions` | Per-topic design-decision log | ✅ advisory lock | ✅ same |

### Security Properties

- **Read-only git policy** — blocks all mutating git operations (`commit`, `push`, `merge`, `rebase`, `checkout`, `reset`, `branch -d`, `tag -d`, `stash drop`, etc.)
- **Shell-free execution** — all subprocess invocations use `execFileSync` with `shell: false` and argument arrays
- **Executable allowlist** — only `fdx`, `git`, `npm`, `bun`, `vitest`, `oxlint`, `tsc`, `node` are permitted
- **NUL byte rejection** — rejected in both executable names and arguments
- **Argument size caps** — 100 max args, 16KB per arg, 64KB total

### Native Fallback Improvements (v0.8.0-alpha.12)

- **`nativeImpactFallback`** — scans TypeScript/JavaScript import and require statements for dependency inference, replacing the previous no-op placeholder
- **`nativeOutlineFallback`** — regex-based detection of functions, classes, interfaces, traits, structs across TypeScript, Rust, Python, and Go
- **`.gitignore` filtering** — `nativeSearchFallback` now loads root `.gitignore` patterns and honors them during directory walk, in addition to the hardcoded exclude list (`node_modules`, `.git`, `dist`, `target`, `.next`, `.cache`)

---

## PR Monitor

The FDX PR Monitor is an event-driven CI auto-repair system that detects workflow failures, collects logs, classifies root causes, and attempts automated repair within a bounded retry budget.

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

### State Machine

```
IDLE → FAILURE_DETECTED → CLAIMED → LOGS_COLLECTED → CLASSIFIED → 
REPAIRING → LOCAL_VALIDATION → PUSHING → WAITING_FOR_NEW_CI → GREEN
```

**Terminal exits:** `BLOCKED`, `STALE_HEAD`, `MAX_ATTEMPTS_REACHED`, `INFRASTRUCTURE_FAILURE`, `MODEL_FAILED`, `LOCAL_VALIDATION_FAILED`

### Tool Interface

```typescript
fdx-pr-monitor({
  action: "start" | "stop" | "status" | "run_once" | "repair_now",
  repo?: "heidi-dang/FlowDeck",
  pr?: 32,
  mode?: "observe" | "auto_fix",
  max_attempts?: 3,
  retry_flaky_once?: true
})
```

### Safety Protections

- **SHA-based dedup** — one repair per PR head SHA at a time
- **Circuit breaker** — maximum 3 repair attempts per head SHA
- **Stale head detection** — re-reads PR before pushing; aborts if another commit landed
- **Fork PR protection** — same-repository-only push policy
- **Prohibited paths** — `release.yml`, `.env` files cannot be modified
- **Flaky classification** — infrastructure and timeout failures are retried once before code repair
- **No auto-merge or release** — monitor never merges or publishes

---

## Tools (27)

| ID | Tool | Source | Native Fallback |
|---|---|---|---|
| 1 | `doctor` | `src/tools/doctor.ts` | N/A |
| 2 | `planning-state` | `src/tools/planning-state.ts` | N/A |
| 3 | `codebase-state` | `src/tools/codebase-state.ts` | N/A |
| 4 | `repo-memory` | `src/tools/repo-memory.ts` | N/A |
| 5 | `hash-edit` | `src/tools/hash-edit.ts` | N/A |
| 6 | `codegraph` | `src/tools/codegraph-tool.ts` | N/A |
| 7 | `load-rules` | `src/tools/load-rules.ts` | N/A |
| 8 | `list-rules` | `src/tools/load-rules.ts` | N/A |
| 9 | `capture-lesson` | `src/tools/capture-lesson.ts` | N/A |
| 10 | `review-lessons` | `src/tools/capture-lesson.ts` | N/A |
| 11 | `debug-audit` | `src/tools/debug-logs.ts` | N/A |
| 12 | `fdx-validate` | `src/tools/fdx-validate.ts` | N/A |
| 13 | `fdx-worktree` | `src/tools/fdx-worktree.ts` | N/A |
| 14 | `fdx-pr-monitor` | `src/tools/fdx-pr-monitor.ts` | N/A |
| 15–28 | `fdx-*` (14 tools) | `src/tools/fdx.ts` + `src/tools/fdx-shared.ts` | ✅ TS fallback |

---

## Architecture

```
OpenCode (model access, sessions, core tools, UI)
  |
  +-- FlowDeck Plugin (src/index.ts)
        |
        +-- Configuration (src/config/)
        |     +-- Schema validation (JSON/JSONC)
        |     +-- Agent model overrides
        |     +-- Governance settings (supervisor, guards, budgets)
        |
        +-- Agent Registry (src/agents/)
        |     +-- Heidi (default primary agent, depth-0 execution)
        |     +-- 12 specialized agents (depth-1, task:deny)
        |     +-- Canonical registry + capability contracts
        |     +-- Runtime agent-policy enforcement
        |
        +-- Commands (src/commands/)
        |     +-- 8 markdown-based slash commands
        |     +-- Pipeline: task → review → execute → verify → done
        |     +-- Utilities: status, resume, checkpoint
        |
        +-- Hooks (src/hooks/)
        |     +-- Tool guard (execution control, design gate)
        |     +-- Guard rails (plan-confirmed gate, lockfile)
        |     +-- Orchestrator guard (delegation depth, budgets)
        |     +-- Session lifecycle (start, idle, end, events)
        |     +-- Command reference guard (invalid command detection)
        |
        +-- Services (src/services/)
        |     +-- Governance wiring (validator, supervisor, audit)
        |     +-- Loop detector + recovery layer
        |     +-- Token budget + tool-selection policy
        |     +-- PR Monitor (event-driven CI auto-repair)
        |     +-- Verification layer + shell-command classifier
        |
        +-- Tools (src/tools/)
        |     +-- 27 registered tools (14 FDX, 13 other)
        |     +-- FDX shared infrastructure (fdx-shared.ts)
        |     +-- Executable allowlist + argument validation
        |     +-- Git read-only policy enforcement
        |
        +-- Skills (src/skills/)
        |     +-- 61 validated workflow patterns (SKILL.md)
        |
        +-- MCP (src/mcp/)
        |     +-- Model Context Protocol server configurations
        |
        +-- FDX Native (crates/fdx/)
              +-- 15 CLI subcommands, 6,912 lines of Rust
              +-- tree-sitter AST parsing (5 languages)
              +-- Dual-AST symbol diff engine
              +-- Advisory file-locked context/decisions logging
```

### Boundary Summary

| Layer | Responsibility |
|---|---|
| **OpenCode core** | Model access, sessions, core tool execution, UI |
| **FlowDeck plugin** | Agent orchestration, governance, hooks, skills, CI monitoring |
| **FDX (Rust)** | High-performance code intelligence (optional, with TS fallbacks) |
| **PR Monitor** | Event-driven CI failure detection and auto-repair |

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

## Verification

```bash
# Level 1 — CLI resolves
flowdeck --version

# Level 2 — Package identity and plugin registration
flowdeck verify

# Level 3 — Full diagnostics (exit code 0/1/2)
flowdeck doctor

# Level 4 — OpenCode smoke test (requires restart)
opencode run "inspect this project" --agent heidi
```

### Pre-Push Gate

```bash
node scripts/pre-push.mjs
```

Runs lint, typecheck, build, and tests on changed files. Required before all commits.

---

## Development

```bash
npm ci
npm run build
npm run lint           # oxlint --deny-warnings
npm run typecheck       # tsc --noEmit
npm test                # bun test (full suite)
npm run test:coverage   # coverage check
npm run validate:skills # skill file integrity
npm run validate:docs   # documentation integrity
node scripts/pre-push.mjs  # pre-push gate
```

### Rust Development

```bash
# Install Rust toolchain
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Build and test FDX CLI
cargo build --manifest-path crates/fdx/Cargo.toml
cargo test --manifest-path crates/fdx/Cargo.toml --all
cargo clippy --manifest-path crates/fdx/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path crates/fdx/Cargo.toml --check
```

See [Development](docs/wiki/Development.md) for detailed contribution guidelines.

---

## Roadmap

### v0.8.0-alpha.12 (Current)
- [x] Heidi master orchestration with depth-1 delegation
- [x] 13 specialized agents and 61 validated skills
- [x] 8 slash commands with full planning pipeline
- [x] 27 registered tools with governance
- [x] Tool governance: allowlist, git policy, budgets, audit logging
- [x] Guard rails: plan-confirmed gate, lockfile, auto-recover, design gate
- [x] Exit-code contract: canonical 0/1/2 implementation
- [x] 14 FDX tools with Rust backing + TS fallbacks
- [x] Real fallbacks: `nativeImpactFallback`, `nativeOutlineFallback`
- [x] `.gitignore` filtering in search fallback
- [x] FDX file split: `fdx-shared.ts` + `fdx.ts`
- [x] Rust: `SymbolChangeEntry` refactor, migration fix, clippy clean
- [x] PR Monitor: event-driven CI auto-repair system
- [x] Installation ownership tracking and safe uninstall
- [x] Deterministic doctor exit codes
- [x] Merge auto-stash in worktree tool

### Planned
- **Better Harness** — repository analysis, evidence-based scoring, remediation planning, and verification for AI-produced code changes
- Web UI reporting for governance and audit data
- Expanded skill library
- PR Monitor: GitHub App webhook integration

---

## Security

- FlowDeck governance operates within OpenCode's permission model — it is not an operating-system sandbox.
- All subprocess invocations use `execFileSync` with `shell: false` and argument arrays — no shell command injection.
- An executable allowlist restricts which binaries can be spawned: `fdx`, `git`, `npm`, `bun`, `vitest`, `oxlint`, `tsc`, `node`.
- Git operations enforce a read-only policy — mutating commands (`commit`, `push`, `merge`, etc.) are blocked at the validation layer.
- Users remain responsible for provider credentials and tool permissions.
- Report security vulnerabilities through GitHub Issues (private disclosure preferred).

---

## License

MIT — see [LICENSE](LICENSE)

*Upstream source: [DVNghiem/FlowDeck](https://github.com/DVNghiem/FlowDeck)*
