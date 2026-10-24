"""Offline legacy recovery in a new SQLite copy, never an in-place worker unblock.

No app, dotenv, provider instance, migration or service is started. Stop old serving
processes before a separate deployment cutover; this tool never performs cutover.
"""
import argparse
import getpass
import hashlib
import json
import os
import re
import sqlite3
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path
from time import monotonic
from typing import Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import create_engine, delete, select, update
from sqlalchemy.engine import URL
from sqlalchemy.exc import SQLAlchemyError

from .governance import canonical_json
from .identity import Identity, LoginFailure, sessions, token_digest, users
from .provider_comparison import ComparisonRecovery, ComparisonRun, comparisons
from .research import ResearchRecovery, ResearchRun
from .research_service import research_runs

ROOT = Path(__file__).resolve().parents[3]
TABLES = {"research": research_runs, "comparison": comparisons}
CONTRACTS = {"research": ResearchRun, "comparison": ComparisonRun}


class RecoveryDenied(Exception):
    """Only safe fixed messages are printed by the CLI."""


class RecoverySelection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["research", "comparison"]
    id: UUID
    account_id: UUID
    revision: int = Field(ge=1)
    payload_hash: str = Field(pattern=r"^[a-f0-9]{64}$")


class CopyManifest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    protocol: Literal["legacy-recovery-copy-1"] = "legacy-recovery-copy-1"
    isolation_id: UUID
    source_path: str
    copy_path: str
    copy_snapshot_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    organization_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,80}$")
    prepared_at: str
    records: list[RecoverySelection] = Field(max_length=40)
    more_pending_records: bool


def digest_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1_048_576), b""):
            digest.update(chunk)
    return digest.hexdigest()


def private_path(path, *, exists=False):
    candidate = Path(path).absolute()
    if candidate.is_symlink() or not candidate.parent.is_dir():
        raise RecoveryDenied("recovery_path_unavailable")
    resolved = candidate.resolve(strict=exists)
    if resolved.is_relative_to(ROOT) or (exists and not resolved.is_file()):
        raise RecoveryDenied("recovery_copy_must_be_private_and_outside_checkout")
    return resolved


def selection_key(value):
    try:
        kind, run_id = value.split(":")
        if kind not in TABLES or str(UUID(run_id)) != run_id:
            raise ValueError
        return kind, run_id
    except (ValueError, AttributeError):
        raise RecoveryDenied("invalid_exact_legacy_selection") from None


def prepare_copy(source_path, destination_path, organization_id, *, candidates=None):
    if not isinstance(organization_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", organization_id):
        raise RecoveryDenied("invalid_recovery_organization")
    if candidates and (len(candidates) > 20 or len(set(candidates)) != len(candidates)):
        raise RecoveryDenied("select_at_most_twenty_exact_candidates")
    chosen = [selection_key(value) for value in candidates or []]
    source = Path(source_path).resolve(strict=True)
    destination = private_path(destination_path)
    manifest_path = Path(str(destination) + ".legacy-recovery.json")
    if not source.is_file() or destination == source or destination.exists() or manifest_path.exists():
        raise RecoveryDenied("recovery_requires_a_new_copy_path")
    # Exclusive creation separates publication from every engine targeting the source file.
    descriptor = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(descriptor)
    isolation_id, prepared_at = uuid4(), datetime.now(UTC).isoformat()
    deadline = monotonic() + 60

    def progress(_status, _remaining, _total):
        if monotonic() > deadline:
            raise RecoveryDenied("recovery_snapshot_timed_out")

    with (
        closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True, timeout=5)) as original,
        closing(sqlite3.connect(destination, timeout=5)) as copied,
    ):
        original.backup(copied, pages=128, progress=progress, sleep=0.01)
        copied.execute("PRAGMA journal_mode=DELETE")
        with copied:
            # Descendant copies get a fresh nonce while preserving all prior dispositions/audits.
            copied.execute("CREATE TABLE IF NOT EXISTS legacy_recovery_copy (isolation_id TEXT PRIMARY KEY, consumed_at TEXT)")
            copied.execute("INSERT INTO legacy_recovery_copy VALUES (?, NULL)", (str(isolation_id),))
            copied.execute("""CREATE TABLE IF NOT EXISTS legacy_recovery_records (
                isolation_id TEXT NOT NULL, kind TEXT NOT NULL, run_id TEXT NOT NULL,
                organization_id TEXT NOT NULL, actor_id TEXT NOT NULL, recovered_at TEXT NOT NULL,
                before_payload TEXT NOT NULL, after_payload TEXT NOT NULL,
                PRIMARY KEY(isolation_id, kind, run_id))""")
            # No copied review, scheduler or mailbox session retains authority at cutover.
            copied.execute("DELETE FROM sessions")
        records, more = [], False
        for kind, table in TABLES.items():
            ids = [run_id for selected_kind, run_id in chosen if selected_kind == kind]
            if chosen:
                rows = [copied.execute(f"SELECT payload FROM {table.name} WHERE organization_id=? AND id=? "
                    "AND status='pending'", (organization_id, run_id)).fetchone() for run_id in ids]
                if any(row is None for row in rows):
                    raise RecoveryDenied("exact_legacy_candidate_unavailable")
            else:
                rows = copied.execute(f"SELECT payload FROM {table.name} WHERE organization_id=? AND status='pending' "
                    "ORDER BY started_at DESC, id DESC LIMIT 21", (organization_id,)).fetchall()
                more |= len(rows) > 20
            for (encoded,) in rows[:20]:
                payload = json.loads(encoded)
                run = CONTRACTS[kind].model_validate(payload)
                if run.worker_deadline_at is None and run.status == "pending":
                    records.append(RecoverySelection(kind=kind, id=run.id, account_id=run.account_id,
                        revision=run.revision, payload_hash=hashlib.sha256(canonical_json(payload)).hexdigest()))
                elif chosen:
                    raise RecoveryDenied("only_unfenced_pending_candidates_supported")
    manifest = CopyManifest(isolation_id=isolation_id, source_path=str(source), copy_path=str(destination),
        copy_snapshot_sha256=digest_file(destination), organization_id=organization_id,
        prepared_at=prepared_at, records=records, more_pending_records=more)
    # Manifest excludes payload text, passwords, session tokens and provider keys.
    with manifest_path.open("x", encoding="utf-8") as stream:
        stream.write(manifest.model_dump_json(indent=2) + "\n")
    return manifest_path, manifest


