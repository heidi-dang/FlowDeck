#!/usr/bin/env bash
# install.sh — Atomic FlowDeck Clean Reinstall Bootstrap
#
# Streamed from:
#   curl -fsSL https://raw.githubusercontent.com/heidi-dang/FlowDeck/main/install.sh | bash
#
# This script is a standalone bootstrap. It does NOT require:
#   - A local repository checkout
#   - package.json beside this script
#   - bin/flowdeck.js beside this script
#   - A specific current working directory
#   - A hardcoded home directory or OpenCode path
#
# It validates prerequisites, creates an isolated temp directory,
# resolves the exact FlowDeck npm release, and delegates all config
# mutations to the packaged FlowDeck CLI.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/heidi-dang/FlowDeck/main/install.sh | bash
#   curl ... | bash -s -- --dry-run
#   curl ... | bash -s -- --verify-only
#   curl ... | bash -s -- --uninstall-only
#   curl ... | bash -s -- --help
#
# Environment variables:
#   FLOWDECK_PACKAGE_SPEC   Override the npm package spec (for testing with local tarballs)
#   FLOWDECK_VERSION         Specific version to install (default: detected from package)
#   DEBUG                    Set to "true" for verbose output

set -euo pipefail

# ─── Constants ─────────────────────────────────────────────────────────────

PACKAGE="@heidi-dang/flowdeck"
VERSION=""
SPEC=""
SCRIPT_MODE="install"
KEEP_BACKUP=false
VERBOSE=false

# ─── Color helpers ─────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*" >&2; }
err()   { echo -e "${RED}[ERR]${NC}   $*" >&2; }
stage() { echo -e "\n${BLUE}[${1}/${2}]${NC} ${3}"; }

# ─── Parse arguments ───────────────────────────────────────────────────────

for arg in "$@"; do
  case "$arg" in
    --dry-run)          SCRIPT_MODE="dry-run" ;;
    --verify-only)      SCRIPT_MODE="verify-only" ;;
    --verify)           SCRIPT_MODE="verify-only" ;;
    --uninstall-only)   SCRIPT_MODE="uninstall-only" ;;
    --uninstall)        SCRIPT_MODE="uninstall-only" ;;
    --keep-backup)      KEEP_BACKUP=true ;;
    --verbose|-v)       VERBOSE=true ;;
    --help|-h)          SCRIPT_MODE="help" ;;
    --project|-p)       PROJECT_FLAG="--project" ;;
    --global|-g)        PROJECT_FLAG="" ;;
    --version)          VERSION="${2:-}"; shift ;;
    --local-repo)       LOCAL_REPO="${2:-}"; shift ;;
  esac
done

# ─── Help ─────────────────────────────────────────────────────────────────

if [ "$SCRIPT_MODE" = "help" ]; then
  echo ""
  echo "FlowDeck Clean Reinstall Bootstrap"
  echo ""
  echo "Usage:"
  echo "  curl -fsSL https://raw.githubusercontent.com/heidi-dang/FlowDeck/main/install.sh | bash"
  echo "  curl ... | bash -s -- --dry-run"
  echo "  curl ... | bash -s -- --verify-only"
  echo "  curl ... | bash -s -- --uninstall-only"
  echo "  curl ... | bash -s -- --help"
  echo ""
  echo "Options:"
  echo "  --dry-run               Show what would be done, make no changes"
  echo "  --verify-only           Verify current state, do not install"
  echo "  --uninstall-only        Remove FlowDeck, do not reinstall"
  echo "  --keep-backup           Keep backup files after success"
  echo "  --project, -p           Install in project .opencode/"
  echo "  --global, -g            Install globally (default)"
  echo "  --local-repo <path>     Install from local checkout"
  echo "  --verbose, -v           Verbose output"
  echo "  --help, -h              Show this help"
  echo ""
  echo "Environment:"
  echo "  FLOWDECK_PACKAGE_SPEC   Override npm spec (for testing)"
  echo "  FLOWDECK_VERSION         Specific version to install"
  echo ""
  exit 0
fi

# ─── Stage 1: Prerequisites ───────────────────────────────────────────────

TOTAL_STAGES=9
stage 1 $TOTAL_STAGES "Prerequisites"

# Check bash version
if [ -z "${BASH_VERSION:-}" ]; then
  err "This installer requires Bash"
  exit 1
fi

# Check for required commands
MISSING=""
for cmd in node npm; do
  if ! command -v "$cmd" &>/dev/null; then
    MISSING="$MISSING $cmd"
  fi
done

if [ -n "$MISSING" ]; then
  err "Missing required commands:$MISSING"
  err "Please install Node.js (>= 18) and npm first."
  exit 1
fi

