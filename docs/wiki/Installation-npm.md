# Installation — npm

Install FlowDeck from the published npm package. This is the recommended method for most users.

## Prerequisites

- Node.js >= 18.0.0
- npm (bundled with Node.js)
- OpenCode >= 1.4.0

## Install

```bash
npx @heidi-dang/flowdeck install
```

### Expected Output

```
Installing FlowDeck (@heidi-dang/flowdeck v0.8.0-alpha.1)...

  ✓ Added @heidi-dang/flowdeck to plugin list

✓ FlowDeck installed (comments preserved).
  A fresh OpenCode session is required to activate.
```

### What Happens

1. `npx` downloads `@heidi-dang/flowdeck` to a temporary cache.
2. The `install` command reads your OpenCode configuration file.
3. It adds `@heidi-dang/flowdeck` to the `plugin` array.
4. If no `default_agent` exists, it sets `default_agent` to `heidi`.
5. An installation manifest (`.flowdeck-manifest.json`) is created for safe uninstall.

### Configuration Changes

**Before** (example):
```json
{
  "plugin": ["@existing/plugin"]
}
```

**After**:
```json
{
  "plugin": ["@existing/plugin", "@heidi-dang/flowdeck"],
  "default_agent": "heidi"
}
```

### Verification

```bash
flowdeck verify
flowdeck doctor
```

### Uninstall

```bash
npx @heidi-dang/flowdeck uninstall
```

See [Uninstall](Uninstall.md) for full details.
