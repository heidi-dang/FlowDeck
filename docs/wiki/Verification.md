# Verification

FlowDeck provides an 8-level verification procedure to confirm correct installation and runtime behavior.

## Level 0 — Clean-Install Verification

When using the atomic clean installer, verification is built in:

```bash
curl -fsSL https://raw.githubusercontent.com/heidi-dang/FlowDeck/main/install.sh | bash
```

The installer automatically runs:
1. Clean-state verification (no FlowDeck remnants before install)
2. Static verification (`flowdeck verify`, `doctor`, `config validate`)
3. OpenCode runtime agent discovery (`opencode agent list`)
4. Optional provider-backed smoke test

You can also run verification independently:

```bash
curl ... | bash -s -- --verify-only
# or
flowdeck clean-install --verify-only
```

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

This runs 25+ diagnostic checks covering package identity, configuration validity, installation manifest, agent registry, skills, commands, delegation depth, governance wiring, FDX availability, lock implementation, and more.

**Expected exit code**: 0

**Expected output**: "Status: HEALTHY"

## Level 4 — Configuration Validation

```bash
flowdeck config validate
```

**Expected exit code**: 0

**Expected output**: "Valid JSON/JSONC configuration"

## Level 5 — Clean-State Verification

Verify no stale FlowDeck registrations remain:

```bash
flowdeck clean-install --verify-only
```

Produces a machine-readable clean-state report:

```
Clean-state verification:
  Configs checked: 2
  FlowDeck plugin entries: 0
  Legacy plugin entries: 0
  Verified FlowDeck paths: 0
  Parse errors: 0
  Clean: YES
```

## Level 6 — OpenCode Runtime Verification

The most authoritative check — confirms the real OpenCode process loads FlowDeck correctly:

```bash
opencode --print-logs --log-level DEBUG agent list
```

**Required results:**
- Heidi is returned as a registered agent
- Heidi mode is `primary`
- Heidi is NOT hidden
- No `"Plugin export is not a function"` error
- No `"failed to load plugin"` error
- Orchestrator is returned as a primary agent

## Level 7 — Provider-Backed Smoke Test (optional)

When provider credentials are configured, run a read-only task:

```bash
opencode run --no-write --prompt "Return exactly: FLOWDECK_RUNTIME_OK"
```

**Expected output**: Contains `FLOWDECK_RUNTIME_OK`

This test is **skipped** when no credentials are available — absence of credentials is not a failure.

## Complete Verification Script

The packaged `verify:installation` script runs the full verification suite:

```bash
# Offline (no provider credentials needed)
node scripts/verify-opencode-integration.mjs --offline

# Full (includes optional OpenCode runtime checks)
node scripts/verify-opencode-integration.mjs

# Release alignment
node scripts/release-alignment.mjs
```
