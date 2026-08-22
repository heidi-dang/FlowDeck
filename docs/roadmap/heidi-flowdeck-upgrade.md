# Heidi FlowDeck Fusion — Production Runtime Upgrade Roadmap

## 1. System Baseline Lock

- **Repository**: `heidi-dang/FlowDeck`
- **Base SHA**: `4823c6eec1fe1758353f518221e2d5f91ee734ed`
- **Node**: `v24.18.0`
- **npm**: `11.16.0`
- **Bun**: `1.3.14`
- **Rust / Cargo**: `Not Installed (cargo / rustc absent in build environment)`
- **OpenCode**: `1.18.5`
- **Existing Test Count**: 1331 tests across 44 files (1324 passed, 7 failed due to Windows path regexes & `/tmp` separators)
- **Registered Agents**: 12 (`orchestrator`, `planner`, `architect`, `researcher`, `mapper`, `backend-coder`, `frontend-coder`, `devops`, `tester`, `reviewer`, `security-auditor`, `debug-specialist`)
- **Registered Slash Commands**: 8 (`fd-checkpoint`, `fd-done`, `fd-execute`, `fd-resume`, `fd-review`, `fd-status`, `fd-task`, `fd-verify`)
- **Registered Skills**: 53 in `src/skills/`
- **Package Build Status**: `npm run build` succeeds (generates `dist/index.js` and `dist/index.d.ts`)
- **FDX Build Status**: Rust compilation skipped; FDX native binary absent; TS fallback tools active

---

## 2. Runtime Truth Matrix

| Capability | Documented | Registered | Executed | Enforced | Tested |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Agents** | 12 | 12 | Yes | Partial (Orchestrator guard & Tool access) | Yes (12 registered) |
| **Commands** | 24 (Claimed) | 8 (Actual) | Yes | Missing 16 advertised commands | 8 tested |
| **Skills** | 67 (Claimed) | 53 (Actual) | Yes | Failed (`validate-skills`: 42 missing YAML frontmatter) | Failed in CI script |
| **Cost budget** | Yes | Yes (Schema) | Partial | **No** (No runtime cutoff/limit check) | **No** |
| **Delegation budget** | Yes | Yes (Config) | Prompt-only | **No** (No runtime subagent depth check) | **No** |
| **Loop detection** | Yes | Yes | `before`/`after` | **Partial** (`toolOutput` sentinel `[unavailable]`, no session clear) | Partial (1 Windows path fail) |
| **Supervisor** | Yes | Yes (`reviewer`) | Manual | **No** (No mandatory completion gate) | Partial |
| **Scorecards** | Yes | Yes | On-demand | **No** (Static mock numbers, not empirical) | Yes |
| **Memory** | Yes | Yes (`repo-memory`) | Tool exposed | **Partial** (No file locking or rotation) | Yes |
| **Verification layer** | Yes | Yes | `before` hook | **Broken** (Ran PRE-write in `before` hook) | Partial |
| **FDX tools** | Yes | 15 tools | Redirect guard | **Broken** (Strict block without binary or fallback) | 3 worktree tests fail |

---

## 3. Discrepancy & Defect Inventory

### 3.1 Documentation & Registration Mismatches
1. **Command Mismatch**: Legacy documentation referenced 24 slash commands (`fd-init-deep`, `fd-map-codebase`, `fd-new-feature`, `fd-discuss`, `fd-design`, `fd-plan`, `fd-fix-bug`, `fd-write-docs`, `fd-deploy-check`, `fd-reflect`, `fd-retrospective`, `fd-multi-repo`, `fd-translate-intent`, `fd-suggest`, `fd-ask`, `fd-doctor`, `fd-merge-assist`, `fd-ultrawork`, etc.), which were unified into canonical registered commands.
2. **Skill Mismatch**: Documentation claims 67 skills; `src/skills` contains 53.
3. **Skill Validation Failure**: 42 skill markdown files lack YAML frontmatter (`name` and `description`).
4. **Workflow Naming Mismatch**: Code has competing/conflicting workflow class concepts (`quick` vs `trivial`).

### 3.2 Runtime Correctness & Safety Vulnerabilities (P0/P1)
1. **Validator Enforcement (P0)**: `validateToolAccess` severity checks bypass `action` mode, causing `advisory` mode to block execution when block-severity violations exist.
2. **Write Lifecycle (P0)**: `recordWrite` and `verifyAfterWrite` execute inside `tool.execute.before`. Failed writes count as successful, and verification inspects pre-write file state.
3. **Loop Detector Output & Cleanup (P0)**: `tool.execute.after` uses `[unavailable]` sentinel for tool output. Session history is never cleared when sessions terminate.
4. **Configuration Safety (P0)**: Configuration updates do not validate existing JSON/JSONC before mutation, risking configuration corruption on malformed files.
5. **Guard Agent Context (P0)**: `resolveAgentName` falls back silently when `agentName` is missing rather than resolving strictly from SDK session context.
6. **FDX Hard Dependency (P1)**: `checkFdxRedirect` blocks native read tools when FDX binary is unavailable without fallback.
7. **Windows Path Incompatibilities (P1)**: 7 test failures in test suite due to POSIX regex assumptions (`^\/`) and `/tmp` directory path joins on Windows.

---

## 4. OpenCode SDK Payload Specifications

### 4.1 `tool.execute.before`
- **Received Arguments**: `(toolInput: any, toolOutput: any)`
- **Available Fields**: `toolInput.sessionID`, `toolInput.tool`, `toolInput.name`, `toolInput.args`, `toolInput.agent`.
- **Context Capabilities**: `ctx.directory` contains working directory; `ctx.agent` or `ctx.session.agent` contains active agent identity.

### 4.2 `tool.execute.after`
- **Received Arguments**: `(toolInput: any)`
- **Available Fields**: `toolInput.sessionID`, `toolInput.tool`, `toolInput.name`, `toolInput.args`, `toolInput.output`.
- **Note**: `toolOutput` is not passed as a second argument. Tool return value must be read from `toolInput.output` if present.

### 4.3 Session & Error Events
- **Received Arguments**: `({ event }: { event: any })`
- **Types**: `session.created`, `session.started`, `session.idle`, `session.error`, `tool.error`.
- **Properties**: `event.properties.sessionID`, `event.properties.error`.

---

## 5. Upgrade Phase Schedule

- **Phase 0**: Baseline Lock & Runtime Truth Audit (Completed with Score 10/10)
- **Phase 1**: Critical Runtime Correctness Repairs (`fix/phase-1-runtime-correctness`)
- **Phase 2**: Heidi Primary Execution Policy (`feat/phase-2-heidi-execution-policy`)
- **Phase 3**: Agent Registry, Model Inheritance & Delegation Enforcement (`feat/phase-3-agent-registry`)
- **Phase 4**: Context, Memory & Token Efficiency (`feat/phase-4-context-memory`)
- **Phase 5**: Complete Governance Wiring (`feat/phase-5-governance`)
- **Phase 6**: FDX Reliability & Fallback (`fix/phase-6-fdx-hardening`)
- **Phase 7**: Installer, Upgrade, Doctor & Uninstall (`feat/phase-7-installer-release`)
- **Phase 8**: CI & Production Gates (`ci/phase-8-production-gates`)
- **Phase 9**: Documentation & User Experience (`docs/phase-9-runtime-truth`)
- **Phase 10**: Final Production Audit & Rollup (`audit/phase-10-production-readiness`)
