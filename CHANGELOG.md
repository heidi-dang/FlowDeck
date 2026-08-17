# Changelog

## [2.0.7] - 2026-08-17
### Fixed & Hardened
- **Incident-Scoped Heidi Liveness Recovery**: Scoped reasoning-recovery budgets to distinct failure incidents (max 3 auto-continuations per incident) rather than a single global session counter, allowing long sessions to recover from later independent malformed turns.
- **Progress-Based Incident Closure**: Successful visible assistant progress or valid tool execution promptly clears the recovery counter and marks the incident resolved.
- **Session Emergency Ceiling**: Added a bounded session-wide emergency budget (50 continuations) protecting against infinite loops across massive sessions.
- **Visible, Recoverable Recovery Exhaustion**: Preserved `hasUnresolvedTask = true` upon recovery exhaustion, preventing silent task drops and enabling resumption with a manual follow-up prompt.
- **Synchronous Prompt & History Safety**: Hardened against synchronous `session.prompt` returns while preserving provider-safe replay history formatting.

## [2.0.6] - 2026-08-17
### Fixed & Hardened
- **Semantic Heidi Liveness Watchdog**: Added robust semantic idle session detection and recovery.
- **Provider Replay Sanitation**: In-place sanitization for reasoning-only and empty-output turns.
- **Async Resource Lifecycles**: Strict watchdog/continuation timer cleanup and state map isolation across plugin dispose to prevent cross-platform file locking (`EBUSY`) and async leaks.
- **CI Reliability**: Fixed `SyntaxError` streaming bug in CI packed-tarball validation.

## [2.0.5] - 2026-08-16

### Fixed
- Heidi reasoning-only session recovery and provider replay safety
- Windows CI stability and SQLite database connection disposal
- OpenCode history and system hooks compatibility
- Cross-platform temporary-path handling

## [2.0.4] - 2026-08-16

### Changed
- Raise productive autonomous-session limits to ≥100 (writes, delegations, pipeline calls, scheduler budget)
- Add heidi.autonomy_limits Doctor check reporting configured quotas

## [2.0.3] - 2026-08-16

### Fixed
- Fix release-environment and package validation defects from v2.0.2
- Include Heidi recoverable-guard hotfix
- Correct packaged Doctor runtime detection and tsconfig.json/uninstall.sh contract
- Harden CI and test isolation across skill routing, browser capability, and adaptive budget control

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.2] - 2026-08-16

### Fixed & Hardened

- **Recoverable FlowDeck Guard Error Handling**: FlowDeck guard blocks in `tool.execute.before` now return machine-readable feedback (`RecoverableFlowDeckBlockError`) so Heidi continues autonomously in the same session without stalling or requiring manual "continue" prompts.
- **Heidi & Orchestrator Identity Normalization**: `heidi` and compatibility alias `orchestrator` resolve to the exact same canonical primary direct-execution identity.
- **Read-Only GitHub CLI (`gh`) Inspection**: Read-only `gh api` GET requests, `gh repo view`, `gh pr view`, `gh run view`, and `gh issue view` are recognized as read operations and allowed for Heidi.
- **Planning Workspace State & Orphan Recovery**: `planningWorkspaceStatus` distinguishes `absent`, `incomplete_orphaned`, `valid_no_active_plan`, `active_unconfirmed`, and `active_confirmed`. Empty/orphaned directories lacking `STATE.md` no longer block edits.
- **Loop Guard `fdx-read` Redirection**: Repeated reads via `fdx-read`, `fdx-search`, `fdx-grep` are normalized and redirected with machine-readable guidance without ending Heidi's session.
- **FlowDeck State & Telemetry Ignored**: State directories (`.flowdeck/`, `.codebase/`, `.fd-plan/`) are automatically excluded in `.gitignore` on plugin initialization to prevent workspace file pollution.

## [2.0.1] - 2026-08-16

### Fixed & Hardened

- **FlowDeck Doctor Repair Engine (`flowdeck doctor fix`)**: Deterministic single-command machine and runtime auto-repair with transaction safety, atomic backups, repair locks, and post-fix verification.
- **Heidi Execution Policy & Guard Recovery**: Fixed guard error recovery paths so recoverable FlowDeck blocks provide structured feedback without causing Heidi to stall or stop.
- **Heidi UI/App Studio**: Autonomous UI creation, UI Architect, Design-System Intelligence, Native UI Generator, Visual Critic, Design Mode, and Full-Stack Builder.
- **Autonomous Browser Debugging**: Real Chrome integration, CDP session probes, console error repair, and multi-viewport responsive testing.
- **Curated Skills Security**: 65 validated skill modules with security provenance tracked in `skills-lock.json`.

