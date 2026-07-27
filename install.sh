#!/usr/bin/env bash
# install.sh — FlowDeck Installer (Heidi fork)
# Delegates all configuration mutations to: node bin/flowdeck.js
#
# Usage:
#   bash install.sh                    Install (global)
#   bash install.sh --local-repo       Install from local checkout
#   bash install.sh --check-config     Verify configuration
#   bash install.sh --dry-run          Show what would be done
#   bash install.sh --uninstall        Remove FlowDeck

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Quick pre-checks
if [ ! -f "$SCRIPT_DIR/package.json" ]; then
  echo "[ERR]  package.json not found in $SCRIPT_DIR" >&2
  exit 1
fi

# Parse and dispatch known flags
for arg in "$@"; do
  case "$arg" in
    --check-config)
      exec node "$SCRIPT_DIR/bin/flowdeck.js" verify
      ;;
    --dry-run)
      exec node "$SCRIPT_DIR/bin/flowdeck.js" dry-run
      ;;
    --uninstall)
      exec node "$SCRIPT_DIR/bin/flowdeck.js" uninstall
      ;;
  esac
done

# Determine install mode
if [ "$#" -eq 0 ]; then
  exec node "$SCRIPT_DIR/bin/flowdeck.js" install
elif [ "$1" = "--local-repo" ] || [ "$1" = "--local" ] || [ "$1" = "--dev-env" ]; then
  exec node "$SCRIPT_DIR/bin/flowdeck.js" install --local-repo
else
  # Pass any other args through
  exec node "$SCRIPT_DIR/bin/flowdeck.js" install "$@"
fi
