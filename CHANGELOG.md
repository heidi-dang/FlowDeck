# Changelog

## [2.5.1] - FlowDeck v2.5.1 — Runtime Stop Authority Hotfix

### Fixed

- **BUG-001 (P1): Autonomous loop / stop authority failure** — Internal FlowDeck orchestration
  messages injected via `session.promptAsync` (specialist dispatch, verification prompt,
  continuation prompts) were transported back by OpenCode as `role=user` messages. The
  `onChatMessage` handler called `incrementTurnVersion` on every such message before
  classifying it, silently incrementing the durable `user_turn_version` counter. This
  created new continuation authority on each injection, causing autonomous reinvocation
  after the model's `finish=stop` — the confirmed v2.5.0 production loop.

  **Fix:** Authority boundary guard added at the entry of `onChatMessage`, checked before
  any `userTurnVersion` mutation. Internal FlowDeck messages are detected by their
  canonical prefix set (see `src/runtime/message-provenance.ts`) and returned early with
  `noteInternalContinuation`. Only genuine user messages increment the durable turn counter
  and enter task classification.

  **Invariants established:**
  - `FLOWDECK INTERNAL MESSAGE ≠ GENUINE USER MESSAGE`: internal orchestration messages
    never increment `userTurnVersion` regardless of OpenCode transport format.
  - `USER STOP/CANCEL → quiescent`: once a Run is terminal, no synthetic message echo
    can create new continuation authority.
  - `GENUINE USER MESSAGE → new authority`: only real user messages can establish fresh
    task intent after a stop.

  18 regression tests added covering: message provenance detection, userTurnVersion
  authority, terminal-run idle resistance (100× idle after cancel = 0 promptAsync calls),
  user-stop revocation, and specialist dispatch atomicity.

## [2.5.0] - FlowDeck v2.5.0 — Bounded Repository Intelligence for Adaptive Orchestration

### Added & Changed
- **Advisory Repo Master**: Introduced bounded, deterministic repository intelligence wrapping the FDX workspace index and repository hot-context cache. Provides compact file scope, dependency graphs, risk analysis, test targeting, and capability evidence for repository-significant tasks without execution, model selection, or completion authority.
- **Adaptive Task Routing (DIRECT / SINGLE_SPECIALIST / MULTI_SPECIALIST)**: Deterministic task routing by Heidi evaluates complexity and risk to dispatch lean direct workflows for simple edits, single-specialist subagents for focused tasks, or multi-specialist plans with Repo Master advisory consultation for cross-cutting features.
- **Dynamic Specialists & OpenCode Integration**: Capability-driven specialist subagents execute natively within OpenCode's subagent Task lifecycle. The immutable `SpecialistPlan` manages candidate validation, deduplication, acyclic dependency ordering (`dependsOn`), bounded fan-out caps (default max: 3), and strict global model policy inheritance without recursive delegation.
- **Durable Orchestration & Reliability**: State engine backed by local SQLite persistence provides crash resilience, restart recovery, transactional run/assignment writes, idempotent state transitions, convergence enforcement, strategy exhaustion detection, clean cancellation, dynamic assignment replacement/modification (MODIFY), and fail-closed handling for continuation ambiguity or storage corruption.
- **VerificationService & CompletionPolicy Authorities**: Enforced strict separation of output, verification, and completion:
  - `VerificationService` serves as the sole verification authority, objectively evaluating test runs, typechecks, and linter outputs against success criteria.
  - `CompletionPolicy` acts as the exclusive terminal completion gatekeeper. Specialist prose claims or advisory hints have zero completion authority.
