"""Verify committed source in a new external environment; never publishes or deploys."""
import argparse
import io
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import zipfile
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
MAXIMUM_ARCHIVE = 100_000_000
MAXIMUM_FILES = 20_000
FORBIDDEN_PARTS = {".git", ".venv", "venv", "node_modules", ".next", ".local", "__pycache__", "logs", "dumps"}
FORBIDDEN_SUFFIXES = {".md", ".db", ".sqlite", ".sqlite3", ".log", ".pyc", ".tsbuildinfo", ".key", ".pem", ".pfx", ".p12", ".bundle"}
OS_KEYS = {"PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL",
           "PROGRAMFILES", "PROGRAMFILES(X86)", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS"}
LIMITS = [
    "Local fresh-source/dependency/build and isolated SQLite HTTP evidence only; no browser or hosted acceptance.",
    "Dependency installation may access package registries. Smoke requests deny provider transports and use synthetic records.",
    "Export filtering excludes named private/runtime paths; it is not an independent content-secret or license audit.",
    "The exported commit is tested; uncommitted checkout changes and Git history are not exported.",
]


class CheckFailed(Exception):
    """Only a fixed step name is safe for user-facing errors."""


def timestamp():
    return datetime.now(UTC).isoformat()


def clean_environment(home: Path):
    result = {key.upper(): value for key, value in os.environ.items() if key.upper() in OS_KEYS}
    result.update({"HOME": str(home), "USERPROFILE": str(home), "APPDATA": str(home / "appdata"),
        "LOCALAPPDATA": str(home / "localappdata"), "CI": "1", "NEXT_TELEMETRY_DISABLED": "1",
        "PYTHONNOUSERSITE": "1", "PYTHONUTF8": "1", "npm_config_userconfig": str(home / "npmrc"),
        "npm_config_globalconfig": str(home / "global-npmrc"), "npm_config_cache": str(home / "npm-cache")})
    return result


def validate_member(info: zipfile.ZipInfo):
    name = info.filename
    parts = PurePosixPath(name).parts
    mode = stat.S_IFMT(info.external_attr >> 16)
    raw_parts = name[:-1].split("/") if name.endswith("/") else name.split("/")
    if (name != info.orig_filename or not name or "\\" in name or name.startswith("/") or not parts or ".." in parts
            or any(part in {"", ".", ".."} for part in raw_parts)
            or any(part in {"", "."} or ":" in part or part.endswith((" ", ".")) for part in parts)
            or any(part.casefold() in FORBIDDEN_PARTS for part in parts)
            or any(re.fullmatch(r"(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", part, re.IGNORECASE) for part in parts)
            or mode not in {0, stat.S_IFREG, stat.S_IFDIR}):
        raise CheckFailed("source_export")
    leaf = parts[-1].casefold()
    if (PurePosixPath(leaf).suffix in FORBIDDEN_SUFFIXES
            or leaf.endswith((".db-wal", ".db-shm", ".sqlite-wal", ".sqlite-shm", ".sqlite3-wal", ".sqlite3-shm"))
            or (leaf.startswith(".env") and leaf != ".env.example")
            or leaf in {".npmrc", ".pypirc", ".netrc", "npmrc", "credentials"}):
        raise CheckFailed("source_export")
    return name.casefold().rstrip("/")


def extract_source(data: bytes, source: Path):
    if len(data) > MAXIMUM_ARCHIVE:
        raise CheckFailed("source_export")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        members = archive.infolist()
        if not members or len(members) > MAXIMUM_FILES or sum(item.file_size for item in members) > MAXIMUM_ARCHIVE:
            raise CheckFailed("source_export")
        seen = set()
        for info in members:
            key = validate_member(info)
            if key in seen:
                raise CheckFailed("source_export")
            seen.add(key)
        source.mkdir()
        for info in members:
            destination = source.joinpath(*PurePosixPath(info.filename).parts)
            if info.is_dir():
                destination.mkdir(parents=True, exist_ok=True)
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(info) as incoming, destination.open("xb") as output:
                shutil.copyfileobj(incoming, output)
    return len([item for item in members if not item.is_dir()])


def run_step(name: str, command: list[str], cwd: Path, environment: dict, output: Path, report: dict, *, timeout=1800):
    log_name = name + ".log"
    entry = {"name": name, "command": command, "returncode": None, "log": log_name}
    report["steps"].append(entry)
    try:
        with (output / log_name).open("xb") as log:
            result = subprocess.run(command, cwd=cwd, env=environment, stdin=subprocess.DEVNULL,
                stdout=log, stderr=subprocess.STDOUT, timeout=timeout, check=False)
        entry["returncode"] = result.returncode
    except (OSError, subprocess.TimeoutExpired) as error:
        raise CheckFailed(name) from error
    if result.returncode:
        raise CheckFailed(name)
    return (output / log_name).read_text(encoding="utf-8", errors="replace")


SMOKE = r'''
import hashlib,json,socket,sys
from pathlib import Path
from unittest.mock import patch
from fastapi.testclient import TestClient
from sqlalchemy import MetaData,select
from vita_api.app import create_app
from vita_api.config import Settings
from vita_api.identity import Identity
from vita_api.sample import SAMPLE_ORG

class NoInference:
    def analyze(self,*args,**kwargs): raise AssertionError("Provider unavailable in clean setup smoke")
    draft=analyze
    plan=analyze

database=Path(sys.argv[1])
settings=Settings(_env_file=None,database_url="sqlite:///"+database.as_posix(),auth_mode="session")
def application(): return create_app(settings,NoInference())
def snapshot(store):
    metadata=MetaData(); metadata.reflect(store.engine)
    with store.engine.connect() as connection:
        rows={table.name:[dict(row) for row in connection.execute(select(table).order_by(*table.primary_key.columns)).mappings()] for table in metadata.sorted_tables}
    data=json.dumps(rows,sort_keys=True,separators=(",",":"),default=str).encode()
    return hashlib.sha256(data).hexdigest(),{name:len(values) for name,values in rows.items()}
app=application()
with TestClient(app) as client:
    Identity(app.state.store.engine).create_user("clean-setup-viewer","synthetic-local-password",SAMPLE_ORG,"viewer")
    with patch.object(socket.socket,"connect",side_effect=AssertionError("Smoke cannot connect to a provider")):
        response=client.post("/api/auth/login",headers={"X-VitaAi-Request":"1"},json={"username":"clean-setup-viewer","password":"synthetic-local-password"})
        assert response.status_code==200
        token=client.cookies.get("vitaai_session")
        portfolio=client.get("/api/portfolio"); assert portfolio.status_code==200
        assert len(portfolio.json()["accounts"])==6
        route="/health/ready" if "/health/ready" in app.openapi()["paths"] else "/health"
        assert client.get(route).status_code==200
        assurance=client.get("/api/assurance/guardrails"); assert assurance.status_code==200
        assert assurance.json()["report"]["evidence_tier"]=="synthetic"
        before,counts=snapshot(app.state.store)
other=application()
with TestClient(other) as client:
    client.cookies.set("vitaai_session",token)
    with patch.object(socket.socket,"connect",side_effect=AssertionError("Smoke cannot connect to a provider")):
        assert client.get("/api/auth/session").json()["actor"]["role"]=="viewer"
        assert client.get("/api/portfolio").json()==portfolio.json()
        assert client.get(route).status_code==200
        after,after_counts=snapshot(other.state.store)
        assert before==after and counts==after_counts
print(json.dumps({"mode":"isolated_synthetic_sqlite_http","restart_preserved":True,"database_sha256":after,"table_counts":counts,"health_route":route,"assurance_cases":assurance.json()["report"]["total_cases"]}))
'''


def check(output: Path, *, root: Path = ROOT):
    root = root.resolve(strict=True)
    resolved_output = output.resolve()
    if resolved_output.is_relative_to(root) or root.is_relative_to(resolved_output) or not resolved_output.parent.is_dir():
        raise CheckFailed("destination")
    try:
        output.lstat()
    except FileNotFoundError:
        pass
    else:
        raise FileExistsError("Destination must be new")
    output = resolved_output
    # mkdir without exist_ok rejects an existing file, directory or symlink.
    output.mkdir()
    report = {"schema_version": "1", "started_at": timestamp(), "finished_at": None, "status": "failed",
        "revision": None, "evidence_tier": "local_fresh_source", "steps": [], "limits": LIMITS}
    try:
        home = output / "tool-home"
        home.mkdir()
        for name in ("npmrc", "global-npmrc"):
            (home / name).write_text("", encoding="utf-8")
        environment = clean_environment(home)
        revision = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, env=environment,
            capture_output=True, timeout=30, check=True).stdout.decode("ascii").strip()
        if not re.fullmatch(r"[a-f0-9]{40}", revision):
            raise CheckFailed("source_export")
        report["revision"] = revision
        archive = subprocess.run(["git", "archive", "--format=zip", revision], cwd=root, env=environment,
            capture_output=True, timeout=60, check=True).stdout
        report["source_files"] = extract_source(archive, output / "source")
        source = output / "source"
        report["python"] = sys.version.split()[0]
        node = shutil.which("node")
        npm = shutil.which("npm")
        if not node or not npm:
            raise CheckFailed("node_runtime")
        npm_cli = Path(npm).resolve().parent / "node_modules" / "npm" / "bin" / "npm-cli.js"
        npm_command = [node, str(npm_cli)] if npm_cli.is_file() else [npm]
        report["node"] = run_step("node_version", [node, "--version"], source, environment, output, report).strip()
        run_step("python_environment", [sys.executable, "-m", "venv", str(output / "python")], source, environment, output, report)
        python = output / "python" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        run_step("python_dependencies", [str(python), "-m", "pip", "--isolated", "install", "--disable-pip-version-check", "--no-input",
            "--index-url", "https://pypi.org/simple", "-r", str(source / "services/api/requirements.txt")], source, environment, output, report)
        run_step("web_dependencies", [*npm_command, "ci", "--no-audit", "--no-fund"], source, environment, output, report)
        run_step("web_build", [*npm_command, "run", "build"], source, environment, output, report)
        api = source / "services/api"
        run_step("assurance_check", [str(python), "-m", "vita_api.guardrail_evaluation", "--check"], api, environment, output, report, timeout=120)
        smoke = run_step("api_restart_smoke", [str(python), "-c", SMOKE, str(output / "runtime.sqlite")], api, environment, output, report, timeout=120)
        report["smoke"] = json.loads(smoke.strip().splitlines()[-1])
        report["status"] = "passed"
        return report
    except (OSError, ValueError, subprocess.SubprocessError, zipfile.BadZipFile, CheckFailed) as error:
        report["failed_step"] = str(error) if isinstance(error, CheckFailed) else "setup_unavailable"
        raise CheckFailed(report["failed_step"]) from None
    finally:
        report["finished_at"] = timestamp()
        with (output / "result.json").open("x", encoding="utf-8") as stream:
            json.dump(report, stream, indent=2)
            stream.write("\n")


def main():
    parser = argparse.ArgumentParser(description="Check committed VitaAi source in a new isolated external environment")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        check(args.output)
    except (OSError, ValueError, CheckFailed):
        parser.exit(2, "Clean setup failed; inspect the external result and logs locally.\n")
    print("Clean committed-source setup checks passed. External report records scope and limitations.")


if __name__ == "__main__":
    main()
