"""Collect installed third-party legal texts offline; no legal/release verdict."""
import argparse
import hashlib
import importlib.metadata
import importlib.util
import json
import re
import stat
from datetime import UTC, datetime
from email.parser import Parser
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("vitaai_inventory", Path(__file__).with_name("license-inventory.py"))
inventory = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(inventory)
MAXIMUM_INSTANCES = 5000
MAXIMUM_FILES = 20000
MAXIMUM_TEXT = 2_000_000
MAXIMUM_TOTAL = 50_000_000
MAXIMUM_ENTRIES = 20000
MAXIMUM_REPORT = 25_000_000
MAXIMUM_DEPTH = 32
LEGAL_NAME = re.compile(r"(?:licen[cs]e|copying|notice)(?:[._-][A-Za-z0-9._-]+)?", re.IGNORECASE)
LIMITS = (
    "Installed package-owned conventional and declared legal text bytes only; discovery is bounded and may be incomplete.",
    "Texts and metadata are untrusted third-party material, not independently verified attribution or legal compatibility.",
    "Optional/uninstalled dependencies, OS/base-image components and bundled vendored subcomponents are not certified complete.",
    "Missing/unreadable/unsupported texts remain explicit; no project-license selection, legal compliance or release pass follows.",
    "No network, package code, installer, provider or business database is invoked; output is a new external directory.",
)


class NoticeError(ValueError):
    """Safe fixed error; do not expose source text, credentials or local paths."""


def relative_name(value):
    if (not isinstance(value, str) or not value or len(value) > 512 or "\\" in value
            or value.startswith("/") or any(ord(char) < 32 for char in value)):
        raise NoticeError("Unsafe text path")
    parts = value.split("/")
    if any(part in {"", ".", ".."} or ":" in part or part.endswith((" ", "."))
           or part.startswith(".") for part in parts):
        raise NoticeError("Unsafe text path")
    return PurePosixPath(value)


def bounded_children(directory):
    entries = []
    for entry in directory.iterdir():
        entries.append(entry)
        if len(entries) > MAXIMUM_ENTRIES:
            raise NoticeError("Directory bound exceeded")
    return sorted(entries)


def reject_links(path, boundary):
    current = boundary
    for part in path.relative_to(boundary).parts:
        current = current / part
        info = current.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
            raise NoticeError("Linked legal text path")


def web_instances(root):
    pending, visited = [(root / "node_modules", 0)], set()
    result, excluded, scanned = [], 0, 0
    while pending:
        modules, depth = pending.pop()
        if depth > MAXIMUM_DEPTH:
            raise NoticeError("Package depth exceeded")
        reject_links(modules, root)
        modules = modules.resolve(strict=True)
        if not modules.is_relative_to(root) or not modules.is_dir():
            raise NoticeError("Unsafe modules path")
        if modules in visited:
            continue
        visited.add(modules)
        packages = []
        for entry in bounded_children(modules):
            if entry.name.startswith("."):
                continue
            canonical = entry.resolve(strict=True)
            if not canonical.is_relative_to(root):
                raise NoticeError("Unsafe package path")
            if canonical.is_dir():
                packages.extend(bounded_children(canonical) if entry.name.startswith("@") else [entry])
        for package in packages:
            canonical = package.resolve(strict=True)
            if not canonical.is_relative_to(root) or not canonical.is_dir():
                raise NoticeError("Unsafe package path")
            scanned += 1
            if scanned > MAXIMUM_INSTANCES:
                raise NoticeError("Package bound exceeded")
            metadata = inventory.read_package(canonical / "package.json", root)
            if canonical.is_relative_to(root / "apps") and metadata.get("private") is True:
                excluded += 1
            else:
                license_value, legacy = metadata.get("license"), metadata.get("licenses", [])
                licenses = [license_value.get("type") if isinstance(license_value, dict) else license_value]
                if isinstance(legacy, list):
                    licenses.extend(item.get("type") if isinstance(item, dict) else item for item in legacy)
                repository = metadata.get("repository")
                record = inventory.record("npm", metadata.get("name"), metadata.get("version"), licenses,
                    [metadata.get("homepage"), repository.get("url") if isinstance(repository, dict) else repository])
                issues, candidates = [], []
                if canonical.is_relative_to(modules):
                    candidates = [(canonical, entry.name) for entry in bounded_children(canonical)
                                  if LEGAL_NAME.fullmatch(entry.name)]
                else:
                    issues.append({"code": "unsupported_workspace_location"})
                result.append((record, candidates, issues, canonical))
            nested = canonical / "node_modules"
            if nested.exists() or nested.is_symlink():
                pending.append((nested, depth + 1))
    return result, excluded