- **FDX Hardening & Parsed-Diff Safety**: Rust-native code intelligence in `crates/fdx` hardened for high-speed AST parsing, dependency mapping, robust multi-file Git diff parsing, and ANSI forced-colour terminal resilience (`color.ui = always`), backed by TypeScript fallbacks.
- **Final Runtime Consolidation**: Reconciled orchestrator event pipelines, metrics collection, and OpenCode adapter bridges for seamless, reproducible execution.
- **README Rewrite & Documentation**: Completely rewritten user documentation detailing authority boundaries, execution models, diagnostic commands, and configuration.
- **Full Qualification & Platform Matrix**: Verified 100% passing test suites, schema integrity, Rust clippy/tests, FDX parity, and cross-platform verification across Ubuntu Linux, macOS, and Windows.


## [2.4.1] - FlowDeck v2.4.1 — Security Containment & Reliability Patch

### Security & Reliability
- **Filesystem Path Containment (.codebase)**: Enforced strict repository containment for all `.codebase/` read and write operations via central containment primitive `resolveCodebasePath`, rejecting path traversals, absolute paths, prefix collisions, symlinks, and root-level symlinked `.codebase` directories.
- **Rust FDX Daemon Jail**: Added canonical `--root <dir>` parameter to `fdx serve`, jailing daemon filesystem operations (`read`, `search`, `outline`, `impact`) to the authoritative repository root.
- **TypeScript FDX Fallback Jail**: Applied identical containment validation to all TypeScript fallback operations (`nativeReadFallback`, `nativeSearchFallback`, `nativeLsFallback`, `nativeOutlineFallback`, `nativeImpactFallback`, `fdx-batch`).
- **Git Read-Only Policy Hardening**: Blocked `-c`, `--config`, `--config-env`, `--exec-path`, `--output`, `--ext-diff`, `--textconv`, `--paginate`, `--no-pager`, and dangerous config overrides across TS and Rust.
- **Heidi Code Mode Selection Policy**: Enforced declared selection boundaries (`maxLines`, `maxSourceBytes`, `maxToolCalls`, `maxParallelCalls`, `maxDependencyStages`, `maxCollectionItems`, and ambient authority prohibitions) and rejected unbounded exploration prompts.
- **Doctor Truthfulness**: Corrected text formatter status output (`OK`, `WARN`, `INFO`, `SKIP`, `ERROR`), reconciled `autoFixAvailable` declarations with actual handlers, and updated version fallback.
- **Package Dependency Closure**: Included `scripts/release-channel.mjs` in package file whitelist and added extracted tarball validation tests.
- **Installer Safety**: Converted Doctor arguments in `install.sh` to validated Bash arrays and verified profile inputs.
- **Test Hardening & Real Coverage**: Removed false-green test patterns and verified 83.64% remote / 83.85% local aggregate line coverage.


## [2.4.0] - FlowDeck v2.4.0 — OpenCode-Native Heidi Code Mode

### Added & Changed
- **OpenCode 1.18.20 Support**: Fully qualified integration with OpenCode version 1.18.20.
- **Native Code Mode Selection**: Heidi now intelligently evaluates small MCP tool compositions against strict policy boundaries to dispatch them directly to OpenCode's native Code Mode, leveraging OpenCode's authoritative execution sandbox.
- **Truthful Capability Handling**: Code Mode availability is now accurately modeled as `AVAILABLE`, `UNKNOWN` (enabled but missing eligible MCP context), or `UNAVAILABLE`. Heidi will only utilize Code Mode when explicitly `AVAILABLE`.
- **Bounded MCP Composition**: Configured robust boundaries (max 10 tool calls, max 4 parallel calls, max 3 dependency stages, 30-second timeout) for native Code Mode execution, rejecting overly complex operations back to normal Heidi execution.
- **FAST_DIRECT Prompt Isolation**: The fast-path prompt remains lean (under 600 baseline tokens) with no Code Mode guidance leakage, maintaining baseline execution speeds for non-Code Mode tasks.
- **FDX Architecture Independence**: FlowDeck's native Rust FDX code intelligence tooling remains deliberately excluded from OpenCode 1.18.20 Code Mode environments, running instead on FlowDeck's established secure path.
- **Improved Diagnostics**: FlowDeck Doctor now provides precise runtime qualification reporting, verifying accurate architecture configurations and OpenCode version alignment.
- **CI & Quality Improvements**: Strengthened CI qualification production gates. The release includes full coverage metrics ensuring 90% aggregate line coverage, passing Rust unit and integration validation.
- **Architectural Clarification**: Solidified system boundaries—FlowDeck provides development intelligence, task classification, and coordination policy, while OpenCode retains full ownership of model execution, session lifecycle, and sandboxed native runtimes.


