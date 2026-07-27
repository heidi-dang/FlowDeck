# Installation — macOS

## Prerequisites

- Node.js >= 18.0.0 (install via [Homebrew](https://brew.sh) or [nodejs.org](https://nodejs.org))
- OpenCode >= 1.4.0

### Install Node.js via Homebrew

```bash
brew install node
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

Can be overridden with the `OPENCODE_CONFIG_DIR` environment variable.
