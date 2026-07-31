# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-07-31

### Highlights

FlowDeck 1.0 marks the first stable production release of FlowDeck: a governed multi-agent orchestration, code-intelligence, and CI lifecycle platform built for OpenCode. This release stabilizes the orchestration runtime, hardens the security and governance layers, and ships the Rust-native FDX code intelligence CLI with full TypeScript fallbacks.

### Added

- **13 specialized agents**: `heidi` as the default primary agent plus 12 specialist agents (`orchestrator`, `planner`, `architect`, `researcher`, `mapper`, `backend-coder`, `frontend-coder`, `devops`, `tester`, `reviewer`, `security-auditor`, `debug-specialist`), governed by the Heidi Primary Execution Policy with depth-1 delegation and `task:deny` on delegates.
- **61 validated skills** in `src/skills/`, each with the required YAML frontmatter and validated SKILL.md structure.
- **8 slash commands** implementing the orchestration pipeline: `/fd-task`, `/fd-review`, `/fd-execute`, `/fd-verify`, `/fd-done`, `/fd-status`, `/fd-resume`, `/fd-checkpoint`.
- **28 registered tools** including the 17-tool FDX family (`fdx-read`, `fdx-search`, `fdx-grep`, `fdx-batch`, `fdx-impact`, `fdx-outline`, `fdx-diff`, `fdx-git`, `fdx-ls`, `fdx-tree`, `fdx-test`, `fdx-lint`, `fdx-context`, `fdx-decisions`, `fdx-worktree`, `fdx-validate`, `fdx-pr-monitor`).
- **FDX Rust-native CLI** (`crates/fdx/`) with 14 subcommands, tree-sitter AST parsing across 5 languages, and a dual-AST symbol diff engine.
- **PR Monitor auto-repair**: event-driven CI failure detection, root-cause classification, bounded automated repair with a circuit breaker, SHA-based dedup, fork-PR protection, and prohibited-path enforcement.
- **Durable orchestration runtime**: SQLite-backed event persistence, transactional outbox delivery, optimistic concurrency (unit-of-work + versioned writers), replay-safe completion, and deterministic resource cleanup.
- **Command boundary with typed outcomes**: `timeout`, `max_buffer_exceeded`, `executable_not_found`, `parse_rejected`, `authorization_rejected` — with hard-validated resource limits before process spawn.
- **GitHub Actions matrix CI**: 3 OS × 3 Node.js versions, coverage gate (80%), lint/typecheck with zero warnings, docs/skills validation, orchestration integration and schema checks, and FDX Rust gates.

### Changed

- Product description updated to reflect production-grade multi-agent orchestration, governance, CI repair, and code intelligence for OpenCode.
- Package version stabilized at `1.0.0`; internal `pkgVersion` moved to `1.0.0`.

### Security

- Zero vulnerabilities across production and full dependency audits.
- Executable allowlist enforced with `shell: false` on all subprocess invocations; NUL-byte rejection, argument-count and length caps.
- Git read-only policy blocks mutating subcommands at the validation layer.
- Governance decisions (block/warn/approve) recorded as structured audit events.

### Reliability

- 3,189 tests passing (0 failures) across 153 files; 81.31% weighted aggregate line coverage.
- Full suite verified on Linux, macOS, and Windows; zero typecheck and lint errors.
- FDX native/TypeScript parity verified end-to-end; Rust gates (fmt, clippy, tests) pass.

### Compatibility

- **No configuration migration required** from any `0.8.0-alpha.x` release. The configuration schema is backward-compatible; existing plugin registrations, `default_agent`, and JSONC comments are preserved by the installer.
- Node.js >= 20.0.0, OpenCode >= 1.4.0, Linux/macOS/Windows supported. Rust toolchain optional (required only for the native FDX CLI; TypeScript fallbacks ship in the package).

### Migration

Upgrade with `npx @heidi-dang/flowdeck install` (or `curl -fsSL https://raw.githubusercontent.com/heidi-dang/flowdeck/main/install.sh | bash`), then run `npx flowdeck doctor` to verify the environment. No manual configuration changes are required.

## [0.8.0] - 2026-07-26