def python_instances(distributions):
    result = []
    for distribution in distributions:
        if len(result) >= MAXIMUM_INSTANCES:
            raise NoticeError("Package bound exceeded")
        record = inventory.python_records([distribution])[0]
        install_root = Path(distribution.locate_file("")).resolve(strict=True)
        if not install_root.is_dir():
            raise NoticeError("Unsupported installation root")
        files = distribution.files
        if files is None:
            result.append((record, [], [{"code": "unsupported_distribution_files"}], install_root))
            continue
        if len(files) > MAXIMUM_ENTRIES:
            raise NoticeError("Distribution file bound exceeded")
        roots = {str(PurePosixPath(str(item)).parent) for item in files
                 if PurePosixPath(str(item)).name in {"METADATA", "PKG-INFO"}
                 and PurePosixPath(str(item)).parent.name.endswith((".dist-info", ".egg-info"))}
        if len(roots) != 1:
            result.append((record, [], [{"code": "unsupported_metadata_location"}], install_root))
            continue
        relative_root = relative_name(roots.pop())
        metadata_path = Path(distribution.locate_file(str(relative_root))).absolute()
        if not metadata_path.is_relative_to(install_root):
            raise NoticeError("Unsafe distribution metadata root")
        reject_links(metadata_path, install_root)
        metadata_root = metadata_path.resolve(strict=True)
        if not metadata_root.is_relative_to(install_root) or not metadata_root.is_dir():
            raise NoticeError("Unsafe distribution metadata root")
        raw = distribution.read_text("METADATA") or distribution.read_text("PKG-INFO")
        declared = Parser().parsestr(raw, headersonly=True).get_all("License-File", [])
        names = set()
        for value in declared:
            path = relative_name(value)
            # Modern wheel declarations are relative to dist-info/licenses.
            modern = metadata_root / "licenses" / str(path)
            if modern.exists() or modern.is_symlink():
                names.add("licenses/" + str(path))
            elif len(path.parts) == 1 and LEGAL_NAME.fullmatch(path.name):
                names.add(str(path))
            else:
                names.add("licenses/" + str(path))
        for item in files:
            path = PurePosixPath(str(item))
            if path.is_relative_to(relative_root):
                tail = path.relative_to(relative_root)
                if ((len(tail.parts) == 1 and LEGAL_NAME.fullmatch(tail.name))
                        or (len(tail.parts) >= 2 and tail.parts[0] == "licenses")):
                    names.add(str(relative_name(str(tail))))
        result.append((record, [(metadata_root, name) for name in sorted(names)], [], install_root))
    return result


def read_text_bytes(base, name):
    relative = relative_name(name)
    path = base / str(relative)
    reject_links(path, base)
    resolved = path.resolve(strict=True)
    if not resolved.is_relative_to(base.resolve()) or not resolved.is_file():
        raise NoticeError("Unsafe legal text")
    with resolved.open("rb") as stream:
        data = stream.read(MAXIMUM_TEXT + 1)
    if len(data) > MAXIMUM_TEXT:
        raise NoticeError("Text bound exceeded")
    if not data:
        return None
    # Preserve bytes verbatim, while rejecting binary/non-text candidates.
    try:
        decoded = data.decode("utf-8-sig")
    except UnicodeError:
        return None
    if "\0" in decoded:
        return None
    return data


