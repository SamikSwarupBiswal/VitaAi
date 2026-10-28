"""Offline installed dependency declarations; never a license-compatibility verdict."""
import argparse
import importlib.metadata
import ipaddress
import json
import platform
import re
from collections import defaultdict
from datetime import UTC, datetime
from email.parser import Parser
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[1]
MAXIMUM_PACKAGES = 5000
MAXIMUM_BYTES = 2_000_000
MAXIMUM_DEPTH = 32
MAXIMUM_REPORT = 25_000_000
LIMITS = (
    "Declared installed metadata only; package license texts and source attribution are not bundled or independently verified.",
    "Missing or conflicting declarations require review; no legal compatibility, project-license choice or release pass is inferred.",
    "The current Python environment and installed web package roots are measured; optional/uninstalled packages are outside this inventory.",
    "No package code, installer, network request, provider or business database is invoked.",
)


class InventoryError(ValueError):
    """A fixed safe failure, without copied package values or filesystem paths."""


def scalar(value, maximum=200):
    return isinstance(value, str) and 0 < len(value.strip()) <= maximum and not any(ord(char) < 32 for char in value)


def public_link(value):
    if not isinstance(value, str) or len(value) > 2048:
        return None
    value = value.removeprefix("git+")
    try:
        parsed = urlsplit(value)
        host = parsed.hostname or ""
        if (parsed.scheme != "https" or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.port not in {None, 443} or any(ord(char) < 33 for char in value)
                or not re.fullmatch(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}", host)
                or host.endswith((".local", ".internal", ".test", ".localhost"))):
            return None
        try:
            ipaddress.ip_address(host)
            return None
        except ValueError:
            return urlunsplit(("https", host, parsed.path, "", ""))
    except ValueError:
        return None


def declarations(values):
    result = sorted({value.strip() for value in values if scalar(value)
        and not re.search(r"[A-Za-z]:[\\/]|/(?:Users|home|tmp)/", value)})
    if len(result) > 32:
        raise InventoryError("Declaration bound exceeded")
    return result


def record(ecosystem, name, version, licenses, links):
    if (not scalar(name) or not re.fullmatch(r"[@A-Za-z0-9][@A-Za-z0-9._/+!-]*", name)
            or not scalar(version) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+!-]*", version)):
        raise InventoryError("Invalid package identity")
    declared = declarations(licenses)
    source_links = sorted({link for value in links if (link := public_link(value))})
    if len(source_links) > 32:
        raise InventoryError("Link bound exceeded")
    return {"ecosystem": ecosystem, "name": name, "version": version, "declared_licenses": declared,
        "license_status": "multiple_declarations" if len(declared) > 1 else "declared" if declared else "missing", "source_links": source_links}


def python_records(distributions=None):
    records = []
    distributions = importlib.metadata.distributions() if distributions is None else distributions
    for distribution in distributions:
        if len(records) >= MAXIMUM_PACKAGES:
            raise InventoryError("Package bound exceeded")
        raw = distribution.read_text("METADATA") or distribution.read_text("PKG-INFO")
        if not isinstance(raw, str) or len(raw.encode("utf-8")) > MAXIMUM_BYTES:
            raise InventoryError("Metadata unavailable or oversized")
        metadata = Parser().parsestr(raw, headersonly=True)
        licenses = [metadata.get("License-Expression"), metadata.get("License")]
        licenses.extend(value for value in metadata.get_all("Classifier", []) if value.startswith("License ::"))
        links = [metadata.get("Home-page")]
        links.extend(value.partition(",")[2].strip() for value in metadata.get_all("Project-URL", []))
        records.append(record("python", metadata.get("Name"), metadata.get("Version"), licenses, links))
    return records


def unique_fields(pairs):
    result = dict(pairs)
    if len(result) != len(pairs):
        raise InventoryError("Duplicate metadata fields")
    return result


def read_package(path, root):
    resolved = path.resolve(strict=True)
    if not resolved.is_relative_to(root) or not resolved.is_file():
        raise InventoryError("Package path outside workspace")
    with resolved.open("rb") as stream:
        raw = stream.read(MAXIMUM_BYTES + 1)
    if len(raw) > MAXIMUM_BYTES:
        raise InventoryError("Metadata bound exceeded")
    value = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_fields,
        parse_constant=lambda _: (_ for _ in ()).throw(InventoryError("Non-finite metadata")))
    if not isinstance(value, dict):
        raise InventoryError("Invalid package metadata")
    return value


