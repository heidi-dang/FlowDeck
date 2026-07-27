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
DOCTOR_MODE=false; DOCTOR_STRICT=false; DOCTOR_APPLY=false
NON_INTERACTIVE=false; DOCTOR_PROFILE=""

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
    --doctor)           DOCTOR_MODE=true; SCRIPT_MODE="doctor"; i=$((i + 1)) ;;
    --strict)           DOCTOR_STRICT=true; i=$((i + 1)) ;;
    --apply-recommended) DOCTOR_APPLY=true; i=$((i + 1)) ;;
    --non-interactive)  NON_INTERACTIVE=true; i=$((i + 1)) ;;
    --profile)
      i=$((i + 1)); [ $i -ge $# ] && { err "--profile requires a value"; exit 1; }
      DOCTOR_PROFILE="${@:$i:1}"; i=$((i + 1)) ;;
    --version)
      i=$((i + 1)); [ $i -ge $# ] && { err "--version requires a value"; exit 1; }
      VERSION="${@:$i:1}"; i=$((i + 1)) ;;
    --local-repo)
      i=$((i + 1)); [ $i -ge $# ] && { err "--local-repo requires a path"; exit 1; }
      LOCAL_REPO="${@:$i:1}"; i=$((i + 1)) ;;
    *) i=$((i + 1)) ;;
  esac
done

# ---- Help ----
if [ "$SCRIPT_MODE" = "help" ]; then
  echo ""; echo "FlowDeck Clean Reinstall Bootstrap"; echo ""
  echo "Usage:"
  echo "  curl -fsSL https://raw.githubusercontent.com/heidi-dang/FlowDeck/main/install.sh | bash"
  echo "  curl ... | bash -s -- --dry-run | --verify-only | --help"
  echo ""; echo "Install Options:"
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
  echo ""; echo "Doctor Options:"
  echo "  --doctor           Audit-only diagnostics (no installation)"
  echo "  --strict           Fail on warnings in doctor checks"
  echo "  --apply-recommended Apply safe auto-fixes (idempotent)"
  echo "  --non-interactive  Never prompt; use safe defaults"
  echo "  --profile NAME     Named profile (recommended-dev, ci)"
  echo ""; echo "Environment:"; echo "  FLOWDECK_PACKAGE_SPEC   Override npm spec"
  echo "  FLOWDECK_VERSION         Specific version to install"
  echo ""; exit 0
fi

# ---- Helper: locate the FlowDeck package ----
locate_flowdeck() {
  # Try npm root global first, then local node_modules
  local global_root
  global_root=$(npm root -g 2>/dev/null || echo "")
  if [ -n "$global_root" ] && [ -f "$global_root/$PACKAGE/package.json" ]; then
    echo "$global_root/$PACKAGE"
    return 0
  fi
  # Check if we're in the repo
  if [ -f "package.json" ] && grep -q '"@heidi-dang/flowdeck"' package.json 2>/dev/null; then
    echo "$(pwd)"
    return 0
  fi
  return 1
}

# ---- Helper: run doctor ----
run_doctor_check() {
  local pkg_dir="$1"
  local mode="$2"  # "pre-install" or "post-install"
  local doctor_args=""

  if [ "$DOCTOR_STRICT" = true ]; then
    doctor_args="$doctor_args --strict"
  fi
  if [ "$DOCTOR_APPLY" = true ]; then
    doctor_args="$doctor_args --apply-recommended"
  fi
  if [ -n "$DOCTOR_PROFILE" ]; then
    doctor_args="$doctor_args --profile $DOCTOR_PROFILE"
  fi
  if [ "$VERBOSE" = true ]; then
    doctor_args="$doctor_args --verbose"
  fi

  if [ "$mode" = "pre-install" ]; then
    info "Running pre-install doctor checks..."
  else
    info "Running post-install doctor checks..."
  fi

  # Run doctor via node directly against the service CLI
  local exit_code=0
  if [ -f "$pkg_dir/src/doctor/cli.mjs" ]; then
    node "$pkg_dir/src/doctor/cli.mjs" doctor $doctor_args 2>/dev/null || exit_code=$?
  elif [ -f "$pkg_dir/bin/flowdeck.js" ]; then
    node "$pkg_dir/bin/flowdeck.js" doctor $doctor_args 2>/dev/null || exit_code=$?
  else
    # Fall back to npm exec
    npm exec --package="$PACKAGE" -- flowdeck doctor $doctor_args 2>/dev/null || exit_code=$?
  fi

  return $exit_code
}

