# Installation — Linux

## Prerequisites

- Node.js >= 18.0.0 (install via your package manager or [nodejs.org](https://nodejs.org))
- OpenCode >= 1.4.0

### Install Node.js (Debian/Ubuntu)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### Install Node.js (Fedora/RHEL)

```bash
sudo dnf install nodejs
```

## Install from npm (Recommended)

```bash
npx @heidi-dang/flowdeck install
```

## Install from Local Repository

```bash
git clone https://github.com/heidi-dang/FlowDeck.git
cd FlowDeck
npm install
npm run build
bash install.sh --local-repo
```

## Configuration Path

```
~/.config/opencode/opencode.json
```

Can be overridden with the `OPENCODE_CONFIG_DIR` or `XDG_CONFIG_HOME` environment variables.

```bash
# Override config directory
export OPENCODE_CONFIG_DIR=~/.config/my-opencode
```