### Added
- **Heidi Primary Execution Policy**: 8 canonical execution strategies (`fast_direct`, `direct`, `explore_then_direct`, `planner_then_execute`, `debugger_root_cause`, `frontend_backend_parallel`, `audit_only`, `audit_after_change`) with `heidi` primary identity and `orchestrator` alias compatibility.
- **Justified Delegation Enforcement**: Enforced that delegation to subagents occurs ONLY when explicitly justified, with max delegation depth 1.
- **Complete Governance Wiring**: Integrated `OrchestratorGuard`, `toolGuardHook`, `guardRailsHook`, `loopDetector`, `agent-validator`, append-only audit logging (`.codebase/AUDIT.jsonl`), post-write verification (`.codebase/VERIFICATION.jsonl`), and `doctorTool`.
- **Native TypeScript FDX Fallbacks**: Pure JS/TS fallback handlers for all 15 FDX tools (`fdx-read`, `fdx-grep`, `fdx-search`, `fdx-outline`, `fdx-tree`, `fdx-ls`, `fdx-impact`, `fdx-diff`, `fdx-git`, `fdx-batch`, `fdx-context`, `fdx-decisions`, `fdx-worktree`, `fdx-validate`, `fdx-test`).
- **Doctor Health Diagnostic Service**: `doctorTool` and CLI diagnostics running automated checks across Node environment, workspace writability, `.flowdeck.json`, agent contracts, skill frontmatter, and FDX availability.
- **GitHub Actions Matrix CI**: 9-job CI workflow running tests across 3 operating systems (`ubuntu-latest`, `windows-latest`, `macos-latest`) and 3 Node.js versions (`20.x`, `22.x`, `24.x`).
- **Curated Skill Adoption**: Adopted 8 top-tier agent skills (`verification-before-completion`, `systematic-debugging`, `subagent-driven-development`, `writing-plans`, `executing-plans`, `improve-codebase-architecture`, `writing-skills`, `workflow-skill-creator`), bringing total validated skill count to 61 in `src/skills/`.

### Fixed
- **Validator Enforcement**: Fixed severity checking so `advisory` governance mode emits warnings without blocking tool execution.
- **Write Lifecycle Execution Order**: Moved `verifyAfterWrite` and `recordWrite` to `tool.execute.after` to inspect true post-write state.
- **Windows Path Normalization**: Fixed Windows 8.3 short paths (`RUNNER~1`) and symlinks in `fdxWorktreeTool` and test suites.

## [0.7.0] - 2026-07-24

### Added
- **`fdx-context` tool**: per-topic append/read/clear log of subagent output. Each entry is `[<ISO timestamp>] [<stage>/<agent>] <summary>`, capped at 2000 chars with truncation marker. Per-topic advisory lock prevents concurrent-append races between subagents.
- **`fdx-decisions` tool**: per-topic design-decision log. Each entry is a `## <decision>` block with rationale, made_by, and ISO timestamp. Markdown-injection guard strips `\r\n\0` from user-supplied fields to keep blocks single-line.
- **`fdx-validate` tool**: pre-execute consistency check for topic artifacts. Validates `task.md` / `affect.md` / `plan.md` exist, parses `affect.md`'s `## Affected Files` section (recognizes `create` / `modify` / `delete` verbs, skips code-fenced lines and HTML comments, refuses `..` path traversal), and checks that `plan.md` mtime >= `task.md` mtime.
- **`fdx-worktree` tool**: typed `git worktree` wrapper. Five actions: `create` (3-way create-path logic — refuses non-empty unregistered dirs without `--force`-deleting user data), `list` (parses porcelain output), `merge` (clean-target preflight + conflict detection via `git diff --diff-filter=U` + automatic `git merge --abort` to leave the repo clean), `cleanup` (resolved-path cwd-containment guard), `cleanup-all` (snapshot-once-per-the-review, per-entry failure reporting with skipped/failed breakdown).
- Two new path helpers in `planning-state-lib.ts`: `topicContextPath`, `topicDecisionsPath`.
- Three new FS helpers: `readOrMissing`, `appendWithMkdir`, `clearFile`.
- One new lock-aware helper: `appendWithLock` (per-topic `.lock` file, 5s stale-lock detection, explicit stderr-logged fallback to unlocked append on contention timeout).
- New `clearFileWithLock` for atomic clear under the same lock.

