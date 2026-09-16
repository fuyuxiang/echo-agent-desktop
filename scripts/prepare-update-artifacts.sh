#!/usr/bin/env bash
# Prepare consistently named EchoAgent installers and signed Tauri updater
# artifacts from one Windows NSIS installer and two architecture-specific DMGs.

set -euo pipefail

log_step() { printf '\n\033[36m===> %s\033[0m\n' "$1"; }
log_ok()   { printf '  \033[32m[OK]\033[0m   %s\n' "$1"; }
log_warn() { printf '  \033[33m[WARN]\033[0m %s\n' "$1"; }
log_err()  { printf '  \033[31m[ERR]\033[0m  %s\n' "$1" >&2; }
log_info() { printf '         %s\n' "$1"; }

usage() {
  cat <<'EOF'
Prepare EchoAgent desktop release artifacts from three existing installers.

Usage:
  bash scripts/prepare-update-artifacts.sh \
    --windows-exe /path/to/EchoAgent-v0.3.10-windows-x86_64-setup.exe \
    --mac-arm64-dmg /path/to/EchoAgent-v0.3.10-darwin-aarch64.dmg \
    --mac-x64-dmg /path/to/EchoAgent-v0.3.10-darwin-x86_64.dmg \
    [--output-dir /path/to/output] [--unsigned] [--allow-unsigned-platform]

Signing (required unless --unsigned is used):
  Set TAURI_SIGNING_PRIVATE_KEY_PATH to the existing updater private key, or
  set TAURI_SIGNING_PRIVATE_KEY to the key content. If the key is encrypted,
  also set TAURI_SIGNING_PRIVATE_KEY_PASSWORD.

Output:
  EchoAgent-v<VERSION>-windows-x86_64-setup.exe[.sig]
  EchoAgent-v<VERSION>-darwin-aarch64.app.tar.gz[.sig]
  EchoAgent-v<VERSION>-darwin-x86_64.app.tar.gz[.sig]
  Canonically named DMGs for manual installation, artifacts.json and SHA-256s.

The --unsigned option is only for inspecting and testing package structure.
Unsigned output is not accepted by the EchoAgent/Tauri updater.
The --allow-unsigned-platform option bypasses Apple/Windows platform-signature
checks for development only. Output produced with it cannot be published.
EOF
}

die() {
  log_err "$1"
  exit "${2:-1}"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

extract_version() {
  local filename="$1"
  local target="$2"
  local suffix="$3"
  local canonical_prefix="EchoAgent-v"
  local canonical_suffix="-$target$suffix"
  local legacy_pattern='([0-9]+\.[0-9]+\.[0-9]+)'
  if [[ "$filename" == "$canonical_prefix"*"$canonical_suffix" ]]; then
    local version="${filename#"$canonical_prefix"}"
    printf '%s\n' "${version%"$canonical_suffix"}"
  elif [[ "$filename" =~ $legacy_pattern ]]; then
    # Compatibility for pre-standardization names such as EchoAgent_0.3.10_x64.dmg.
    printf '%s\n' "${BASH_REMATCH[1]}"
  else
    return 1
  fi
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

WINDOWS_EXE=""
MAC_ARM64_DMG=""
MAC_X64_DMG=""
OUTPUT_DIR=""
UNSIGNED=0
ALLOW_UNSIGNED_PLATFORM=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --windows-exe)
      WINDOWS_EXE="${2:-}"
      shift 2
      ;;
    --mac-arm64-dmg)
      MAC_ARM64_DMG="${2:-}"
      shift 2
      ;;
    --mac-x64-dmg)
      MAC_X64_DMG="${2:-}"
      shift 2
      ;;
    --output-dir)
      OUTPUT_DIR="${2:-}"
      shift 2
      ;;
    --unsigned)
      UNSIGNED=1
      shift
      ;;
    --allow-unsigned-platform)
      ALLOW_UNSIGNED_PLATFORM=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "Unknown argument: $1" 2
      ;;
  esac
done

[[ "$(uname -s)" == "Darwin" ]] || die "This script must run on macOS so it can mount DMG images."
[[ -n "$WINDOWS_EXE" ]] || die "--windows-exe is required" 2
[[ -n "$MAC_ARM64_DMG" ]] || die "--mac-arm64-dmg is required" 2
[[ -n "$MAC_X64_DMG" ]] || die "--mac-x64-dmg is required" 2

for input in "$WINDOWS_EXE" "$MAC_ARM64_DMG" "$MAC_X64_DMG"; do
  [[ -f "$input" ]] || die "Input file not found: $input"
  [[ -r "$input" ]] || die "Input file is not readable: $input"
done

require_command file
require_command hdiutil
require_command lipo
require_command node
require_command shasum
require_command tar
require_command codesign
require_command spctl
[[ -x /usr/libexec/PlistBuddy ]] || die "Required command not found: /usr/libexec/PlistBuddy"

