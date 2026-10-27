"""Build an original Microsoft app package outside the checkout; makes no network call."""
import argparse
import json
import re
import struct
import sys
import zlib
from pathlib import Path
from urllib.parse import urlsplit
from uuid import UUID
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]


def https(value, *, origin=False):
    parsed = urlsplit(value)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment
            or parsed.port not in {None, 443} or (origin and (parsed.path not in {"", "/"} or parsed.query))):
        raise ValueError("Expected a public HTTPS URL")
    if not re.fullmatch(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}", parsed.hostname):
        raise ValueError("Expected a public hostname")
    return value.rstrip("/") if origin else value


def png(size, outline=False):
    """Original geometric V mark; RGBA PNG with no third-party asset."""
    scan = bytearray()
    for y in range(size):
        scan.append(0)
        for x in range(size):
            nx, ny = x / size, y / size
            mark = .2 < ny < .82 and abs(abs(nx-.5) - (.82-ny)*.48) < .045
            scan.extend((255, 255, 255, 255) if mark else (0, 0, 0, 0) if outline else (24, 57, 47, 255))
    def chunk(name, value):
        return struct.pack(">I", len(value)) + name + value + struct.pack(">I", zlib.crc32(name+value) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(scan)) + chunk(b"IEND", b"")


def openapi(origin, tenant, app_id):
    sys.path.insert(0, str(ROOT / "services/api"))
    from vita_api.config import Settings
    Settings.model_config["env_file"] = None
    from vita_api.app import create_app
    schema = create_app(Settings(_env_file=None)).openapi()
    paths = {path.removeprefix("/api/platform"): {method: value} for path, item in schema["paths"].items() for method, value in item.items()
        if value.get("operationId") in {"platformContext", "platformPreparation"}}
    if len(paths) != 2:
        raise ValueError("Expected exactly two allowlisted platform operations")
    needed = set()
    def references(value):
        if isinstance(value, dict):
            if "$ref" in value:
                name = value["$ref"].removeprefix("#/components/schemas/")
                if name not in needed:
                    needed.add(name)
                    references(schema["components"]["schemas"][name])
            for item in value.values():
                references(item)
        elif isinstance(value, list):
            for item in value:
                references(item)
    references(paths)
    def compatible(value):
        if isinstance(value, dict):
            result = {key: compatible(item) for key, item in value.items() if key not in {"const", "anyOf"}}
            if "const" in value:
                result["enum"] = [value["const"]]
            if "anyOf" in value:
                choices = [item for item in value["anyOf"] if item.get("type") != "null"]
                if len(choices) == 1 and len(choices) != len(value["anyOf"]):
                    result.update(compatible(choices[0])); result["nullable"] = True
                else:
                    result["anyOf"] = compatible(choices)
            return result
        return [compatible(item) for item in value] if isinstance(value, list) else value
    for item in paths.values():
        for operation in item.values():
            operation["security"] = [{"entra": [f"api://{urlsplit(origin).hostname}/{app_id}/access_as_user"]}]
            operation["x-oai-isConsequential"] = False
    return compatible({"openapi": "3.0.3", "info": {"title": "VitaAi delegated context", "version": "1.0.0"},
        "servers": [{"url": origin + "/api/platform-gateway"}], "paths": paths, "components": {
            "schemas": {name: schema["components"]["schemas"][name] for name in sorted(needed)},
            "securitySchemes": {"entra": {"type": "oauth2", "flows": {"authorizationCode": {
                "authorizationUrl": f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize",
                "tokenUrl": f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
                "scopes": {f"api://{urlsplit(origin).hostname}/{app_id}/access_as_user": "Access current mapped VitaAi records"}}}}}}})


def build(destination, app_id, tenant, origin, auth_reference, privacy, terms):
    origin, privacy, terms = https(origin, origin=True), https(privacy), https(terms)
    app_id, tenant = str(UUID(app_id)), str(UUID(tenant))
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,200}", auth_reference):
        raise ValueError("Expected Microsoft auth configuration reference ID")
    destination = Path(destination).resolve()
    if destination.is_relative_to(ROOT) or destination.exists():
        raise ValueError("Choose a new output folder outside the repository")
    substitutions = {"APP_ID": app_id, "WEB_ORIGIN": origin, "WEB_HOST": urlsplit(origin).hostname,
        "AUTH_REFERENCE_ID": auth_reference, "PRIVACY_URL": privacy, "TERMS_URL": terms}
    contents = {}
    for source, output in [("manifest.template.json", "manifest.json"), ("plugin.template.json", "plugin.json"),
                           ("declarative-agent.json", "declarative-agent.json")]:
        text = (ROOT / "deploy/microsoft" / source).read_text(encoding="utf-8")
        for key, value in substitutions.items():
            text = text.replace("${"+key+"}", value)
        if "${" in text:
            raise ValueError("Unresolved manifest substitution")
        contents[output] = json.dumps(json.loads(text), indent=2).encode()
    contents["openapi.json"] = json.dumps(openapi(origin, tenant, app_id), indent=2).encode()
    contents["color.png"], contents["outline.png"] = png(192), png(32, True)
    destination.mkdir(parents=True, exist_ok=False)
    for name, data in contents.items():
        (destination / name).write_bytes(data)
    with ZipFile(destination / "vitaai-microsoft.zip", "x", ZIP_DEFLATED) as archive:
        for name, data in contents.items():
            archive.writestr(name, data)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("output", "app-id", "tenant-id", "web-origin", "auth-reference-id", "privacy-url", "terms-url"):
        parser.add_argument("--"+name, required=True)
    args = parser.parse_args()
    try:
        build(args.output, args.app_id, args.tenant_id, args.web_origin, args.auth_reference_id, args.privacy_url, args.terms_url)
    except (ValueError, OSError):
        raise SystemExit("Package build failed: check values and use a new output folder outside the repository.") from None
    print("Microsoft package created. Configuration and package generation do not establish tenant acceptance.")
