"""Read-only declaration inventory, package-root coverage and external output safety."""
import importlib.util
import json
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[3] / "scripts/license-inventory.py"
SPEC = importlib.util.spec_from_file_location("vitaai_license_inventory", SCRIPT)
inventory = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(inventory)


class Distribution:
    def __init__(self, metadata):
        self.value = metadata

    def read_text(self, name):
        return self.value if name == "METADATA" else None


class LicenseInventoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.root = self.base / "workspace"
        self.root.mkdir()
        (self.root / "node_modules").mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def package(self, relative, name="example", version="1.2.3", **extra):
        directory = self.root / relative
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "package.json").write_text(json.dumps({"name": name, "version": version, **extra}), encoding="utf-8")
        return directory

    def distribution(self):
        return Distribution("Name: python-example\nVersion: 2.3.4\nLicense-Expression: MIT\n"
            "Home-page: https://github.com/example/python-example\nProject-URL: Docs, https://docs.python.org/3/\n"
            "Author-email: private@example.test\n\nPrivate description and C:/private/location are not report fields")

    def test_python_metadata_excludes_description_contacts_paths_and_invalid_links(self):
        report = inventory.python_records([self.distribution()])
        self.assertEqual(report[0]["name"], "python-example")
        self.assertEqual(report[0]["declared_licenses"], ["MIT"])
        self.assertEqual(report[0]["source_links"], ["https://docs.python.org/3/", "https://github.com/example/python-example"])
        encoded = json.dumps(report)
        for private in ("private@example", "Private description", "C:/private"):
            self.assertNotIn(private, encoded)
        for link in ("https://user:secret@github.com/example", "file:///private", "http://github.com/example", "https://localhost/x", "https://docs.internal/x", "https://github.com/x?token=secret", "https://github.com/x#private", "https://127.0.0.1/x"):
            self.assertIsNone(inventory.public_link(link))
        self.assertEqual(inventory.public_link("git+https://github.com/example/project.git"), "https://github.com/example/project.git")

    def test_scoped_nested_and_duplicate_packages_are_measured_but_test_files_are_not_packages(self):
        self.package("node_modules/root", "root", license="MIT")
        self.package("node_modules/@scope/child", "@scope/child", license="Apache-2.0")
        self.package("node_modules/root/node_modules/duplicate", "duplicate", license="BSD-3-Clause")
        self.package("node_modules/duplicate", "duplicate", license="BSD-3-Clause")
        self.package("node_modules/root/tests/fake", "not-an-installed-package", license="MIT")
        with patch.object(socket.socket, "connect", side_effect=AssertionError("Offline inventory cannot connect")):
            result = inventory.inventory(self.root, [self.distribution()])
        self.assertEqual(result["installed_instances"], 5)
        self.assertEqual(result["record_count"], 4)
        self.assertNotIn("not-an-installed-package", json.dumps(result))
        self.assertEqual(next(item for item in result["records"] if item["name"] == "duplicate")["instances"], 2)

    def test_missing_multiple_and_conflicting_declarations_remain_explicit(self):
        self.package("node_modules/one", "shared", license="MIT")
        self.package("node_modules/two", "shared", license="Apache-2.0")
        self.package("node_modules/missing", "missing")
        self.package("node_modules/legacy", "legacy", license="MIT", licenses=[{"type": "BSD-3-Clause"}])
        result = inventory.inventory(self.root, [])
        self.assertEqual(result["missing_license_count"], 1)
        self.assertEqual(result["conflict_groups"], [{"ecosystem": "npm", "name": "shared", "version": "1.2.3", "declarations": [["Apache-2.0"], ["MIT"]]}])
        self.assertEqual(next(item for item in result["records"] if item["name"] == "legacy")["license_status"], "multiple_declarations")
        self.assertNotIn("meets_rubric", result)
        self.assertNotIn("legal_compatible", result)

    def test_singular_license_objects_preserve_valid_type_and_expose_malformed_as_missing(self):
        self.package("node_modules/legacy", "legacy", license={"type": "MIT", "url": "https://opensource.org/license/mit"})
        self.package("node_modules/malformed", "malformed", license={"type": {"unexpected": "MIT"}})
        self.package("node_modules/absent", "absent", license={"url": "https://opensource.org/license/mit"})
        result = inventory.inventory(self.root, [])
        legacy = next(item for item in result["records"] if item["name"] == "legacy")
        self.assertEqual(legacy["declared_licenses"], ["MIT"])
        self.assertEqual(legacy["license_status"], "declared")
        for name in ("malformed", "absent"):
            item = next(item for item in result["records"] if item["name"] == name)
            self.assertEqual(item["declared_licenses"], [])
            self.assertEqual(item["license_status"], "missing")
        self.assertEqual(result["missing_license_count"], 2)

    def test_malformed_duplicate_nonfinite_or_missing_package_identity_reject(self):
        package = self.package("node_modules/bad")
        for raw in ("{", '{"name":"bad","name":"duplicate","version":"1"}', '{"name":"bad","version":NaN}', '{"license":"MIT"}', "[]"):
            (package / "package.json").write_text(raw, encoding="utf-8")
            with self.assertRaises((ValueError, TypeError)):
                inventory.web_records(self.root)
        with self.assertRaises(ValueError):
            inventory.python_records([Distribution("Name: bad\n\nmissing version")])

    def test_package_metadata_and_inventory_bounds_reject_without_output(self):
        package = self.package("node_modules/large")
        with patch.object(inventory, "MAXIMUM_BYTES", 10), self.assertRaises(ValueError):
            inventory.web_records(self.root)
        with patch.object(inventory, "MAXIMUM_PACKAGES", 0), self.assertRaises(ValueError):
            inventory.inventory(self.root, [])
        with patch.object(inventory, "MAXIMUM_DEPTH", -1), self.assertRaises(ValueError):
            inventory.web_records(self.root)
        target = self.base / "too-large.json"
        with patch.object(inventory, "MAXIMUM_REPORT", 20), self.assertRaises(ValueError):
            inventory.write_inventory(target, self.root, [])
        self.assertFalse(target.exists())
        self.assertTrue((package / "package.json").exists())

    def test_output_is_new_external_and_preserves_metadata(self):
        package = self.package("node_modules/example", license="MIT")
        before = (package / "package.json").read_bytes()
        target = self.base / "inventory.json"
        value = inventory.write_inventory(target, self.root, [])
        self.assertEqual(json.loads(target.read_text(encoding="utf-8"))["record_count"], value["record_count"])
        with self.assertRaises(ValueError):
            inventory.write_inventory(target, self.root, [])
        with self.assertRaises(ValueError):
            inventory.write_inventory(self.root / "private.json", self.root, [])
        self.assertFalse((self.root / "private.json").exists())
        self.assertEqual((package / "package.json").read_bytes(), before)

    def test_workspace_link_is_excluded_and_external_package_link_is_rejected(self):
        workspace = self.package("apps/web", "@vitaai/web", private=True)
        link = self.root / "node_modules/local"
        try:
            link.symlink_to(workspace, target_is_directory=True)
        except OSError:
            self.skipTest("This host does not permit creating directory symlinks")
        records, excluded = inventory.web_records(self.root)
        self.assertEqual((records, excluded), ([], 1))
        link.unlink()
        external = self.base / "outside"
        external.mkdir()
        (external / "package.json").write_text('{"name":"outside","version":"1"}', encoding="utf-8")
        link.symlink_to(external, target_is_directory=True)
        with self.assertRaises(ValueError):
            inventory.web_records(self.root)

    def test_cli_failure_does_not_echo_private_destination(self):
        private = self.base / "private-credential-destination.json"
        private.write_text("preserve", encoding="utf-8")
        response = subprocess.run([sys.executable, str(SCRIPT), "--output", str(private)], capture_output=True, text=True, check=False)
        self.assertEqual(response.returncode, 2)
        self.assertNotIn(str(private), response.stderr)
        self.assertNotIn("private-credential", response.stderr)
        self.assertEqual(private.read_text(encoding="utf-8"), "preserve")


if __name__ == "__main__":
    unittest.main()
