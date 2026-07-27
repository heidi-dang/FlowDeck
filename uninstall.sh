#!/usr/bin/env bash
# uninstall.sh — Remove FlowDeck (Heidi fork) from OpenCode
# Delegates all configuration mutations to: node bin/flowdeck.js uninstall
# Usage: bash uninstall.sh [--dry-run] [--yes|-y] [--clean]
#   --clean: also remove backup files and plugin cache

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

OPENCODE_DIR="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"

# Pre-check
if [ ! -d "$OPENCODE_DIR" ]; then
  echo "[WARN] OpenCode config directory not found at $OPENCODE_DIR"
  echo "[INFO] Nothing to uninstall."
  exit 0
fi

CLEAN_BACKUPS=0

for arg in "$@"; do
  case "$arg" in
    --dry-run)
      echo "[INFO] DRY RUN — No files modified."
      echo "[INFO] Would uninstall @heidi-dang/flowdeck from $OPENCODE_DIR"
      exit 0
      ;;
    --clean) CLEAN_BACKUPS=1 ;;
  esac
done

# Delegate all config mutations to CLI
node "$SCRIPT_DIR/bin/flowdeck.js" uninstall

# Post-cleanup: backup files (config mutation was handled by CLI)
if [ "$CLEAN_BACKUPS" -eq 1 ]; then
  backup_count=0
  for bk in "$OPENCODE_DIR/"*.bak*; do
    [ -f "$bk" ] && rm -f "$bk" && backup_count=$((backup_count + 1))
  done 2>/dev/null || true
  if [ $backup_count -gt 0 ]; then
    echo "[OK]   Removed $backup_count backup files"
  fi
fi

# Clean up plugin cache directories (global mode only)
for cache_dir in "$HOME/.cache/opencode/packages/@heidi-dang/flowdeck@"*; do
  [ -d "$cache_dir" ] && rm -rf "$cache_dir" 2>/dev/null || true
done

echo ""
echo "[OK]   FlowDeck uninstalled from: $OPENCODE_DIR"
echo "[INFO] To reinstall: bash install.sh"