## [2.3.0] - Stable Release

### Added & Changed — Native Background Subagents & Orchestration Reliability
- **Native Background Task Execution**: Migrated FlowDeck's simulated subagent scheduler to natively utilize OpenCode's `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` capability. Heidi can now dispatch domain specialists concurrently without blocking the orchestrator turn.
- **Isolated Multiplex Cancellation**: Hardened `FdxTurboEngine` to support independent caller subscriptions. If caller A aborts, it unsubscribes cleanly without killing the shared in-flight worker for caller B.
- **Absolute Fallback Deadlines**: Plumbed `AbortSignal` and absolute time-bounding natively through `runFdxAsync` and all TypeScript FDX fallbacks. All FDX pipeline boundaries now guarantee fail-fast settlement to prevent event-loop lockups.
- **Rust FDX Daemon Bounded Pool**: Refactored `crates/fdx/src/serve.rs` to operate a dedicated bounded thread pool (`sync_channel`) to eliminate head-of-line blocking on concurrent IPC streams.
- **Token Budget Lifecycle Management**: Eliminated cross-session leakage by implementing rigorous garbage collection on `TokenBudgetRuntime`, alongside O(1) assignment identity lookups.
- **Lock Stealing & Jitter**: Fortified SQLite file-based synchronization (`acquireLock`) with genuine PID liveness checks, stale lock stealing, and randomized backoff.
- **Native Task Status UX**: Added integration semantic rules requiring Heidi to natively publish `todowrite` checklist indicators for outstanding background tasks.


## [2.2.7] - 2026-08-20

### Added & Changed — Heidi Autonomous Developer & Explicit User Approval Workflow
- **Capability-Based Authorization Model**: Replaced legacy binary read-only/mutating orchestrator block with three distinct capability tiers:
  - `ALLOW`: Heidi operates autonomously for all local workspace development tasks (file creation/editing/deletion, directory management, safe command substitutions like `$(date ...)` and `$(git rev-parse HEAD)`, test & build runners, and local git operations).
  - `APPROVAL_REQUIRED`: Actions crossing sensitive, external, privileged, or destructive trust boundaries (`git push`, `git push --force`, `npm publish`, `cargo publish`, `gh release create`, `sudo`, `.env` or private key reads, cloud/infra deployments, external `rm -rf /...`) require explicit one-shot user approval.
  - `DENY_INVALID`: Technically malformed or impossible operations are rejected immediately.
- **One-Shot Approval Registry & State Machine (`src/services/approval-service.ts`)**:
  - Exact action fingerprinting with TTL expiration and per-session isolation.
  - One-shot consumption on successful execution to prevent token-churning replay loops.
  - Structured `WAITING_FOR_APPROVAL` state machine preventing retry flood and sound/card spam.
- **Nested Command Substitution & Pipeline Risk Inheritance**: Upgraded `src/services/shell-command-classifier.ts` to parse nested `$()` and backtick substitutions in context and evaluate composite pipelines by inheriting maximum risk.
- **Audit & Governance Integration**: Emits dedicated `approval.required`, `approval.granted`, `approval.denied`, and `approval.consumed` audit events to `.codebase/AUDIT.jsonl`.

## [2.2.6] - 2026-08-20

