# FlowDeck — OpenCode Plugin

> AI-powered multi-agent workflow orchestration with Heidi primary execution policy and governance intelligence for OpenCode

FlowDeck adds a structured, multi-agent development workflow to OpenCode. It coordinates 13 specialist agents through an adaptive lifecycle — intake, route, context, execute, verify, complete — with persistent state that survives session restarts, a configurable governance layer, and tool-selection policies that route work to codegraph, token-optimized readers, web search, and library docs when available.

---

## Features

- 🤖 **13 registered agents** — `heidi` (primary policy), `orchestrator`, `planner`, `architect`, `backend-coder`, `frontend-coder`, `devops`, `tester`, `reviewer`, `researcher`, `security-auditor`, `mapper`, and `debug-specialist`.
- 🛠️ **61 skills** — validated workflow patterns in `src/skills/` (TDD, verification-before-completion, systematic-debugging, subagent-driven-development, writing-plans, executing-plans, improve-codebase-architecture, workflow-skill-creator, and more).
- ⚡ **8 slash commands** — slash-command entry points for planning, execution, verification, and support (`/fd-task`, `/fd-execute`, `/fd-verify`, `/fd-review`, `/fd-checkpoint`, `/fd-resume`, `/fd-status`, `/fd-done`).
- 📋 **Heidi Execution Policy** — 8 canonical execution strategies (`fast_direct`, `direct`, `explore_then_direct`, `planner_then_execute`, `debugger_root_cause`, `frontend_backend_parallel`, `audit_only`, `audit_after_change`) with justified delegation enforcement (max depth 1).
- 🔄 **Persistent state** — resume exactly where you left off across sessions via `.planning/STATE.md`.
- 🔀 **Parallel execution** — independent tasks run simultaneously through the orchestrator.
- 🦀 **FDX CLI Reliability & Fallbacks** — native TypeScript fallbacks for all 15 FDX tools (`fdx-read`, `fdx-grep`, `fdx-search`, `fdx-outline`, `fdx-tree`, `fdx-ls`, `fdx-impact`, `fdx-diff`, `fdx-git`, `fdx-batch`, `fdx-context`, `fdx-decisions`, `fdx-worktree`, `fdx-validate`, `fdx-test`).
- 🛡️ **Complete Governance Layer** — `OrchestratorGuard`, `toolGuardHook`, `guardRailsHook`, `loopDetector`, `agent-validator`, append-only audit logging (`.codebase/AUDIT.jsonl`), post-write verification (`.codebase/VERIFICATION.jsonl`), and Doctor health diagnostics.
- 🪝 **OpenCode hooks** — session events, shell environment injection, and guard rails that enforce phase and design constraints.

---

## Quick Install

### Recommended curl installation

```bash
curl -fsSL https://raw.githubusercontent.com/heidi-dang/flowdeck/main/install.sh | bash
```

See [docs/getting-started/installation.md](docs/getting-started/installation.md) for prerequisites, verification steps, and environment options.

---

## Core Workflow Commands

| Step | Command | What happens |
|------|---------|--------------|
| **Task Lifecycle** | `/fd-task "…"` | Execute task through the Heidi workflow lifecycle |
| **Execute** | `/fd-execute` | Implement feature with TDD discipline and parallel agents |
| **Verify** | `/fd-verify` | Full verification pipeline: tests, code review, security scan |
| **Review** | `/fd-review` | Supervisor code review gate |
| `/fd-checkpoint` | Save mid-session checkpoint to `STATE.md` |
| `/fd-resume` | Reload `STATE.md` to continue interrupted session |
| `/fd-status` | View project progress and roadmap |
| **Done** | `/fd-done` | Mark feature complete, verify post-write state, and clear session locks |

---

## Model Selection

**FlowDeck does not hardcode any model.** Every agent inherits the user's active OpenCode session model by default.

To assign a specific model to a specific agent, add it to `.flowdeck.json`:

```json
{
  "agents": {
    "planner": { "model": "anthropic/claude-opus-4" },
    "tester":  { "model": "openai/gpt-4o-mini" }
  }
}
```

---

## License

MIT