## [2.0.0] - 2026-08-15

### Promoted

- **Official FlowDeck v2.0.0 Stable Release**: Official stable promotion of the proven `2.0.0-rc.1` runtime to npm `latest`.
- **Zero Runtime Delta**: No new runtime behavior, features, schema changes, or breaking changes were introduced during promotion from RC.1.
- **Heidi Persistent Memory & Recall**: Governed user, agent, and repository persistent memory with cross-session FTS5 search recall.
- **Evidence-Backed Learning & Skills**: Continuous evidence proposal, pending review, versioned skill creation, and rollback capabilities.
- **Governed Tool Pipelines**: Multi-tool declarative pipeline execution with advisory locking and boundary enforcement.
- **Durable Scheduler & Task Engine**: Subcommand-backed scheduling, interval/cron tasks, state transitions, and retry handling.
- **Durable Adaptive Parallel Execution**: Overlapping multi-specialist parallel DAG runs with process-isolated execution boundaries.
- **Process Restart Durability**: State, memory, learning, and schedules survive full isolated OpenCode process restarts.
- **Native FDX & TypeScript Fallback**: High-performance Rust native FDX binary integration with automated TypeScript fallback.
- **Installer, Doctor & Identity Hardening**: Hardened plugin installation, automated Doctor health checks, duplicate registration detection, and self-healing.
- **Platform & Runtime Compatibility**: Verified Node.js `>=20.0.0`, OpenCode `>=1.4.0`, FDX `^0.1.0`, and schema version 11.
- **Immutable RC Baseline**: `v2.0.0-rc.1` remains an immutable historical prerelease reference.

## [2.0.0-rc.1] - 2026-08-13

### Added

- **Runtime Identity Verification**: Validates runtime identity and configuration consistency.
- **Stale OpenCode FlowDeck Cache Discovery & Cleanup**: Discovers and cleans up stale OpenCode FlowDeck plugin caches.
- **Config vs Loaded Runtime Mismatch Detection**: Detects mismatches between configured settings and loaded runtime modules.

### Fixed

- **Doctor Packaging Fix**: Corrected doctor check/apply module exports and packaging paths.

## [2.0.0-alpha.4] - 2026-08-11

### Publication status

- **v2.0.0-alpha.4 supersedes the failed/unpublished v2.0.0-alpha.3 publication attempt.** The alpha.3 npm release was never published (the tag-triggered publish run `31480180293` failed in `Run Tests` before the publish step).
- The `v2.0.0-alpha.3` tag remains an immutable historical release record (tag object `51d5eb30…`, peeled commit `1a2e695`) and is not modified or republished.
- alpha.4 is the first published candidate of the post-M9 v2 line on the `alpha` npm dist-tag.

### Fixed

- **Schema fail-closed release-runner fix**: `scripts/check-schema-generated.mjs` now invokes the *detected* SQLite CLI path through the validation boundary instead of a literal `sqlite3` from PATH. A detected-but-broken or injected SQLite executable fails closed (non-zero exit) and can no longer be silently bypassed. This closes the exact regression that blocked the alpha.3 publication (`tests/check-schema-fallback.test.ts`, previously failing at line 386 with "Expected: not 0").
- **Post-migration schema gate realigned**: `scripts/orchestration/verify-schema.mjs` expected counts were stale (62/84) relative to the merged migration-registry state on the release line (migration v7 `assignment_execution_bindings` added 1 table + 3 indexes). The live post-migration contract is now asserted as 63 tables / 87 indexes / 36 triggers; the frozen v1 gate (53/66/36) is unchanged. Fresh, existing-v6→v7, and repeated-startup migrations verified.

### Added

- M1-M9 V2 autonomous execution remains 9/9 CLOSED with the Master Plan at 100%.
- Release regression coverage proving alpha.4 maps to the `alpha` npm dist-tag, `latest` is never overwritten, tag/version alignment, and that the historical alpha.3 tag need not equal the current release-line HEAD.

### Known limitations (alpha)

- Semver prerelease: 2.0.0-alpha.4 does not imply stable-channel guarantees.
- Verification-reuse fast-path still re-verifies on recovery (outcome-correct, decision deduped) — see milestone evidence.