### Fixed — Heidi Orchestrator Guard Regression & UI Event Flood Elimination
- **Developer Shell Inspection & Verification Classification**: Classified legitimate read-only inspection commands as permitted `read` category in `src/services/shell-command-classifier.ts`:
  - `node -p` / `node --print` expressions and `node -c` / `node --check` syntax checks.
  - `bun test`, `bun -p`, `bun --print`, and test/lint/typecheck verification scripts (`bun run test|typecheck|lint|check|verify`).
  - `cargo test`, `cargo check`, `cargo clippy`, and `cargo fmt --check`.
  - `npm test`, `pnpm test`, `yarn test`, and `deno test|check|lint|fmt --check`.
- **Bounded Guard Retry Circuit & Terminal Invalidation**: Added `cwd` to `normalizeGuardFingerprint`. Enforced `ORCHESTRATOR_GUARD_STRATEGY_INVALIDATED` (`terminal: true`, `recoverable: false`) when an identical blocked command is re-attempted unchanged, eliminating infinite retry loops after attempt 1.
- **Machine-Readable Heidi Replanning Feedback**: Updated `RecoverableFlowDeckBlockError` to provide clear next-step guidance (route to specialist agent, switch to FDX/native read tools, review test results) and explicitly forbid unchanged retries.
- **Lifecycle & State Cleanup**: Wrapped `orchestratorGuard.check()` in `src/index.ts` to release call timers, decrement `sessionActiveTools`, and clear `watchdogState.isPendingTool` upon guard blocks. Registered `orchestratorGuardStrategyCircuit.clearSession(sessionID)` in `cleanupSessionState()` and manual task phase resets.
- **Cross-Platform Fast-Lane Path Normalization**: Supported Windows path separators in `isSafePathToken` and hardened test lifecycle handle teardown against Windows `EBUSY` lock races.
- **Security Invariant Preserved**: Genuinely mutating commands (`rm`, `git commit/push`, `npm install`, `cargo publish/build`) and reads from sensitive files (`.env`, `~/.ssh`, private keys) remain strictly guarded.

## [2.2.5] - 2026-08-20

### Runtime Hardening & Multi-Agent Stability
- **Modularized FlowDeck Runtime Internals**: Separated core orchestration, verification, and persistence lifecycles with strict process safety boundaries.
- **Configuration Dependency Cleanup**: Streamlined dependency resolutions and eliminated circular references across config and environment hooks.
- **Heidi/OpenCode Execution Reliability**: Auto-forwarded native read/file operations to FDX adapters and hardened tool dispatch.
- **Improved Error Propagation & Diagnostics**: Enforced structured error hierarchies with unambiguous error reporting across subsystems.
- **Doctor Repair Re-verification & Idempotency**: Hardened automated self-repair mechanisms with atomic pre-mutation backups and idempotent passes.
- **FDX Native/Fallback Discovery Hardening**: Hardened binary path detection, dynamic PATH observation, and cache invalidation mechanics.
- **Subprocess & Shell Safety**: Secured temporary rm parsers, path traversal guards, and command-line sanitization against metacharacter exploitation.
- **Stale-Lock Live-Owner Protection**: Enforced Contract A live-process inspection before reclaiming PID lockfiles across POSIX and Windows.
- **Repository Lease Coordinator Safety**: Protected state integrity against partial writes and atomic rename failures.
- **Orchestration Database Hardening**: Enforced split-brain protection, deterministic fallback candidate discovery, and safe multi-worker SQLite startup with PRAGMA integrity verification.