def unique_fields(pairs):
    result = dict(pairs)
    if len(result) != len(pairs):
        raise RecoveryDenied("duplicate_manifest_field")
    return result


def apply_copy(manifest_path, selections, username, password, *, acknowledge_cutover=False):
    path = private_path(manifest_path, exists=True)
    if not acknowledge_cutover or path.stat().st_size > 65536:
        raise RecoveryDenied("explicit_offline_cutover_acknowledgement_required")
    manifest = CopyManifest.model_validate(json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_fields))
    destination = private_path(manifest.copy_path, exists=True)
    if (path != Path(str(destination) + ".legacy-recovery.json") or destination == Path(manifest.source_path).resolve()
            or digest_file(destination) != manifest.copy_snapshot_sha256):
        raise RecoveryDenied("recovery_copy_changed")
    if not 1 <= len(selections) <= 20 or len(set(selections)) != len(selections):
        raise RecoveryDenied("select_one_to_twenty_exact_legacy_records")
    indexed = {f"{item.kind}:{item.id}": item for item in manifest.records}
    if len(indexed) != len(manifest.records) or any(selection not in indexed for selection in selections):
        raise RecoveryDenied("recovery_selection_not_in_manifest")
    engine = create_engine(URL.create("sqlite", database=str(destination)))
    identity, session_token = Identity(engine), None
    try:
        with engine.connect() as connection:
            fence = connection.exec_driver_sql("SELECT isolation_id, consumed_at FROM legacy_recovery_copy WHERE isolation_id=?",
                (str(manifest.isolation_id),)).fetchall()
            if fence != [(str(manifest.isolation_id), None)]:
                raise RecoveryDenied("recovery_copy_already_used_or_not_isolated")
        actor, session_token = identity.login(username, password, 1)
        if actor.role != "admin" or actor.organization_id != manifest.organization_id:
            raise RecoveryDenied("recovery_organization_administrator_required")
        with engine.connect() as connection:
            try:
                connection.exec_driver_sql("PRAGMA foreign_keys=ON")
                connection.commit()
                connection.exec_driver_sql("BEGIN IMMEDIATE")
                current = connection.execute(select(users.c.id).join(sessions, sessions.c.user_id == users.c.id).where(
                    users.c.id == actor.id, users.c.enabled.is_(True), users.c.role == "admin",
                    users.c.organization_id == manifest.organization_id, sessions.c.token_hash == token_digest(session_token),
                    sessions.c.expires_at > int(datetime.now(UTC).timestamp()))).scalar()
                if not current:
                    raise RecoveryDenied("recovery_authentication_changed")
                now = datetime.now(UTC)
                winner = connection.exec_driver_sql("UPDATE legacy_recovery_copy SET consumed_at=? "
                    "WHERE isolation_id=? AND consumed_at IS NULL", (now.isoformat(), str(manifest.isolation_id)))
                if winner.rowcount != 1:
                    raise RecoveryDenied("recovery_copy_already_used_or_not_isolated")
                recovered = []
                for selection in selections:
                    expected = indexed[selection]
                    table = TABLES[expected.kind]
                    payload = connection.execute(select(table.c.payload).where(table.c.id == str(expected.id),
                        table.c.organization_id == actor.organization_id, table.c.status == "pending")).scalar()
                    if payload is None or hashlib.sha256(canonical_json(payload)).hexdigest() != expected.payload_hash:
                        raise RecoveryDenied("legacy_record_changed")
                    run = CONTRACTS[expected.kind].model_validate(payload)
                    if run.worker_deadline_at is not None or run.revision != expected.revision or run.account_id != expected.account_id:
                        raise RecoveryDenied("only_exact_unfenced_pending_records_may_finalize")
                    recovery_type = ResearchRecovery if expected.kind == "research" else ComparisonRecovery
                    run.recovery = recovery_type(actor_id=actor.id, recovered_at=now, previous_revision=run.revision,
                        reason="isolated_database_copy", isolation_id=manifest.isolation_id)
                    if expected.kind == "research":
                        run.error_code = "research_interrupted"
                    else:
                        for result in run.results:
                            if result.status == "pending":
                                result.status, result.error_code, result.finished_at = "discarded", "comparison_interrupted", now
                    run.status, run.finished_at, run.revision = "interrupted", now, run.revision + 1
                    final = run.model_dump(mode="json")
                    changed = connection.execute(update(table).where(table.c.id == str(run.id),
                        table.c.organization_id == actor.organization_id, table.c.status == "pending")
                        .values(status="interrupted", payload=final))
                    if changed.rowcount != 1:
                        raise RecoveryDenied("legacy_record_changed")
                    connection.exec_driver_sql("INSERT INTO legacy_recovery_records VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        (str(manifest.isolation_id), expected.kind, str(run.id), actor.organization_id, actor.id,
                         now.isoformat(), canonical_json(payload).decode(), canonical_json(final).decode()))
                    recovered.append(selection)
                connection.execute(delete(sessions))
                connection.commit()
                return recovered
            except BaseException:
                connection.rollback()
                raise
    finally:
        if session_token:
            identity.logout(session_token)
        engine.dispose()