def web_records(root=ROOT):
    root = root.resolve(strict=True)
    pending = [(root / "node_modules", 0)]
    visited = set()
    records = []
    scanned = excluded = 0
    while pending:
        modules, depth = pending.pop()
        if depth > MAXIMUM_DEPTH:
            raise InventoryError("Package depth exceeded")
        resolved = modules.resolve(strict=True)
        if not resolved.is_relative_to(root) or not resolved.is_dir():
            raise InventoryError("Modules path outside workspace")
        if resolved in visited:
            continue
        visited.add(resolved)
        children = list(resolved.iterdir())
        if len(children) > MAXIMUM_PACKAGES:
            raise InventoryError("Modules bound exceeded")
        packages = []
        for child in sorted(children):
            if child.name.startswith("."):
                continue
            canonical = child.resolve(strict=True)
            if not canonical.is_relative_to(root):
                raise InventoryError("Package path outside workspace")
            if not canonical.is_dir():
                continue
            if child.name.startswith("@"):
                scoped = list(canonical.iterdir())
                if len(scoped) > MAXIMUM_PACKAGES:
                    raise InventoryError("Scope bound exceeded")
                packages.extend(sorted(scoped))
            else:
                packages.append(child)
        for package in packages:
            canonical = package.resolve(strict=True)
            if not canonical.is_relative_to(root) or not canonical.is_dir():
                raise InventoryError("Package path outside workspace")
            scanned += 1
            if scanned > MAXIMUM_PACKAGES:
                raise InventoryError("Package bound exceeded")
            metadata = read_package(canonical / "package.json", root)
            repository = metadata.get("repository")
            links = [metadata.get("homepage"), repository.get("url") if isinstance(repository, dict) else repository]
            license_value = metadata.get("license")
            legacy = metadata.get("licenses", [])
            licenses = [license_value.get("type") if isinstance(license_value, dict) else license_value]
            if isinstance(legacy, list):
                licenses.extend(item.get("type") if isinstance(item, dict) else item for item in legacy)
            workspace = canonical.is_relative_to(root / "apps") and metadata.get("private") is True
            if workspace:
                excluded += 1
            else:
                records.append(record("npm", metadata.get("name"), metadata.get("version"), licenses, links))
            nested = canonical / "node_modules"
            if nested.exists() or nested.is_symlink():
                pending.append((nested, depth + 1))
    return records, excluded


def summarize(records):
    grouped = {}
    licenses = defaultdict(set)
    for value in records:
        key = json.dumps(value, sort_keys=True, separators=(",", ":"))
        if key not in grouped:
            grouped[key] = {**value, "instances": 0}
        grouped[key]["instances"] += 1
        licenses[(value["ecosystem"], value["name"], value["version"])].add(tuple(value["declared_licenses"]))
    conflicts = [{"ecosystem": key[0], "name": key[1], "version": key[2], "declarations": [list(item) for item in sorted(values)]}
        for key, values in sorted(licenses.items()) if len(values) > 1]
    return sorted(grouped.values(), key=lambda value: (value["ecosystem"], value["name"].casefold(), value["version"], json.dumps(value, sort_keys=True))), conflicts


def inventory(root=ROOT, distributions=None):
    web, excluded = web_records(root)
    python = python_records(distributions)
    records, conflicts = summarize([*python, *web])
    return {"schema_version": "1", "generated_at": datetime.now(UTC).isoformat(), "evidence_tier": "installed_metadata",
        "python_version": platform.python_version(), "records": records, "record_count": len(records),
        "installed_instances": sum(value["instances"] for value in records), "workspace_packages_excluded": excluded,
        "missing_license_count": sum(value["license_status"] == "missing" for value in records),
        "conflict_groups": conflicts, "limitations": LIMITS}


def write_inventory(output, root=ROOT, distributions=None):
    if output.exists() or output.is_symlink():
        raise InventoryError("Use a new output file")
    destination = output.resolve()
    if destination.is_relative_to(root.resolve()) or not destination.parent.is_dir():
        raise InventoryError("Use an external output file")
    value = inventory(root, distributions)
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n"
    if len(encoded.encode("utf-8")) > MAXIMUM_REPORT:
        raise InventoryError("Report bound exceeded")
    with destination.open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(encoded)
    return value


def main():
    parser = argparse.ArgumentParser(description="Inventory installed dependency declarations offline; no legal compatibility verdict")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        report = write_inventory(args.output)
    except (OSError, ValueError, TypeError, RecursionError):
        parser.exit(2, "Dependency inventory unavailable; inspect installed metadata and the new external destination locally.\n")
    print(f"Recorded {report['record_count']} metadata records; missing/conflicting declarations remain explicit.")


if __name__ == "__main__":
    main()