## [2.2.4] - 2026-08-20
### Fixed — Subagent Loop Elimination, Circuit Breaker Hardening & Guard Precision
- **Auto-Forward Native Read Tools to `fdx-read`**: Updated `tryFdxRedirect` in `src/hooks/tool-guard.ts` to silently rewrite native `read` / `read_file` args into `fdx-read` compatible requests rather than throwing advisory rejection errors, preventing subagent retry loops.
- **Tool Error Circuit Breaker**: Added per-session tool error tracking (`recordToolError`, `clearToolErrorCounts`) in `src/services/orchestrator-guard-strategy-circuit.ts` with a 3-strike hard limit to suppress repeated tool failure churn.
- **Shell Classifier Compound & Path Precision**: Treated leading `cd` segments as transparent in `classifySegment` (unblocking read-only compound inspection like `cd /dir && git status`) and removed broad `~` path-traversal blocking in `hasPathTraversal` (unblocking non-sensitive cache inspections like `ls ~/.cache/`).
- **Disposable Fixture Cleanup Exemption**: Scoped `rm -rf` pattern checks in `tool-guard.ts` to allow recursive directory removal within temporary directories (`/tmp/`, `/var/folders/`, `$TMPDIR`).
- **Token Optimization & Opt-In `sequentialThinking`**: Set `sequentialThinking` MCP server to opt-in (`FLOWDECK_ENABLE_SEQUENTIAL_THINKING=true`), eliminating ~1,500 tokens of schema overhead per turn.
- **FDX Tool Priority Prompt Hardening**: Injected hard rules in `src/agents/debug.ts` and `src/agents/security-auditor.ts` instructing specialist subagents to immediately switch to `fdx-read` / `fdx-grep`.
- **Subagent Turn Budget Controls**: Added `maxChildTurns` (default 60) and child turn count tracking in `src/services/heidi-task-state.ts`.

### Verification
- Full unit and integration test suite: 1,082 pass / 0 fail across 41 test files (4,105 across full matrix).
- All pre-push checks and benchmarks pass.

## [2.2.3] - 2026-08-19
### Fixed — Recovery-Loop Suppression & Orchestrator Guard Read-Only Discovery
- **Orchestrator Guard & Command Classifier Read-Only Discovery**: Added `isVersionOrHelpQuery()` classifying `--version`, `-v`, `-V`, `--help`, `-h`, and `help` queries as read-only inspection. Classified `command -v`, `whereis`, and read-only `git branch` query flags (`--show-current`, `--list`, `-a`, `-r`) as permitted inspection commands in `orchestrator-guard-hook`. Destructive branch mutation flags (`-d`, `-D`, `-m`, `-C`, etc.) remain fully protected. Fixed compound pipeline classification to attribute category and reason to the exact blocking segment.
- **Precise LoopDetector & FDX Fingerprint Normalization**: Updated `normalizeAction()` to extract `args.file` (in addition to `filePath`/`path`), `mode`, `symbol`, line ranges, and search query/dir. Distinct reads produce distinct semantic fingerprints instead of collapsing into identical working-directory keys.
- **Errored Tool-Turn Completion Safety**: Updated `detectNoVisibleOutputCompletion()` in `provider-history-safety` so any tool execution part (completed, pending, running, or error) counts as active tool execution. Tool turns returning errors are handled via normal tool failure lifecycle and are never misclassified as empty/reasoning-only completions.
- **Authoritative Recovery Admission Gate (`canInjectRecoveryContinuation`)**: Implemented single-flight recovery gating in `RecoveryCoordinator` enforcing strict `(sessionID, incidentID, generation) -> max 1` outstanding continuation. Automatically suppresses duplicate prompts with concrete telemetry (`ALREADY_IN_FLIGHT`, `DUPLICATE_GENERATION`, `TERMINAL_SESSION`, `EXHAUSTED`, `NO_SESSION`, `NO_API`).
- **Task Phase Boundary Reset**: Clearing stale `LoopDetector` session state on manual new task phase boundary in `index.ts`.
- **Preserved Protections**: Preserves inactive-session watchdog protection (`isWatchdogEligible`), bounded legitimate Loop Guard recovery, shell non-zero failure recovery, provider replay sanitation, and Active Parallel Coordination.

