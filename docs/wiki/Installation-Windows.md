# Installation — Windows

FlowDeck supports Windows 10 and later via Node.js. The CLI uses Node.js directly, avoiding shell-script dependencies.

## Prerequisites

- [Node.js](https://nodejs.org) >= 20.0.0 (LTS recommended)
- OpenCode >= 1.4.0

## Install from npm (Recommended)

```powershell
npx @heidi-dang/flowdeck install
```

## Install from Local Repository

```powershell
git clone https://github.com/heidi-dang/FlowDeck.git
cd FlowDeck
npm install
npm run build
node bin/flowdeck.js install --local-repo
```

## Configuration Path

Windows OpenCode configuration is at:

```
%APPDATA%\opencode\opencode.json
```

Typical path:

```
C:\Users\<username>\AppData\Roaming\opencode\opencode.json
```

## Paths Containing Spaces

FlowDeck handles paths with spaces correctly. The CLI uses `process.execPath` and `file://` URLs internally, which are space-safe.

## Troubleshooting

| Issue | Solution |
|---|---|
| `flowdeck` not found | Restart your terminal or add `%APPDATA%\npm` to PATH |
| `npx` not found | Install Node.js from [nodejs.org](https://nodejs.org) |
| JSON parse errors | Ensure `opencode.json` is valid JSON or JSONC |
