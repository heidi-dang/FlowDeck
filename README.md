# FlowDeck

[![npm version](https://img.shields.io/npm/v/@heidi-dang/flowdeck.svg)](https://www.npmjs.com/package/@heidi-dang/flowdeck)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**FlowDeck v2.5.0** is a production-grade orchestration engine and OpenCode plugin that delivers deterministic task routing, bounded repository intelligence, dynamic specialist coordination, rigorous verification, and high-performance code intelligence for complex software development.

**14 registered agents** | **11 specialized subagents** | **89 validated skills** | **15 registered commands**

---

## What FlowDeck Is

FlowDeck extends OpenCode with deterministic orchestration and repository intelligence. Rather than attempting to replace OpenCode's execution environment or inventing a competing model sandbox, FlowDeck acts as an intelligent governor and coordinator. It classifies developer requests, consults bounded repository evidence, creates dependency-ordered specialist plans, dispatches work through OpenCode's native subagent Task lifecycle, and strictly validates evidence before allowing any run to terminate.

FlowDeck ensures that AI development workflows are reproducible, auditable, safe, and convergent.

---

## Core Design

FlowDeck maintains strict, unambiguous authority boundaries across all participating subsystems:

- **OpenCode**: The sole execution authority. OpenCode owns interactive sessions, native tools, permissions, filesystem sandboxing, and the underlying native Task and subagent lifecycle. FlowDeck never bypasses or duplicates OpenCode's execution substrate.
- **Heidi**: The central orchestration authority. Heidi analyzes incoming developer intent, selects the deterministic execution strategy, manages orchestration state transitions, and guides task dispatch.
- **Repo Master**: The advisory repository intelligence authority. Repo Master provides bounded, read-only repository context (file architecture, hot-context caches, Git change fingerprints) to inform planning. Repo Master is strictly advisory and has no execution or completion authority.
- **SpecialistPlan**: The specialist selection and validation authority. It translates routing decisions and advisory repository context into an immutable, dependency-ordered, deduplicated specialist execution graph, enforcing strict fan-out limits (default cap: 3) and preserving inherited model and tool policies.
- **VerificationService**: The verification authority. It evaluates objective verification evidence (test outputs, typecheck results, linter runs, schema conformance) against defined criteria. A passing check from `VerificationService` certifies evidence validity but does not directly modify terminal state.
- **CompletionPolicy**: The sole terminal-completion authority. Only `CompletionPolicy` can evaluate the full aggregation of run requirements, active assignments, verification results, and termination preconditions to transition a run to terminal completion.
- **FDX**: The high-performance Rust-native repository, code, and change intelligence subsystem. FDX performs AST parsing, dependency mapping, structural search, and safe Git diff analysis.

| Component | Authority Role | Boundary / Guarantee |
|---|---|---|
| **OpenCode** | Execution & Tool Authority | Native sessions, tool permissions, sandboxing, and Task dispatch. |
| **Heidi** | Orchestration Authority | Workflow classification, state transition management, and strategy coordination. |
| **Repo Master** | Advisory Intelligence | Bounded, read-only repository context; never executes tools or completes runs. |
| **SpecialistPlan** | Specialist Planning Authority | Dependency ordering, deduplication, fan-out caps, and policy inheritance. |
| **VerificationService** | Verification Evaluation | Objective evaluation of test and verification evidence against pass/fail criteria. |
| **CompletionPolicy** | Sole Terminal Completion Authority | Terminal completion evaluator; prose or unverified advice cannot complete runs. |
| **FDX** | Code & Change Intelligence | High-speed AST parsing, dependency graphs, and robust Git diff analysis. |

---

## Adaptive Execution

FlowDeck routes developer tasks adaptively using three deterministic execution modes based on task complexity, structural scope, and repository risk:

### 1. DIRECT (`FAST_DIRECT`)
Used for self-contained, low-risk, or single-file operations (e.g. localized edits, typo fixes, simple queries, or quick doc updates).
- **Behavior**: Bypasses specialist subagent fan-out and advisory overhead. Heidi coordinates the action directly within the primary session.
- **Example**: `"Fix the typo in src/config/defaults.ts and update the inline comment."`

### 2. SINGLE_SPECIALIST (`SINGLE_SPECIALIST`)
Used for focused tasks that require domain expertise in a single functional area (e.g. backend implementation, frontend refactor, security audit, or dedicated test authoring).
- **Behavior**: Heidi consults advisory repository context if needed, constructs a single-assignment `SpecialistPlan`, and delegates execution to the appropriate native OpenCode specialist subagent.
- **Example**: `"Implement the SQLite transactional run writer in src/orchestration/persistence/."`

### 3. MULTI_SPECIALIST (`MULTI_SPECIALIST`)
Used for cross-cutting, repository-significant architectural features, multi-stage migrations, or complex full-stack changes.
- **Behavior**: Heidi invokes Repo Master for bounded architectural and dependency intelligence, generates a multi-stage `SpecialistPlan` with explicit dependency ordering (DAG), deduplicates overlapping scopes, enforces the fan-out cap, and dispatches subagents sequentially or concurrently as dependencies allow.
- **Example**: `"Refactor the authentication middleware across API routes, add integration test coverage, and update client session management."`

---

## Repo Master

Repo Master delivers bounded, fast, advisory repository intelligence to inform planning without unbounded exploration loops:

- **Advisory Only**: Repo Master produces structured advice (architectural boundaries, file hotspots, dependency relationships) to guide `SpecialistPlan`. It cannot execute tools, write files, or mark tasks complete.
- **Bounded Exploration**: Operates within strict token and time budgets. It never performs recursive file scans or unbounded search loops.
- **Repository Fingerprint**: Computes deterministic fingerprints based on repository state (HEAD commit SHA, working tree dirty status, and file modification markers) to bind intelligence to the exact codebase state.
- **Cache & Freshness**: Reuses warm in-memory context and FDX AST indexes; automatically invalidates cached intelligence when file modification times or Git SHAs change.
- **Restart Behavior**: Ephemeral advisory state is safely discarded upon session restart. Durable runs re-evaluate repository context against the current working tree.
- **Repository Isolation**: Scoped strictly to the target repository workspace; cannot inspect or leak data across project boundaries.
- **Stale-State Invalidation**: Any file modification or branch shift immediately invalidates advisory caches, preventing stale planning.
- **What It Cannot Do**: Repo Master cannot execute shell commands, cannot write code, cannot bypass security policies, and cannot authorize task completion.

---

## Dynamic Specialists

FlowDeck orchestrates specialized capabilities dynamically while maintaining rigorous operational control:

- **Capability-Driven Roles**: Specialists represent distinct functional capabilities (e.g., `@planner`, `@backend-coder`, `@frontend-coder`, `@tester`, `@reviewer`, `@security-auditor`, `@devops`, `@debug-specialist`).
- **Bounded Fan-Out**: The `SpecialistPlan` enforces a strict concurrency and count cap (default maximum: 3 active specialists per stage) to prevent resource exhaustion and token explosion.
- **Explicit Dependency Graph**: Specialist assignments form an acyclic dependency graph (`dependsOn`). Downstream specialists do not start until prerequisite specialist assignments successfully complete.
- **Native OpenCode Task Execution**: Each specialist assignment executes as a native OpenCode subagent Task with clean execution isolation and standard OpenCode tool permissions.
- **No Recursive Uncontrolled Delegation**: Specialists are strictly prohibited from spawning their own independent subagent trees. Only Heidi coordinates planning and delegation.
- **Global Model Inheritance**: All specialists strictly inherit the user's globally configured OpenCode model. FlowDeck never silently substitutes models behind the user's back.

---

## Reliability

FlowDeck is engineered with a fail-closed, transactionally consistent reliability architecture:

- **Durable Run and Assignment State**: All orchestration lifecycle events, plans, assignments, and verification outputs are persisted in a local SQLite database.
- **Restart Recovery**: If an OpenCode process or machine restarts mid-run, FlowDeck reconstructs the active run state, assesses completed assignments, and resumes execution without data loss or duplicate work.
- **Idempotency**: All state transitions and assignment dispatches are idempotent. Re-evaluating an existing state produces identical outcomes.
- **Convergence**: Orchestration loops must strictly converge toward completion. If progress stalls or cyclical failures occur, FlowDeck terminates the loop with explicit diagnostics.
- **Strategy Exhaustion**: When a planned execution strategy fails repeatedly or exceeds retry budgets, FlowDeck fails closed and requires human intervention rather than entering infinite repair loops.
- **Cancellation**: Active runs and pending specialist subagents can be cancelled cleanly, terminating child tasks and releasing resources.
- **Replacement & Modification (MODIFY)**: Assignments can be dynamically replaced or modified in response to runtime discoveries, with all modifications logged transactionally.
- **Fail-Closed Continuation Ambiguity**: If continuation conditions or session state become ambiguous, FlowDeck halts and requests clarification rather than making unverified assumptions.
- **Persistence Corruption Behavior**: If the persistence store becomes corrupted or unreadable, FlowDeck safely fails closed, preserves the corrupted file for diagnostics, and initialises a safe recovery state.

---

## Verification and Completion

FlowDeck enforces a non-negotiable separation between task output and completion verification:

$$\text{Specialist Output} \neq \text{Verification}$$
$$\text{Repo Master Advice} \neq \text{Verification}$$
$$\text{VerificationService PASS} \neq \text{Direct Terminal Mutation}$$

- **No Completion Through Prose**: A specialist claiming "all tests pass" or "task is complete" in markdown text has zero authority. Text claims are ignored by the completion engine.
- **Objective Evidence Required**: `VerificationService` evaluates real execution evidence—command exit codes, test runner JSON/TAP outputs, linter summaries, and compiler diagnostics.
- **Separation of Evaluation and Mutation**: A passing result from `VerificationService` records verification evidence but does not directly mutate run status.
- **CompletionPolicy Authority**: `CompletionPolicy` is the sole gatekeeper. It verifies that all mandatory specialist assignments are complete, all required verification checks have passed, no unresolved errors exist, and all goal criteria are met before transitioning a run to `COMPLETED`.

---

## FDX (FlowDeck Native Extension)

FDX is FlowDeck's Rust-native code intelligence and repository analysis engine, located in `crates/fdx/`:

- **File and Project Intelligence**: High-speed indexing of codebase structure, symbols, imports, and cross-file relationships using tree-sitter AST parsers.
- **Dependency and Code Analysis**: Real-time dependency graph resolution across TypeScript, JavaScript, Rust, Python, and Java.
- **Parsed Git Diff Safety**: Robust, hardened Git diff parsing that correctly handles multi-file diffs, binary files, rename detection, and edge cases.
- **Forced-Colour Hardening**: Safe diff and command execution even in terminal environments where ANSI forced-colour styling (`color.ui = always`) is active.
- **TypeScript Fallbacks**: Seamless TypeScript fallback implementations ensure full operational continuity on platforms or environments where native binaries are not yet compiled.

---

## Installation

### Recommended: Install via npm

Install FlowDeck globally or locally in your project using npm:

```bash
# Global installation (recommended for CLI and OpenCode plugin registration)
npm install -g @heidi-dang/flowdeck

# Register with OpenCode
flowdeck install
```

### Local Repository / Development Installation

To install and link FlowDeck directly from a local repository checkout:

```bash
# From the root of the cloned FlowDeck repository
./install.sh --local-repo .
```

### Bootstrap Installer Script

You can also use the atomic bootstrap installer script:

```bash
# Run doctor diagnostics without installing
curl -fsSL https://raw.githubusercontent.com/heidi-dang/flowdeck/main/install.sh | bash -s -- --doctor

# Standard installation
curl -fsSL https://raw.githubusercontent.com/heidi-dang/flowdeck/main/install.sh | bash
```

---

## Quick Start

### 1. Register FlowDeck with OpenCode
```bash
flowdeck install
```

### 2. Verify Your Installation
```bash
flowdeck verify
flowdeck doctor
```

### 3. Start OpenCode
Launch OpenCode in your project workspace. FlowDeck automatically activates as an OpenCode plugin:
```bash
opencode
```

### 4. Direct Task Execution
In your OpenCode prompt, interact naturally with Heidi:
```text
@heidi Run the test suite and fix any failing unit tests in the auth service.
```

---

## Configuration

FlowDeck respects standard OpenCode configuration and provides environment variables for granular control:

| Variable | Description | Default |
|---|---|---|
| `FLOWDECK_PROFILE` | Default doctor profile (`minimal`, `recommended-dev`, `full-dev`, `ci`, `release`) | `recommended-dev` |
| `FLOWDECK_STATE_DIR` | Directory path for SQLite persistence databases and orchestration state | `~/.flowdeck/state` or `.opencode/state` |
| `FLOWDECK_PLAN_DIR` | Directory path for persisted specialist plans | `~/.flowdeck/plans` |
| `FLOWDECK_GUARD_RAILS_ENABLED` | Enable runtime safety guardrails and command boundaries | `true` |
| `FLOWDECK_DISABLE_MCP` | Disable Model Context Protocol (MCP) server integration | `false` |
| `FDX_BINARY_PATH` | Path to custom compiled `fdx` native binary | Auto-detected |
| `FDX_DISABLE_FALLBACK` | Disable TypeScript fallback when native FDX binary is unavailable | `false` |

---

## Models

FlowDeck adheres to strict model transparency and predictability:

- **Single Globally Selected Model**: Heidi and all specialist subagents inherit the model configured in your OpenCode session or settings.
- **No Silent Model Swapping**: FlowDeck never swaps models behind the scenes (e.g. replacing a frontier model with a smaller model) without explicit user configuration.
- **Inherited Policy**: Specialist subagents execute under the exact same model parameters and provider settings as the primary session.

---

## Doctor / Diagnostics

FlowDeck includes comprehensive self-diagnostics to audit configuration, runtime dependencies, plugin health, and system requirements:

```bash
# Run comprehensive health check
flowdeck doctor

# Run doctor via npx
npx @heidi-dang/flowdeck doctor

# Run doctor with automated safe repair of detected issues
./install.sh --doctor --apply-recommended

# Run doctor with strict failure exit codes for CI/CD
flowdeck doctor --profile ci --strict
```

---

## Development

FlowDeck development uses Bun, Node.js, and Cargo:

```bash
# 1. Install dependencies
npm ci

# 2. Linting and static analysis
npm run lint

# 3. TypeScript type checking
npm run typecheck

# 4. Run test suite
npm test

# 5. Run test suite with coverage enforcement
npm run test:coverage

# 6. Build and test Rust FDX native crate
cargo fmt --all --check
cargo clippy -p fdx --all-targets --all-features -- -D warnings
cargo test -p fdx

# 7. Verify FDX TypeScript/Rust parity
npm run test:fdx-parity

# 8. Validate documentation and skills
npm run validate:docs
npm run validate:skills

# 9. Execute full pre-push release gate
node scripts/pre-push.mjs --full
```

---

## Testing Philosophy

FlowDeck maintains high test confidence through rigorous multi-layered qualification:

- **Production-Path Tests**: All tests execute against real production code paths rather than artificial test mocks.
- **Adversarial & Fault Tests**: Tests explicitly inject database corruption, filesystem errors, invalid ASTs, malformed Git diffs, and timeout conditions to verify fail-closed behavior.
- **Source-Bound Qualification**: All verification artifacts, schemas, and reports are directly derived and validated against repository source code.
- **Fresh-Clone Gates**: Every release candidate is verified from a clean, isolated repository clone (`npm ci`, clean build, and end-to-end qualification).
- **Cross-Platform CI**: Continuous integration matrices validate functionality across Ubuntu Linux, macOS, and Windows.

---

## Project Structure

```
flowdeck/
├── bin/                      # CLI entry point (flowdeck)
├── crates/
│   └── fdx/                  # Rust native AST & code intelligence engine
├── docs/                     # Documentation, release notes, and wiki
├── install.sh                # Bootstrap installer and clean reinstall script
├── package.json              # Package manifest and npm configuration
├── scripts/                  # Pre-push gates, doctor engine, and validation tools
├── src/
│   ├── agents/               # Registered agent and specialist definitions
│   ├── commands/             # OpenCode slash commands
│   ├── config/               # Configuration management and transaction engine
│   ├── doctor/               # Comprehensive diagnostic and repair checks
│   ├── hooks/                # OpenCode plugin lifecycle hooks
│   ├── mcp/                  # MCP server client integration
│   ├── orchestration/        # Heidi, Repo Master, SpecialistPlan, and Persistence
│   ├── services/             # VerificationService, CompletionPolicy, and Fast Router
│   ├── skills/               # 89 validated agent skills
│   └── tools/                # Native tool implementations and FDX bridges
└── tests/                    # Unit, integration, E2E, and adversarial test suites
```

---

## Security / Safety

- **Permission Enforcement**: All specialist actions execute within OpenCode's native permission and sandbox model. FlowDeck never bypasses configured permissions.
- **Fail-Closed Architecture**: Any unhandled exception, persistence failure, or verification ambiguity immediately halts execution in a safe state.
- **Secret Handling**: Credentials, tokens, and secret environment variables are stripped from persisted plans, run logs, and diagnostic reports.
- **No Completion Through Prose**: Task completion requires programmatic verification evidence; text-based conversational assertions cannot complete a run.
- **No Hidden Model Substitution**: Operates strictly with user-configured models without hidden routing to third-party endpoints.

---

## Contributing

1. Fork the repository and create a feature branch (`feat/your-feature-name`).
2. Implement your changes following existing architectural boundaries and test-driven conventions.
3. Ensure all tests, linting, typechecking, and docs validations pass:
   ```bash
   node scripts/pre-push.mjs --full
   ```
4. Submit a Pull Request against `main`. Ensure PR CI passes on Linux, macOS, and Windows.

---

## License

MIT License

Copyright (c) 2026 Dang Van Nghiem

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.