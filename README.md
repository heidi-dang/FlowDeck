# FlowDeck — Heidi fork

> Structured planning and execution workflows for [OpenCode](https://opencode.ai)

**FlowDeck** is an OpenCode plugin that adds governed multi-agent orchestration, skill-based workflows, tool-selection policies, audit logging, and lifecycle management to OpenCode sessions. It does not replace OpenCode's model access, session management, or core tool execution — it extends them with a structured orchestration and governance layer.

**Package**: [`@heidi-dang/flowdeck`](https://www.npmjs.com/package/@heidi-dang/flowdeck)

| Status | |
|---|---|
| **Development** | Alpha (v0.8.0-alpha.1) |
| **License** | [MIT](LICENSE) |
| **OpenCode** | >= 1.4.0 |
| **Node.js** | >= 18.0.0 |
| **OS** | Linux, macOS, Windows |
| **CI** | [![CI](https://github.com/heidi-dang/FlowDeck/actions/workflows/ci.yml/badge.svg)](https://github.com/heidi-dang/FlowDeck/actions/workflows/ci.yml) |

---

## Overview

FlowDeck integrates with OpenCode as a plugin and provides:

- **Heidi master orchestration** — a primary agent (`heidi`) that executes tasks directly by default and delegates to specialists only when specific conditions are met.
- **13 specialized agents** — each with a defined role, model inheritance, and tool permissions.
- **61 validated skills** — reusable workflow patterns stored in `src/skills/<name>/SKILL.md`.
- **Tool governance** — permission guards, loop detection, token budgets, and audit logging.
- **Validation gates** — fast pre-push checks for changed files and a full production verification suite.
- **Session lifecycle** — start/end hooks, checkpoint, recovery, and session events.
- **Installation ownership tracking** — safe install, upgrade, rollback, and uninstall without damaging pre-existing configuration.

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
3. **Cleanup** — safely removes old/legacy FlowDeck registrations
4. **Verify** — confirms the environment is clean before proceeding
5. **Install** — installs the exact latest npm release
6. **Static verification** — `flowdeck verify`, `doctor`, `config validate`
7. **Runtime verification** — runs real OpenCode agent discovery
8. **Rollback** — automatic if any stage fails

See [Installation](docs/wiki/Installation.md) for all methods.

### Alternative — npm

```bash
npx @heidi-dang/flowdeck install
npx flowdeck verify
npx flowdeck doctor
```

---

## Features

- **13 specialized agents** — Heidi (default primary), orchestrator, planner, architect, and more
- **61 validated skills** — reusable workflow patterns in `src/skills/<name>/SKILL.md`
- **8 slash commands** — `/fd-task`, `/fd-execute`, `/fd-verify`, `/fd-review`, `/fd-checkpoint`, `/fd-resume`, `/fd-status`, `/fd-done`
- **Tool governance** — permission guards, loop detection, token budgets, and audit logging

---

## CLI Commands

| Command | Description |
|---|---|
| `flowdeck install` | Install plugin in OpenCode configuration |
| `flowdeck install --project` | Install in project-level `.opencode/` |
| `flowdeck install --local-repo` | Install from a local Git checkout |
| `flowdeck clean-install` | Atomic clean reinstall with discovery, backup, rollback, and runtime verification |
| `flowdeck verify` | Verify package identity and OpenCode registration |
| `flowdeck doctor` | Run comprehensive diagnostics |
| `flowdeck config validate` | Validate JSON/JSONC configuration syntax |
| `flowdeck migrate` | Migrate configuration from upstream (`@dv.nghiem/flowdeck`) |
| `flowdeck update` | Update plugin registration reference |
| `flowdeck rollback` | Roll back configuration from a backup |
| `flowdeck uninstall` | Remove FlowDeck plugin registration safely |
| `flowdeck dry-run` | Show what would be done without modifying files |
| `flowdeck --help` | Show detailed help |

---

## Architecture

```
OpenCode (model access, session, core tools)
  |
  +-- FlowDeck Plugin (src/index.ts)
        |
        +-- Configuration (src/config/)
        |     +-- Schema validation
        |     +-- Agent model overrides
        |     +-- Governance settings
        |
        +-- Agent Registry (src/agents/)
        |     +-- Heidi (default primary agent)
        |     +-- 12 specialized agents
        |     +-- Routing rules
        |
        +-- Hooks (src/hooks/)
        |     +-- Orchestrator guard (tool permission)
        |     +-- Tool guard (execution control)
        |     +-- Guard rails (safety boundaries)
        |     +-- Session start/end lifecycle
        |     +-- Session events
        |
        +-- Services (src/services/)
        |     +-- Governance wiring (validator, supervisor, audit)
        |     +-- Loop detector
        |     +-- Token budget enforcement
        |     +-- Recovery layer
        |     +-- Verification layer
        |     +-- Canonical agent registry
        |
        +-- Tools (src/tools/)
        |     +-- 15 FDX tools (with TypeScript fallbacks)
        |     +-- Doctor diagnostics
        |     +-- Codebase state and graphing
        |     +-- Rule loading
        |
        +-- Skills (src/skills/)
        |     +-- 61 validated workflow patterns
        |
        +-- MCP (src/mcp/)
        |     +-- Model Context Protocol server configurations
        |
        +-- FDX Native (crates/fdx/)
              +-- Rust-powered CLI for repository analysis
```

### Boundary Summary

| Layer | Responsibility |
|---|---|
| **OpenCode core** | Model access, sessions, core tool execution, UI |
| **FlowDeck plugin** | Agent orchestration, governance, hooks, skills |
| **FDX (Rust)** | High-performance repository analysis (optional) |
| **Web UI** | Not bundled — external integration point |

---

## Configuration

FlowDeck reads its configuration from `opencode.json` (or `opencode.jsonc`) in the OpenCode config directory:

- **Linux/macOS**: `~/.config/opencode/opencode.json`
- **Windows**: `%APPDATA%/opencode/opencode.json`
- **Project-level**: `.opencode/opencode.json` in the project directory
- **Override**: `OPENCODE_CONFIG_DIR` environment variable

The `install` command adds FlowDeck to the `plugin` array and sets `default_agent` to `heidi` when no default agent exists. See [Configuration](docs/wiki/Configuration.md) for details.

---

## Verification

```bash
# Level 1 — CLI resolves
flowdeck --version

# Level 2 — Package identity and plugin registration
flowdeck verify

# Level 3 — Full diagnostics
flowdeck doctor

# Level 4 — OpenCode smoke test (requires restart)
opencode run "inspect this project" --agent heidi
```

See [Verification](docs/wiki/Verification.md) for the complete 7-level verification procedure.

---

## Development

```bash
npm ci
npm run build
npm run lint
npm run typecheck
npm test
npm run test:coverage
npm run validate:skills
npm run validate:docs
npm run verify:fast     # Fast checks for changed files
npm run verify:full     # Full production verification
```

See [Development](docs/wiki/Development.md) for detailed contribution guidelines.

---

## Roadmap

### Current (v0.8.0-alpha.1)
- Heidi master orchestration with delegation depth 1
- 13 specialized agents and 61 validated skills
- Fast and full pre-push verification gates
- Tool governance with loop detection, token budgets, audit logging
- Installation ownership tracking and safe uninstall
- FDX native tools with TypeScript fallbacks

### Planned
- **Better Harness** — repository analysis, evidence-based scoring, remediation planning, and verification for AI-produced code changes
- Web UI reporting for governance and audit data
- Expanded skill library

---

## Contributing

1. Branch from `main` and prefix your branch (e.g., `feat/`, `fix/`, `docs/`).
2. Run focused tests during development: `npm test -- tests/<file>.test.ts`.
3. Run `npm run verify:full` before opening a PR.
4. Do not edit `dist/` — it is generated by `npm run build`.
5. Report security vulnerabilities privately via the [issue tracker](https://github.com/heidi-dang/FlowDeck/issues).

See [Contributing](docs/wiki/Development.md) for full guidelines.

---

## Security

- FlowDeck governance operates within OpenCode's permission model — it is not an operating-system sandbox.
- Users remain responsible for provider credentials and tool permissions.
- Configuration examples in this documentation do not contain real secrets.
- Report security vulnerabilities through GitHub Issues (private disclosure preferred).

---

## License

MIT — see [LICENSE](LICENSE)

*Upstream source: [DVNghiem/FlowDeck](https://github.com/DVNghiem/FlowDeck)*
