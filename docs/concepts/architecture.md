# Architecture

FlowDeck is a plugin that runs inside OpenCode. It layers a structured multi-agent orchestration system on top of the base OpenCode runtime, contributing commands, specialist agents, runtime services, and event-driven hooks.

## Layering

```
OpenCode
  └── FlowDeck Plugin
        ├── Commands (8 slash command entry points)
        ├── Agents (14 registered agents, heidi primary execution policy)
        ├── Skills (89 validated skills in src/skills/)
        ├── Services (governance, doctor, token-optimizer, memory)
        └── Hooks (session-start, tool.execute.before, tool.execute.after, session.idle/error)
```

**OpenCode** provides the underlying runtime: tool execution, file I/O, shell access, MCP integrations, and the conversation UI.

**FlowDeck** adds the workflow layer on top. It extends OpenCode with opinionated orchestration, persistent state, and AI safety services.

## Subsystems

### Commands

Commands are registered as slash commands in the OpenCode CLI (`/fd-task`, `/fd-execute`, `/fd-verify`, `/fd-review`, `/fd-checkpoint`, `/fd-resume`, `/fd-status`, `/fd-done`).

### Agents

FlowDeck ships 14 registered agents:

| Agent | Role |
|-------|------|
| `heidi` | Primary execution policy identity |
| `orchestrator` | Compatibility alias for primary execution |
| `planner` | Technical design and wave plan generation |
| `architect` | Architectural structure design |
| `backend-coder` | Implementation of backend services |
| `frontend-coder` | Implementation of frontend UI |
| `devops` | Infrastructure and deployment |
| `tester` | TDD test execution and verification |
| `reviewer` | Supervisor code review gate |
| `researcher` | Read-only codebase exploration |
| `security-auditor` | Security policy analysis |
| `mapper` | Codebase structure indexing |
| `debug-specialist` | Root-cause diagnosis |

Every agent inherits the active OpenCode session model by default.

### Governance & Verification

- `OrchestratorGuard`, `toolGuardHook`, `guardRailsHook`, `loopDetector`, `agent-validator`
- Post-write verification checks writing to `.codebase/VERIFICATION.jsonl`
- Audit logging writing to `.codebase/AUDIT.jsonl`
- Health diagnostics via `doctorTool`
