# FlowDeck

> FlowDeck is a persistent, governed multi-agent engineering runtime for OpenCode.
> Heidi coordinates specialist agents, Rust-native code intelligence, durable orchestration, evidence-backed learning, safe parallel execution, verification, and CI repair.

[![npm version](https://img.shields.io/npm/v/@heidi-dang/flowdeck.svg)](https://www.npmjs.com/package/@heidi-dang/flowdeck)
[![CI](https://github.com/heidi-dang/FlowDeck/actions/workflows/ci.yml/badge.svg)](https://github.com/heidi-dang/FlowDeck/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

| Metric / Specification | Value |
|---|---|
| **Version** | v2.1.0 |
| **Primary Coordinator** | `heidi` (UI-selectable) |
| **Specialist Agents** | 11 specialized subagents |
| **Slash Commands** | 15 registered commands (`/fd-*`) |
| **Validated Skills** | 89 modular skills |
| **Custom Tools** | 36 governance, FDX & runtime tools |
| **Database Schema** | SQLite v11 migration (53 tables, 36 triggers, 66 indexes) |
| **Runtime Requirements** | OpenCode >= 1.4.0, Node.js >= 20.0.0, Bun |

---

## Table of Contents

- [Why FlowDeck](#why-flowdeck)
- [Quick Start](#quick-start)
- [What is Heidi?](#what-is-heidi)
- [How FlowDeck Executes Work](#how-flowdeck-executes-work)
- [Parallel Engineering Execution](#parallel-engineering-execution)
- [Persistent Agent Runtime](#persistent-agent-runtime)
- [Specialist Agents](#specialist-agents)
- [FDX Code Intelligence](#fdx-code-intelligence)
- [Commands](#commands)
- [Skills](#skills)
- [Verification & Better Harness](#verification--better-harness)
- [CI Auto-Repair](#ci-auto-repair)
- [Safety & Governance](#safety--governance)
- [Installation / Upgrade](#installation--upgrade)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [Compatibility](#compatibility)
- [Development](#development)
- [Release Status](#release-status)
- [License](#license)

---

## Why FlowDeck

OpenCode provides lightweight LLM agent sessions, but complex software engineering workloads require structured coordination, durable state, token governance, safe parallel editing, and automated verification.

FlowDeck transforms OpenCode into a governed engineering runtime by introducing:

- **Heidi Execution Coordinator**: Direct execution by default, delegating only when justified by domain or parallel boundaries.
- **Durable Parallel Execution Engine v2**: Dependency-aware DAG scheduling, adaptive concurrency, atomic token reservations, and isolated worktree editing.
- **Persistent State & Recall**: Cross-session SQLite memory, FTS session archiving, and evidence-backed post-completion learning.
- **FDX Code Intelligence**: High-performance Rust-native symbol indexing, search, outline, and impact analysis with TypeScript fallbacks.
- **Pre-push & Verification Gates**: Empirical test verification, 80%+ coverage enforcement, and automated CI repair.

---

## Quick Start

### Installation

```bash
curl -fsSL https://raw.githubusercontent.com/heidi-dang/flowdeck/main/install.sh | bash
```

### Basic Workflow

```bash
# Start a governed engineering task in OpenCode
/fd-task "Implement JWT authentication endpoint with tests"

# Check active parallel specialist runs and delegation DAG
/fd-agents list

# Run integrated verification gate
/fd-verify

# Complete task and checkpoint state
/fd-done
```

---

## What is Heidi?

**Heidi** is FlowDeck's primary execution coordinator. Unlike legacy orchestrators that delegate every trivial task to subagents, Heidi executes work directly using built-in read/write tools, shell inspection, and code intelligence. She delegates to specialist agents **only when justified**:

1. Explicit user request for a specialist.
2. Independent tasks with non-overlapping file ownership (parallel workstreams).
3. Specialized domain expertise (e.g. security audit, infrastructure).
4. Read-only audit or threat review.
5. Direct repository discovery failure.
6. Multi-domain spanning changes requiring coordinated ownership.

---

## How FlowDeck Executes Work

FlowDeck follows a strict 6-stage lifecycle for engineering tasks:

```
┌─────────┐     ┌─────────┐     ┌─────────┐     ┌─────────┐     ┌─────────┐     ┌──────────┐
│ Intake  │ ──► │  Route  │ ──► │ Context │ ──► │ Execute │ ──► │ Verify  │ ──► │ Complete │
└─────────┘     └─────────┘     └─────────┘     └─────────┘     └─────────┘     └──────────┘
```

1. **Intake**: Understand prompt, goal, and constraints.
2. **Route**: Select strategy (`fast_direct`, `direct`, `planner_then_execute`, `frontend_backend_parallel`, etc.).
3. **Context**: Surface-area check (dependents, existing tests, config, error paths).
4. **Execute**: Direct file edits or dispatch justified parallel specialists.
5. **Verify**: Unit tests, typechecks, build, and empirical evidence check.
6. **Complete**: Summarize changes, test results, and save checkpoint.

Pipeline sequence:
`/fd-task` → `/fd-review` → `/fd-execute` → `/fd-verify` → `/fd-done`

---

## Parallel Engineering Execution

FlowDeck v2 introduces the **Heidi Parallel Execution Engine v2** — a dependency-aware, durable specialist execution graph designed specifically for software engineering workloads.

### Comparison: Earlier Delegation vs Heidi Engine v2

| Feature / Dimension | Earlier Heidi | Heidi Parallel Engine v2 |
|---|---|---|
| **Execution Model** | Sequential / batch delegation | Dependency-aware DAG wave scheduler |
| **Concurrency Control** | Fixed max concurrency cap | Adaptive concurrency based on budget & provider load |
| **Token Governance** | Post-dispatch check | Pre-dispatch atomic token reservation |
| **Write Isolation** | Shared working tree | Isolated Git worktrees (`fdx-worktree`) per writer |
| **Conflict Handling** | Overlapping write races | Write-scope prediction & deterministic conflict review |
| **Persistence** | Session-scoped memory | SQLite-backed durable DAG runs (`heidi_delegation_runs`) |
| **Restart Recovery** | Interrupted jobs lost | Automatic restart recovery & safe unverified write blocking |
| **Dependency Scheduling**| Wait for entire batch | Incremental fan-in; unblock dependents immediately |
| **Failure Scope** | Single failure halts batch | Partial failure isolation; independent nodes continue |

### Execution Graph Example

```
Task: Add authenticated user endpoint
                    Heidi
                      │
           DAG Dependency Analysis
                      │
       ┌──────────────┼──────────────┐
       │              │              │
   researcher       mapper       security
   read-only        read-only      read-only
       │              │              │
       └───────┬──────┴───────┬──────┘
               │              │
          backend-coder    tester
         (worktree A)    (worktree B)
               │              │
               └──────┬───────┘
                      │
             Integration & Merge
                      │
             Integrated Verify
```

---

## Persistent Agent Runtime

Heidi operates as a persistent engineering runtime across sessions:

| Aspect | Capability |
|---|---|
| **Memory** | Persistent USER, AGENT, and REPO memory graph stored in `.codebase/MEMORY.json` and SQLite. |
| **Session Archive** | Full FTS (Full-Text Search) session indexing allowing cross-session recall (`/fd-recall`). |
| **Evidence Learning**| Post-completion evidence harvesting into versioned learned skills (`/fd-learn-from-session`). |
| **Governance** | Strict tool allowlists, read-only git guards, and command authorization hooks. |
| **Budgeting** | Hierarchical token controller with run ceilings, child limits, and atomic reservations. |

---

## Specialist Agents

The FlowDeck agent registry consists of **Heidi** (primary coordinator) plus **11 specialist subagents**:

| Agent ID | Role / Specialization | Mode | Allowed Tools |
|---|---|---|---|
| **`heidi`** | Primary execution coordinator & direct coder | Primary | Full tool access (`read`, `write`, `edit`, `bash`, FDX, etc.) |
| **`orchestrator`** | Compatibility alias for Heidi | Primary | Inherits Heidi capabilities |
| **`planner`** | Task breakdown, step decomposition, and wave sizing | Subagent | Read, glob, grep, planning-state |
| **`architect`** | System design, ADRs, and API contract specifications | Subagent | Read, glob, grep, codegraph |
| **`researcher`** | Research documentation, vendor APIs, and libraries | Subagent | Read, search, webfetch, context7 |
| **`mapper`** | Codebase exploration and structural mapping | Subagent | Read, glob, grep, fdx-read, fdx-outline |
| **`backend-coder`** | Backend API, data layer, and business logic implementation | Subagent | Read, write, edit, patch, bash, FDX |
| **`frontend-coder`** | UI components, state management, and styling implementation | Subagent | Read, write, edit, patch, bash, FDX |
| **`devops`** | CI/CD, Docker, infrastructure scripts, and configuration | Subagent | Read, write, edit, patch, bash, FDX |
| **`tester`** | Test suite implementation following TDD principles | Subagent | Read, write, edit, patch, bash, fdx-test |
| **`reviewer`** | Code quality, blast radius, and regression review | Subagent | Read, glob, grep, fdx-diff, fdx-impact |
| **`security-auditor`**| OWASP Top 10, auth, injection, and secret vulnerability audit | Subagent | Read, glob, grep, security-scan |
| **`debug-specialist`**| Systematic root cause analysis and build/type failure repair | Subagent | Read, edit, bash, fdx-test, fdx-lint |

---

## FDX Code Intelligence

FDX is FlowDeck's Rust-native code intelligence CLI (`crates/fdx`), built for high performance and low token consumption. When the binary is not present, FlowDeck falls back seamlessly to TypeScript implementations.

### Supported FDX Commands

#### Discovery
- `fdx search <query>`: Fast identifier and symbol search.
- `fdx grep <pattern>`: Pattern matching with token-optimized context lines.
- `fdx tree [path]`: Gitignore-aware directory tree visualization.
- `fdx ls [path]`: Compact directory listing (directories grouped first).

#### Structural Analysis
- `fdx read <file>`: Token-optimized file reader (supports `prototype`, `deep`, and `raw` modes).
- `fdx outline [paths...]`: Project-wide symbol and function hierarchy outline.
- `fdx impact <files...>`: Dependency and caller impact analysis.
- `fdx diff [commit]`: Symbol-aware git diff displaying changed definitions.

#### Batch Execution
- `fdx batch <files...>`: Read multiple files in a single call to minimize round trips.

#### Verification
- `fdx test [args...]`: Failures-only test runner wrapper (strips passing test noise).
- `fdx lint [args...]`: Failures-only linter wrapper (groups findings by file).

#### Durable Context
- `fdx context <action>`: Topic-based agent context log manager.
- `fdx decisions <action>`: Design-decision logger with rationale and ownership.

---

## Commands

FlowDeck registers **15 slash commands** with OpenCode:

| Command | Description |
|---|---|
| `/fd-task` | Start a new governed task pipeline (`intake` → `route` → `context`) |
| `/fd-review` | Perform architecture, blast-radius, and safety review before execution |
| `/fd-execute` | Execute planned task steps directly or via parallel specialists |
| `/fd-verify` | Run unit tests, typechecks, linters, and verification rules |
| `/fd-done` | Finalize task, summarize changes, and record completion evidence |
| `/fd-status` | Display current task phase, active step, and session health |
| `/fd-resume` | Resume an interrupted or checkpointed session |
| `/fd-checkpoint` | Explicitly save current session state checkpoint |
| `/fd-agents` | Operational view & control of durable delegated child runs |
| `/fd-schedule` | Manage scheduled autonomous background tasks |
| `/fd-memory` | Read or update persistent repository memory graph |
| `/fd-recall` | Search cross-session FTS archive for past decisions and context |
| `/fd-learning` | List and inspect evidence-backed learned skills |
| `/fd-learn` | Extract reusable lesson from recent session work |
| `/fd-learn-from-session` | Harvest evidence from completed session into a versioned skill |

---

## Skills

FlowDeck ships with **89 validated skills** under `src/skills/<name>/SKILL.md`. Categories include:

- **Architecture & Design**: `clean-architecture`, `hexagonal-architecture`, `ddd-architecture`, `cqrs`, `saga-architecture`, `api-design`, `app-shell-design`.
- **Language Patterns**: `typescript-patterns`, `python-patterns`, `rust-patterns`, `golang-patterns`, `java-patterns`, `django-patterns`, `postgres-patterns`.
- **Testing & Quality**: `tdd-workflow`, `test-coverage`, `test-gap-detector`, `django-tdd`, `verification-before-completion`.
- **Security & Audit**: `security-scan`, `arch-constraint-guard`, `dependency-audit`, `human-review-routing`, `patch-trust-score`.
- **Workflow & Harness**: `executing-plans`, `writing-plans`, `agent-harness-construction`, `context-steward`, `failure-replay-engine`, `regression-prediction`.

---

## Verification & Better Harness

FlowDeck enforces empirical verification before declaring any task complete:

- **Red-Green-Refactor**: TDD cycle enforced for new features and bug fixes.
- **Coverage Ceiling**: Minimum **80% line coverage** required for modified code.
- **Regression Lock**: Failing test mandatory before applying bug fixes.
- **Pre-Push Script**: `node scripts/pre-push.mjs` executes linting, typechecking, and test suites prior to pushing.

---

## CI Auto-Repair

The **FDX PR Monitor** (`fdx-pr-monitor`) runs event-driven auto-repair cycles on GitHub PRs:

1. **Detect**: Polls CI status for test or build failures.
2. **Classify**: Categorizes failure into compilation, test failure, lint error, or infrastructure flake.
3. **Isolate & Repair**: Spawns isolated `@debug-specialist` worktree to diagnose and apply minimal fix.
4. **Validate**: Runs local test verification suite.
5. **Push**: Pushes repair commit directly to the PR branch.

---

## Safety & Governance

FlowDeck incorporates multi-layered defense baselines:

- **Prompt Injection Protection**: Refuses instructions overriding system behavior or system prompts.
- **Secret Protection**: Automatic redaction of API keys, tokens, and credentials in logs and outputs.
- **Executable Allowlist**: Restricts shell tool execution to safe, declared commands (`git`, `bun`, `npm`, `tsc`, `cargo`, `pytest`).
- **Read-Only Git Policy**: Mutating git operations on tracked branches are blocked or diverted to worktrees.
- **Self-Delegation Guard**: Prevents recursive agent self-calls.

---

## Installation / Upgrade

### Guided Installer

Run the self-contained installation script:

```bash
curl -fsSL https://raw.githubusercontent.com/heidi-dang/flowdeck/main/install.sh | bash
```

### Manual Installation via NPM

```bash
npm install -g @heidi-dang/flowdeck
flowdeck install
```

### Verify Installation

```bash
flowdeck doctor
```

---

## Architecture

FlowDeck follows a clean hexagonal architecture backed by SQLite persistence:

```
src/
├── agents/             # Canonical agent definitions & factories
├── commands/           # Command definition specifications
├── config/             # Configuration schemas (token budget, governance, FDX)
├── doctor/             # Environment & health diagnostic engine
├── hooks/              # OpenCode lifecycle event hooks & guards
├── mcp/                # Context7 & Exa MCP server integrations
├── orchestration/      # Core execution engine
│   ├── commands/       # Durable command execution service
│   ├── events/         # Event bus & publisher
│   ├── execution/      # Worktree executor, scheduler & sqlite repository
│   └── persistence/    # SQLite migrations (v1 - v11) & transactions
├── services/           # Parallel Engine v2, Token Controller, FDX index, Memory
├── skills/             # 61 validated SKILL.md modules
└── tools/              # 36 custom OpenCode tool definitions
```

---

## Configuration

FlowDeck reads configuration from `.flowdeck.json` or `opencode.json` in the project root:

```json
{
  "governance": {
    "mode": "strict",
    "maxDelegationDepth": 1,
    "maxToolCalls": 100
  },
  "parallelExecution": {
    "enabled": true,
    "maxChildren": 6,
    "defaultTarget": 4,
    "maxWriteChildren": 3,
    "childTimeoutMs": 600000,
    "retryLimit": 1,
    "adaptive": true
  },
  "tokenBudget": {
    "enabled": true,
    "profile": "normal",
    "runTotal": 500000,
    "childTotal": 100000
  }
}
```

---

## Compatibility

- **OpenCode**: `>= 1.4.0`
- **Node.js**: `>= 20.0.0`
- **Bun**: `>= 1.0.0` (required for build and native test runner)
- **Platforms**: Linux (x64/arm64), macOS (x64/arm64), Windows (x64 via WSL2/Native)

---

## Development

### Prerequisites

- Node.js >= 20
- Bun >= 1.0

### Setup & Test

```bash
# Clone repository
git clone https://github.com/heidi-dang/FlowDeck.git
cd FlowDeck

# Install dependencies
bun install

# Build TypeScript output
bun run build

# Run unit and integration test suite
bun test

# Run full release verification gate
bun run verify:full
```

---

## Release Status

- **Current Version**: `v2.1.0`
- **Track**: Stable (`@latest`)
- **Status**: Official stable release. Production-ready core orchestration, parallel DAG engine, persistent Heidi runtime, and verification gates complete.

---

## License

FlowDeck is released under the [MIT License](LICENSE).

Copyright © 2026 [Heidi Dang](https://github.com/heidi-dang). All rights reserved.
