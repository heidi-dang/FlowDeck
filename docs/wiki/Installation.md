# Installation

FlowDeck supports multiple installation methods. Choose the one that matches your use case.

## Method Comparison

| Method | Recommended For | Command |
|---|---|---|
| **npm** (recommended) | Most users | `npx @heidi-dang/flowdeck install` |
| **Local repository** | Contributors, developers | `bash install.sh --local-repo` |
| **Project** | Single-project isolation | `flowdeck install --project` |

## Prerequisites

| Dependency | Minimum Version | Required For |
|---|---|---|
| [Node.js](https://nodejs.org) | >= 18.0.0 | All installations |
| [npm](https://www.npmjs.com) | (bundled with Node.js) | npm installation |
| [OpenCode](https://opencode.ai) | >= 1.4.0 | Plugin activation |
| [Bun](https://bun.sh) | >= 1.0.0 | Development and local builds |
| [Rust/Cargo](https://rustup.rs) | >= 1.70 | FDX native tool development |

### Verify Prerequisites

```bash
node --version     # Must be >= 18.0.0
npm --version      # Bundled with Node.js
opencode --version # Must be >= 1.4.0
```

Bun is only required when building from source or running tests:

```bash
bun --version      # Optional — for development
```

Cargo is only required for FDX (Rust) tool development:

```bash
cargo --version    # Optional — for FDX development
```

## Platform-Specific Guides

- [Windows](Installation-Windows.md)
- [macOS](Installation-macOS.md)
- [Linux](Installation-Linux.md)

## Installation Methods

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
- [ ] `flowdeck --version` shows the correct version
- [ ] `flowdeck verify` passes all checks
- [ ] `flowdeck doctor` reports HEALTHY status
- [ ] OpenCode starts without plugin errors
- [ ] The `heidi` agent is available in OpenCode

See [Verification](Verification.md) for the complete procedure.
