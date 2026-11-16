"""Real isolated child processes and local HTTP probes; no deployed-service proof."""
import contextlib
import importlib.util
import io
import os
import subprocess
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("hosted_launch", ROOT / "deploy/hosted/launch.py")
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)


class HostedRuntimeTests(unittest.TestCase):
    def environment(self, **changes):
        return {"AUTH_MODE": "session", "SESSION_COOKIE_SECURE": "true", "WEB_ORIGIN": "https://vitaai.example",
                "VITAAI_WEB_ORIGIN": "https://vitaai.example", "PORT": "10000",
                "DATABASE_URL": "postgresql://fixture:private@db.example/vitaai", **changes}

    def test_configuration_rejects_ephemeral_storage_insecure_or_crossed_origins_and_ports(self):
        result, port = runtime.configuration(self.environment())
        self.assertEqual(port, 10000)
        self.assertTrue(result["DATABASE_URL"].startswith("postgresql+psycopg://"))
        self.assertIn("sslmode=require", result["DATABASE_URL"])
        for changes in ({"DATABASE_URL": "sqlite:///ephemeral.db"}, {"DATABASE_URL": ""},
                        {"DATABASE_URL": "postgresql://db.example/vitaai?sslmode=disable"},
                        {"WEB_ORIGIN": ""}, {"VITAAI_WEB_ORIGIN": "https://foreign.example"},
                        {"AUTH_MODE": "sample"}, {"SESSION_COOKIE_SECURE": "false"},
                        {"PORT": "8000"}, {"PORT": "0"}, {"PORT": "65536"}, {"PORT": "bad"}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                runtime.configuration(self.environment(**changes))

    def test_web_environment_excludes_api_credentials_and_provider_worker_gates(self):
        environment = self.environment(NEBIUS_API_KEY="private", HUBSPOT_ACCESS_TOKEN="private",
                                       HUBSPOT_REFRESH_WORKER_ENABLED="true", MICROSOFT_CLIENT_SECRET="private")
        web = runtime.web_environment(environment)
        self.assertEqual(web["VITAAI_WEB_ORIGIN"], environment["WEB_ORIGIN"])
        self.assertEqual(set(web) & set(environment), {"VITAAI_WEB_ORIGIN", "PORT"})
        self.assertNotIn("private", str(web))

    def test_invalid_configuration_cli_omits_private_url_without_starting_children(self):
        result = subprocess.run([sys.executable, str(ROOT / "deploy/hosted/launch.py"), "--check"],
                                env={**os.environ, **self.environment(DATABASE_URL="private-unparseable-value")},
                                capture_output=True, text=True, timeout=10, check=False)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr.strip(), "Invalid hosted configuration")

    def test_actual_http_probe_requires_200_preserves_host_and_never_follows_redirect(self):
        requests = []

        class Handler(BaseHTTPRequestHandler):
            status = 200

            def do_GET(self):
                requests.append((self.path, self.headers["Host"]))
                self.send_response(self.status)
                if self.status == 302:
                    self.send_header("Location", "/redirected")
                self.end_headers()

            def log_message(self, *_args):
                pass

        with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                for status in (200, 401, 503, 302):
                    Handler.status = status
                    self.assertEqual(runtime.http_ready(f"http://127.0.0.1:{server.server_port}/probe",
                                                        "vitaai.example"), status == 200)
                self.assertEqual(requests, [("/probe", "vitaai.example")] * 4)
            finally:
                server.shutdown()
                worker.join(timeout=5)
        self.assertFalse(runtime.http_ready(f"http://127.0.0.1:{server.server_port}/probe", "vitaai.example"))

    def run_children(self, api_code, web_code, *, ready=lambda: True, timeout=2, stop=None):
        children = []
        original = subprocess.Popen

        def spawn(*args, **kwargs):
            child = original(*args, **kwargs, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            children.append(child)
            return child

        with patch.object(runtime.subprocess, "Popen", side_effect=spawn):
            result = runtime.supervise([sys.executable, "-c", api_code], [sys.executable, "-c", web_code],
                                       dict(os.environ), dict(os.environ), stop or threading.Event(),
                                       ready=ready, startup_timeout=timeout)
        self.assertTrue(children)
        self.assertTrue(all(child.poll() is not None for child in children), "Every owned child must be reaped")
        return result, len(children)

    def test_api_exit_and_readiness_timeout_never_start_web(self):
        for code in ("raise SystemExit(7)", "import time; time.sleep(30)"):
            with self.subTest(code=code):
                result, count = self.run_children(code, "raise SystemExit(0)", ready=lambda: False, timeout=.3)
                self.assertNotEqual(result, 0)
                self.assertEqual(count, 1)

    def test_web_exit_stops_and_reaps_api_even_when_child_exits_zero(self):
        for status in (0, 9):
            with self.subTest(status=status):
                result, count = self.run_children("import time; time.sleep(30)", f"raise SystemExit({status})")
                self.assertNotEqual(result, 0)
                self.assertEqual(count, 2)

    def test_api_exit_after_readiness_stops_and_reaps_web(self):
        result, count = self.run_children("import time; time.sleep(.5); raise SystemExit(8)",
                                         "import time; time.sleep(30)")
        self.assertNotEqual(result, 0)
        self.assertEqual(count, 2)

    def test_requested_stop_terminates_both_children(self):
        stop = threading.Event()
        timer = threading.Timer(.5, stop.set)
        timer.start()
        try:
            result, count = self.run_children("import time; time.sleep(30)", "import time; time.sleep(30)", stop=stop)
            self.assertEqual((result, count), (0, 2))
        finally:
            timer.cancel()

    def test_recipe_keeps_secrets_out_of_build_and_api_off_public_interface(self):
        source = (ROOT / "deploy/hosted/Dockerfile").read_text()
        self.assertIn("USER 10001:10001", source)
        self.assertIn("COPY LICENSE /opt/vitaai/LICENSE", source)
        self.assertNotIn("ARG ", source)
        self.assertNotIn("COPY . ", source)
        self.assertIn("!deploy/hosted/launch.py", (ROOT / ".dockerignore").read_text())
        self.assertIn("--check", source)


class HostedPreflightTests(unittest.TestCase):
    environment = HostedRuntimeTests.environment

    def preflight(self):
        spec = importlib.util.spec_from_file_location("hosted_preflight", ROOT / "deploy/hosted/preflight.py")
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"launch": runtime}):
            spec.loader.exec_module(module)
        return module

    def test_empty_database_uses_read_only_inspection_then_executes_normal_launcher(self):
        module = self.preflight()
        engine = MagicMock()
        connection = engine.connect.return_value.__enter__.return_value
        connection.execute.return_value.scalar_one.return_value = 0
        with patch.dict(os.environ, self.environment(), clear=True), \
                patch.object(module, "create_engine", return_value=engine) as create, \
                patch.object(module.os, "execve") as execute, contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(module.main(), 0)
        self.assertEqual([str(call.args[0]) for call in connection.execute.call_args_list], [
            "SET TRANSACTION READ ONLY",
            "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')",
        ])
        self.assertIn("sslmode=require", create.call_args.args[0])
        engine.dispose.assert_called_once()
        self.assertEqual(execute.call_args.args[:2], (sys.executable, [sys.executable,
                         str(ROOT / "deploy/hosted/launch.py")]))
        self.assertIn("postgresql+psycopg://", execute.call_args.args[2]["DATABASE_URL"])
        self.assertEqual(output.getvalue().strip(), "VITAAI_PREFLIGHT_NON_SYSTEM_TABLES=0")

    def test_nonempty_database_never_starts_or_initializes_application(self):
        module = self.preflight()
        for count in (1, 49):
            engine = MagicMock()
            engine.connect.return_value.__enter__.return_value.execute.return_value.scalar_one.return_value = count
            with self.subTest(count=count), patch.dict(os.environ, self.environment(), clear=True), \
                    patch.object(module, "create_engine", return_value=engine), \
                    patch.object(module.os, "execve") as execute, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(module.main(), 1)
                execute.assert_not_called()
                engine.dispose.assert_called_once()

    def test_storage_failure_omits_private_details_and_never_executes_launcher(self):
        module = self.preflight()
        engine = MagicMock()
        engine.connect.side_effect = RuntimeError("private-database-url")
        with patch.dict(os.environ, self.environment(), clear=True), \
                patch.object(module, "create_engine", return_value=engine), \
                patch.object(module.os, "execve") as execute, contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(module.main(), 1)
            execute.assert_not_called()
        self.assertEqual(output.getvalue().strip(), "VITAAI_PREFLIGHT_FAILED")
        engine.dispose.assert_called_once()

    def test_invalid_configuration_denies_before_database_access(self):
        module = self.preflight()
        with patch.dict(os.environ, self.environment(DATABASE_URL="private-invalid-url"), clear=True), \
                patch.object(module, "create_engine") as create, \
                patch.object(module.os, "execve") as execute, contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(module.main(), 1)
            create.assert_not_called()
            execute.assert_not_called()
        self.assertEqual(output.getvalue().strip(), "VITAAI_PREFLIGHT_FAILED")