# ---- Doctor-only mode (audit, no install) ----
if [ "$SCRIPT_MODE" = "doctor" ]; then
  info "FlowDeck Doctor — Audit Mode"
  info "Running diagnostics without installation..."

  PKG_DIR=$(locate_flowdeck) || true

  if [ -n "$PKG_DIR" ]; then
    run_doctor_check "$PKG_DIR" "pre-install"
    DOCTOR_EXIT=$?
    if [ $DOCTOR_EXIT -ne 0 ]; then
      err "Doctor checks failed (exit code: $DOCTOR_EXIT)"
      exit $DOCTOR_EXIT
    fi
    ok "All doctor checks passed."
  else
    warn "FlowDeck package not found locally."
    warn "Running doctor via npm registry..."
    doctor_args=""
    [ "$DOCTOR_STRICT" = true ] && doctor_args="$doctor_args --strict"
    [ "$DOCTOR_APPLY" = true ] && doctor_args="$doctor_args --apply-recommended"
    [ -n "$DOCTOR_PROFILE" ] && doctor_args="$doctor_args --profile $DOCTOR_PROFILE"

    DOCTOR_EXIT=0
    npm exec --yes --package="$PACKAGE" -- flowdeck doctor $doctor_args || DOCTOR_EXIT=$?
    if [ $DOCTOR_EXIT -ne 0 ]; then
      err "Doctor checks failed (exit code: $DOCTOR_EXIT)"
      exit $DOCTOR_EXIT
    fi
    ok "All doctor checks passed."
  fi
  exit 0
fi

# ======== Normal installation flow ========

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

# ---- Pre-install doctor ----
if [ "$DOCTOR_MODE" = true ] || [ -n "$DOCTOR_PROFILE" ]; then
  echo -e "\n${BLUE}[Pre-flight]${NC} Doctor checks"
  pkg_dir=$(locate_flowdeck) || true
  if [ -n "$pkg_dir" ]; then
    if ! run_doctor_check "$pkg_dir" "pre-install"; then
      err "Pre-install doctor checks failed. Fix issues before installing."
      err "Run './install --doctor' for details."
      exit 1
    fi
    ok "Pre-install doctor checks passed."
  else
    warn "Cannot run pre-install doctor (package not found). Skipping."
  fi
fi

# ---- Non-interactive profile selection ----
if [ -z "$DOCTOR_PROFILE" ] && [ "$NON_INTERACTIVE" = true ]; then
  # Default to recommended-dev when non-interactive
  DOCTOR_PROFILE="recommended-dev"
  info "Non-interactive mode: using profile 'recommended-dev'"
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

# ---- Preview safe changes (non-interactive applies, interactive can be previewed) ----
if [ "$DOCTOR_APPLY" = true ]; then
  echo -e "\n${BLUE}[Pre-flight]${NC} Applying safe recommendations..."
  pkg_dir=$(locate_flowdeck) || true
  if [ -n "$pkg_dir" ]; then
    if run_doctor_check "$pkg_dir" "pre-install"; then
      ok "Safe recommendations applied."
    else
      warn "Some recommendations could not be applied automatically."
    fi
  fi
fi

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

  # ---- Post-install doctor ----
  if [ "$DOCTOR_MODE" = true ] || [ -n "$DOCTOR_PROFILE" ] || [ "$DOCTOR_STRICT" = true ] || [ "$DOCTOR_APPLY" = true ]; then
    echo ""
    pkg_dir=$(locate_flowdeck) || true
    if [ -n "$pkg_dir" ]; then
      info "Running post-install verification..."
      if run_doctor_check "$pkg_dir" "post-install"; then
        ok "Post-install verification passed."
      else
        warn "Post-install doctor found issues."
        info "Run './install --doctor' for detailed diagnostics."
      fi
    fi
  fi

  # Readiness summary
  echo ""
  echo -e "${GREEN}── Readiness Summary ──${NC}"
  echo "  Package: $PACKAGE"
  echo "  Version: $VERSION"
  echo "  Status:  INSTALLED"
  if [ -n "$DOCTOR_PROFILE" ]; then
    echo "  Profile: $DOCTOR_PROFILE"
  fi
  echo ""
  echo "  A fresh OpenCode session is required to activate."
else
  err "FlowDeck installation FAILED (exit code: $EXIT_CODE)"
  exit $EXIT_CODE
fi
