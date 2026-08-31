#!/usr/bin/env bash
# Upload one Tauri-signed updater artifact and atomically publish latest.json.
set -euo pipefail

HOST="root@10.132.19.82"
VERSION=""
TARGET=""
ARTIFACT=""
NOTES_FILE=""
MANDATORY=0

usage() {
  echo "Usage: $0 --version 0.3.9 --target windows-x86_64|darwin-aarch64|darwin-x86_64 --artifact FILE [--notes-file FILE] [--mandatory] [--host user@host]"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 ;;
    --target) TARGET="${2:-}"; shift 2 ;;
    --artifact) ARTIFACT="${2:-}"; shift 2 ;;
    --notes-file) NOTES_FILE="${2:-}"; shift 2 ;;
    --mandatory) MANDATORY=1; shift ;;
    --host) HOST="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$VERSION" || -z "$TARGET" || -z "$ARTIFACT" ]]; then
  usage >&2
  exit 2
fi
if [[ ! "$VERSION" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]]; then
  echo "Invalid SemVer: $VERSION" >&2
  exit 2
fi
if [[ ! "$TARGET" =~ ^(windows|darwin|linux)-(x86_64|aarch64)$ ]]; then
  echo "Unsupported updater target: $TARGET" >&2
  exit 2
fi
if [[ ! -f "$ARTIFACT" || ! -f "$ARTIFACT.sig" ]]; then
  echo "Artifact and generated signature are required: $ARTIFACT and $ARTIFACT.sig" >&2
  exit 2
fi
if [[ -n "$NOTES_FILE" && ! -f "$NOTES_FILE" ]]; then
  echo "Notes file not found: $NOTES_FILE" >&2
  exit 2
fi

REMOTE_TMP="$(ssh "$HOST" 'mktemp -d /tmp/echoagent-update.XXXXXX')"
if [[ ! "$REMOTE_TMP" =~ ^/tmp/echoagent-update\.[A-Za-z0-9]+$ ]]; then
  echo "Unexpected remote staging path: $REMOTE_TMP" >&2
  exit 1
fi
cleanup() { ssh "$HOST" "rm -rf '$REMOTE_TMP'" >/dev/null 2>&1 || true; }
trap cleanup EXIT

scp "$ARTIFACT" "$ARTIFACT.sig" "$HOST:$REMOTE_TMP/"
REMOTE_ARTIFACT="$REMOTE_TMP/$(basename "$ARTIFACT")"
REMOTE_SIGNATURE="$REMOTE_TMP/$(basename "$ARTIFACT").sig"
REMOTE_NOTES=""
if [[ -n "$NOTES_FILE" ]]; then
  scp "$NOTES_FILE" "$HOST:$REMOTE_TMP/release-notes.txt"
  REMOTE_NOTES="--notes-file '$REMOTE_TMP/release-notes.txt'"
fi
REMOTE_MANDATORY=""
if [[ $MANDATORY -eq 1 ]]; then REMOTE_MANDATORY="--mandatory"; fi

ssh "$HOST" \
  "/usr/local/sbin/echoagent-publish-update --version '$VERSION' --target '$TARGET' --artifact '$REMOTE_ARTIFACT' --signature '$REMOTE_SIGNATURE' $REMOTE_NOTES $REMOTE_MANDATORY"

echo "Published manifest: https://10.132.19.82:8787/desktop-updates/stable/$TARGET.json"