### Verification
- Full test suite: 4,003 pass / 0 fail; weighted line coverage 83.68% (>= 80% threshold).
- FDX native parity PASS; Rust gates PASS; Packaging/CLI and installer gates PASS; Pipeline completion PASS.
- Production Gates and Orchestration Validation green on candidate SHA `94129fe37ece4ab41752f1dbd130454bb303d501`.

## [2.2.2] - 2026-08-19
## [2.2.2] - 2026-08-19
### Fixed — Inactive-Session Watchdog & Incident Single-Flight
- **Authoritative Watchdog Eligibility Predicate (`isWatchdogEligible`)**: Fixed `updateWatchdogState` defaulting `hasUnresolvedTask` to `true` upon session observation. `isWatchdogEligible(state)` now strictly requires an active, non-terminal session with genuine unresolved executable work, rejecting idle, completed, cancelled, failed-final, and superseded sessions.
- **Terminal Lifecycle Cleanup**: `session.completed` and `session.error` events deterministically set `hasUnresolvedTask: false`, `isActiveSession: false`, `isTerminalTask: true`, and `isPendingContinuation: false`, preventing completed sessions from ever becoming watchdog-eligible.
- **Watchdog Incident Single-Flight & Deduplication**: Added `inFlight: boolean` state to `WatchdogIncidentState`. Repeated timer ticks while a directive is in flight suppress duplicate prompts, eliminating nag-loop flooding.
- **Bounded Legitimate Active Stall Recovery**: Legitimate active stalls continue to receive single-flight bounded recovery (1 first directive, <=1 alternate directive, transitioning to `STALLED_UNRECOVERED` without infinite prompts).
- **v2.2.1 Shell Failure & Runtime Integrity Preserved**: Exact exit codes, in-place WebUI updates, and Runtime Integrity scoring remain fully operational.

### Verification
- Full test suite: 389 pass / 0 fail (48 test files); weighted line coverage 90.0% (>= 80% threshold).
- FDX native parity PASS; Rust gates PASS; Packaging/CLI and installer gates PASS; Pipeline completion PASS.
- Production Gates and Orchestration Validation green on the exact release SHA.

## [2.2.1] - 2026-08-19
### Fixed — Shell Failure Propagation & Operation Lifecycle
- **Non-Zero Shell Exit Status & Exit Code Preservation**: Fixed `shell-executor.ts` `runBash()` swallowing non-zero process exits; exact exit codes and redacted `stderr` metadata are now preserved in `ShellExecutionResult`.
- **Stable Operation Lifecycle Identity (`operation.started → operation.failed / completed`)**: Introduced deterministic `deriveOperationId` and `OperationLifecycle` store. The same event ID is preserved from `started` through `failed`/`completed`.
- **In-Place WebUI Action Row Updates & Reload De-duplication**: The FlowDeck WebUI dashboard updates the original action row in place (rendering visible text `Failed · exit N`, accessible labels, and expandable `stderr` summary). De-duplication in `RuntimeScoreboard` guarantees 1 row per operation across page refresh and ledger reload.
- **Negative Runtime Integrity Scoring for Tool Failures**: `NONZERO_EXIT` severe violations apply an immediate integrity cap (30%) on the failed operation while keeping score events strictly out-of-band (never leaking into model/provider replay context).
- **Bounded & Deduplicated Recovery**: `ShellFailureTracker` registers exactly one recovery incident per semantic failure fingerprint (`tool + command + repoGeneration + exitCode`); repeated unchanged commands are suppressed by Loop Guard without nag floods.
- **Autonomous Strategy Recovery**: Heidi observes non-zero tool failures, receives bounded operational facts, autonomously changes strategy, and completes tasks without silent `Thinking` stalls.
- **Real-Runtime OpenCode 1.18.18 & Multi-Worker Verification**: Verified live in OpenCode 1.18.18 with model `heidi/heidi-antigravity` across focused recovery and full 4-specialist capability audits.

