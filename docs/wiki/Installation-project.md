# Installation — Project

Install FlowDeck for a single project. The plugin is registered in the project's `.opencode/opencode.json` rather than the user-level configuration.

## Who Should Use This

- Users who want FlowDeck only in specific projects
- Teams that want project-level agent configurations
- Users with conflicting plugin requirements across projects

## Prerequisites

- Node.js >= 18.0.0
- npm
- OpenCode >= 1.4.0

## Install

```bash
# FlowDeck must be available via npx or globally installed first
npx @heidi-dang/flowdeck install --project
```

### Expected Output

```
Installing FlowDeck for this project...
```

### Configuration Precedence

OpenCode loads configuration in this order:

1. **Project-level**: `.opencode/opencode.json` in the current working directory
2. **User-level**: `~/.config/opencode/opencode.json` (or `%APPDATA%/opencode/opencode.json` on Windows)

Project-level settings override user-level settings. FlowDeck can be installed at either or both levels.

### Verification

```bash
# Check project config
flowdeck config validate --project

# Full verification applies to whichever config OpenCode loads
flowdeck verify
flowdeck doctor
```

### Uninstall

```bash
flowdeck uninstall --project
```

For project installations, the `--project` flag must match the install flag.
