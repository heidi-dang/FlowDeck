#!/usr/bin/env bash
# install.sh — Atomic FlowDeck Clean Reinstall Bootstrap
# Streamed from: curl -fsSL https://raw.githubusercontent.com/heidi-dang/FlowDeck/main/install.sh | bash
# No eval used for user data. All config mutations via packaged Node.js engine.
#
# Doctor flags:
#   --doctor               Audit-only mode (no installation, exit 0 if healthy)
#   --strict               Fail on warnings in doctor checks
#   --apply-recommended    Apply safe auto-fixes (idempotent)
#   --non-interactive      Never prompt; use safe defaults
#   --profile <name>       Named profile (recommended-dev, ci)

set -euo pipefail

PACKAGE="@heidi-dang/flowdeck"
VERSION=""; SPEC=""; SCRIPT_MODE="install"
KEEP_BACKUP=false; VERBOSE=false; PROJECT_FLAG=""; LOCAL_REPO=""

# Doctor flags
DOCTOR_MODE=false; STRICT_MODE=false; APPLY_RECOMMENDED=false
NON_INTERACTIVE=false; PROFILE="recommended-dev"; DOCTOR_PROFILE=""

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
    --doctor)           DOCTOR_MODE=true; i=$((i + 1)) ;;
    --strict)           STRICT_MODE=true; i=$((i + 1)) ;;
    --apply-recommended) APPLY_RECOMMENDED=true; i=$((i + 1)) ;;
    --non-interactive)  NON_INTERACTIVE=true; i=$((i + 1)) ;;
    --yes|-y)           NON_INTERACTIVE=true; i=$((i + 1)) ;;
    --profile)
      i=$((i + 1)); [ $i -gt $# ] && { err "--profile requires a value"; exit 1; }
      PROFILE="${@:$i:1}"; i=$((i + 1)) ;;
    --version)
      i=$((i + 1)); [ $i -gt $# ] && { err "--version requires a value"; exit 1; }
      VERSION="${@:$i:1}"; i=$((i + 1)) ;;
    --local-repo)
      i=$((i + 1)); [ $i -gt $# ] && { err "--local-repo requires a path"; exit 1; }
      LOCAL_REPO="${@:$i:1}"; i=$((i + 1)) ;;
    *) i=$((i + 1)) ;;
  esac
done

# ---- Help ----
if [ "$SCRIPT_MODE" = "help" ]; then
  echo ""; echo "FlowDeck Bootstrap Installer"; echo ""
  echo "Usage:"
  echo "  curl -fsSL https://raw.githubusercontent.com/heidi-dang/FlowDeck/main/install.sh | bash"
  echo "  curl ... | bash -s -- --doctor"
  echo "  curl ... | bash -s -- --non-interactive --apply-recommended"
  echo ""; echo "Options:"
  echo "  --doctor            Audit-only mode — run doctor and exit without installing"
  echo "  --strict            Propagate doctor failures as exit code 1"
  echo "  --apply-recommended Apply safe auto-fixes idempotently"
  echo "  --non-interactive   Never prompt; use safe defaults
  --yes, -y           Accept all prompts (same as --non-interactive)"
  echo "  --profile NAME      Select profile (minimal, recommended-dev, full-dev, ci, release)"
  echo "  --dry-run           Show what would be done, make no changes"
  echo "  --verify-only       Verify current state, do not install"
  echo "  --uninstall-only    Remove FlowDeck, do not reinstall"
  echo "  --keep-backup       Keep backup files after success"
  echo "  --project, -p       Install in project .opencode/"
  echo "  --global, -g        Install globally (default)"
  echo "  --local-repo PATH   Install from local checkout"
  echo "  --verbose, -v       Verbose output"
  echo "  --version VER       Specific version to install"
  echo "  --help, -h          Show this help"
  echo ""; echo "Environment:"
  echo "  FLOWDECK_PACKAGE_SPEC   Override npm spec"
  echo "  FLOWDECK_VERSION         Specific version to install"
  echo "  FLOWDECK_PROFILE         Default doctor profile"
  echo ""; exit 0
fi

# Non-interactive guard: if --doctor without --non-interactive, ensure safe mode
if [ "$DOCTOR_MODE" = true ] && [ "$NON_INTERACTIVE" = false ]; then
  # doctor-mode without --non-interactive is fine — shows output and exits
  :
fi

# Resolve profile from env if not set via flag
if [ -z "${PROFILE:-}" ] || [ "$PROFILE" = "recommended-dev" ]; then
  PROFILE="${FLOWDECK_PROFILE:-recommended-dev}"