## [2.0.0-alpha.3] - 2026-08-11


### Added

- M1-M9 V2 autonomous execution: 9/9 milestones CLOSED, Master Plan 100%.
- Canonical executable commands (task/start, plan, execute, verify, complete, review/audit, resume/recover, status) with durable idempotency (20-way).
- Scheduler/workstream/Assignment dispatch with durable assignment binding.
- Canonical token governance, worktree isolation, ownership controls.
- Canonical verification, evidence, and six-gate Completion Engine.
- Fresh-runtime recovery R1-R15: nonterminal resume after process restart, terminal projection with zero rerun, concurrent-recovery single-flight, historical command-version preservation.
- Pre-merge controlled dogfooding (D1-D15) + soak: 57 runs, zero unexpected failures/hangs/leaks.

### Fixed

- Completion regression: real VerificationResult/Evidence now reach the Completion Engine on the required-verification path (current-SHA gate no longer starved).
- Worktree integration gate no longer bypassed (agent verificationPassed is authoritative).
- Cancellation now cascades to logical Assignments (no zombie assignments).
- Recovery claim acquisition serialized (BEGIN IMMEDIATE); SHA-scoped recovery fast-path.

### Known limitations (alpha)

- Semver prerelease: 2.0.0-alpha.3 does not imply stable-channel guarantees.
- Verification-reuse fast-path still re-verifies on recovery (outcome-correct, decision deduped) — see milestone evidence.

## [2.0.0-alpha.2] - 2026-08-09

### Added

- Release candidate for the integrated v2 execution runtime on the `alpha` npm channel.
- Deterministic task intelligence, dependency-aware workstream execution, isolated worktrees, adaptive token control, capability-specific agent performance profiles, gated authoritative routing, optional FDX indexing/daemon support, unified observability, B1–B14 benchmark validation, and crash/recovery/security hardening.

### Verification

- Master Plan: 100% (12 CLOSED, 1 SUPERSEDED, 0 PARTIAL, 0 OPEN).
- V2 milestones M1–M8: 100% CLOSED.
- Historical pre-benchmark baseline is not comparable to the current benchmark surface; no unsupported historical performance improvement is claimed.
- This release remains prerelease and is not promoted to `latest`.

## [2.0.0-alpha.1] - 2026-08-09

### Added

- **v2 integration line**: the completed Orchestration Master Plan (Phases 0–12, 100% complete — 12 CLOSED, 1 SUPERSEDED) is now integrated into the shipped product. The durable orchestration runtime — event store, delivery/outbox engine, completion engine, verification & evidence system, contract system, health checks, and real metrics — is part of the plugin, not an internal spec.
- **Release channel derivation**: `scripts/release-channel.mjs` is the single authority: `alpha.*` → `alpha`, `beta.*` → `beta`, `rc.*` → `next`, stable → `latest`, and unsupported/malformed versions fail closed.
- `tests/release-channel.test.ts`: lifecycle matrix coverage, exact CLI output, and rejection regressions.
- `tests/publish-workflow-order.test.ts`: invariant 12 requires the publish step to derive the dist-tag from `scripts/release-channel.mjs` and pass it explicitly to `npm publish --tag`.
- `scripts/release-alignment.mjs`: verifies release-channel derivability and that pre-release/stable versions map to the correct channel.

### Changed

- Development version bumped to `2.0.0-alpha.1` across `package.json`, `package-lock.json`, `src/index.ts` (runtime agent-policy `pkgVersion`), and release-registry test fixtures.
- README updated for the v2 architecture, a separate "FlowDeck v1 vs v2" comparison, stable/alpha install channels, and release-policy notes.

### Compatibility

- No configuration migration is required from v1.x. This is a development release on the `alpha` npm channel; stable 1.x releases remain on `latest`.

## [1.0.3] - 2026-07-31

### Fixed

- **npm registry availability check under `bash -e`**: the v1.0.2 release was blocked because the `Check Registry Availability` step in `publish.yml` ran `LOOKUP_OUTPUT="$(npm view ...)"` under GitHub Actions' default `bash -e` (errexit). When npm returns E404 for an unpublished version — the expected state for a first publish — the command substitution exits non-zero and bash terminated the step before `LOOKUP_EXIT=$?` could be captured. The step now scopes `set +e`/`set -e` strictly around the `npm view` assignment and classifies outcomes explicitly: exit 0 (already published) fails, genuine npm E404 "No match found for version" continues to publish, and every other outcome (authentication, network, DNS, timeout, SSL, malformed, unexpected npm errors) fails the workflow.