def collect(root=ROOT, distributions=None):
    root = root.resolve(strict=True)
    web, excluded = web_instances(root)
    distributions = importlib.metadata.distributions() if distributions is None else distributions
    entries = [*python_instances(distributions), *web]
    if len(entries) > MAXIMUM_INSTANCES:
        raise NoticeError("Package bound exceeded")
    records, blobs, source_roots, total = [], [], {root}, 0
    for index, (record, candidates, issues, source_root) in enumerate(entries, 1):
        instance = f"instance-{index:05d}"
        if source_root is not None:
            source_roots.add(source_root)
        texts = []
        for base, name in candidates:
            if len(blobs) >= MAXIMUM_FILES:
                raise NoticeError("Text count exceeded")
            try:
                data = read_text_bytes(base, name)
            except FileNotFoundError:
                issues.append({"code": "missing_declared_text", "source_name": name})
                continue
            except OSError:
                issues.append({"code": "unreadable_text", "source_name": name})
                continue
            if data is None:
                issues.append({"code": "empty_or_unsupported_text", "source_name": name})
                continue
            total += len(data)
            if total > MAXIMUM_TOTAL:
                raise NoticeError("Bundle byte bound exceeded")
            bundle_path = f"texts/{instance}/{len(texts) + 1:04d}.txt"
            texts.append({"source_name": name, "bundle_path": bundle_path,
                          "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)})
            blobs.append((bundle_path, data))
        if not candidates and not issues:
            issues.append({"code": "no_conventional_text_found"})
        records.append({**record, "instance_id": instance, "texts": texts, "issues": issues,
                        "coverage": "collected" if texts and not issues else "partial" if texts else "unavailable"})
    report = {"schema_version": "1", "generated_at": datetime.now(UTC).isoformat(),
        "evidence_tier": "installed_notice_bytes", "status": "collected_with_gaps" if any(r["issues"] for r in records) else "collected",
        "installed_instances": len(records), "workspace_packages_excluded": excluded, "text_count": len(blobs),
        "text_bytes": total, "instances_with_gaps": sum(bool(r["issues"]) for r in records),
        "records": records, "limitations": LIMITS}
    encoded = json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n"
    if len(encoded.encode("utf-8")) > MAXIMUM_REPORT:
        raise NoticeError("Manifest bound exceeded")
    return report, encoded, blobs, source_roots


def write_bundle(output, root=ROOT, distributions=None):
    if output.exists() or output.is_symlink():
        raise NoticeError("Use a new output directory")
    destination = output.resolve()
    root = root.resolve(strict=True)
    if destination.is_relative_to(root) or root.is_relative_to(destination) or not destination.parent.is_dir():
        raise NoticeError("Use an external output directory")
    report, encoded, blobs, source_roots = collect(root, distributions)
    if any(destination.is_relative_to(source) or source.is_relative_to(destination) for source in source_roots):
        raise NoticeError("Output overlaps installed source")
    destination.mkdir()
    marker = destination / "INCOMPLETE.txt"
    marker.write_text("Incomplete notice collection; no acceptance. Preserve for private inspection.\n", encoding="utf-8")
    for relative, data in blobs:
        path = destination / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("xb") as stream:
            stream.write(data)
    with (destination / "manifest.json").open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(encoded)
    marker.unlink()
    return report


def main():
    parser = argparse.ArgumentParser(description="Collect installed third-party legal texts offline, without legal certification")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        report = write_bundle(args.output)
    except (OSError, ValueError, TypeError, RecursionError):
        parser.exit(2, "Notice collection unavailable; inspect installed sources and the external destination privately.\n")
    print(f"Collected {report['text_count']} texts from {report['installed_instances']} installed instances; "
          f"{report['instances_with_gaps']} instances have explicit coverage gaps. No legal/release pass is inferred.")


if __name__ == "__main__":
    main()
