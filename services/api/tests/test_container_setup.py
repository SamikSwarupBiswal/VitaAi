"""Local source invariants and actual probe exits, without Docker execution."""
import json
import subprocess
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
LOCAL = ROOT / "deploy" / "local"


def recipe(name):
    return (LOCAL / name).read_text(encoding="utf-8").replace("\\\n", " ")


def command(source, instruction):
    line = next(line for line in source.splitlines() if line.startswith(instruction + " "))
    return json.loads(line[line.index("["):])


class ContainerSetupTests(unittest.TestCase):
    def test_shared_loopback_topology_has_no_api_publication_or_host_state_mount(self):
        config = json.loads((LOCAL / "compose.json").read_text(encoding="utf-8"))
        self.assertEqual(set(config["services"]), {"api", "web"})
        api, web = (config["services"][name] for name in ("api", "web"))
        self.assertEqual(api["ports"], ["127.0.0.1:3000:3000"])
        self.assertNotIn("ports", web)
        self.assertEqual(web["network_mode"], "service:api")
        self.assertEqual(web["depends_on"]["api"]["condition"], "service_healthy")
        self.assertEqual(api["volumes"], ["state:/var/lib/vitaai"])
        self.assertEqual(config["volumes"], {"state": {}})
        for service in (api, web):
            self.assertNotIn("env_file", service)
            self.assertNotIn("privileged", service)
            self.assertNotIn("container_name", service)
            self.assertEqual((LOCAL / service["build"]["context"]).resolve(), ROOT)
            self.assertTrue((ROOT / service["build"]["dockerfile"]).is_file())
        self.assertEqual(api["environment"], {
            "DATABASE_URL": "sqlite:////var/lib/vitaai/vitaai.db", "AUTH_MODE": "session"})
        self.assertNotIn("environment", web)
        self.assertNotIn("${", json.dumps(config))

    def test_context_is_default_deny_with_only_application_source_exceptions(self):
        rules = [line for line in (ROOT / ".dockerignore").read_text().splitlines()
                 if line and not line.startswith("#")]
        self.assertEqual(rules[0], "**")
        for rule in rules[1:]:
            self.assertTrue(rule.startswith("!"))
            path = rule[1:]
            # Directory exceptions also include descendants in Docker's matcher.
            self.assertFalse(path.endswith("/"))
            self.assertNotIn("..", path.split("/"))
            for excluded in (".env", "node_modules", ".next", "tests"):
                self.assertNotIn(excluded, path)
            if not path.endswith("/"):
                self.assertNotIn(path, {"*", "**", "**/*"})
                self.assertIn(Path(path).suffix, {".py", ".ts", ".tsx", ".css", ".json", ".txt", ".pdf"})
                if "*" in path:
                    self.assertIn(Path(path).suffix, {".py", ".ts", ".tsx", ".css"})

    def test_recipes_preserve_runtime_layout_without_build_initialization(self):
        api, web = recipe("api.Dockerfile"), recipe("web.Dockerfile")
        for source in (api, web):
            self.assertNotIn("COPY . ", source)
            self.assertNotIn("COPY .\n", source)
            self.assertNotIn("--reload", source)
            self.assertNotIn("USER root", source)
        api_command = command(api, "CMD")
        self.assertEqual(api_command[api_command.index("--host") + 1], "127.0.0.1")
        self.assertIn("vita_api.app:app", api_command)
        self.assertIn("COPY services/api/migrations ./migrations", api)
        self.assertIn("USER 10001:10001", api)
        for line in api.splitlines():
            if line.startswith("RUN "):
                self.assertNotIn("vita_api", line)
        self.assertNotIn("standalone", web)
        self.assertIn("npm run build", web)
        self.assertIn("npm prune --omit=dev", web)
        self.assertIn("USER node", web)
        self.assertIn("/opt/vitaai/apps/web/.next", web)
        self.assertIn("/opt/vitaai/apps/web/public", web)
        self.assertEqual(command(web, "CMD")[1:3], ["../../node_modules/next/dist/bin/next", "start"])

    def test_source_defined_probe_commands_fail_on_unhealthy_http(self):
        class Handler(BaseHTTPRequestHandler):
            status = 200

            def do_GET(self):
                self.send_response(self.status)
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, *_):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            for name, port, path in (("api.Dockerfile", 8000, "/health/ready"),
                                     ("web.Dockerfile", 3000, "/api/auth/session")):
                probe = command(recipe(name), "HEALTHCHECK")
                self.assertIn(f"http://127.0.0.1:{port}{path}", probe[-1])
                probe[-1] = probe[-1].replace(f"127.0.0.1:{port}", f"127.0.0.1:{server.server_port}")
                if probe[0] == "python":
                    probe[0] = sys.executable
                for status in (200, 401, 502, 503):
                    with self.subTest(recipe=name, status=status):
                        Handler.status = status
                        result = subprocess.run(probe, capture_output=True, timeout=10, check=False)
                        self.assertEqual(result.returncode == 0, status == 200)
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
