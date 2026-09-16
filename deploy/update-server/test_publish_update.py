from __future__ import annotations

import importlib.util
from pathlib import Path
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
import json
import sys
import tempfile
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).with_name("publish-update.py")
SPEC = importlib.util.spec_from_file_location("echoagent_publish_update", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class SemverTests(unittest.TestCase):
    def test_stable_sorts_after_prerelease(self) -> None:
        self.assertLess(MODULE.semver_key("1.2.3-rc.1"), MODULE.semver_key("1.2.3"))

    def test_numeric_prerelease_sorts_before_text(self) -> None:
        self.assertLess(MODULE.semver_key("1.2.3-1"), MODULE.semver_key("1.2.3-alpha"))

    def test_invalid_leading_zero_is_rejected(self) -> None:
        for version in ("01.2.3", "1.2.3-01", "1.2.3-alpha..1", "1.2.3+meta..1"):
            with self.subTest(version=version), self.assertRaises(ValueError):
                MODULE.semver_key(version)


class PublishingTests(unittest.TestCase):
    def test_same_version_cannot_be_replaced_with_different_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifact = root / "EchoAgent-v1.2.3-windows-x86_64-setup.exe"
            signature = root / f"{artifact.name}.sig"
            artifact.write_bytes(b"first")
            signature.write_text("A" * 100, encoding="utf-8")
            arguments = [
                str(MODULE_PATH),
                "--version",
                "1.2.3",
                "--target",
                "windows-x86_64",
                "--artifact",
                str(artifact),
                "--signature",
                str(signature),
                "--root",
                str(root / "updates"),
            ]

            output = StringIO()
            with mock.patch.object(sys, "argv", arguments), redirect_stdout(output), redirect_stderr(output):
                self.assertEqual(MODULE.main(), 0)
            manifest_path = root / "updates" / "stable" / "windows-x86_64.json"
            original = json.loads(manifest_path.read_text(encoding="utf-8"))

            artifact.write_bytes(b"second")
            with mock.patch.object(sys, "argv", arguments), redirect_stdout(output), redirect_stderr(output):
                self.assertEqual(MODULE.main(), 2)
            current = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(current["sha256"], original["sha256"])


if __name__ == "__main__":
    unittest.main()
