#!/usr/bin/env python3
"""Atomically publish one signed EchoAgent desktop updater artifact."""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
from urllib.parse import quote

SEMVER = re.compile(
    r"^(?P<major>0|[1-9]\d*)\."
    r"(?P<minor>0|[1-9]\d*)\."
    r"(?P<patch>0|[1-9]\d*)"
    r"(?:-(?P<pre>[0-9A-Za-z.-]+))?"
    r"(?:\+[0-9A-Za-z.-]+)?$"
)
TARGETS = {
    "windows-x86_64": (".exe", ".msi"),
    "windows-aarch64": (".exe", ".msi"),
    "darwin-x86_64": (".app.tar.gz",),
    "darwin-aarch64": (".app.tar.gz",),
    "linux-x86_64": (".AppImage",),
    "linux-aarch64": (".AppImage",),
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", required=True)
    parser.add_argument("--target", choices=sorted(TARGETS), required=True)
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--signature", type=Path, required=True)
    parser.add_argument("--notes-file", type=Path)
    parser.add_argument("--mandatory", action="store_true")
    parser.add_argument(
        "--root",
        type=Path,
        default=Path("/opt/echo-agent-desktop-updates"),
    )
    parser.add_argument(
        "--base-url",
        default="https://10.132.19.82:8787/desktop-updates",
    )
    return parser.parse_args()


def semver_key(value: str) -> tuple[int, int, int, tuple[tuple[int, object], ...]]:
    match = SEMVER.fullmatch(value)
    if not match:
        raise ValueError(f"invalid SemVer: {value}")
    pre = match.group("pre")
    # Stable releases sort after any prerelease of the same core version.
    if pre is None:
        pre_key: tuple[tuple[int, object], ...] = ((2, ""),)
    else:
        identifiers = []
        for item in pre.split("."):
            identifiers.append((0, int(item)) if item.isdigit() else (1, item))
        pre_key = tuple(identifiers)
    return (
        int(match.group("major")),
        int(match.group("minor")),
        int(match.group("patch")),
        pre_key,
    )


def atomic_copy(source: Path, destination: Path) -> None:
    temporary = destination.with_name(f".{destination.name}.{os.getpid()}.tmp")
    with source.open("rb") as reader, temporary.open("wb") as writer:
        shutil.copyfileobj(reader, writer, length=1024 * 1024)
        writer.flush()
        os.fsync(writer.fileno())
    os.chmod(temporary, 0o644)
    os.replace(temporary, destination)


def atomic_json(payload: dict[str, object], destination: Path) -> None:
    temporary = destination.with_name(f".{destination.name}.{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8") as writer:
        json.dump(payload, writer, ensure_ascii=False, indent=2)
        writer.write("\n")
        writer.flush()
        os.fsync(writer.fileno())
    os.chmod(temporary, 0o644)
    os.replace(temporary, destination)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as reader:
        while chunk := reader.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    args = parse_args()
    version = args.version.removeprefix("v")
    try:
        incoming_key = semver_key(version)
    except ValueError as error:
        print(error, file=sys.stderr)
        return 2

    artifact = args.artifact.resolve()
    signature_path = args.signature.resolve()
    if not artifact.is_file() or not signature_path.is_file():
        print("artifact and signature must both be regular files", file=sys.stderr)
        return 2
    if not any(artifact.name.endswith(suffix) for suffix in TARGETS[args.target]):
        print(f"artifact type does not match target {args.target}: {artifact.name}", file=sys.stderr)
        return 2

    signature = signature_path.read_text(encoding="utf-8").strip()
    if len(signature) < 80 or any(char.isspace() for char in signature):
        print("signature does not look like a Tauri updater .sig payload", file=sys.stderr)
        return 2

    notes = ""
    if args.notes_file:
        notes = args.notes_file.read_text(encoding="utf-8").strip()

    root = args.root.resolve()
    stable = root / "stable"
    version_dir = root / "releases" / version
    stable.mkdir(parents=True, exist_ok=True)
    version_dir.mkdir(mode=0o755, parents=True, exist_ok=True)

    lock_path = stable / ".publish.lock"
    with lock_path.open("a", encoding="utf-8") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        manifest_path = stable / f"{args.target}.json"
        existing: dict[str, object] | None = None
        if manifest_path.exists():
            existing = json.loads(manifest_path.read_text(encoding="utf-8"))
            existing_version = str(existing.get("version", ""))
            if existing_version and existing_version != version:
                try:
                    if incoming_key <= semver_key(existing_version):
                        print(
                            f"refusing non-forward publish: {version} <= {existing_version}",
                            file=sys.stderr,
                        )
                        return 2
                except ValueError:
                    print("existing latest.json contains invalid SemVer", file=sys.stderr)
                    return 2

        destination = version_dir / artifact.name
        atomic_copy(artifact, destination)
        sha256 = sha256_file(destination)
        (version_dir / f"{artifact.name}.sha256").write_text(
            f"{sha256}  {artifact.name}\n", encoding="utf-8"
        )
        os.chmod(version_dir / f"{artifact.name}.sha256", 0o644)
        atomic_copy(signature_path, version_dir / f"{artifact.name}.sig")

        if existing and existing.get("version") == version and not notes:
            notes = str(existing.get("notes", ""))

        base_url = args.base_url.rstrip("/")
        manifest: dict[str, object] = {
            "version": version,
            "notes": notes or f"EchoAgent {version}",
            "pub_date": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
            "mandatory": bool(args.mandatory),
            "url": f"{base_url}/releases/{quote(version)}/{quote(artifact.name)}",
            "signature": signature,
            "sha256": sha256,
        }
        atomic_json(manifest, manifest_path)

    print(f"published EchoAgent {version} for {args.target}")
    print(f"artifact: {destination}")
    print(f"manifest: {manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
