#!/usr/bin/env bash
# install.sh — Atomic FlowDeck Clean Reinstall Bootstrap
# Streamed from: curl -fsSL https://raw.githubusercontent.com/heidi-dang/FlowDeck/main/install.sh | bash
# No eval used for user data. All config mutations via packaged Node.js engine.

set -euo pipefail

PACKAGE="@heidi-dang/flowdeck"
VERSION=""; SPEC=""; SCRIPT_MODE="install"
KEEP_BACKUP=false; VERBOSE=false; PROJECT_FLAG=""; LOCAL_REPO=""

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*" >&2; }
err()   { echo -e "${RED}[ERR]${NC}   $*" >&2; }

# Indexed while-loop parser (no eval for user data in main flow)
i=1
while [ $i -le $# ]; do
  arg="${@:$i:1}"
  case "$arg" in
    --dry-run)          SCRIPT_MODE="dry-run"; i=$((i + 1)) ;;
    --verify-only|--verify) SCRIPT_MODE="verify-only"; i=$((i + 1)) ;;
    --uninstall-only|--uninstall) SCRIPT_MODE="uninstall-only"; i=$((i + 1)) ;;
    --keep-backup)      KEEP_BACKUP=true; i=$((i + 1)) ;;
    --verbose|-v)       VERBOSE=true; i=$((i + 1)) ;;
    --help|-h)          SCRIPT_MODE="help"; i=$((i + 1)) ;;
    --project|-p)       PROJECT_FLAG="--project"; i=$((i + 1)) ;;
    --global|-g)        PROJECT_FLAG=""; i=$((i + 1)) ;;
    --version)
      i=$((i + 1)); [ $i -ge $# ] && { err "--version requires a value"; exit 1; }
      VERSION="${@:$i:1}"; i=$((i + 1)) ;;
    --local-repo)
      i=$((i + 1)); [ $i -ge $# ] && { err "--local-repo requires a path"; exit 1; }
      LOCAL_REPO="${@:$i:1}"; i=$((i + 1)) ;;
    *) i=$((i + 1)) ;;
  esac
done

if [ "$SCRIPT_MODE" = "help" ]; then
  echo ""; echo "FlowDeck Clean Reinstall Bootstrap"; echo ""
  echo "Usage:"
  echo "  curl -fsSL https://raw.githubusercontent.com/heidi-dang/FlowDeck/main/install.sh | bash"
  echo "  curl ... | bash -s -- --dry-run | --verify-only | --help"
  echo ""; echo "Options:"
  echo "  --dry-run         Show what would be done, make no changes"
  echo "  --verify-only     Verify current state, do not install"
  echo "  --uninstall-only  Remove FlowDeck, do not reinstall"
  echo "  --keep-backup     Keep backup files after success"
  echo "  --project, -p     Install in project .opencode/"
  echo "  --global, -g      Install globally (default)"
  echo "  --local-repo PATH Install from local checkout"
  echo "  --verbose, -v     Verbose output"
  echo "  --version VER     Specific version to install"
  echo "  --help, -h        Show this help"
  echo ""; echo "Environment:"; echo "  FLOWDECK_PACKAGE_SPEC   Override npm spec"
  echo "  FLOWDECK_VERSION         Specific version to install"
  echo ""; exit 0
fi

# Prerequisites
echo -e "\n${BLUE}[1/9]${NC} Prerequisites"
[ -z "${BASH_VERSION:-}" ] && { err "Bash required"; exit 1; }
MISSING=""
for cmd in node npm; do
  command -v "$cmd" &>/dev/null || MISSING="$MISSING $cmd"
done
[ -n "$MISSING" ] && { err "Missing: $MISSING"; exit 1; }
NODE_VERSION=$(node -e "console.log(process.version.slice(1))" 2>/dev/null || echo "0")
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 18 ]; then err "Node.js >= 18 required (found v$NODE_VERSION)"; exit 1; fi
info "Node.js: v$NODE_VERSION, npm: v$(npm --version 2>/dev/null || echo '?')"
command -v opencode &>/dev/null && info "OpenCode: $(command -v opencode)" || warn "OpenCode not in PATH"

# Isolated temp directory
TMP_ROOT=$(mktemp -d)
# cleanup will happen via EXIT trap
trap 'rm -f "$TMP_ROOT"/*.tmp 2>/dev/null; rmdir "$TMP_ROOT" 2>/dev/null; true' EXIT INT TERM
info "Working directory: $TMP_ROOT"
cd "$TMP_ROOT"

# Resolve package version
if [ -n "${FLOWDECK_PACKAGE_SPEC:-}" ]; then
  SPEC="$FLOWDECK_PACKAGE_SPEC"
elif [ -n "${FLOWDECK_VERSION:-}" ]; then
  SPEC="${PACKAGE}@${FLOWDECK_VERSION}"; VERSION="$FLOWDECK_VERSION"
else
  VERSION=$(npm view "$PACKAGE" version 2>/dev/null || echo "")
  [ -z "$VERSION" ] && { err "Cannot determine latest version"; exit 1; }
  SPEC="${PACKAGE}@${VERSION}"
fi
info "Version: $VERSION"

# Build CLI args as bash array
CLI_ARGS=(--exact-version "$VERSION" --remove-legacy --verify-runtime)
[ "$SCRIPT_MODE" = "dry-run" ]       && CLI_ARGS+=(--dry-run)
[ "$SCRIPT_MODE" = "verify-only" ]   && CLI_ARGS+=(--verify-only)
[ "$SCRIPT_MODE" = "uninstall-only" ] && CLI_ARGS+=(--uninstall-only)
[ "$KEEP_BACKUP" = true ]            && CLI_ARGS+=(--keep-backup)
[ "$VERBOSE" = true -o "${DEBUG:-}" = true ] && CLI_ARGS+=(--verbose)
[ -n "${LOCAL_REPO:-}" ]             && CLI_ARGS+=(--local-repo "$LOCAL_REPO")
[ -n "$PROJECT_FLAG" ]               && CLI_ARGS+=("$PROJECT_FLAG")

# Execute (bash array expansion, no eval)
info "Installing $SPEC..."
EXIT_CODE=0
npm exec --yes --package="$SPEC" -- flowdeck clean-install "${CLI_ARGS[@]}" || EXIT_CODE=$?

# Result
echo ""
if [ $EXIT_CODE -eq 0 ]; then
  ok "FlowDeck installation completed."
  echo "  Package: $PACKAGE  Version: $VERSION"
else
  err "FlowDeck installation FAILED (exit code: $EXIT_CODE)"
  exit $EXIT_CODE
fi