fi

# Preserve all existing modes
if [ "$DOCTOR_MODE" = true ] && [ "$SCRIPT_MODE" != "install" ]; then
  # --doctor with other mode flags: doctor takes precedence, no install
  SCRIPT_MODE="doctor-only"
fi

# ─── Doctor Mode (audit-only, no install) ──────────────────────────────

if [ "$DOCTOR_MODE" = true ]; then
  echo ""
  echo -e "${BLUE}┌─ FlowDeck Environment Doctor ──────────────────────────────┐${NC}"
  echo -e "${BLUE}│  Audit-only mode — no installation will be performed        │${NC}"
  echo -e "${BLUE}└─────────────────────────────────────────────────────────────┘${NC}"
  echo ""

  # Detect platform
  PLATFORM="$(uname -s)" 2>/dev/null || PLATFORM="unknown"
  echo "  Platform: $PLATFORM"
  echo "  Profile:  $PROFILE"
  echo ""

  # Locate doctor entry point
  DOCTOR_SCRIPT=""
  if [ -f "src/doctor/cli.mjs" ]; then
    DOCTOR_SCRIPT="src/doctor/cli.mjs"
  elif [ -f "../src/doctor/cli.mjs" ]; then
    DOCTOR_SCRIPT="../src/doctor/cli.mjs"
  elif command -v flowdeck &>/dev/null; then
    DOCTOR_USE_CLI=true
  else
    # Try via npm exec for the packaged version
    if [ -n "${SPEC:-}" ]; then
      DOCTOR_NPM_SPEC="$SPEC"
    else
      warn "Doctor script not found locally and flowdeck not in PATH."
      warn "Install FlowDeck first or run from the repository root."
      [ "$STRICT_MODE" = true ] && exit 1
      exit 0
    fi
  fi

  # Validate profile against supported profiles
  case "$PROFILE" in
    minimal|recommended-dev|full-dev|ci|release) ;;
    *)
      err "Invalid profile '$PROFILE'. Supported profiles: minimal, recommended-dev, full-dev, ci, release"
      exit 1
      ;;
  esac

  # Build doctor arguments as Bash array
  DOCTOR_ARGS=()
  [ "$STRICT_MODE" = true ] && DOCTOR_ARGS+=(--strict)
  [ "$VERBOSE" = true ] && DOCTOR_ARGS+=(--verbose)
  [ "$APPLY_RECOMMENDED" = true ] && DOCTOR_ARGS+=(--apply-recommended)
  [ "$NON_INTERACTIVE" = true ] && DOCTOR_ARGS+=(--non-interactive)
  DOCTOR_ARGS+=(--profile "$PROFILE")

  # Run doctor with safe array expansion. Doctor intentionally returns 1 for
  # a degraded non-strict environment; capture that result despite errexit so
  # audit-only mode can report it and retain its documented non-strict exit 0.
  set +e
  if [ -n "${DOCTOR_SCRIPT:-}" ]; then
    node "$DOCTOR_SCRIPT" "${DOCTOR_ARGS[@]}"
    DOCTOR_EXIT=$?
  elif [ "${DOCTOR_USE_CLI:-}" = true ]; then
    flowdeck doctor "${DOCTOR_ARGS[@]}"
    DOCTOR_EXIT=$?
  elif [ -n "${DOCTOR_NPM_SPEC:-}" ]; then
    npm exec --yes --package="$DOCTOR_NPM_SPEC" -- flowdeck doctor "${DOCTOR_ARGS[@]}"
    DOCTOR_EXIT=$?
  fi
  set -e

  echo ""
  if [ $DOCTOR_EXIT -eq 0 ]; then
    ok "Doctor completed — environment is healthy"
  elif [ $DOCTOR_EXIT -eq 1 ]; then
    if [ "$STRICT_MODE" = true ]; then
      err "Doctor found issues (strict mode)"
    else
      warn "Doctor found issues — review recommendations"
    fi
  else
    err "Doctor encountered an error (exit code: $DOCTOR_EXIT)"
  fi

  # Audit-only: exit without installing
  [ "$STRICT_MODE" = true ] && exit $DOCTOR_EXIT
  exit 0
fi

# ─── Pre-install Doctor ────────────────────────────────────────────────
# Run a quick pre-install check to catch blocking issues