### Added

- `tests/release-registry-check.test.ts` (9 tests): behavioural coverage executing the exact extracted `Check Registry Availability` step body from `publish.yml` under `bash -e` with a mocked `npm` binary — unpublished E404 continues, published version blocks, auth/network/DNS/timeout/unexpected errors all stop, plus errexit and command-substitution regressions. The suite fails against the v1.0.2 workflow (0/9) and passes against v1.0.3 (9/9).
- `tests/publish-workflow-order.test.ts`: invariant 8 strengthened to require `set +e`/`set -e` scoping, `LOOKUP_EXIT` capture, and the E404 "No match found for version" classification.

### Compatibility

- No runtime configuration migration is required. No user-facing runtime changes are included; this is a release-pipeline integrity release. v1.0.0 and v1.0.1 remain immutable; the v1.0.2 tag is preserved and was never published to npm.

## [1.0.2] - 2026-07-31

### Fixed

- **Tag-triggered publish workflow build order**: the v1.0.1 publish workflow ran `npm test` before `npm run build`. On a fresh tag checkout no `dist/index.js` exists, so the packed-doctor tests hard-failed and the v1.0.1 tag never published. The publish workflow now builds before running tests, matching `ci.yml` ordering.

### Changed

- **Bun pinned to 1.3.14** in the publish workflow: the tag-triggered publish runs on a fresh checkout, so a floating Bun version could change test behaviour between releases.
- **Tag/version alignment validation**: the publish workflow fails when the git tag and `package.json` version disagree (a `v1.0.2` tag must always publish `@heidi-dang/flowdeck@1.0.2`).
- **Registry availability validation**: the publish workflow checks that the target version is not already published and fails on registry lookup errors instead of masking them.
- **Package content validation**: `npm pack --dry-run --json` verifies package identity, version, required runtime files, and the absence of development caches, secrets, test output, and Rust `target/` directories before publication.
- **npm provenance preserved**: `npm publish --provenance --access public` with least-privilege permissions (`contents: read`, `id-token: write`).

### Added

- `tests/publish-workflow-order.test.ts` expanded to 11 invariants: dependency-install-before-build, typecheck-before-publish, build-before-test, tests-before-publish, package-validation-before-publish, Bun 1.3.14 pin, tag/version alignment, registry availability check, npm provenance, version-tag-only triggering, and no `|| true` masking. The suite fails against the v1.0.1 workflow and passes against v1.0.2.

### Compatibility

- No runtime configuration migration is required. No user-facing runtime changes are included in this release; it is a release-pipeline integrity release.

## [1.0.1] - 2026-07-31

### Fixed

- **Streamed installer unbound variable**: the v1.0.0 installer referenced `DOCTOR_PROFILE` at the pre-install doctor gate under `set -euo pipefail` without initialising it, aborting every plain `curl ... | bash` install with `DOCTOR_PROFILE: unbound variable`. `DOCTOR_PROFILE=""` is now initialised alongside the other doctor flags.
- **Packaged Doctor false failures**: the Doctor validated repository-only artefacts (`tsconfig.json`, `uninstall.sh`, `.gitignore`) that are not shipped in the npm tarball, reporting errors on healthy npm/packed installs. A new environment classifier (`classifyDoctorEnvironment`) marks those checks `skipped` on npm/packed layouts while keeping them active on source checkouts.
- **Secret-redaction check made behavioural**: `security.secret_redaction` now imports `redactSecrets` from the packaged bundle (`dist/index.js`) or the source module and asserts a synthetic token is redacted, instead of reporting a hardcoded pass.

### Added

- `tests/doctor-packed.test.ts` (14 tests): packed/npm layout classification, repo-only check skipping, behavioural redaction probe, honest error reporting, and the exit-code contract (0 healthy / 1 failure / 2 engine-invocation failure).
- `tests/installer/streamed-installer.test.ts` (3 tests): streams the real `install.sh` through `bash -s` with stubbed `node`/`npm`, proving no unbound-variable abort and that the pre-install doctor gate is reached.
- CI: packed tarball doctor gate (audits the extracted tarball layout, not the repo checkout); packed CLI doctor exit checks tightened from `-gt 1` to `-ne 0`.

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
