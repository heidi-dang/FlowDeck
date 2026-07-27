# Uninstall

FlowDeck's uninstall process respects installation ownership tracking. It only removes configuration entries that FlowDeck itself added.

## Standard Uninstall

```bash
flowdeck uninstall
```

**Requirements**: A valid `.flowdeck-manifest.json` must exist.

**What it removes**:
- The FlowDeck plugin entry from the `plugin` array (only if FlowDeck added it).
- The `default_agent` property (only if FlowDeck set it, restoring the previous value if one existed).

**What it preserves**:
- Pre-existing plugin entries
- Pre-existing `default_agent` value
- Configuration comments
- All other configuration properties

## Forced Uninstall

```bash
flowdeck uninstall --force
```

Use when the installation manifest is missing or corrupt.

**What it removes**:
- The exact `@heidi-dang/flowdeck` or `file://` reference from the `plugin` array.
- Does NOT touch `default_agent` (no manifest means no authority to revert it).

## Project-Level Uninstall

```bash
flowdeck uninstall --project
```

Removes FlowDeck from the project-level `.opencode/opencode.json`.

## Shell Script

```bash
bash uninstall.sh
```

The shell wrapper delegates all configuration mutations to the CLI.

## Verify Uninstall

After uninstalling:

```bash
flowdeck verify
```

This will report that FlowDeck is not registered, confirming the uninstall succeeded.

## Full Cleanup

To also remove backup files and plugin cache:

```bash
bash uninstall.sh --clean
```

## Reinstall

```bash
flowdeck install
```

All configuration changes are reversible — reinstall restores the plugin entry.