### Changed
- Orchestrator prompt: added 4 new tools to the Tool Permissions list, plus an "Observability hooks" section that instructs the LLM to log-and-continue on `fdx-context` append failures (observability is not control flow).
- `planning-state-lib.ts` extended with new helpers and lock primitives; pre-existing functions untouched.

### Fixed
- **`fdx-worktree.list`**: now correctly extracts `topic` and `phase` from worktree path basenames (previously returned `topic: null` due to a regex mismatch with the actual path format).
- **`appendWithLock`**: replaced the busy-wait spin loop with explicit lock-state polling, added 5-second stale-lock detection to prevent permanent block on crashed appends, and made the 1-second timeout fallback explicit (logs to stderr instead of silently dropping the lock).

## [0.6.1] - 2026-07-13

### Added
- Added `formatContextPacket` function to build orchestrator context for task delegation and subagent context injection.
- Added guidelines for handling orchestrator context in task descriptions across multiple agents.

### Changed
- Updated blast radius message in `formatContextPacket` for clarity.

### Documentation
- Added detailed documentation for `fd-init-deep`, `fd-merge-assist`, and `fd-retrospective` commands.
- Updated README to reflect changes in agent count, features, and governance layer details.

## [0.6.0] - 2026-07-01

### Added
- Added Rust `fdx` CLI binary with `fdx-read`, `fdx-grep`, `fdx-search`, `fdx-outline`, `fdx-tree`, `fdx-ls`, `fdx-impact`, `fdx-diff`, `fdx-git`, and `fdx-batch` tools.
- FDX redirect guard, installation/uninstallation scripts, and binary health checks.
- `/fd-ultrawork` command for autonomous maximum-effort workflows.
- Background subagent execution with poll/check tools.
- `/fd-init-deep` command for AGENTS.md hierarchy generation.
- tmux subagent visibility tools.
- Per-agent model configuration via `.flowdeck.jsonc`.
- TDD enforcement guard that blocks production code writes without a failing test.
- Write-limit guard to stop agents exceeding per-session file budgets.
- `planning-state` tool with `write_plan` action and plan persistence tests.
- `capture-lesson`, `review-lessons`, and `/fd-retrospective` learning flow with in-session and cross-session failure learning.
- Dynamic orchestrator routing generated from the agent registry.
- Token-optimization rules added to every agent prompt.
- Routing types and tests.
- Shell command classification with blocked tools and mutating prefixes.
- Verification layer for structured event logging.
- `sessionEventsHook` and `toolGuardHook` integration into the plugin.
- Grep functionality with context lines and max-matches limits.
- Improved output handling for FDX search results.

### Changed
- Rewrote orchestrator prompt for the evaluate-discuss-route-self-correct flow and improved routing/handoff instructions.
- Refactored orchestrator and related commands.
- Simplified `src/index.ts` to under 200 lines.
- Removed non-core services, dashboard, hooks, and outdated planning documents from the codebase.
- Replaced `context-ingress` with a lean session-start loader.
- Cached rule/language detection to reduce per-command filesystem scans.
- Simplified and reorganized `install.sh`.
- Updated documentation and command references to reflect the current agent count and available skills.
- Updated agent descriptions, classifications, and tier mappings.
- Refreshed orchestrator prompt tests.
- `makeEventLogStub` `args` type updated to `Record<string, unknown>`.
- `FlowDeckConfig` governance property type updated to `GovernanceConfig`.

### Removed
- Removed `fd-quick` from registered commands and its associated tests.
- Removed outdated router-dispatch and workflow-router service tests.
- Removed dead decision-trace and reflect references.
- Removed event-logging hooks and related functionality.

### Fixed
- Orchestrator guard now blocks only the orchestrator when `toolInput.agent` is present.
- Guard now allows executor writes when the plan is confirmed.
- Allowed `task` tool in orchestrator, enabled dynamic agent list, and added self-correction rule.
- fdx binary check now uses `help` instead of `version` for better compatibility.

### Security
- Bumped `actions/checkout` in the GitHub Actions group.

## [0.5.X] - 2026-06-15 - unstable

### Added
- Delegation budget service and context ingress service.

[0.6.0]: https://github.com/heidi-dang/flowdeck/compare/0.4.12...0.6.0
