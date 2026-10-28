"""Clean-source export, environment and failed-command integrity checks."""
import importlib.util
import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "check-clean-setup.py"
SPEC = importlib.util.spec_from_file_location("clean_setup", SCRIPT)
clean_setup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(clean_setup)


def archive(entries):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as output:
        for name, value in entries:
            if isinstance(name, zipfile.ZipInfo):
                output.writestr(name, value)
            else:
                # Preserve hostile raw ZIP names; Windows ZipInfo normally replaces backslashes.
                info = zipfile.ZipInfo(name)
                info.filename = name
                info.orig_filename = name
                output.writestr(info, value)
    return stream.getvalue()


class CleanSetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_all_members_validate_before_any_extraction(self):
        for index, name in enumerate(("../escape.py", "/absolute.py", "C:/path.py", "folder\\alternate.py", "folder/.env", "folder/.ENV.LOCAL",
                     "docs/private.MD", "folder/database.sqlite", ".git/config", ".local/runtime.json", "node_modules/pkg/index.js",
                     "folder/secret.pem", "folder/.npmrc", "NUL.txt", "name./file.py", "a/./b.py", "a//b.py",
                     "data/state.db-wal", "data/state.db-shm", "data/state.sqlite-wal", "data/state.sqlite-shm", "logs/events.json", "dumps/state.json")):
            with self.subTest(name=name):
                destination = self.root / f"source-{index}"
                with self.assertRaises(clean_setup.CheckFailed):
                    clean_setup.extract_source(archive([("safe.py", "safe"), (name, "private")]), destination)
                self.assertFalse(destination.exists())

    def test_symlinks_case_collisions_and_size_bounds_reject(self):
        info = zipfile.ZipInfo("shortcut")
        info.create_system = 3
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        for data in (archive([(info, "elsewhere")]), archive([("File.py", "one"), ("file.py", "two")])):
            with self.assertRaises(clean_setup.CheckFailed):
                clean_setup.extract_source(data, self.root / "source")
            self.assertFalse((self.root / "source").exists())
        with patch.object(clean_setup, "MAXIMUM_ARCHIVE", 2), self.assertRaises(clean_setup.CheckFailed):
            clean_setup.extract_source(b"abc", self.root / "source")

    def test_original_source_and_example_configuration_extract_exclusively(self):
        destination = self.root / "source"
        data = archive([("package.json", "{}"), ("services/api/.env.example", "AUTH_MODE=sample\n"), ("apps/web/app/page.tsx", "export default null")])
        self.assertEqual(clean_setup.extract_source(data, destination), 3)
        self.assertEqual((destination / "services/api/.env.example").read_text(), "AUTH_MODE=sample\n")
        with self.assertRaises(FileExistsError):
            clean_setup.extract_source(data, destination)

    def test_child_environment_omits_provider_keys_gates_and_user_config(self):
        with patch.dict(os.environ, {"PATH": "tool-path", "SystemRoot": "system", "NEBIUS_API_KEY": "private",
            "DATABASE_URL": "private-database", "HUBSPOT_REFRESH_WORKER_ENABLED": "true", "PIP_INDEX_URL": "private-registry",
            "PYTHONPATH": "foreign", "NODE_OPTIONS": "--require=foreign", "GIT_CONFIG_GLOBAL": "foreign"}, clear=True):
            environment = clean_setup.clean_environment(self.root)
        self.assertEqual(environment["PATH"], "tool-path")
        self.assertEqual(environment["SYSTEMROOT"], "system")
        self.assertEqual(environment["HOME"], str(self.root))
        self.assertEqual(environment["npm_config_userconfig"], str(self.root / "npmrc"))
        for name in ("NEBIUS_API_KEY", "DATABASE_URL", "HUBSPOT_REFRESH_WORKER_ENABLED", "PIP_INDEX_URL", "PYTHONPATH", "NODE_OPTIONS", "GIT_CONFIG_GLOBAL"):
            self.assertNotIn(name, environment)

    def test_command_failure_keeps_result_and_exclusive_log_without_shell(self):
        report = {"steps": []}
        with patch.object(clean_setup.subprocess, "run", return_value=SimpleNamespace(returncode=7)) as runner, \
                self.assertRaisesRegex(clean_setup.CheckFailed, "web_build"):
            clean_setup.run_step("web_build", ["node", "fixed-script.js"], self.root, {}, self.root, report)
        self.assertEqual(report["steps"][0]["returncode"], 7)
        self.assertEqual(report["steps"][0]["command"], ["node", "fixed-script.js"])
        self.assertEqual(runner.call_args.kwargs.get("shell", False), False)
        self.assertTrue((self.root / "web_build.log").exists())
        with self.assertRaises(clean_setup.CheckFailed):
            clean_setup.run_step("web_build", ["unused"], self.root, {}, self.root, report)

    def test_destinations_inside_repository_ancestors_and_existing_paths_deny(self):
        repo = self.root / "repo"
        repo.mkdir()
        for destination in (repo / "output", self.root, repo):
            with self.assertRaises(clean_setup.CheckFailed):
                clean_setup.check(destination, root=repo)
        occupied = self.root / "occupied"
        occupied.mkdir()
        with self.assertRaises(FileExistsError):
            clean_setup.check(occupied, root=repo)
        self.assertEqual(list(occupied.iterdir()), [])

    def test_export_uses_only_exact_committed_revision_and_keeps_failure_report(self):
        repo = self.root / "repo"
        repo.mkdir()
        output = self.root / "check"
        revision = "a" * 40
        def command(args, **kwargs):
            if args[1:3] == ["rev-parse", "HEAD"]:
                return SimpleNamespace(stdout=(revision + "\n").encode())
            if args[1:3] == ["archive", "--format=zip"]:
                self.assertEqual(args[-1], revision)
                return SimpleNamespace(stdout=archive([("package.json", "{}")]))
            raise AssertionError("Unexpected command")
        with patch.object(clean_setup.subprocess, "run", side_effect=command), patch.object(clean_setup.shutil, "which", return_value=None), \
                self.assertRaisesRegex(clean_setup.CheckFailed, "node_runtime"):
            clean_setup.check(output, root=repo)
        report = json.loads((output / "result.json").read_text())
        self.assertEqual(report["revision"], revision)
        self.assertEqual(report["status"], "failed")
        self.assertEqual(report["failed_step"], "node_runtime")
        self.assertEqual(report["source_files"], 1)
        self.assertIsNotNone(report["finished_at"])

    def test_dangling_output_symlink_is_rejected_without_creating_its_target(self):
        repo = self.root / "repo"
        repo.mkdir()
        target = self.root / "absent-target"
        link = self.root / "existing-link"
        try:
            link.symlink_to(target, target_is_directory=True)
        except OSError as error:
            self.skipTest(f"Native symlink unavailable: {type(error).__name__}")
        with self.assertRaises(FileExistsError):
            clean_setup.check(link, root=repo)
        self.assertTrue(link.is_symlink())
        self.assertFalse(target.exists())

    def test_timeout_is_a_named_failure_without_exception_details(self):
        report = {"steps": []}
        with patch.object(clean_setup.subprocess, "run", side_effect=subprocess.TimeoutExpired("private-command-value", 1)), \
                self.assertRaises(clean_setup.CheckFailed) as raised:
            clean_setup.run_step("python_dependencies", ["python"], self.root, {}, self.root, report)
        self.assertEqual(str(raised.exception), "python_dependencies")
        self.assertIsNone(report["steps"][0]["returncode"])

    def test_actual_smoke_reconstructs_synthetic_app_without_network_or_original_storage(self):
        result = subprocess.run([sys.executable, "-c", clean_setup.SMOKE, str(self.root / "runtime.sqlite")],
            cwd=SCRIPT.parents[1] / "services/api", env=clean_setup.clean_environment(self.root),
            capture_output=True, text=True, timeout=120, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        measured = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertTrue(measured["restart_preserved"])
        self.assertEqual(measured["mode"], "isolated_synthetic_sqlite_http")
        self.assertEqual(measured["table_counts"]["accounts"], 6)
        self.assertEqual(measured["assurance_cases"], 21)
        self.assertNotIn("synthetic-local-password", result.stdout)

    def test_cli_destination_failure_does_not_echo_private_path(self):
        destination = SCRIPT.parents[1] / "private-path-not-created"
        result = subprocess.run([sys.executable, str(SCRIPT), "--output", str(destination)],
            capture_output=True, text=True, timeout=30, check=False)
        self.assertEqual(result.returncode, 2)
        self.assertNotIn(str(destination), result.stderr)
        self.assertFalse(destination.exists())


if __name__ == "__main__":
    unittest.main()
