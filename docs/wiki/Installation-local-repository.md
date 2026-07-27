# Installation — Local Repository

Install FlowDeck from a local Git checkout. This method is designed for contributors and developers who want to modify FlowDeck source code.

## Prerequisites

- Node.js >= 18.0.0
- npm
- Git
- OpenCode >= 1.4.0
- Bun >= 1.0.0 (for building from source, installed by `npm install`)

## Install

```bash
# Clone the repository
git clone https://github.com/heidi-dang/FlowDeck.git
cd FlowDeck

# Install dependencies and build
npm install
npm run build

# Register the plugin in OpenCode
bash install.sh --local-repo
```

### Expected Output

```
Installing FlowDeck from local repository...

  Package: @heidi-dang/flowdeck
  Version: 0.8.0-alpha.1
  Source:  /home/user/FlowDeck

  ✓ Added file:///home/user/FlowDeck to plugin list

✓ FlowDeck installed (comments preserved).
  A fresh OpenCode session is required to activate.
  Installed from local repository.
  Config: /home/user/.config/opencode
  Source: /home/user/FlowDeck
```

### What Happens

1. The plugin reference uses a `file://` URL pointing to your local checkout.
2. OpenCode loads FlowDeck directly from the checkout path.
3. The `install` command adds `file:///absolute/path/to/FlowDeck` to the `plugin` array.
4. The default agent is set to `heidi` if not already configured.
5. An installation manifest records the checkout path for verification.

### Verification

```bash
flowdeck verify
flowdeck doctor
```

The `doctor` command will report `global install mode: local repository checkout` and display the checkout path.

### Updating

```bash
cd FlowDeck
git pull origin main
npm install
npm run build
```

OpenCode will pick up the updated plugin on next restart.

### Uninstall

```bash
bash install.sh --uninstall
```

Or:

```bash
flowdeck uninstall
```

### PowerShell (Windows)

```powershell
node bin/flowdeck.js install --local-repo
```

See [Windows installation](Installation-Windows.md) for platform-specific guidance.
