"""Exact installed notice bytes, explicit gaps and exclusive output boundaries."""
import hashlib
import importlib.metadata
import importlib.util
import json
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[3] / "scripts/license-notices.py"
SPEC = importlib.util.spec_from_file_location("vitaai_notices", SCRIPT)
notices = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(notices)


class LicenseNoticeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.root = self.base / "workspace"
        (self.root / "node_modules").mkdir(parents=True)
        self.site = self.base / "installed-python"
        self.site.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def package(self, relative="node_modules/example", name="example", **extra):
        directory = self.root / relative
        directory.mkdir(parents=True)
        (directory / "package.json").write_text(json.dumps({"name": name, "version": "1.0", "license": "MIT",
            "repository": "https://github.com/example/project", **extra}), encoding="utf-8")
        return directory

    def distribution(self, files=None, declared=()):
        directory = self.site / "example-1.0.dist-info"
        directory.mkdir(exist_ok=True)
        metadata = "Name: python-example\nVersion: 1.0\nLicense-Expression: MIT\n"
        metadata += "Home-page: https://github.com/example/python\nAuthor-email: private@example.test\n"
        metadata += "".join(f"License-File: {name}\n" for name in declared)
        (directory / "METADATA").write_text(metadata + "\nPrivate package description\n", encoding="utf-8")
        names = ["example-1.0.dist-info/METADATA"]
        for name, data in (files or {}).items():
            path = directory / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            names.append("example-1.0.dist-info/" + name)
        (directory / "RECORD").write_text("".join(f"{name},,\n" for name in names), encoding="utf-8")
        return importlib.metadata.PathDistribution(directory)

    def assert_texts(self, report, output):
        count = 0
        for record in report["records"]:
            for text in record["texts"]:
                data = (output / text["bundle_path"]).read_bytes()
                self.assertEqual(hashlib.sha256(data).hexdigest(), text["sha256"])
                self.assertEqual(len(data), text["bytes"])
                count += 1
        self.assertEqual(count, report["text_count"])

    def test_actual_distribution_and_scoped_nested_instances_copy_exact_bytes_offline(self):
        distribution = self.distribution({"licenses/LICENSE.md": b"Python MIT\r\nCopyright Example\n",
            "licenses/vendor/NOTICE": b"Retain this notice.\n", "private.md": b"Private metadata file"}, ("LICENSE.md",))
        root = self.package(name="same")
        (root / "LICENSE").write_bytes(b"Root MIT\r\n")
        (root / "private.md").write_text("Private project planning", encoding="utf-8")
        nested = self.package("node_modules/example/node_modules/same", "same")
        (nested / "LICENSE").write_bytes(b"Distinct installed text\n")
        scoped = self.package("node_modules/@scope/child", "@scope/child")
        (scoped / "NOTICE.md").write_bytes(b"Scoped attribution\n")
        output = self.base / "bundle"
        with patch.object(socket.socket, "connect", side_effect=AssertionError("Offline only")):
            report = notices.write_bundle(output, self.root, [distribution, distribution])
        self.assertEqual(report["installed_instances"], 5)
        self.assertEqual(report["ecosystems"], ["python", "npm"])
        self.assertEqual(report["text_count"], 7)
        self.assertEqual(report["instances_with_gaps"], 0)
        self.assertEqual(len({row["instance_id"] for row in report["records"]}), 5)
        self.assertEqual(sum(row["name"] == "same" for row in report["records"]), 2)
        self.assert_texts(report, output)
        self.assertFalse((output / "INCOMPLETE.txt").exists())
        serialized = json.dumps(report)
        for private in (str(self.base), "Private package description", "private@example.test", "private.md"):
            self.assertNotIn(private, serialized)
        self.assertNotIn("legal_compatible", report)
        self.assertNotIn("meets_rubric", report)

    def test_python_only_environment_needs_no_web_tree_and_preserves_source_fence(self):
        (self.root / "node_modules").rmdir()
        distribution = self.distribution({"licenses/LICENSE": b"Python-only legal bytes\r\n"})
        output = self.base / "python-only"
        with patch.object(notices, "web_instances", side_effect=AssertionError("No npm scan")), \
                patch.object(socket.socket, "connect", side_effect=AssertionError("Offline only")):
            report = notices.write_bundle(output, self.root, [distribution], ecosystem="python")
        self.assertEqual(report["ecosystems"], ["python"])
        self.assertEqual([row["ecosystem"] for row in report["records"]], ["python"])
        self.assertEqual(report["installed_instances"], 1)
        self.assert_texts(report, output)
        with self.assertRaises(ValueError):
            notices.write_bundle(self.site / "inside-python", self.root, [distribution], ecosystem="python")
        self.assertFalse((self.site / "inside-python").exists())

    def test_npm_only_does_not_enumerate_collector_python_environment(self):
        package = self.package()
        (package / "LICENSE").write_bytes(b"Selected npm legal bytes\n")
        output = self.base / "npm-only"
        with patch.object(notices, "python_instances", side_effect=AssertionError("No Python scan")), \
                patch.object(notices.importlib.metadata, "distributions", side_effect=AssertionError("No Python metadata")), \
                patch.object(socket.socket, "connect", side_effect=AssertionError("Offline only")):
            report = notices.write_bundle(output, self.root, ecosystem="npm")
        self.assertEqual(report["ecosystems"], ["npm"])
        self.assertEqual([row["ecosystem"] for row in report["records"]], ["npm"])
        self.assert_texts(report, output)

    def test_invalid_ecosystem_rejects_before_read_or_output(self):
        output = self.base / "invalid-scope"
        with patch.object(notices, "web_instances", side_effect=AssertionError("Must reject first")), \
                patch.object(notices, "python_instances", side_effect=AssertionError("Must reject first")), \
                self.assertRaises(ValueError):
            notices.write_bundle(output, self.root, ecosystem="private-invalid-value")
        self.assertFalse(output.exists())

    def test_custom_root_cannot_write_into_collector_contribution_checkout(self):
        output = SCRIPT.parent.parent / ".notice-output-must-not-exist"
        with patch.object(notices, "collect", side_effect=AssertionError("Must reject before scan")), \
                self.assertRaises(ValueError):
            notices.write_bundle(output, self.root, ecosystem="npm")
        self.assertFalse(output.exists())

    def test_cli_explicit_root_and_npm_scope_collects_exact_bytes_and_safe_errors(self):
        package = self.package()
        (package / "LICENSE").write_bytes(b"CLI-selected legal bytes\r\n")
        output = self.base / "cli-selected"
        result = subprocess.run([sys.executable, str(SCRIPT), "--root", str(self.root), "--ecosystem", "npm",
            "--output", str(output)], capture_output=True, text=True, check=False, cwd=self.base)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads((output / "manifest.json").read_text())
        self.assertEqual(report["ecosystems"], ["npm"])
        self.assertEqual(report["installed_instances"], 1)
        self.assert_texts(report, output)
        result = subprocess.run([sys.executable, str(SCRIPT), "--root", str(self.root),
            "--ecosystem", "private-invalid-value", "--output", str(self.base / "invalid-cli")],
            capture_output=True, text=True, check=False, cwd=self.base)
        self.assertEqual(result.returncode, 2)
        self.assertNotIn("private-invalid-value", result.stderr)
        self.assertFalse((self.base / "invalid-cli").exists())

    def test_nested_vendored_texts_keep_parent_identity_and_exact_relative_names(self):
        package = self.package()
        nested = package / "dist/compiled/vendor"
        nested.mkdir(parents=True)
        data = b"Bundled attribution\r\nCopyright Vendor\n"
        (nested / "LICENSE.md").write_bytes(data)
        (nested / "package.json").write_text('{"name":"unverified-vendor","version":"9"}')
        (nested / "private.md").write_text("Not a legal candidate")
        hidden = package / ".private"
        hidden.mkdir()
        (hidden / "LICENSE").write_text("Excluded hidden material")
        output = self.base / "nested-bundle"
        with patch.object(socket.socket, "connect", side_effect=AssertionError("Offline only")):
            report = notices.write_bundle(output, self.root, [])
        self.assertEqual(report["installed_instances"], 1)
        self.assertEqual(report["records"][0]["name"], "example")
        self.assertEqual(report["records"][0]["version"], "1.0")
        text = report["records"][0]["texts"][0]
        self.assertEqual(text["source_name"], "dist/compiled/vendor/LICENSE.md")
        self.assertEqual((output / text["bundle_path"]).read_bytes(), data)
        self.assertEqual(report["text_count"], 1)
        self.assert_texts(report, output)

    def test_nested_directory_link_rejects_before_reading_linked_candidates(self):
        package = self.package()
        external = self.base / "outside"
        external.mkdir()
        (external / "LICENSE").write_text("Private external material")
        try:
            (package / "vendor").symlink_to(external, target_is_directory=True)
        except OSError:
            self.skipTest("Host does not allow symlink creation")
        with patch.object(notices, "read_text_bytes", side_effect=AssertionError("Must reject before read")), \
                self.assertRaises(ValueError):
            notices.write_bundle(self.base / "linked-vendor", self.root, [])
        self.assertFalse((self.base / "linked-vendor").exists())

    def test_recursive_file_and_depth_bounds_reject_before_output(self):
        package = self.package()
        nested = package / "dist/vendor"
        nested.mkdir(parents=True)
        (nested / "LICENSE").write_bytes(b"Legal bytes")
        for index, (constant, bound) in enumerate((("MAXIMUM_ENTRIES", 3), ("MAXIMUM_DEPTH", 1))):
            output = self.base / f"recursive-bound-{index}"
            with patch.object(notices, constant, bound), self.assertRaises(ValueError):
                notices.write_bundle(output, self.root, [])
            self.assertFalse(output.exists())

    def test_missing_declared_and_unsupported_texts_stay_explicit(self):
        distribution = self.distribution({}, ("missing.txt",))
        package = self.package()
        (package / "LICENSE").write_bytes(b"\xff\xfe\0")
        output = self.base / "gaps"
        report = notices.write_bundle(output, self.root, [distribution])
        self.assertEqual(report["text_count"], 0)
        self.assertEqual(report["instances_with_gaps"], 2)
        self.assertEqual(report["status"], "collected_with_gaps")
        self.assertEqual(report["records"][0]["issues"], [{"code": "missing_declared_text", "source_name": "licenses/missing.txt"}])
        self.assertEqual(report["records"][1]["issues"][0]["code"], "empty_or_unsupported_text")

    def test_absent_text_and_unsupported_distribution_file_lists_remain_unavailable(self):
        self.package()
        distribution = self.distribution()
        (self.site / "example-1.0.dist-info/RECORD").unlink()
        report = notices.write_bundle(self.base / "unsupported", self.root, [distribution])
        self.assertEqual(report["records"][0]["issues"], [{"code": "unsupported_distribution_files"}])
        self.assertEqual(report["records"][1]["issues"], [{"code": "no_conventional_text_found"}])
        with self.assertRaises(ValueError):
            notices.write_bundle(self.site / "inside-unsupported", self.root, [distribution])
        self.assertFalse((self.site / "inside-unsupported").exists())

    def test_unsupported_metadata_location_keeps_source_output_fence(self):
        self.package()
        distribution = self.distribution()
        (self.site / "example-1.0.dist-info/RECORD").write_text("package/LICENSE,,\n", encoding="utf-8")
        report = notices.write_bundle(self.base / "unknown-location", self.root, [distribution])
        self.assertEqual(report["records"][0]["issues"], [{"code": "unsupported_metadata_location"}])
        with self.assertRaises(ValueError):
            notices.write_bundle(self.site / "inside-location", self.root, [distribution])
        self.assertFalse((self.site / "inside-location").exists())

    def test_unsafe_declared_paths_reject_before_output(self):
        self.package()
        for index, name in enumerate(("../private.md", "/absolute", "C:/secret", "folder\\LICENSE", "a/./LICENSE", ".env")):
            distribution = self.distribution({}, (name,))
            output = self.base / f"unsafe-{index}"
            with self.subTest(name=name), self.assertRaises(ValueError):
                notices.write_bundle(output, self.root, [distribution])
            self.assertFalse(output.exists())

    def test_external_text_symlink_rejects_without_reading_external_bytes(self):
        package = self.package()
        external = self.base / "private.env"
        external.write_text("Private credential", encoding="utf-8")
        link = package / "LICENSE"
        try:
            link.symlink_to(external)
        except OSError:
            self.skipTest("Host does not allow symlink creation")
        with self.assertRaises(ValueError):
            notices.write_bundle(self.base / "symlink", self.root, [])
        self.assertFalse((self.base / "symlink").exists())
        self.assertEqual(external.read_text(), "Private credential")

    def test_in_root_file_and_directory_links_cannot_export_private_material(self):
        package = self.package()
        private = package / ".env"
        private.write_text("Private token", encoding="utf-8")
        link = package / "LICENSE"
        try:
            link.symlink_to(private)
        except OSError:
            self.skipTest("Host does not allow symlink creation")
        with self.assertRaises(ValueError):
            notices.write_bundle(self.base / "in-root-npm", self.root, [])
        self.assertFalse((self.base / "in-root-npm").exists())
        link.unlink()
        distribution = self.distribution()
        metadata = self.site / "example-1.0.dist-info"
        (metadata / "private").mkdir()
        (metadata / "private/NOTICE").write_text("Private planning", encoding="utf-8")
        (metadata / "licenses").symlink_to(metadata / "private", target_is_directory=True)
        with (metadata / "RECORD").open("a") as stream:
            stream.write("example-1.0.dist-info/licenses/NOTICE,,\n")
        with self.assertRaises(ValueError):
            notices.write_bundle(self.base / "in-root-python", self.root, [distribution])
        self.assertFalse((self.base / "in-root-python").exists())
        self.assertEqual(private.read_text(), "Private token")
        self.assertEqual((metadata / "private/NOTICE").read_text(), "Private planning")

    def test_private_application_workspace_is_excluded(self):
        package = self.package("apps/web", "@vitaai/web", private=True)
        (package / "LICENSE.md").write_text("Private app material", encoding="utf-8")
        nested = self.package("apps/web/node_modules/third-party", "third-party")
        (nested / "LICENSE.md").write_bytes(b"Nested third-party legal text\r\n")
        (self.root / "node_modules/@vitaai").mkdir()
        try:
            (self.root / "node_modules/@vitaai/web").symlink_to(package, target_is_directory=True)
        except OSError:
            self.skipTest("Host does not allow symlink creation")
        report = notices.write_bundle(self.base / "workspace-bundle", self.root, [])
        self.assertEqual(report["installed_instances"], 1)
        self.assertEqual(report["workspace_packages_excluded"], 1)
        self.assertEqual(report["instances_with_gaps"], 0)
        self.assertEqual(report["records"][0]["name"], "third-party")
        self.assertEqual(report["records"][0]["texts"][0]["source_name"], "LICENSE.md")
        copied = self.base / "workspace-bundle" / report["records"][0]["texts"][0]["bundle_path"]
        self.assertEqual(copied.read_bytes(), b"Nested third-party legal text\r\n")

    def test_nonprivate_workspace_link_cannot_export_source_texts(self):
        source = self.package("shared-source", "shared-source", private=False)
        (source / "LICENSE.md").write_text("Original source material", encoding="utf-8")
        try:
            (self.root / "node_modules/shared-source").symlink_to(source, target_is_directory=True)
        except OSError:
            self.skipTest("Host does not allow symlink creation")
        report = notices.write_bundle(self.base / "linked-source", self.root, [])
        self.assertEqual(report["installed_instances"], 1)
        self.assertEqual(report["text_count"], 0)
        self.assertEqual(report["records"][0]["issues"], [{"code": "unsupported_workspace_location"}])
        self.assertNotIn("Original source material", json.dumps(report))

    def test_linked_node_modules_directory_cannot_relabel_workspace_source(self):
        package = self.package()
        source = self.package("shared-source/pkg", "linked-pkg")
        (source / "LICENSE.md").write_text("Workspace source material", encoding="utf-8")
        try:
            (package / "node_modules").symlink_to(source.parent, target_is_directory=True)
        except OSError:
            self.skipTest("Host does not allow symlink creation")
        output = self.base / "linked-modules"
        with self.assertRaises(ValueError):
            notices.write_bundle(output, self.root, [])
        self.assertFalse(output.exists())
        self.assertEqual((source / "LICENSE.md").read_text(), "Workspace source material")

    def test_unreadable_text_is_a_coverage_gap_not_a_successful_copy(self):
        package = self.package()
        (package / "LICENSE").write_text("Installed legal text", encoding="utf-8")
        with patch.object(notices, "read_text_bytes", side_effect=PermissionError("private path")):
            report = notices.write_bundle(self.base / "unreadable", self.root, [])
        self.assertEqual(report["text_count"], 0)
        self.assertEqual(report["records"][0]["issues"], [{"code": "unreadable_text", "source_name": "LICENSE"}])
        self.assertNotIn("private path", json.dumps(report))

    def test_count_text_total_manifest_and_depth_bounds_reject_before_output(self):
        package = self.package()
        (package / "LICENSE").write_bytes(b"Legal bytes")
        for index, (constant, value) in enumerate((("MAXIMUM_INSTANCES", 0), ("MAXIMUM_FILES", 0),
                ("MAXIMUM_TEXT", 1), ("MAXIMUM_TOTAL", 1), ("MAXIMUM_REPORT", 1), ("MAXIMUM_DEPTH", -1))):
            output = self.base / f"bounded-{index}"
            with self.subTest(constant=constant), patch.object(notices, constant, value), self.assertRaises(ValueError):
                notices.write_bundle(output, self.root, [])
            self.assertFalse(output.exists())

    def test_output_is_exclusive_external_and_never_inside_python_source(self):
        self.package()
        distribution = self.distribution({"licenses/LICENSE": b"MIT text"})
        existing = self.base / "existing"
        existing.mkdir()
        (existing / "preserve.txt").write_text("preserve")
        for output in (existing, self.root / "inside", self.site / "inside", self.root.parent):
            with self.subTest(output=output), self.assertRaises(ValueError):
                notices.write_bundle(output, self.root, [distribution])
        self.assertEqual((existing / "preserve.txt").read_text(), "preserve")
        self.assertFalse((self.site / "inside").exists())

    def test_partial_write_retains_incomplete_marker_and_cli_error_is_safe(self):
        package = self.package()
        (package / "LICENSE").write_bytes(b"Legal text")
        destination = self.base / "partial"
        original_open = Path.open

        def fail_output(path, *args, **kwargs):
            if path.is_relative_to(destination / "texts"):
                raise OSError("Private credential path")
            return original_open(path, *args, **kwargs)

        with patch.object(notices.Path, "open", fail_output), self.assertRaises(OSError):
            notices.write_bundle(destination, self.root, [])
        self.assertTrue(destination.is_dir())
        self.assertTrue((destination / "INCOMPLETE.txt").is_file())
        self.assertFalse((destination / "manifest.json").exists())
        with self.assertRaises(ValueError):
            notices.write_bundle(destination, self.root, [])
        private = self.base / "private-secret-output"
        private.mkdir()
        result = subprocess.run([sys.executable, str(SCRIPT), "--output", str(private)],
            capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 2)
        self.assertNotIn("private-secret", result.stderr)
        self.assertNotIn(str(private), result.stderr)


if __name__ == "__main__":
    unittest.main()
