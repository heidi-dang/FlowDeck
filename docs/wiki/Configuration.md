# Configuration

FlowDeck reads its configuration from the OpenCode configuration file (`opencode.json` or `opencode.jsonc`).

## Configuration File Location

| Scope | Path |
|---|---|
| User-level (Linux/macOS) | `~/.config/opencode/opencode.json` |
| User-level (Windows) | `%APPDATA%\opencode\opencode.json` |
| Project-level | `.opencode/opencode.json` (in project root) |
| Custom | `$OPENCODE_CONFIG_DIR/opencode.json` |

## What FlowDeck Adds

When you run `flowdeck install`, the following changes are made:

### Plugin Registration

```json
{
  "plugin": [
    "@heidi-dang/flowdeck"
  ]
}
```

For local-repo installations:
```json
{
  "plugin": [
    "file:///absolute/path/to/FlowDeck"
  ]
}
```

### Default Agent

If no `default_agent` exists in your configuration, FlowDeck sets:

```json
{
  "default_agent": "heidi"
}
```

## Safe Configuration Editing

The `install` command uses transactional config mutation:

1. **Read and validate** — parses the configuration; rejects malformed JSON/JSONC without mutation.
2. **Compute intended edits** — determines exactly what changes are needed.
3. **Validate edits** — verifies the edits produce valid JSON/JSONC.
4. **Backup** — creates a timestamped backup before writing.
5. **Write** — writes the mutated file preserving JSONC comments.

If any step fails, the file is not modified.

## JSONC Support

FlowDeck preserves JSONC comments (both `//` and `/* */` styles) through all mutation operations. Existing comments remain intact after `install`, `update`, `migrate`, or `uninstall`.

## Agent Model Overrides

FlowDeck does not hardcode models. All agents inherit the OpenCode session model by default. To assign specific models:

```json
{
  "agent": {
    "planner": { "model": "anthropic/claude-opus-4" },
    "tester":  { "model": "openai/gpt-4o-mini" }
  }
}
```

This is optional. Without overrides, every agent uses the model selected in the OpenCode UI.

## Governance Configuration

Governance subsystems can be configured with mode settings:

```json
{
  "governance": {
    "validator": "strict",
    "loopDetector": "advisory",
    "auditLog": "strict",
    "toolGuard": "strict"
  }
}
```

Modes: `off` (disabled), `advisory` (warn only), `strict` (block violations).

## Environment Variables

| Variable | Purpose |
|---|---|
| `OPENCODE_CONFIG_DIR` | Override the OpenCode config directory |
| `XDG_CONFIG_HOME` | Base directory for XDG config (Linux/macOS) |

## Validating Configuration

```bash
flowdeck config validate
```

This command checks:
- JSON/JSONC syntax validity
- Plugin entry structure
- Agent override format
- Governance settings

## Preserving Existing Settings

FlowDeck's installation ownership tracking ensures:

- Pre-existing plugins are preserved
- Existing `default_agent` value is not overwritten
- Non-FlowDeck configuration properties are never modified
- Uninstall removes only what FlowDeck added
