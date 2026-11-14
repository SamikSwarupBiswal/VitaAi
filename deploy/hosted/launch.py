"""Supervise one hosted web/API pair; credentials and provisioning stay external."""
import os
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

from sqlalchemy.engine import make_url
from sqlalchemy.exc import ArgumentError
from vita_api.config import Settings

ROOT = Path(__file__).resolve().parents[2]


def configuration(environment):
    value = environment.get("DATABASE_URL", "")
    if value.startswith("postgres://"):
        value = "postgresql://" + value[len("postgres://"):]
    try:
        url = make_url(value)
    except ArgumentError:
        raise ValueError("Invalid hosted database URL") from None
    if url.drivername == "postgresql":
        url = url.set(drivername="postgresql+psycopg")
    if url.drivername != "postgresql+psycopg" or not url.host or not url.database:
        raise ValueError("Hosted storage requires PostgreSQL")
    if url.query.get("sslmode", "require") not in {"require", "verify-ca", "verify-full"}:
        raise ValueError("Hosted storage requires TLS")
    url = url.update_query_dict({"sslmode": url.query.get("sslmode", "require")})
    settings = Settings(_env_file=None, database_url=url.render_as_string(hide_password=False),
                        auth_mode=environment.get("AUTH_MODE", "sample"),
                        session_cookie_secure=environment.get("SESSION_COOKIE_SECURE", "false"),
                        web_origin=environment.get("WEB_ORIGIN", ""))
    if not settings.web_origin or environment.get("VITAAI_WEB_ORIGIN") != settings.web_origin:
        raise ValueError("Hosted web and API origins must match")
    port = environment.get("PORT", "10000")
    if not re.fullmatch(r"[1-9][0-9]{3,4}", port) or not 1024 <= int(port) <= 65535 or int(port) == 8000:
        raise ValueError("Invalid hosted web port")
    return {**environment, "DATABASE_URL": settings.database_url}, int(port)


def web_environment(environment):
    # Only the API child receives database/provider credentials and write/worker gates.
    return {**{name: environment[name] for name in ("PATH", "SYSTEMROOT", "VITAAI_WEB_ORIGIN", "PORT")
               if name in environment}, "NODE_ENV": "production", "NEXT_TELEMETRY_DISABLED": "1"}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def http_ready(url, host=None):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    request = urllib.request.Request(url, headers={"Host": host} if host else {})
    try:
        with opener.open(request, timeout=2) as response:
            return response.status == 200
    except (urllib.error.URLError, OSError, TimeoutError):
        return False


def api_ready():
    return http_ready("http://127.0.0.1:8000/health/ready")


def supervise(api_command, web_command, api_environment, web_environment, stop, *,
              ready=api_ready, startup_timeout=90):
    children = []
    try:
        api = subprocess.Popen(api_command, cwd=ROOT / "services/api", env=api_environment)
        children.append(api)
        deadline = time.monotonic() + startup_timeout
        while not stop.is_set():
            if api.poll() is not None or time.monotonic() >= deadline:
                print("Hosted API failed readiness", file=sys.stderr, flush=True)
                return 1
            if ready():
                break
            stop.wait(.2)
        if stop.is_set():
            return 0
        children.append(subprocess.Popen(web_command, cwd=ROOT / "apps/web", env=web_environment))
        while not stop.wait(.2):
            if any(child.poll() is not None for child in children):
                print("Hosted child exited unexpectedly", file=sys.stderr, flush=True)
                return 1
        return 0
    finally:
        for child in children:
            if child.poll() is None:
                child.terminate()
        for child in children:
            try:
                child.wait(timeout=15)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()


def main():
    try:
        environment, port = configuration(dict(os.environ))
    except (ValueError, TypeError):
        print("Invalid hosted configuration", file=sys.stderr)
        return 1
    if sys.argv[1:] == ["--check"]:
        return 0 if api_ready() and http_ready(f"http://127.0.0.1:{port}/api/auth/session",
                                               urlsplit(environment["WEB_ORIGIN"]).hostname) else 1
    if sys.argv[1:]:
        return 1
    stop = threading.Event()
    for event in (signal.SIGTERM, signal.SIGINT):
        signal.signal(event, lambda *_: stop.set())
    api = [sys.executable, "-m", "uvicorn", "vita_api.app:app", "--host", "127.0.0.1", "--port", "8000",
           "--no-proxy-headers"]
    web = ["node", str(ROOT / "node_modules/next/dist/bin/next"), "start", "--hostname", "0.0.0.0", "--port", str(port)]
    try:
        return supervise(api, web, environment, web_environment(environment), stop)
    except OSError:
        print("Hosted child could not start", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
