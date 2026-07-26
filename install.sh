#!/usr/bin/env bash
# install.sh — Install, Check, or Manage FlowDeck in OpenCode
# Usage: bash install.sh [--local] [--yes|-y] [--dry-run] [--check-config] [--uninstall]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IS_LOCAL=0
NON_INTERACTIVE=0
DRY_RUN=0
CHECK_CONFIG=0
UNINSTALL=0

for arg in "$@"; do
  case "$arg" in
    --local) IS_LOCAL=1 ;;
    --yes|-y) NON_INTERACTIVE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --check-config) CHECK_CONFIG=1 ;;
    --uninstall) UNINSTALL=1 ;;
  esac
done

info()    { echo "[INFO] $*"; }
success() { echo "[OK]   $*"; }
warn()    { echo "[WARN] $*"; }
error()   { echo "[ERR]  $*" >&2; exit 1; }

if [ "$IS_LOCAL" -eq 1 ]; then
  OPENCODE_DIR="$(pwd)/.opencode"
else
  OPENCODE_DIR="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"
fi

# ── Uninstall Mode ────────────────────────────────────────────────────────────
if [ "$UNINSTALL" -eq 1 ]; then
  if [ -f "$SCRIPT_DIR/uninstall.sh" ]; then
    exec bash "$SCRIPT_DIR/uninstall.sh" "$@"
  else
    error "uninstall.sh not found in $SCRIPT_DIR"
  fi
fi

# ── Config Check Mode ─────────────────────────────────────────────────────────
if [ "$CHECK_CONFIG" -eq 1 ]; then
  info "Running FlowDeck configuration verification..."
  node --input-type=module <<EOF
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const openCodeJson = "${OPENCODE_DIR}/opencode.json";
let errors = 0;

if (existsSync(openCodeJson)) {
  try {
    JSON.parse(readFileSync(openCodeJson, "utf-8"));
    console.log("[OK]   opencode.json syntax valid");
  } catch (err) {
    console.error("[ERR]  opencode.json syntax invalid: " + err.message);
    errors++;
  }
} else {
  console.log("[WARN] opencode.json not found at " + openCodeJson);
}

const flowdeckJson = join(process.cwd(), ".flowdeck.json");
if (existsSync(flowdeckJson)) {
  try {
    JSON.parse(readFileSync(flowdeckJson, "utf-8"));
    console.log("[OK]   .flowdeck.json syntax valid");
  } catch (err) {
    console.error("[ERR]  .flowdeck.json syntax invalid: " + err.message);
    errors++;
  }
}

if (errors > 0) {
  process.exit(1);
} else {
  console.log("[OK]   Configuration check complete (0 errors)");
}
EOF
  exit $?
fi

# ── Dry Run Display ───────────────────────────────────────────────────────────
if [ "$DRY_RUN" -eq 1 ]; then
  info "DRY RUN MODE — No files will be modified."
  info "Target OpenCode dir: $OPENCODE_DIR"
  info "Action: Clone/update heidi-dang/FlowDeck repo and register plugin"
  success "Dry run complete."
  exit 0
fi

# ── clone repo ───────────────────────────────────────────────────────────────

FLOWDECK_REPO_URL="https://github.com/heidi-dang/FlowDeck.git"
FLOWDECK_INSTALL_DIR="${FLOWDECK_INSTALL_DIR:-$HOME/.local/share/flowdeck}"

clone_repo() {
  if [ -d "$FLOWDECK_INSTALL_DIR/.git" ]; then
    info "FlowDeck repo already cloned at $FLOWDECK_INSTALL_DIR"
    info "Pulling latest changes..."
    git -C "$FLOWDECK_INSTALL_DIR" pull --quiet || warn "git pull failed, using existing code"
  else
    info "Cloning FlowDeck repo to $FLOWDECK_INSTALL_DIR..."
    mkdir -p "$(dirname "$FLOWDECK_INSTALL_DIR")"
    git clone --depth 1 --quiet "$FLOWDECK_REPO_URL" "$FLOWDECK_INSTALL_DIR" || {
      error "Failed to clone FlowDeck repo. Check network connection and git."
    }
  fi
}

clone_repo

# ── fdx install (optional / graceful fallback) ────────────────────────────────

install_fdx() {
  if [ -n "${FDX_SKIP:-}" ]; then
    info "fdx install skipped (FDX_SKIP is set)"
    return 0
  fi

  if command -v fdx >/dev/null 2>&1; then
    success "fdx already installed"
    return 0
  fi

  if ! command -v cargo >/dev/null 2>&1; then
    info "cargo not found — skipping native fdx compilation; native TS fallbacks active."
    return 0
  fi

  FDX_PATH="$FLOWDECK_INSTALL_DIR/crates/fdx"
  if [ ! -d "$FDX_PATH" ]; then
    warn "crates/fdx not found — skipping native fdx build"
    return 0
  fi

  info "Building fdx native binary..."
  cargo install --path "$FDX_PATH" --quiet 2>/dev/null || warn "cargo install fdx failed — native TS fallbacks will be used"
  success "fdx installed"
}

install_fdx

# ── register plugin in opencode.json ─────────────────────────────────────────

OPENCODE_JSON="$OPENCODE_DIR/opencode.json"
node --input-type=module <<EOF
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
const configFile = "${OPENCODE_JSON}";
let cfg = {};
if (existsSync(configFile)) {
  try { cfg = JSON.parse(readFileSync(configFile, "utf-8")); } catch {}
}
if (!Array.isArray(cfg.plugin)) cfg.plugin = [];
const already = cfg.plugin.some(p => p === "flowdeck" || String(p).startsWith("@dv.nghiem/flowdeck"));
if (!already) {
  cfg.plugin.push("@dv.nghiem/flowdeck");
}
if (!cfg.default_agent) {
  cfg.default_agent = "orchestrator";
}
mkdirSync("${OPENCODE_DIR}", { recursive: true });
writeFileSync(configFile, JSON.stringify(cfg, null, 2) + "\n");
console.log("[OK]   Registered @dv.nghiem/flowdeck in opencode.json");
EOF

echo ""
success "FlowDeck installed to: $OPENCODE_DIR"
info   "Source code: $FLOWDECK_INSTALL_DIR"
info   "To verify health: run Doctor or `bash install.sh --check-config`"
info   "To uninstall: bash $FLOWDECK_INSTALL_DIR/uninstall.sh"