### Verification
- Full test suite: 4,052 pass / 0 fail (323 test files); line coverage 83.65% (>= 80% threshold).
- FDX native parity PASS; Rust gates PASS; Packaging/CLI and installer gates PASS; Pipeline completion PASS.
- Production Gates and Orchestration Validation green on the exact release SHA.

## [2.2.0] - 2026-08-18
### Added — Heidi Active Parallel Coordination & Runtime Integrity
- **Heidi Active Parallel Coordination**: Root Heidi remains productive with non-conflicting coordinator work while all specialist children execute concurrently.
- **Incremental Integration of READY Results**: Results from completed children are reviewed and integrated immediately (before the last child finishes) with no global wait-all barrier.
- **Event-Driven + Adaptive Child Reconciliation**: Coordinator tracks child lifecycle events and reconciles state adaptively; healthy parallel workload polls 0 model turns (pollModelTurns === 0).
- **Fan-out Reconciliation & Root-Depth Provenance Fixes**: Correct effective depth (root 0, child 1), fan-out reconciliation, and provenance preservation for the root coordinator during delegation.
- **Scoped Ownership & Duplicate-Work Protections**: Running coordinator work is non-conflicting with children; ownership conflicts and duplication events both remain 0.
- **Runtime Self-Audit / Runtime Integrity Scoring**: FlowDeck surfaces live runtime integrity scores on live actions and via the WebUI.
- **Visible Per-Action FlowDeck XX% WebUI Surface**: Per-action runtime scores rendered in the WebUI dashboard with Current Health and Session Integrity.
- **Evidence-Gated Completion Scoring**: Completion is gated on current, SHA-matched verification evidence.
- **Score Isolation from Provider/Model Context**: Runtime scores are kept isolated from provider/model context.
- **Resident FDX Execution / Warm Index Improvements**: FDX native daemon + warm index improvements.
- **Deterministic Shell Fast Lane**: Deterministic fast-lane execution for safe shell commands.
- **Long-Session Recovery / Convergence Protections**: Confirmed-terminal recovery, single-flight continuations, provenance lifecycle persistence, and convergence guard.
- **Explicit Real-Runtime Acceptance & CI-Safe Live-Test Separation**: npm test:live-acceptance isolates live OpenCode/WebUI probes from the deterministic CI test matrix; normal CI and coverage exclude live probes while retaining the offline coordinator/mutation regressions.
- **Cross-Platform Ubuntu / Windows / macOS Validation**: All three OS test matrices green.

### Verification
- Full test suite: 3,953 pass / 0 fail; coverage 83.75% lines (>= 80% threshold).
- FDX native parity PASS; Rust gates PASS; Packaging/CLI and installer gates PASS; Pipeline completion PASS.
- Production Gates and Orchestration Validation green on the exact release SHA.

## [2.1.0] - 2026-08-18
### Added — Heidi Fast Harness v1
- **Route-First Task Execution**: Deterministic per-user-task classification (FAST_DIRECT, SPECIALIST, PARALLEL_SPECIALISTS, STANDARD, DEEP) before repository discovery; manual user turns only — internal continuation/recovery prompts never reclassify or reset route state.
- **FAST_DIRECT Path**: Trivial local tasks follow classify → inspect → edit → focused verify → done, without planning overhead or delegation.
- **Immediate Specialist Delegation**: Debug, security, UI/frontend, backend, DevOps, review, architecture tasks delegate to the right specialist on turn 1.
- **Frontend/Backend Parallel Specialist Routing**: Independent frontend + backend workstreams resolve to frontend-coder + backend-coder and run concurrently (new BACKEND domain).
- **Live Per-Turn Lazy Context**: The permanent Heidi core prompt stays static and small; only task-specific sections are injected per turn (measured 82.3% FAST_DIRECT prompt reduction: 2,933 → 518 tokens).
- **Concurrent Repository Reads**: ReadBatchService executes independent reads in parallel (measured 3.82× speedup on 4 independent reads) with compact structured result packets.
- **Compact External Task State**: Per-task state (<200-token provider packets) externalized from conversation history.
- **Repository Hot-Context Cache**: Stable repo facts (root, HEAD, branch, languages, package manager, commands, FDX availability) cached with invalidation on HEAD/config/manifest change.
- **Config Cache**: Cached FlowDeck config resolution on the hot path (governance mode, etc.).
- **Governance Read Fast Path**: Whitelisted read-only tools authorize in ~0.0001 ms p50; writes, shell, deletions, and delegation always take the full policy path.
- **In-Memory Token-Accounting Hot Index**: FileTokenUsageStore keeps an in-memory index (no full JSONL reread on hot queries); JSONL remains the restart/durability source.
- **Buffered Non-Critical Audit Persistence**: Informational audit events buffer (bounded queue, size/periodic/dispose flush); critical events (blocks, policy violations, destructive-op guards, recovery exhaustion, security mismatches, delegation lifecycle) remain synchronous.
- **Deterministic Tool-Call Repair**: Mechanical argument normalization (aliases, path separators, scalar-array shapes) before another model inference; never infers semantic intent.

