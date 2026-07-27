# Verification

FlowDeck provides a 7-level verification procedure to confirm correct installation and runtime behavior.

## Level 1 — CLI Verification

```bash
# Confirm the CLI resolves
flowdeck --help

# Confirm the version
flowdeck --version
```

**Expected exit code**: 0

**Expected output**: Displays help text or version string.

## Level 2 — Package and Registration Verification

```bash
flowdeck verify
```

This checks:
1. Package identity (`@heidi-dang/flowdeck` in `package.json`)
2. Global config plugin registration
3. Project config plugin registration (if applicable)
4. Local-repo checkout resolution (for local-repo installations)
5. Package version

**Expected exit code**: 0

**Expected output**: All checks pass.

## Level 3 — Comprehensive Diagnostics

```bash
flowdeck doctor
```

This runs the full diagnostic engine and reports:

- Package identity
- Plugin version
- Repository identity
- Config validity
- Plugin registration
- Default agent status
- Agent count (expected: 13)
- Skill validation (expected: 61)
- FDX compatibility
- Installer identity
- Config ownership manifest

**Expected exit code**: 0

**Expected output**: `Status: HEALTHY`

## Level 4 — Filesystem Verification

Confirm that expected files exist in the installation:

```bash
# Package directory (npm installation)
ls node_modules/@heidi-dang/flowdeck/dist/index.js

# Or local checkout (local-repo installation)
ls /path/to/FlowDeck/dist/index.js

# Installation manifest
ls ~/.config/opencode/.flowdeck-manifest.json
```

## Level 5 — OpenCode Configuration Verification

```bash
# Validate configuration syntax
flowdeck config validate

# Manually inspect
cat ~/.config/opencode/opencode.json
```

Confirm:
- `"@heidi-dang/flowdeck"` (or `"file://..."`) appears in the `plugin` array exactly once.
- Other plugin entries remain unchanged.
- Comments are preserved (for JSONC files).
- `default_agent` is `"heidi"` (or your preferred agent).

## Level 6 — OpenCode Runtime Verification

Restart OpenCode and verify the plugin loads:

1. Start or restart OpenCode.
2. Confirm no plugin-loading errors appear.
3. Verify the `heidi` agent is available: `opencode --agent heidi`
4. Run a read-only test: in a non-critical directory, start OpenCode and ask: *"Inspect this project without modifying files. Report the repository language, package manager and available test command."*

**Expected result**: OpenCode responds with project analysis, demonstrating that the FlowDeck plugin orchestrated the task.

## Level 7 — Uninstall and Reinstall Verification

In an isolated test environment:

1. `flowdeck install` — install
2. `flowdeck verify` — verify
3. `flowdeck doctor` — full diagnostics
4. Start OpenCode and run a read-only task — runtime verification
5. `flowdeck uninstall` — uninstall
6. Confirm only FlowDeck-owned entries were removed from config
7. `flowdeck install` — reinstall
8. `flowdeck verify` — verify again

This proves the full lifecycle works without data loss.

## Automated Verification Script

```bash
npm run verify:installation:offline    # Structural checks (no credentials)
npm run verify:installation            # Full checks (may require provider)
```

See [OpenCode Integration Test](OpenCode-integration-test.md) for detailed runtime verification.
