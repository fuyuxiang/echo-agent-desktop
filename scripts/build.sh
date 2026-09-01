#!/usr/bin/env bash
# ===========================================================================
#  EchoAgent macOS packaging script (bash)
#
#  Produces a distributable .dmg via `pnpm tauri build --bundles dmg`.
#  Builds for the host architecture (Apple Silicon or Intel); Tauri picks
#  the right target automatically.
#
#  Usage:
#    bash scripts/build.sh
#    bash scripts/build.sh --version 0.2.0
#
#  Prerequisites:
#    The complete vendored Runtime source is included in the repository.
#    `scripts/setup.sh` can be used to verify checkout integrity.
#
#  NOTE on code signing / notarization:
#    This script intentionally does NOT sign or notarize the bundle.
#    Unsigned .dmg/.app will run on the build machine but will prompt
#    "unidentified developer" elsewhere (right-click > Open to bypass).
#    Setting up signing is a separate task requiring an Apple Developer ID.
# ===========================================================================

set -euo pipefail

# ---- helpers --------------------------------------------------------------
log_step() { printf '\n\033[36m===> %s\033[0m\n' "$1"; }
log_ok()   { printf '  \033[32m[OK]\033[0m   %s\n' "$1"; }
log_warn() { printf '  \033[33m[WARN]\033[0m %s\n' "$1"; }
log_err()  { printf '  \033[31m[ERR]\033[0m  %s\n' "$1"; }
log_info() { printf '         %s\n' "$1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# Cargo.toml may be updated when --version is supplied.
CARGO_TOML="$PROJECT_ROOT/src-tauri/Cargo.toml"

# ---------------------------------------------------------------------------
# 1. Parse args
# ---------------------------------------------------------------------------
NEW_VERSION=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --version)
            NEW_VERSION="${2:-}"
            if [[ -z "$NEW_VERSION" ]]; then
                log_err "--version requires a value"
                exit 1
            fi
            shift 2
            ;;
        -h|--help)
            sed -n '2,28p' "$0"
            exit 0
            ;;
        *)
            log_err "Unknown argument: $1"
            exit 1
            ;;
    esac
done

# ---------------------------------------------------------------------------
# 2. Platform + toolchain checks
# ---------------------------------------------------------------------------
log_step "Checking platform"
if [[ "$(uname -s)" != "Darwin" ]]; then
    log_err "This script targets macOS. On Windows use scripts/build.ps1 instead."
    exit 1
fi
ARCH="$(uname -m)"
log_ok "macOS detected ($ARCH)"

log_step "Checking toolchain"
for cmd in pnpm cargo rustc; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        log_err "$cmd not found on PATH."
        exit 1
    fi
    log_info "$(printf '%-7s %s' "$cmd" "$("$cmd" --version 2>/dev/null | head -1)")"
done

# grok's build.rs invokes protoc; honor $PROTOC or a protoc on PATH.
if [[ -z "${PROTOC:-}" ]] && ! command -v protoc >/dev/null 2>&1; then
    log_err "protoc not found. Install protobuf (brew install protobuf) or set PROTOC=/path/to/protoc."
    exit 1
fi
log_ok "protoc available via ${PROTOC:-PATH}"
log_ok "Core tools present"

# ---------------------------------------------------------------------------
# 3. Version sync (optional)
# ---------------------------------------------------------------------------
if [[ -n "$NEW_VERSION" ]]; then
    log_step "Syncing version -> $NEW_VERSION"
    PKG_JSON="$PROJECT_ROOT/package.json"
    Tauri_CONF="$PROJECT_ROOT/src-tauri/tauri.conf.json"
    # sed -i behaves differently on GNU vs BSD; use a temp file for portability.
    sed -E "s/\"version\"[[:space:]]*:[[:space:]]*\"[^\"]*\"/\"version\": \"$NEW_VERSION\"/" "$PKG_JSON" > "$PKG_JSON.tmp" && mv "$PKG_JSON.tmp" "$PKG_JSON"
    sed -E "s/\"version\"[[:space:]]*:[[:space:]]*\"[^\"]*\"/\"version\": \"$NEW_VERSION\"/" "$Tauri_CONF" > "$Tauri_CONF.tmp" && mv "$Tauri_CONF.tmp" "$Tauri_CONF"
    # Cargo.toml: only replace the first `version = "..."` (under [package]).
    awk -v v="$NEW_VERSION" '
        !done && /^[[:space:]]*version[[:space:]]*=/ { sub(/"[^"]*"/, "\"" v "\""); done=1 }
        { print }
    ' "$CARGO_TOML" > "$CARGO_TOML.tmp" && mv "$CARGO_TOML.tmp" "$CARGO_TOML"
    log_ok "Bumped version in package.json, tauri.conf.json, Cargo.toml"
fi

# ---------------------------------------------------------------------------
# 4. Vendored Runtime sanity check. Path dependencies in Cargo.toml resolve
#    directly into vendor/grok-build, which is tracked by this repository.
# ---------------------------------------------------------------------------
log_step "Checking vendored Runtime source"
node "$PROJECT_ROOT/scripts/verify-vendored-runtime.mjs"
log_ok "Vendored Runtime source is complete"

# ---------------------------------------------------------------------------
# 5. Build (frontend build runs automatically via beforeBuildCommand).
# ---------------------------------------------------------------------------
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" && -z "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]]; then
    log_err "Updater signing key is required for release builds."
    log_err "Set TAURI_SIGNING_PRIVATE_KEY_PATH (recommended) or TAURI_SIGNING_PRIVATE_KEY."
    log_err "See docs/desktop-updates.md."
    exit 1
fi

log_step "Building .dmg (pnpm tauri build --bundles dmg)"
BUILD_RC=0
pnpm tauri build --bundles dmg || BUILD_RC=$?

# ---------------------------------------------------------------------------
# 6. Report artifacts.
# ---------------------------------------------------------------------------
BUNDLE_DIR="$PROJECT_ROOT/src-tauri/target/release/bundle/dmg"
if [[ $BUILD_RC -eq 0 && -d "$BUNDLE_DIR" ]]; then
    log_step "Build succeeded. Artifacts:"
    while IFS= read -r -d '' f; do
        size_mb=$(du -m "$f" | cut -f1)
        log_ok "$(basename "$f")  (${size_mb} MB)"
        log_info "$f"
    done < <(find "$BUNDLE_DIR" -name '*.dmg' -print0)
    UPDATER_DIR="$PROJECT_ROOT/src-tauri/target/release/bundle/macos"
    while IFS= read -r -d '' f; do
        size_mb=$(du -m "$f" | cut -f1)
        log_ok "$(basename "$f")  (${size_mb} MB) [updater]"
        log_info "$f"
    done < <(find "$UPDATER_DIR" -maxdepth 1 \( -name '*.app.tar.gz' -o -name '*.app.tar.gz.sig' \) -print0 2>/dev/null)
else
    log_err "Build failed (exit $BUILD_RC). See output above."
fi

exit $BUILD_RC