run_preinstall_doctor() {
  if [ -f "src/doctor/cli.mjs" ]; then
    node "src/doctor/cli.mjs" --json --profile "$PROFILE" --non-interactive 2>/dev/null || true
  elif command -v flowdeck &>/dev/null; then
    flowdeck doctor --json --non-interactive 2>/dev/null || true
  fi
}

# ─── Post-install Doctor ───────────────────────────────────────────────
# Runs after installation to verify the result

run_postinstall_doctor() {
  local install_dir="$1"
  if [ -f "$install_dir/src/doctor/cli.mjs" ]; then
    node "$install_dir/src/doctor/cli.mjs" --json --profile "$PROFILE" --non-interactive 2>/dev/null || true
  elif command -v flowdeck &>/dev/null; then
    flowdeck doctor --json --non-interactive 2>/dev/null || true
  fi
}

# ─── Readiness Summary ─────────────────────────────────────────────────

print_readiness_summary() {
  local pre_report="$1"
  local post_report="$2"
  echo ""
  echo -e "${BLUE}── Readiness Summary ──${NC}"
  if [ -n "$pre_report" ]; then
    local pre_errors=$(echo "$pre_report" | grep -o '"errors":[0-9]*' | head -1 | cut -d: -f2)
    echo "  Pre-install:  errors=${pre_errors:-?}"
  fi
  if [ -n "$post_report" ]; then
    local post_errors=$(echo "$post_report" | grep -o '"errors":[0-9]*' | head -1 | cut -d: -f2)
    echo "  Post-install: errors=${post_errors:-?}"
  fi
  echo "  Profile:      $PROFILE"
  echo ""
}

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

# ---- Non-interactive profile selection ----
if [ -n "$DOCTOR_PROFILE" ] || [ "$NON_INTERACTIVE" = true ]; then
  if [ -z "$DOCTOR_PROFILE" ]; then
    DOCTOR_PROFILE="recommended-dev"
    info "Non-interactive mode: using profile 'recommended-dev'"
  fi
fi

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

# Pre-install doctor — non-blocking informational check
PRE_DOCTOR_REPORT=""
if [ "$NON_INTERACTIVE" = true ] || [ "$APPLY_RECOMMENDED" = true ]; then
  info "Running pre-install doctor..."
  # Change back to original directory for doctor
  cd - >/dev/null 2>&1 || true
  PRE_DOCTOR_REPORT="$(run_preinstall_doctor)" || true
  cd "$TMP_ROOT" >/dev/null 2>&1 || true
fi

# Build CLI args as bash array
CLI_ARGS=(--exact-version "$VERSION" --remove-legacy --verify-runtime)
[ "$SCRIPT_MODE" = "dry-run" ]       && CLI_ARGS+=(--dry-run)
[ "$SCRIPT_MODE" = "verify-only" ]   && CLI_ARGS+=(--verify-only)
[ "$SCRIPT_MODE" = "uninstall-only" ] && CLI_ARGS+=(--uninstall-only)
[ "$KEEP_BACKUP" = true ]            && CLI_ARGS+=(--keep-backup)
[ "$VERBOSE" = true -o "${DEBUG:-}" = true ] && CLI_ARGS+=(--verbose)
[ "$NON_INTERACTIVE" = true ] && CLI_ARGS+=(--yes)
[ -n "${LOCAL_REPO:-}" ]             && CLI_ARGS+=(--local-repo "$LOCAL_REPO")
[ -n "$PROJECT_FLAG" ]               && CLI_ARGS+=("$PROJECT_FLAG")

# Execute (bash array expansion, no eval)
info "Installing $SPEC..."
EXIT_CODE=0
npm exec --yes --package="$SPEC" -- flowdeck clean-install "${CLI_ARGS[@]}" || EXIT_CODE=$?

# Post-install doctor verification
POST_DOCTOR_REPORT=""
if [ $EXIT_CODE -eq 0 ]; then
  info "Running post-install doctor..."
  POST_DOCTOR_REPORT="$(run_postinstall_doctor "$(pwd)")" || true
fi

# Result
echo ""
if [ $EXIT_CODE -eq 0 ]; then
  ok "FlowDeck installation completed."
  echo "  Package: $PACKAGE  Version: $VERSION"
  print_readiness_summary "$PRE_DOCTOR_REPORT" "$POST_DOCTOR_REPORT"
else
  err "FlowDeck installation FAILED (exit code: $EXIT_CODE)"
  [ "$STRICT_MODE" = true ] && exit $EXIT_CODE
  exit $EXIT_CODE
fi