### Reliability
- Session-log writable fallback retained (root /.opencode EACCES fix from v2.0.9).
- v2.0.9 recovery hardening retained: confirmed-terminal detection, single-flight continuations, causal generation correlation, provenance lifecycle persistence, orphan timeout.
- Healthy workload auto-Continue count remains 0.

### Verification
- OpenCode plugin-contract and offline integration verification pass (26 offline checks); Fast Harness live path verified through the real OpenCode hook surfaces.
- Full test suite: 3,793 pass / 0 fail; coverage 85.00% lines (80.90% funcs).
- Hermes comparison not available in this release (no Hermes harness in the environment).
## [2.0.9] - 2026-08-18
### Fixed & Hardened
- **Confirmed-Terminal Assistant Recovery**: Replaced unsafe missing-`finishReason` fallback (was defaulting to `stop`) with strict terminal evidence validation. Transient `message.updated` events during active turns no longer trigger recovery prompts.
- **Preflight Debounce Revalidation**: Added preflight state validation immediately before recovery prompt submission, suppressing automatic prompts if provider, tool, child, cancellation, or manual user input becomes active during the debounce window.
- **Causal Recovery Generation Correlation**: Correlated recovery user prompts with specific assistant responses via message ID / parent ID, rejecting unrelated terminal assistant events from retiring active recovery generations.
- **Provenance Lifecycle Persistence**: Fixed internal prompt provenance to survive multi-event lifecycles (`chat.message` + `message.updated`) without one-shot consumption, and eliminated wildcard matching on empty-text events.
- **Single-Flight Continuation Lifecycle**: Closed `isPendingContinuation` state leaks on cancelled or superseded recovery generations, ensuring manual user takeovers cleanly release continuation state and allow future recovery.
- **Bounded Orphan Generation Timeout**: Added a 2-minute safety timeout releasing single-flight locks if no assistant response arrives for an internal recovery prompt.

## [2.0.8] - 2026-08-18
### Fixed & Hardened
- **Continuation-Prompt Flood Guard**: Introduced a centralized `RecoveryCoordinator` ensuring strictly single-flight auto-continuations and eliminating runaway recovery loops.
- **Internal Prompt Provenance**: Disambiguated internal FlowDeck-generated recovery prompts from genuine manual user messages, preventing internal continuation prompts from clearing failure incident counters.
- **Watchdog & Reasoning Recovery Deduplication**: Unified scheduling for semantic watchdog and reasoning-only recovery, preventing overlapping recovery prompts.
- **Pending-Tool State Safety**: Ensured assistant turns with pending/running tool executions are not prematurely flagged as empty/malformed completions.
- **Provider Replay Sanitation Hardening**: Prevented duplicate internal continuation prompt accumulation in model history.

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