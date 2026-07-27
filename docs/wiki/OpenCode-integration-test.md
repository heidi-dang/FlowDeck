# OpenCode Integration Test

This page describes how to verify that FlowDeck is actively working inside OpenCode.

## Offline Structural Verification

Run the automated verification script:

```bash
npm run verify:installation:offline
```

This script performs structural checks without requiring AI provider credentials:

1. Creates an isolated temporary OpenCode configuration directory.
2. Installs FlowDeck from the local package.
3. Runs `flowdeck verify` and `flowdeck doctor`.
4. Inspects the resulting configuration for correct plugin registration.
5. Verifies required packaged files exist.
6. Reports results.

**Expected result**: All offline checks pass.

## Provider-Backed Runtime Verification

```bash
npm run verify:installation
```

This runs the same structural checks plus an OpenCode runtime test. It requires:

- OpenCode installed and available in PATH
- At least one AI provider configured in OpenCode
- Network access to the provider

If provider credentials are not available, only the offline checks run and the online checks are reported as skipped.

## Manual Runtime Test

### Step 1: Confirm Plugin Loading

Start OpenCode in a non-critical directory:

```bash
cd /tmp/test-project
opencode
```

If OpenCode starts without plugin-loading errors, FlowDeck initialized correctly.

### Step 2: Verify Agent Discovery

In an existing OpenCode session, run:

```
Which agents are available? List them.
```

The response should include `heidi` and other FlowDeck agents.

### Step 3: Run a Controlled Task

Use a safe, read-only prompt:

> Inspect this project without modifying files.  
> Report the repository language, package manager, and available test command.

### Step 4: Verify Governance Activity

In a project with FlowDeck governance enabled, attempt to run a tool that requires approval:

- In strict governance mode, the tool should be blocked or require confirmation.
- This proves the governance layer is active.

## Controlled Write Verification

Never run destructive verification in the FlowDeck repository or a production project. Use an isolated temporary directory:

```bash
TMPDIR=$(mktemp -d)
cd "$TMPDIR"
git init
echo "# test" > README.md
git add README.md
git commit -m "init"
opencode
rm -rf "$TMPDIR"
```

## Cleanup

The automated verification script cleans up temporary directories automatically.
