# FlowDeck — Heidi fork

> Structured planning and execution workflows for OpenCode

FlowDeck adds multi-agent workflow orchestration to OpenCode. Coordinates 13 agents through an adaptive lifecycle — intake, route, context, execute, verify, complete — with persistent state, configurable governance, and tool-selection policies.

**Package**: `@heidi-dang/flowdeck`

---

## Quick Install

### From npm (published package)

```bash
npx @heidi-dang/flowdeck install
```

### From local repository

```bash
git clone https://github.com/heidi-dang/FlowDeck.git
cd FlowDeck
bash install.sh --local-repo
```

### From curl (standalone script)

```bash
curl -fsSL https://raw.githubusercontent.com/heidi-dang/flowdeck/main/install.sh | bash
```

See [docs/getting-started/installation.md](docs/getting-started/installation.md) for prerequisites and verification.

---

## Features

- **13 agents** — `heidi` (default primary), `orchestrator`, `planner`, `architect`, `backend-coder`, `frontend-coder`, `devops`, `tester`, `reviewer`, `researcher`, `security-auditor`, `mapper`, `debug-specialist`
- **61 skills** — validated workflow patterns in `src/skills/<name>/SKILL.md`
- **8 slash commands** — `/fd-task`, `/fd-execute`, `/fd-verify`, `/fd-review`, `/fd-checkpoint`, `/fd-resume`, `/fd-status`, `/fd-done`
- **Heidi direct execution** — execute tasks directly by default, delegate to specialists only when justified
- **Delegation depth 1** — specialists cannot delegate; Heidi cannot delegate to itself
- **Persistent state** — resume across sessions via `~/.fd-plan/<project-id>/`
- **FDX CLI with native fallbacks** — all 15 FDX tools have TypeScript fallbacks
- **Governance layer** — validator, supervisor, loop detector, audit log, verification, tool guard, guard rails
- **Governance modes** — `off`, `advisory`, `strict` for all subsystems
- **Model inheritance** — all agents inherit the UI-selected model by default (optional overrides supported)

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `flowdeck install` | Install plugin in opencode.json |
| `flowdeck install --project` | Install in project .opencode/ |
| `flowdeck install --local-repo` | Install from local checkout |
| `flowdeck verify` | Verify fork identity and registration |
| `flowdeck doctor` | Run comprehensive diagnostics |
| `flowdeck config validate` | Validate JSON/JSONC configuration |
| `flowdeck migrate` | Migrate from upstream to fork identity |
| `flowdeck update` | Update plugin registration |
| `flowdeck rollback` | Rollback from backup |
| `flowdeck uninstall` | Remove plugin registration |
| `flowdeck dry-run` | Show what would be done |

---

## Model Selection

FlowDeck does not hardcode any model. Every agent inherits the user's active OpenCode session model by default.

To assign a specific model to a specific agent, add it to `.flowdeck.json`:

```json
{
  "agentModels": {
    "planner": { "model": "anthropic/claude-opus-4" },
    "tester":  { "model": "openai/gpt-4o-mini" }
  }
}
```

---

## License

MIT — see [LICENSE](LICENSE)

*Upstream source: [DVNghiem/FlowDeck](https://github.com/DVNghiem/FlowDeck)*
