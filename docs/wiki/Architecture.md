# Architecture

FlowDeck extends OpenCode as a plugin, adding structured orchestration, governance, and workflow capabilities without replacing OpenCode's core infrastructure.

## System Layers

```
┌─────────────────────────────────────────────────┐
│                  OpenCode Core                   │
│  Model access · Sessions · Core tools · UI      │
└────────────────────┬────────────────────────────┘
                     │ plugin lifecycle
                     ▼
┌─────────────────────────────────────────────────┐
│              FlowDeck Plugin Entry              │
│              src/index.ts                        │
│  ┌───────────┬───────────┬──────────────────┐   │
│  │ Config    │ Agents    │ Hooks            │   │
│  │ Schema    │ Heidi     │ OrchestratorGuard│   │
│  │ Models    │ Planner   │ ToolGuard        │   │
│  │Governance │ Architect │ GuardRails       │   │
│  │           │ ... 13    │ SessionEvents    │   │
│  ├───────────┼───────────┼──────────────────┤   │
│  │ Services  │ Tools     │ Skills           │   │
│  │ Validator │ FDX 15    │ 89 skill files   │   │
│  │ Supervisor│ Doctor    │                  │   │
│  │ AuditLog  │ CodeState │                  │   │
│  │ Recovery  │ Rules     │                  │   │
│  │ LoopDetect│           │                  │   │
│  └───────────┴───────────┴──────────────────┘   │
└────────────────────┬────────────────────────────┘
                     │ optional
                     ▼
┌─────────────────────────────────────────────────┐
│           FDX Native (Rust)                      │
│           crates/fdx/                            │
│  High-performance repository analysis            │
└─────────────────────────────────────────────────┘
```

## Component Boundaries

### OpenCode Core Responsibilities
- Model provider access and credential management
- Session lifecycle (create, continue, resume)
- Core tool execution (file read/write, search, shell)
- User interface (TUI, headless, web, mini)

### FlowDeck Plugin Responsibilities
- Agent orchestration and routing
- Tool permission governance
- Session lifecycle hooks (start, end, events)
- Workflow validation and verification
- Audit logging and recovery
- Skill discovery and validation
- Configuration schema and model resolution
- Pre-push verification gates

### FDX Native (Rust) Responsibilities
- Repository diff analysis
- Codebase impact assessment
- High-performance grep and search
- Tree and outline generation

## Key Design Decisions

### Delegation Depth of 1
Heidi executes tasks directly by default. Delegation to specialist agents is limited to one level — specialists cannot spawn sub-agents, and Heidi cannot delegate to itself. This prevents runaway delegation chains.

### Model Inheritance
All agents inherit the OpenCode session model by default. Model overrides are optional and configured through the `agent` property in FlowDeck configuration.

### Transactional Config Mutation
All configuration changes go through a transaction service that validates, backs up, and atomically applies edits. Failed transactions never leave partial modifications.

### Installation Ownership
The install manifest (`flowdeck-manifest.json`) records exactly what changes FlowDeck made. The `uninstall` command uses this manifest to safely revert only FlowDeck-owned changes.

### JSONC Preservation
Comments in JSONC configuration files are preserved through all mutation operations using the `jsonc-parser` library.

## FlowDeck CLI

The CLI binary (`bin/flowdeck.js`) handles:
- Installation and plugin registration
- Verification and diagnostics
- Configuration validation
- Migration from upstream
- Safe uninstall and rollback
- Dry-run preview
