#!/usr/bin/env bash
# uninstall.sh — Remove FlowDeck (Heidi fork) from OpenCode
# Usage: bash uninstall.sh [--local] [--yes|-y] [--dry-run] [--clean]
set -euo pipefail

IS_LOCAL=0
NON_INTERACTIVE=0
DRY_RUN=0
CLEAN_BACKUPS=0

for arg in "$@"; do
  case "$arg" in
    --local|--local-repo) IS_LOCAL=1 ;;
    --yes|-y) NON_INTERACTIVE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --clean) CLEAN_BACKUPS=1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$IS_LOCAL" -eq 1 ]; then
  OPENCODE_DIR="$PWD/.opencode"
  CACHE_GLOB=""
else
  OPENCODE_DIR="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"
  CACHE_GLOB="$HOME/.cache/opencode/packages/@heidi-dang/flowdeck@*"
fi

info()    { echo "[INFO] $*"; }
success() { echo "[OK]   $*"; }
warn()    { echo "[WARN] $*"; }
error()   { echo "[ERR]  $*" >&2; exit 1; }

if [ "$DRY_RUN" -eq 1 ]; then
  info "DRY RUN — No files deleted."
  info "Target: $OPENCODE_DIR"
  info "Action: Remove @heidi-dang/flowdeck plugin from opencode.json"
  success "Dry run complete."
  exit 0
fi

if [ ! -d "$OPENCODE_DIR" ]; then
  warn "OpenCode directory not found at $OPENCODE_DIR"
  exit 0
fi

info "Uninstalling FlowDeck from: $OPENCODE_DIR"

# Remove plugin from opencode.json
OPENCODE_JSON="$OPENCODE_DIR/opencode.json"
if [ -f "$OPENCODE_JSON" ]; then
  node --input-type=module <<EOF
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const configFile = "${OPENCODE_JSON}";

if (!existsSync(configFile)) {
  console.log("[INFO] opencode.json not found — nothing to uninstall");
  process.exit(0);
}

try {
  const raw = readFileSync(configFile, "utf-8");
  const cfg = JSON.parse(raw);
  let changed = false;

  // Remove @heidi-dang/flowdeck from plugin list
  if (Array.isArray(cfg.plugin)) {
    const before = cfg.plugin.length;
    cfg.plugin = cfg.plugin.filter(
      p => p !== "@heidi-dang/flowdeck" && !String(p).startsWith("@heidi-dang/flowdeck@")
    );
    // Also remove any legacy @dv.nghiem/flowdeck references
    cfg.plugin = cfg.plugin.filter(
      p => p !== "@dv.nghiem/flowdeck" && !String(p).startsWith("@dv.nghiem/flowdeck@")
    );
    if (cfg.plugin.length < before) changed = true;
  }

  // Remove default_agent only if it points to heidi or orchestrator
  if (cfg.default_agent === "heidi" || cfg.default_agent === "orchestrator") {
    delete cfg.default_agent;
    changed = true;
  }

  if (changed) {
    writeFileSync(configFile, JSON.stringify(cfg, null, 2) + "\n");
    console.log("[OK]   Updated opencode.json");
  } else {
    console.log("[INFO] opencode.json unchanged");
  }
} catch (err) {
  console.error("[ERR]  Failed to parse opencode.json:", err.message);
  console.error("       Preserving configuration — manual cleanup required.");
}
EOF
fi

# Remove plugin cache directories (global mode only)
if [ -n "$CACHE_GLOB" ]; then
  for cache_dir in $CACHE_GLOB; do
    if [ -d "$cache_dir" ]; then
      rm -rf "$cache_dir" 2>/dev/null || true
      info "Removed cache: $(basename "$cache_dir")"
    fi
  done
fi

# Clean up backup files if explicit --clean flag
if [ "$CLEAN_BACKUPS" -eq 1 ]; then
  backup_count=0
  for bk in "$OPENCODE_DIR/"*.bak; do
    [ -f "$bk" ] && rm -f "$bk" && backup_count=$((backup_count + 1))
  done 2>/dev/null || true
  if [ $backup_count -gt 0 ]; then
    success "Removed $backup_count backup files"
  fi
else
  info "Preserving configuration backups (.bak files). Use --clean to remove."
fi

echo ""
success "FlowDeck uninstalled from: $OPENCODE_DIR"
info "To reinstall: bash install.sh"
info "Or: npx @heidi-dang/flowdeck install"