NODE_VERSION=$(node -e "console.log(process.version.slice(1))" 2>/dev/null || echo "0")
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 18 ]; then
  err "Node.js >= 18 required (found v$NODE_VERSION)"
  exit 1
fi

NPM_VERSION=$(npm --version 2>/dev/null || echo "unknown")
info "Node.js: v$NODE_VERSION"
info "npm: v$NPM_VERSION"

# Check opencode availability (informational only)
if command -v opencode &>/dev/null; then
  OPENCODE_PATH=$(command -v opencode)
  info "OpenCode: $OPENCODE_PATH"
else
  warn "OpenCode not found in PATH — runtime verification will be limited"
fi

# ─── Create isolated temp directory ───────────────────────────────────────

TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT INT TERM

info "Working directory: $TMP_ROOT"
cd "$TMP_ROOT"

# ─── Resolve package version ──────────────────────────────────────────────

# Priority: 1. FLOWDECK_PACKAGE_SPEC env (for testing)  2. FLOWDECK_VERSION env  3. npm registry latest
if [ -n "${FLOWDECK_PACKAGE_SPEC:-}" ]; then
  SPEC="$FLOWDECK_PACKAGE_SPEC"
  info "Using package spec from FLOWDECK_PACKAGE_SPEC: $SPEC"
elif [ -n "${FLOWDECK_VERSION:-}" ]; then
  SPEC="${PACKAGE}@${FLOWDECK_VERSION}"
  VERSION="$FLOWDECK_VERSION"
  info "Using specified version: $SPEC"
else
  # Query npm for the latest version
  info "Querying npm for latest $PACKAGE version..."
  VERSION=$(npm view "$PACKAGE" version 2>/dev/null || echo "")
  if [ -z "$VERSION" ]; then
    err "Could not determine latest version from npm"
    err "Try setting FLOWDECK_VERSION to a specific version"
    exit 1
  fi
  SPEC="${PACKAGE}@${VERSION}"
  info "Latest version: $VERSION"
fi

# ─── Build CLI arguments ──────────────────────────────────────────────────

CLI_ARGS="--exact-version \"$VERSION\" --remove-legacy --verify-runtime"

if [ "$SCRIPT_MODE" = "dry-run" ]; then
  CLI_ARGS="$CLI_ARGS --dry-run"
elif [ "$SCRIPT_MODE" = "verify-only" ]; then
  CLI_ARGS="$CLI_ARGS --verify-only"
elif [ "$SCRIPT_MODE" = "uninstall-only" ]; then
  CLI_ARGS="$CLI_ARGS --uninstall-only"
fi

if [ "$KEEP_BACKUP" = true ]; then
  CLI_ARGS="$CLI_ARGS --keep-backup"
fi

if [ "${VERBOSE}" = true ] || [ "${DEBUG:-}" = "true" ]; then
  CLI_ARGS="$CLI_ARGS --verbose"
fi

if [ -n "${LOCAL_REPO:-}" ]; then
  CLI_ARGS="$CLI_ARGS --local-repo \"$LOCAL_REPO\""
fi

if [ -n "${PROJECT_FLAG:-}" ]; then
  CLI_ARGS="$CLI_ARGS $PROJECT_FLAG"
fi

# ─── Execute FlowDeck CLI ────────────────────────────────────────────────

# Run from the temp directory so no local checkout can self-resolve
cd "$TMP_ROOT"

info "Installing $SPEC..."
info ""

# Use npm exec to download and run the exact package version
# This avoids any dependency on a local checkout
CMD="npm exec --yes --package=\"$SPEC\" -- flowdeck clean-install $CLI_ARGS"

if [ "$VERBOSE" = true ] || [ "${DEBUG:-}" = "true" ]; then
  info "Running: $CMD"
fi

# Execute and capture exit code
if [ "$SCRIPT_MODE" = "dry-run" ] || [ "$SCRIPT_MODE" = "verify-only" ]; then
  # For non-mutating modes, run directly
  eval "$CMD"
  EXIT_CODE=$?
else
  # For install/uninstall, run and capture exit code
  eval "$CMD" || EXIT_CODE=$?
  EXIT_CODE=${EXIT_CODE:-0}
fi

# ─── Result ───────────────────────────────────────────────────────────────

echo ""
if [ $EXIT_CODE -eq 0 ]; then
  ok "FlowDeck installation process completed."
  echo ""
  echo "  Package: $PACKAGE"
  echo "  Version: $VERSION"
  echo ""
  echo "  Next steps:"
  echo "    - If this is a fresh install, start a new OpenCode session."
  echo "    - Run 'opencode agent list' to verify Heidi is available."
  echo "    - Run 'flowdeck doctor' for detailed diagnostics."
else
  err "FlowDeck installation process FAILED (exit code: $EXIT_CODE)"
  err "Check the output above for details."
  exit $EXIT_CODE
fi
