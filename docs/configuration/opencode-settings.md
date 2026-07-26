# OpenCode Integration Settings

FlowDeck integrates with OpenCode as a plugin. This page explains how the plugin is registered, what gets published as an npm package, and what environment variables FlowDeck reads at runtime.

---

## Plugin Registration

FlowDeck uses the `@opencode-ai/plugin` package to register itself with OpenCode. After running `npm install @heidi-dang/flowdeck`, the `postinstall` script (`postinstall.mjs`) automatically:

1. Reads the OpenCode global config at `~/.config/opencode/opencode.json` (or `$OPENCODE_CONFIG_DIR/opencode.json`)
2. Adds `"@heidi-dang/flowdeck"` to the `plugin` array if not already present
3. Sets `"default_agent": "heidi"` if not already set (preserves existing explicit settings)
4. Writes the updated config back to disk atomically

OpenCode loads all plugins listed in the `plugin` array on startup.

---

## Package Contents

The `package.json` `files` field controls what gets published as the npm package:

```
files:
  dist/         — compiled plugin code
  bin/          — CLI entry point
  src/commands/ — command implementations
  src/rules/    — coding standards
  src/skills/   — skill definitions
  docs/         — documentation
  postinstall.mjs — post-install registration script
```

The npm package does **not** include all source directories. Development files are excluded from the published package.

---

## Plugin Architecture

FlowDeck registers its capabilities through the following source directories:

### `src/agents/`

Agent definitions. Each agent specifies its role, allowed tools, instructions, and delegation policies.

### `src/tools/`

Tool definitions. These extend OpenCode's tool set with FlowDeck-specific capabilities.

### `src/hooks/`

System hooks that react to OpenCode lifecycle events.

### `src/skills/`

Skill definitions exported via the plugin's skill registration API. Skills expose reusable workflow patterns (TDD, security scan, code review, etc.) to OpenCode's skill system.

---

## Environment Variables

FlowDeck reads the following environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCODE_CONFIG_DIR` | `~/.config/opencode` | OpenCode configuration directory |
| `XDG_CONFIG_HOME` | `~/.config` | Used to derive `OPENCODE_CONFIG_DIR` if not set |
| `FLOWDECK_CONTEXT_LIMIT` | `200000` | Token limit for context window monitor |
| `FLOWDECK_TOOL_GUARD_ENABLED` | `on` | Enable/disable tool guard |
| `FLOWDECK_GUARD_RAILS_ENABLED` | `on` | Enable/disable guard rails |
| `FLOWDECK_ORCHESTRATOR_GUARD` | `on` | Enable/disable orchestrator guard |
| `FLOWDECK_MAX_BACKUPS` | `5` | Maximum configuration backup files to retain |

FlowDeck does **not** read any API keys, tokens, or secrets. All model authentication is handled by OpenCode.

---

## opencode.json Schema (Plugin Section)

After installation, your `opencode.json` looks like:

```json
{
  "plugin": [
    "@heidi-dang/flowdeck"
  ],
  "default_agent": "heidi"
}
```

FlowDeck's plugin reads the top-level keys described in [Configuration](index.md) from this same file.
