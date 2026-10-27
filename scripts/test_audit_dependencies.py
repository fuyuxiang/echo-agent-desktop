"""Keep reviewed audit exceptions exact and visible in the saved evidence."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("audit_dependencies", Path(__file__).with_name("audit-dependencies.py"))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)

ADVISORY = "GHSA-qwgh-2vcv-g2f7"
IDENTITY = ("registry+https://github.com/rust-lang/crates.io-index",
            "3078c7629b62d3f0439517fa394996acacc5cbc91c5a20d8c658e77abd503a71")


class RustAuditReviewTests(unittest.TestCase):
    def test_review_is_specific_to_the_verified_release_and_advisory(self):
        review = audit.reviewed_rust_exception("block-buffer", "0.10.4", ADVISORY, {IDENTITY})
        self.assertIn("outside the buffer", review["reason"])
        self.assertTrue((audit.ROOT / review["regression_test"]).is_file())
        for name, version, advisory in [
            ("block-buffer", "0.12.0", ADVISORY),
            ("block-buffer", "0.10.3", ADVISORY),
            ("block-buffer", "0.10.4", "GHSA-another-advisory"),
            ("another-package", "0.10.4", ADVISORY),
        ]:
            with self.subTest(name=name, version=version, advisory=advisory):
                self.assertIsNone(audit.reviewed_rust_exception(name, version, advisory, {IDENTITY}))

    def test_unverified_artifacts_are_never_exempted(self):
        for identities in [set(), {(IDENTITY[0], None)}, {(IDENTITY[0], "changed")},
                           {("registry+https://example.com/index", IDENTITY[1])},
                           {IDENTITY, (IDENTITY[0], "changed")}]:
            with self.subTest(identities=identities):
                self.assertIsNone(audit.reviewed_rust_exception("block-buffer", "0.10.4", ADVISORY, identities))

    def test_report_retains_review_and_other_security_findings(self):
        other = "GHSA-test-unreviewed"
        records = {
            ADVISORY: {"id": ADVISORY, "summary": "panic corrupts inline buffer position"},
            other: {"id": other, "summary": "A separate security finding"},
        }

        def request(url, payload=None):
            if payload is None:
                return records[url.rsplit("/", 1)[-1]]
            return {"results": [
                {"vulns": [{"id": ADVISORY}, {"id": other}]}
                if query["package"]["name"] == "block-buffer" and query["version"] == "0.10.4" else {}
                for query in payload["queries"]
            ]}

        with tempfile.TemporaryDirectory() as directory, patch.object(audit, "request", side_effect=request):
            output = Path(directory)
            self.assertEqual(audit.rust_audit(output), 1)
            report = json.loads((output / "rust.json").read_text())
            self.assertEqual([row["advisory"] for row in report["not_affected"]], [ADVISORY])
            self.assertEqual([row["advisory"] for row in report["security"]], [other])
            self.assertEqual(report["maintenance"], [])
            self.assertIn("src-tauri/Cargo.lock", report["not_affected"][0]["manifests"])
            self.assertEqual(set(json.loads((output / "rust-advisories.json").read_text())), set(records))


if __name__ == "__main__":
    unittest.main()