if [[ $UNSIGNED -eq 0 ]]; then
  require_command pnpm
  if [[ -n "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]]; then
    [[ -f "$TAURI_SIGNING_PRIVATE_KEY_PATH" ]] || die "Updater private key not found: $TAURI_SIGNING_PRIVATE_KEY_PATH"
    [[ -r "$TAURI_SIGNING_PRIVATE_KEY_PATH" ]] || die "Updater private key is not readable: $TAURI_SIGNING_PRIVATE_KEY_PATH"
    private_key_dir="$(cd "$(dirname "$TAURI_SIGNING_PRIVATE_KEY_PATH")" && pwd -P)"
    private_key_path="$private_key_dir/$(basename "$TAURI_SIGNING_PRIVATE_KEY_PATH")"
    case "$private_key_path" in
      "$PROJECT_ROOT"/*) die "Updater private key must stay outside the source repository: $private_key_path" ;;
    esac
    private_key_mode="$(stat -f '%Lp' "$private_key_path")"
    [[ "$private_key_mode" =~ ^[0-7]00$ ]] \
      || die "Updater private key permissions are too broad ($private_key_mode); use chmod 600."
  elif [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
    die "Set TAURI_SIGNING_PRIVATE_KEY_PATH or TAURI_SIGNING_PRIVATE_KEY. Use --unsigned only for package-structure testing."
  fi
fi

windows_version="$(extract_version "$(basename "$WINDOWS_EXE")" "windows-x86_64" "-setup.exe")" \
  || die "Cannot read a SemVer version from Windows filename: $(basename "$WINDOWS_EXE")"
arm64_version="$(extract_version "$(basename "$MAC_ARM64_DMG")" "darwin-aarch64" ".dmg")" \
  || die "Cannot read a SemVer version from ARM64 DMG filename: $(basename "$MAC_ARM64_DMG")"
x64_version="$(extract_version "$(basename "$MAC_X64_DMG")" "darwin-x86_64" ".dmg")" \
  || die "Cannot read a SemVer version from x64 DMG filename: $(basename "$MAC_X64_DMG")"

if [[ "$windows_version" != "$arm64_version" ]]; then
  die "Installer versions differ: windows=$windows_version, mac-arm64=$arm64_version, mac-x64=$x64_version"
fi
if [[ "$windows_version" != "$x64_version" ]]; then
  die "Installer versions differ: windows=$windows_version, mac-arm64=$arm64_version, mac-x64=$x64_version"
fi
VERSION="$windows_version"
node "$PROJECT_ROOT/scripts/release-version.mjs" validate "$VERSION" >/dev/null
node "$PROJECT_ROOT/scripts/release-version.mjs" check "$VERSION" >/dev/null

windows_file_info="$(file -b "$WINDOWS_EXE")"
if [[ "$windows_file_info" != *"PE32"* || "$windows_file_info" != *"Nullsoft Installer"* ]]; then
  die "Windows input is not recognized as an NSIS installer: $windows_file_info"
fi

WINDOWS_PLATFORM_SIGNING="valid"
MAC_ARM64_PLATFORM_SIGNING="valid"
MAC_X64_PLATFORM_SIGNING="valid"
if command -v osslsigncode >/dev/null 2>&1; then
  if ! osslsigncode verify -in "$WINDOWS_EXE" >/dev/null 2>&1; then
    if [[ $ALLOW_UNSIGNED_PLATFORM -eq 1 ]]; then
      WINDOWS_PLATFORM_SIGNING="development-bypass"
      log_warn "Windows Authenticode verification failed; development override accepted."
    else
      die "Windows Authenticode verification failed for $(basename "$WINDOWS_EXE")."
    fi
  else
    log_ok "Verified Windows Authenticode signature"
  fi
elif [[ $ALLOW_UNSIGNED_PLATFORM -eq 1 ]]; then
  WINDOWS_PLATFORM_SIGNING="development-bypass"
  log_warn "osslsigncode is unavailable; development override skipped Windows Authenticode verification."
else
  die "osslsigncode is required to verify Windows Authenticode before release (for example: brew install osslsigncode)."
fi

if [[ -z "$OUTPUT_DIR" ]]; then
  OUTPUT_DIR="$PROJECT_ROOT/release/v$VERSION"
elif [[ "$OUTPUT_DIR" != /* ]]; then
  OUTPUT_DIR="$PROJECT_ROOT/$OUTPUT_DIR"
fi
[[ ! -e "$OUTPUT_DIR" ]] || die "Output path already exists; refusing to overwrite it: $OUTPUT_DIR"

OUTPUT_PARENT="$(dirname "$OUTPUT_DIR")"
mkdir -p "$OUTPUT_PARENT"
WORK_DIR="$(mktemp -d "$OUTPUT_PARENT/.prepare-update.XXXXXX")"
STAGE_DIR="$WORK_DIR/output"
mkdir -p "$STAGE_DIR"

MOUNT_POINTS=()
cleanup() {
  local mount_point
  for mount_point in "${MOUNT_POINTS[@]}"; do
    hdiutil detach "$mount_point" -quiet >/dev/null 2>&1 || true
  done
  if [[ -n "${WORK_DIR:-}" && -d "$WORK_DIR" ]]; then
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT INT TERM

sign_artifact() {
  local artifact="$1"
  if [[ $UNSIGNED -eq 1 ]]; then
    return
  fi

  (
    cd "$PROJECT_ROOT"
    pnpm tauri signer sign "$artifact"
  )
  [[ -s "$artifact.sig" ]] || die "Tauri signer did not create: $artifact.sig"
  local key_id
  key_id="$(node "$PROJECT_ROOT/scripts/verify-updater-signature.mjs" "$artifact")"
  UPDATER_KEY_ID="$key_id"
  log_ok "Signed $(basename "$artifact") with updater key $key_id"
}

package_macos_updater() {
  local dmg="$1"
  local expected_arch="$2"
  local target="$3"
  local mount_dir="$WORK_DIR/mount-$target"
  local app_path
  local plist_path
  local executable_name
  local executable_path
  local actual_arches
  local bundle_version
  local bundle_identifier
  local first_entry
  local updater_name="EchoAgent-v$VERSION-$target.app.tar.gz"
  local updater_path="$STAGE_DIR/$updater_name"
  local canonical_dmg="$STAGE_DIR/EchoAgent-v$VERSION-$target.dmg"
  local verification_dir="$WORK_DIR/verify-$target"
  local extracted_app="$verification_dir/EchoAgent.app"
  local platform_signing="valid"
  local apps=()
  local candidate

  mkdir -p "$mount_dir"
  MOUNT_POINTS+=("$mount_dir")
  hdiutil attach -readonly -nobrowse -mountpoint "$mount_dir" "$dmg" >/dev/null

  while IFS= read -r -d '' candidate; do
    apps+=("$candidate")
  done < <(find "$mount_dir" -maxdepth 2 -type d -name '*.app' -print0)

  [[ ${#apps[@]} -eq 1 ]] \
    || die "Expected exactly one .app inside $(basename "$dmg"), found ${#apps[@]}"
  app_path="${apps[0]}"
  [[ "$(basename "$app_path")" == "EchoAgent.app" ]] \
    || die "Unexpected app bundle in $(basename "$dmg"): $(basename "$app_path")"

  plist_path="$app_path/Contents/Info.plist"
  [[ -f "$plist_path" ]] || die "Info.plist missing from $app_path"
  executable_name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$plist_path")"
  bundle_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist_path")"
  bundle_identifier="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist_path")"
  executable_path="$app_path/Contents/MacOS/$executable_name"
  [[ -f "$executable_path" ]] || die "Main executable missing from $app_path: $executable_name"
  [[ -x "$executable_path" ]] || die "Main executable is not executable: $executable_path"
  [[ "$bundle_version" == "$VERSION" ]] \
    || die "Bundle version mismatch in $(basename "$dmg"): expected $VERSION, got $bundle_version"
  [[ "$bundle_identifier" == "com.echoagent.desktop" ]] \
    || die "Bundle identifier mismatch in $(basename "$dmg"): $bundle_identifier"

  actual_arches="$(lipo -archs "$executable_path")"
  if [[ " $actual_arches " != *" $expected_arch "* ]]; then
    die "Architecture mismatch in $(basename "$dmg"): expected $expected_arch, got $actual_arches"
  fi

  if ! codesign --verify --deep --strict "$app_path" >/dev/null 2>&1 \
      || ! spctl --assess --type execute "$app_path" >/dev/null 2>&1; then
    if [[ $ALLOW_UNSIGNED_PLATFORM -eq 1 ]]; then
      platform_signing="development-bypass"
      log_warn "$target Apple signature/Gatekeeper check failed; development override accepted."
    else
      die "$target app failed Apple code-signature or Gatekeeper verification."
    fi
  else
    log_ok "Verified Apple signature and Gatekeeper assessment for $target"
  fi

  # Match Tauri's updater layout: the .app directory is the archive root.
  COPYFILE_DISABLE=1 tar -czf "$updater_path" \
    -C "$(dirname "$app_path")" "$(basename "$app_path")"
  tar -tzf "$updater_path" >/dev/null
  first_entry="$(tar -tzf "$updater_path" | sed -n '1p')"
  [[ "$first_entry" == "EchoAgent.app" || "$first_entry" == "EchoAgent.app/"* ]] \
    || die "Unexpected updater archive root for $target: $first_entry"

  mkdir -p "$verification_dir"
  tar -xzf "$updater_path" -C "$verification_dir"
  [[ -d "$extracted_app" ]] || die "Updater round-trip lost EchoAgent.app for $target"
  local extracted_version
  local extracted_executable
  local extracted_arches
  extracted_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$extracted_app/Contents/Info.plist")"
  extracted_executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$extracted_app/Contents/Info.plist")"
  extracted_arches="$(lipo -archs "$extracted_app/Contents/MacOS/$extracted_executable")"
  [[ "$extracted_version" == "$VERSION" ]] \
    || die "Updater round-trip version mismatch for $target: $extracted_version"
  [[ " $extracted_arches " == *" $expected_arch "* ]] \
    || die "Updater round-trip architecture mismatch for $target: $extracted_arches"
  if [[ "$platform_signing" == "valid" ]]; then
    codesign --verify --deep --strict "$extracted_app" >/dev/null 2>&1 \
      || die "Updater archive damaged the Apple code signature for $target"
    spctl --assess --type execute "$extracted_app" >/dev/null 2>&1 \
      || die "Updater archive no longer passes Gatekeeper assessment for $target"
  fi

  cp -p "$dmg" "$canonical_dmg"
  sign_artifact "$updater_path"
  log_ok "Prepared $updater_name ($actual_arches)"

  if [[ "$target" == "darwin-aarch64" ]]; then
    MAC_ARM64_PLATFORM_SIGNING="$platform_signing"
  else
    MAC_X64_PLATFORM_SIGNING="$platform_signing"
  fi

  hdiutil detach "$mount_dir" -quiet
}

log_step "Preparing EchoAgent $VERSION artifacts"
log_info "Windows: $(basename "$WINDOWS_EXE")"
log_info "macOS ARM64: $(basename "$MAC_ARM64_DMG")"
log_info "macOS x86_64: $(basename "$MAC_X64_DMG")"

WINDOWS_NAME="EchoAgent-v$VERSION-windows-x86_64-setup.exe"
cp -p "$WINDOWS_EXE" "$STAGE_DIR/$WINDOWS_NAME"
sign_artifact "$STAGE_DIR/$WINDOWS_NAME"
log_ok "Prepared $WINDOWS_NAME"

log_step "Extracting and packaging macOS updater bundles"
package_macos_updater "$MAC_ARM64_DMG" "arm64" "darwin-aarch64"
package_macos_updater "$MAC_X64_DMG" "x86_64" "darwin-x86_64"

cat > "$STAGE_DIR/artifacts.json" <<EOF
{
  "schemaVersion": 1,
  "version": "$VERSION",
  "signed": $([[ $UNSIGNED -eq 0 ]] && printf 'true' || printf 'false'),
  "releaseEligible": $([[ $UNSIGNED -eq 0 && $ALLOW_UNSIGNED_PLATFORM -eq 0 ]] && printf 'true' || printf 'false'),
  "updaterKeyId": "$([[ $UNSIGNED -eq 0 ]] && printf '%s' "$UPDATER_KEY_ID" || printf '')",
  "platformSigning": {
    "windows-x86_64": "$WINDOWS_PLATFORM_SIGNING",
    "darwin-aarch64": "$MAC_ARM64_PLATFORM_SIGNING",
    "darwin-x86_64": "$MAC_X64_PLATFORM_SIGNING"
  },
  "updaterArtifacts": {
    "windows-x86_64": "$WINDOWS_NAME",
    "darwin-aarch64": "EchoAgent-v$VERSION-darwin-aarch64.app.tar.gz",
    "darwin-x86_64": "EchoAgent-v$VERSION-darwin-x86_64.app.tar.gz"
  },
  "manualInstallers": {
    "windows-x86_64": "$WINDOWS_NAME",
    "darwin-aarch64": "EchoAgent-v$VERSION-darwin-aarch64.dmg",
    "darwin-x86_64": "EchoAgent-v$VERSION-darwin-x86_64.dmg"
  }
}
EOF

(
  cd "$STAGE_DIR"
  shasum -a 256 EchoAgent-* > SHA256SUMS
)

mv "$STAGE_DIR" "$OUTPUT_DIR"

log_step "Release artifacts are ready"
log_ok "$OUTPUT_DIR"
if [[ $UNSIGNED -eq 1 ]]; then
  log_warn "Artifacts are unsigned test output and cannot be published to the updater."
elif [[ $ALLOW_UNSIGNED_PLATFORM -eq 1 ]]; then
  log_warn "Platform-signature checks were bypassed; artifacts.json marks this output as non-publishable."
else
  log_info "Publish all platforms with:"
  log_info "bash scripts/publish-all-updates.sh --artifacts-dir '$OUTPUT_DIR'"
fi
