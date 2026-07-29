# Installation

FlowDeck supports multiple installation methods. Choose the one that matches your use case.

## Method Comparison

| Method | Recommended For | Command |
|---|---|---|
| **curl pipe** (recommended) | All users — automated clean install | `curl -fsSL https://raw.githubusercontent.com/heidi-dang/FlowDeck/main/install.sh \| bash` |
| **npm** | Users who prefer explicit npm commands | `npx @heidi-dang/flowdeck install` |
| **Atomic clean reinstall** | Clean or contaminated environments | `flowdeck clean-install` |
| **Local repository** | Contributors, developers | `bash install.sh --local-repo` |
| **Project** | Single-project isolation | `flowdeck install --project` |

## Prerequisites

| Dependency | Minimum Version | Required For |
|---|---|---|
| [Node.js](https://nodejs.org) | >= 20.0.0 | All installations |
| [npm](https://www.npmjs.com) | (bundled with Node.js) | All installations |
| [OpenCode](https://opencode.ai) | >= 1.4.0 | Plugin activation |
| [Bun](https://bun.sh) | >= 1.0.0 | Development and local builds |
| [Rust/Cargo](https://rustup.rs) | >= 1.70 | FDX native tool development |

### Verify Prerequisites

```bash
node --version     # Must be >= 20.0.0
npm --version      # Bundled with Node.js
opencode --version # Must be >= 1.4.0
```

## Recommended: curl pipe installer

The piped installer performs a complete atomic lifecycle:

```bash
curl -fsSL https://raw.githubusercontent.com/heidi-dang/FlowDeck/main/install.sh | bash
```

**What it does:**

1. **Prerequisites check** — validates Node.js, npm, and OpenCode availability
2. **Configuration discovery** — finds FlowDeck registrations in all OpenCode config scopes
3. **Byte-for-byte backup** — every affected file is backed up before mutation
4. **Safe cleanup** — removes FlowDeck registrations using exact identity matching
5. **Clean-state verification** — confirms environment is clean before installing
6. **Exact-version installation** — installs the specific npm release
7. **Static verification** — runs `flowdeck verify`, `doctor`, and `config validate`
8. **Runtime verification** — runs real OpenCode agent discovery to confirm Heidi is available
9. **Automatic rollback** — if any mandatory stage fails, all files are restored

**Dry run:**

```bash
curl -fsSL https://raw.githubusercontent.com/heidi-dang/FlowDeck/main/install.sh | bash -s -- --dry-run
```

**Verify only:**

```bash
curl -fsSL https://raw.githubusercontent.com/heidi-dang/FlowDeck/main/install.sh | bash -s -- --verify-only
```

### How it works

The shell script is a standalone bootstrap that:
- Validates prerequisites
- Creates an isolated temporary directory
- Resolves the exact FlowDeck npm release
- Delegates all configuration mutations to the packaged `flowdeck clean-install` CLI
- Cleans up temporary files
- Returns the CLI exit code

It does NOT require a local repository checkout, `package.json` beside the script, or any specific working directory.

## Alternative: npm install

```bash
# Install and register
npx @heidi-dang/flowdeck install

# Verify
npx flowdeck verify
npx flowdeck doctor
```

## Alternative: atomic clean reinstall (CLI)

If FlowDeck is already installed but needs a clean reinstall:

```bash
flowdeck clean-install
```

With options:

```bash
flowdeck clean-install --dry-run           # Show what would be done
flowdeck clean-install --verify-only       # Check current state only
flowdeck clean-install --uninstall-only    # Remove only, don't reinstall
flowdeck clean-install --no-verify-runtime # Skip OpenCode runtime verification
```

## Platform-Specific Guides

- [Windows](Installation-Windows.md)
- [macOS](Installation-macOS.md)
- [Linux](Installation-Linux.md)

## Detailed Methods

- [Install from npm](Installation-npm.md) — quickest setup, published package
- [Install from local repository](Installation-local-repository.md) — for contributors
- [Install into a specific project](Installation-project.md) — project-local configuration

## Post-Installation

After installing, the FlowDeck plugin is registered in your OpenCode configuration. A fresh OpenCode session is required to activate it.

1. Restart OpenCode
2. Verify the installation: `flowdeck verify`
3. Run diagnostics: `flowdeck doctor`

## Verification Checklist

After installation, confirm:

- [ ] `flowdeck --help` displays the command list
- [ ] `flowdeck clean-install --help` shows clean-install options
- [ ] `flowdeck verify` passes all checks
- [ ] `flowdeck doctor` reports HEALTHY status
- [ ] OpenCode starts without plugin errors
- [ ] The `heidi` agent is available and primary in OpenCode

See [Verification](Verification.md) for the complete procedure.
