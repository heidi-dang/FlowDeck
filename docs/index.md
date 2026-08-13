# FlowDeck

> Structured planning and execution workflows for OpenCode powered by Heidi execution policy

FlowDeck structures every feature through an **adaptive workflow cycle**. The primary agent `heidi` (and compatible `orchestrator` identity) scores each task and selects the minimal sufficient workflow class dynamically.

## Features

- **13 registered agents** — `heidi` (primary policy), `orchestrator`, `planner`, `architect`, `backend-coder`, `frontend-coder`, `devops`, `tester`, `reviewer`, `researcher`, `security-auditor`, `mapper`, and `debug-specialist`.
- **61 skills** — validated workflow patterns in `src/skills/` (TDD, verification-before-completion, systematic-debugging, subagent-driven-development, writing-plans, executing-plans, improve-codebase-architecture, workflow-skill-creator, and more).
- **12 commands** — slash-command entry points for planning, execution, verification, support, memory recall, and learning (`/fd-task`, `/fd-execute`, `/fd-verify`, `/fd-review`, `/fd-checkpoint`, `/fd-resume`, `/fd-status`, `/fd-done`, `/fd-recall`, `/fd-learning`, `/fd-memory`, `/fd-learn`).
- **Persistent Heidi layer** — scoped user/agent memory, repository-preserving memory integration, SQLite/FTS5 session recall, evidence-backed learning candidates, versioned learned skills, progressive capability metadata, bounded tool pipelines, and durable scheduled-job claims.
- **Heidi Primary Execution Policy** — 8 canonical execution strategies (`fast_direct`, `direct`, `explore_then_direct`, `planner_then_execute`, `debugger_root_cause`, `frontend_backend_parallel`, `audit_only`, `audit_after_change`) with justified delegation enforcement (max depth 1).
- **Complete Governance Wiring** — `OrchestratorGuard`, `toolGuardHook`, `guardRailsHook`, `loopDetector`, `agent-validator`, `audit-log`, `verification-layer`, and `doctorTool`.
- **FDX Reliability & Fallbacks** — native TypeScript fallback handlers for all 15 FDX tools (`fdx-read`, `fdx-grep`, `fdx-search`, `fdx-outline`, `fdx-tree`, `fdx-ls`, `fdx-impact`, `fdx-diff`, `fdx-git`, `fdx-batch`, `fdx-context`, `fdx-decisions`, `fdx-worktree`, `fdx-validate`, `fdx-test`).
- **Doctor Health Diagnostics** — automated CLI health checks via `doctorTool` and `npm run validate:skills`.

## Quick Reference

| Command | Purpose |
|---------|---------|
| `/fd-task` | Execute a task through the Heidi workflow lifecycle |
| `/fd-execute` | Implement feature with TDD discipline and parallel agents |
| `/fd-verify` | Full verification pipeline: tests, code review, security scan |
| `/fd-review` | Supervisor code review gate |
| `/fd-checkpoint` | Save a mid-session checkpoint to STATE.md |
| `/fd-resume` | Reload checkpoint to continue interrupted session |
| `/fd-status` | View project progress and roadmap |
| `/fd-done` | Finalize task, verify post-write state, and clear session locks |

## Reference

- [Governance](concepts/governance.md) — Agent contracts, validator, supervisor, and audit logging
- [Workflows](concepts/workflows.md) — Command cycle, adaptive routing, and checkpointing
- [Getting Started → Installation](getting-started/installation.md)
- [Quick Start → First 15 Minutes](getting-started/quick-start.md)
