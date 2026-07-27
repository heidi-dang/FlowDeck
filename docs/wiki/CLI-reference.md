# CLI Reference

The `flowdeck` CLI manages installation, verification, and removal of the FlowDeck plugin.

## Global Options

| Flag | Description |
|---|---|
| `--help` | Show help message |
| `--version` | Show version number |

## Commands

### `install`

Install the FlowDeck plugin in OpenCode configuration.

```bash
flowdeck install                        # User-level installation
flowdeck install --project              # Project-level installation
flowdeck install --local-repo           # Installation from local checkout
```

**Exit codes**: 0 on success, 1 on failure.

**Expected behavior**:
- Reads OpenCode configuration (`opencode.json` or `opencode.jsonc`)
- Adds plugin reference to the `plugin` array
- Sets `default_agent` to `heidi` if no default agent exists
- Creates timestamped backup before any mutation
- Creates ownership manifest (`.flowdeck-manifest.json`)

### `verify`

Verify package identity and OpenCode plugin registration.

```bash
flowdeck verify
```

**Exit codes**: 0 if all checks pass, 1 if any check fails.

**Checks performed**:
1. Package identity in `package.json`
2. Global config plugin registration
3. Project config plugin registration
4. Local-repo checkout resolution
5. Package version

### `doctor`

Run comprehensive diagnostics.

```bash
flowdeck doctor
```

**Exit codes**: 0 if HEALTHY, 1 if UNHEALTHY.

**Checks performed**:
- Package identity and version
- Plugin registration
- Config validity
- Agent registration count (expected: 13)
- Skill validation (expected: 61 valid)
- FDX binary availability
- Install mode detection

### `config validate`

Validate JSON/JSONC configuration syntax.

```bash
flowdeck config validate                # User-level config
flowdeck config validate --project      # Project-level config
```

**Exit codes**: 0 for valid, 1 for invalid or not found.

### `update`

Update FlowDeck plugin registration reference.

```bash
flowdeck update
```

**Exit codes**: 0 on success, 1 on failure.

Updates migration references and stale version-pinned entries.

### `migrate`

Migrate configuration from `@dv.nghiem/flowdeck` to `@heidi-dang/flowdeck`.

```bash
flowdeck migrate
```

**Exit codes**: 0 on success, 1 on failure.

### `rollback`

Roll back configuration from a timestamped backup.

```bash
flowdeck rollback
```

**Exit codes**: 0 on success, 1 on failure.

### `uninstall`

Remove FlowDeck plugin registration.

```bash
flowdeck uninstall                      # Safe uninstall (requires manifest)
flowdeck uninstall --force              # Force removal without manifest
flowdeck uninstall --project            # Project-level uninstall
```

**Exit codes**: 0 on success, 1 on failure.

**Safety**: Without a valid installation manifest, `uninstall` refuses to proceed unless `--force` is provided. This protects against unintended configuration damage.

### `dry-run`

Show what `install` would do without modifying files.

```bash
flowdeck dry-run
```

**Exit codes**: 0.

## Platform-Specific Notes

### Windows

Replace `flowdeck` with `node bin/flowdeck.js` when running from a local checkout:

```powershell
node bin/flowdeck.js install --local-repo
```

### Unix (Linux/macOS)

Use the `install.sh` wrapper for local-repo installations:

```bash
bash install.sh --local-repo
```
