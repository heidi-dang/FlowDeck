#!/usr/bin/env bash
# install.sh — FlowDeck Installer (Heidi fork)
# Usage:
#   bash install.sh                    Install from npm (published package)
#   bash install.sh --local-repo       Install from local repository checkout
#   bash install.sh --dev-env          Alias for --local-repo
#   bash install.sh --check-config     Verify configuration only
#   bash install.sh --dry-run          Show what would be done
#   bash install.sh --uninstall        Remove FlowDeck
#
# For full CLI installer: npx @heidi-dang/flowdeck

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_NAME="@heidi-dang/flowdeck"
MODE="publish"   # publish | local-repo
NON_INTERACTIVE=0
DRY_RUN=0
CHECK_CONFIG=0
UNINSTALL=0

for arg in "$@"; do
  case "$arg" in
    --local-repo|--local|--dev-env) MODE="local-repo" ;;
    --yes|-y) NON_INTERACTIVE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --check-config) CHECK_CONFIG=1 ;;
    --uninstall) UNINSTALL=1 ;;
  esac
done

# Determine OpenCode config directory
if [ "$MODE" = "local-repo" ]; then
  OPENCODE_DIR="$(pwd)/.opencode"
else
  OPENCODE_DIR="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"
fi

info()    { echo "[INFO] $*"; }
success() { echo "[OK]   $*"; }
warn()    { echo "[WARN] $*"; }
error()   { echo "[ERR]  $*" >&2; exit 1; }

# ── Pre-checks ──────────────────────────────────────────────────────────────
if [ "$DRY_RUN" -eq 1 ] && [ "$UNINSTALL" -eq 0 ]; then
  info "DRY RUN — No files modified."
  info "Mode: $MODE"
  info "Target OpenCode dir: $OPENCODE_DIR"
  success "Dry run complete."
  exit 0
fi

# ── Uninstall ───────────────────────────────────────────────────────────────
if [ "$UNINSTALL" -eq 1 ]; then
  if [ -f "$SCRIPT_DIR/uninstall.sh" ]; then
    exec bash "$SCRIPT_DIR/uninstall.sh" "$@"
  else
    error "uninstall.sh not found in $SCRIPT_DIR"
  fi
fi

# ── Config Check Mode ──────────────────────────────────────────────────────
if [ "$CHECK_CONFIG" -eq 1 ]; then
  info "Verifying FlowDeck configuration..."
  OPENCODE_JSON="$OPENCODE_DIR/opencode.json"

  if [ ! -f "$OPENCODE_JSON" ]; then
    warn "opencode.json not found at $OPENCODE_JSON"
    echo "[INFO] Run install first: bash install.sh"
    exit 0
  fi

  node --input-type=module <<EOF
import { readFileSync, existsSync } from "node:fs";
const configFile = "${OPENCODE_JSON}";
let errors = 0;

if (existsSync(configFile)) {
  const raw = readFileSync(configFile, "utf-8");
  try {
    JSON.parse(raw);
    console.log("[OK]   opencode.json is valid JSON");
  } catch (e) {
    console.error("[ERR]  opencode.json is malformed JSON: " + e.message);
    errors++;
  }

  // Check fork identity
  if (raw.includes("@heidi-dang/flowdeck")) {
    console.log("[OK]   Plugin identity: @heidi-dang/flowdeck");
  } else if (raw.includes("@dv.nghiem/flowdeck")) {
    console.error("[ERR]  Plugin points to upstream @dv.nghiem/flowdeck — fork identity issue");
    errors++;
  } else if (!raw.includes("flowdeck")) {
    console.warn("[WARN] FlowDeck plugin not registered in opencode.json");
  }
} else {
  console.warn("[WARN] opencode.json not found at " + configFile);
}

if (errors > 0) {
  console.log("[FAIL] " + errors + " error(s) found");
  process.exit(1);
} else {
  console.log("[OK]   All checks passed");
}
EOF
  exit $?
fi