def main():
    parser = argparse.ArgumentParser(description="Prepare/recover a private SQLite copy; never finalize unfenced workers in place")
    commands = parser.add_subparsers(dest="command", required=True)
    prepare = commands.add_parser("prepare")
    prepare.add_argument("--source", required=True)
    prepare.add_argument("--destination", required=True)
    prepare.add_argument("--organization", required=True)
    prepare.add_argument("--candidate", action="append", help="Optional exact kind:UUID, including older records; at most twenty")
    apply = commands.add_parser("apply")
    apply.add_argument("--manifest", required=True)
    apply.add_argument("--run", action="append", required=True, help="Exact kind:UUID from the manifest; at most twenty")
    apply.add_argument("--username", required=True)
    apply.add_argument("--acknowledge-cutover", action="store_true",
        help="Acknowledge that old serving processes must be stopped before a separate cutover; no automatic restart")
    args = parser.parse_args()
    try:
        if args.command == "prepare":
            manifest_path, manifest = prepare_copy(args.source, args.destination, args.organization, candidates=args.candidate)
            print(json.dumps({"manifest": str(manifest_path), "isolation_id": str(manifest.isolation_id),
                "eligible_records": len(manifest.records), "more_pending_records": manifest.more_pending_records}))
        else:
            password = getpass.getpass("Existing organization administrator password: ")
            recovered = apply_copy(args.manifest, args.run, args.username, password,
                acknowledge_cutover=args.acknowledge_cutover)
            print(json.dumps({"recovered_in_copy": recovered, "provider_cancellation": "unproven", "automatic_cutover": False}))
    except (RecoveryDenied, LoginFailure, ValueError, OSError, sqlite3.Error, SQLAlchemyError):
        raise SystemExit("Recovery was not confirmed. Original database was not changed. Preserve the copy for inspection; prepare a new copy after correcting the input.") from None


if __name__ == "__main__":
    main()