# ── Local-repo installation ──────────────────────────────────────────────
install_local_repo() {
  info "Installing FlowDeck from local repository..."

  if [ ! -f "$SCRIPT_DIR/package.json" ]; then
    error "package.json not found in $SCRIPT_DIR — not a valid FlowDeck repository"
  fi

  local pkg_version
  pkg_version=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$SCRIPT_DIR/package.json','utf-8')).version)")

  info "FlowDeck v${pkg_version} — local repo"

  mkdir -p "$OPENCODE_DIR"

  # Register plugin using Node config editor
  node --input-type=module <<EOF
import { readFileSync, writeFileSync, existsSync, copyFileSync, renameSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const configDir = "${OPENCODE_DIR}";
const configFile = join(configDir, "opencode.json");

mkdirSync(configDir, { recursive: true });

let raw = "{}";
let existingData = {};

if (existsSync(configFile)) {
  raw = readFileSync(configFile, "utf-8");
  try {
    existingData = JSON.parse(raw);
  } catch (e) {
    console.error("[ERR]  malformed opencode.json — preserving without modification");
    console.error("       " + e.message);
    process.exit(1);
  }
}

// Backup before mutation
try { copyFileSync(configFile, configFile + ".pre-install.bak"); } catch {}

const updated = JSON.parse(JSON.stringify(existingData));
let changed = false;

if (!Array.isArray(updated.plugin)) updated.plugin = [];
const pluginRef = "@heidi-dang/flowdeck";
const alreadyReg = updated.plugin.some(p => p === pluginRef || String(p).startsWith(pluginRef + "@"));
if (!alreadyReg) {
  updated.plugin.push(pluginRef);
  console.log("[OK]   Added @heidi-dang/flowdeck to plugin list");
  changed = true;
}

if (updated.default_agent == null) {
  updated.default_agent = "heidi";
  console.log("[OK]   Set default_agent to heidi");
  changed = true;
}

if (changed) {
  const tmpFile = join(configDir, \`.opencode.json.tmp.\${Date.now()}\`);
  writeFileSync(tmpFile, JSON.stringify(updated, null, 2) + "\n", "utf-8");
  renameSync(tmpFile, configFile);
}

console.log(\`[OK]   Installed @heidi-dang/flowdeck to \${configDir}\`);
EOF

  echo ""
  success "FlowDeck installed from local repository"
  info   "Config: $OPENCODE_DIR"
  info   "Source: $SCRIPT_DIR"
  info   "A fresh OpenCode session is required to activate."
  info   "Run: npx @heidi-dang/flowdeck verify"
}

# ── Published package installation ──────────────────────────────────────
install_published() {
  info "Installing FlowDeck published package..."

  # Check if package is available locally (via npm link or local install)
  if command -v npx >/dev/null 2>&1; then
    info "Using npx to register plugin..."
    npx --yes @heidi-dang/flowdeck install 2>/dev/null || {
      warn "npx registration failed — falling back to direct config edit"
      fallback_direct_install
    }
  else
    fallback_direct_install
  fi
}

fallback_direct_install() {
  mkdir -p "$OPENCODE_DIR"
  local configFile="$OPENCODE_DIR/opencode.json"
  local raw="{}"

  if [ -f "$configFile" ]; then
    raw=$(cat "$configFile")
  fi

  # Simple edit using node
  node -e "
const fs = require('fs');
const cfg = JSON.parse('$raw' || '{}');
if (!Array.isArray(cfg.plugin)) cfg.plugin = [];
if (!cfg.plugin.includes('@heidi-dang/flowdeck')) {
  cfg.plugin.push('@heidi-dang/flowdeck');
}
if (cfg.default_agent == null) cfg.default_agent = 'heidi';
const tmp = '$configFile.tmp';
fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
fs.renameSync(tmp, '$configFile');
console.log('[OK] Registered @heidi-dang/flowdeck');
" 2>/dev/null || {
    error "Failed to install — try: npx @heidi-dang/flowdeck install"
  }
}

# ── Main Installation ──────────────────────────────────────────────────
case "$MODE" in
  local-repo)
    install_local_repo
    ;;
  publish)
    install_published
    ;;
esac

echo ""
info "To verify installation: npx @heidi-dang/flowdeck verify"
info "To run diagnostics:     npx @heidi-dang/flowdeck doctor"
