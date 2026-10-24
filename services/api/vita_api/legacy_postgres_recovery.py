"""Operator-only legacy recovery in a new PostgreSQL database; never cut over.

Only the explicitly supplied destination receives DDL/writes. The source uses a
repeatable read-only snapshot. No app, dotenv or provider adapter is started.
"""
import argparse
import getpass
import hashlib
import hmac
import json
import re
from datetime import UTC, datetime
from pathlib import Path
from time import monotonic
from typing import Literal
from uuid import UUID

from alembic.config import Config
from alembic.script import ScriptDirectory
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field
from sqlalchemy import (
    Column,
    ForeignKey,
    MetaData,
    String,
    Table,
    Text,
    create_engine,
    delete,
    func,
    inspect,
    select,
    text,
    update,
)
from sqlalchemy.engine import make_url
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.pool import NullPool

from .governance import canonical_json
from .identity import Actor, LoginFailure, password_digest, sessions, users
from .legacy_recovery import (
    CONTRACTS,
    TABLES,
    RecoveryDenied,
    RecoverySelection,
    private_path,
    selection_key,
    unique_fields,
)
from .migrate import upgrade
from .provider_comparison import ComparisonRecovery
from .research import ResearchRecovery

PRIVATE_TABLES = MetaData(schema="public")
copy_fences = Table("legacy_recovery_copy", PRIVATE_TABLES,
    Column("isolation_id", Text, primary_key=True), Column("consumed_at", Text))
copy_records = Table("legacy_recovery_records", PRIVATE_TABLES,
    Column("isolation_id", Text, ForeignKey(copy_fences.c.isolation_id), primary_key=True),
    Column("kind", Text, primary_key=True), Column("run_id", Text, primary_key=True),
    Column("organization_id", Text, nullable=False), Column("actor_id", Text, nullable=False),
    Column("recovered_at", Text, nullable=False), Column("before_payload", Text, nullable=False),
    Column("after_payload", Text, nullable=False))
copy_manifests = Table("legacy_recovery_manifests", PRIVATE_TABLES,
    Column("isolation_id", Text, ForeignKey(copy_fences.c.isolation_id), primary_key=True),
    Column("binding_hash", String(64), nullable=False))
COPY_NAME = re.compile(r"vitaai_recovery_([a-f0-9]{32})")
NAME = re.compile(r"[a-z][a-z0-9_]*")


class PostgresManifest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    protocol: Literal["legacy-recovery-postgresql-copy-1"] = "legacy-recovery-postgresql-copy-1"
    isolation_id: UUID
    source_identity_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    destination_identity_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    database_snapshot_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    schema_revision: str = Field(pattern=r"^[a-zA-Z0-9_]{1,32}$")
    organization_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,80}$")
    prepared_at: AwareDatetime
    records: list[RecoverySelection] = Field(max_length=40)
    more_pending_records: bool


def manifest_binding(manifest):
    return hashlib.sha256(canonical_json(manifest.model_dump(mode="json",
        exclude={"database_snapshot_sha256"}))).hexdigest()


def postgres_engine(value):
    # URLs are prompted/injected in memory only; never discover default credentials.
    url = make_url(value)
    if url.drivername != "postgresql+psycopg" or url.query or not url.host or not url.database:
        raise RecoveryDenied("explicit_postgresql_psycopg_connection_required")
    return create_engine(url, poolclass=NullPool, hide_parameters=True,
        connect_args={"connect_timeout": 5, "application_name": "vitaai-legacy-copy",
            "options": "-c statement_timeout=60000 -c lock_timeout=5000"})


def project_revision():
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "migrations"))
    return ScriptDirectory.from_config(config).get_current_head()


def database_identity(connection):
    row = connection.execute(text("SELECT current_database() AS database, inet_server_addr()::text AS address, "
        "inet_server_port() AS port, oid::text AS oid FROM pg_database WHERE datname=current_database()")).mappings().one()
    return row["database"], hashlib.sha256(canonical_json(dict(row))).hexdigest()


def transaction_limits(connection, *, read_only=False):
    if read_only:
        connection.exec_driver_sql("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
    connection.exec_driver_sql("SET LOCAL statement_timeout = '60s'")
    connection.exec_driver_sql("SET LOCAL lock_timeout = '5s'")
    connection.exec_driver_sql("SET LOCAL search_path = public, pg_catalog")


def schema_tables(connection):
    # Do not omit hidden rows, execute copied routines, or ignore extra public objects.
    unsupported = connection.execute(text("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
        "WHERE n.nspname='public' AND (c.relrowsecurity OR c.relkind NOT IN ('r','S','i')) LIMIT 1")).first()
    triggers = connection.execute(text("SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid "
        "JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal LIMIT 1")).first()
    routines = connection.execute(text("SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace "
        "WHERE n.nspname='public' LIMIT 1")).first()
    names = inspect(connection).get_table_names(schema="public")
    if unsupported or triggers or routines or any(not NAME.fullmatch(name) for name in names):
        raise RecoveryDenied("only_known_public_project_schema_supported")
    metadata = MetaData(schema="public")
    metadata.reflect(bind=connection, schema="public", only=names)
    return {table.name: table for table in metadata.sorted_tables}


def table_shape(connection, table):
    inspector = inspect(connection)
    shape = {"columns": [(column.name, str(column.type), column.nullable, column.primary_key)
        for column in table.columns]}
    for name in ("indexes", "foreign_keys", "unique_constraints", "check_constraints", "pk_constraint"):
        shape[name] = getattr(inspector, "get_" + name)(table.name, schema="public")
        if isinstance(shape[name], list):
            shape[name] = sorted(shape[name], key=lambda item: canonical_json(item))
    return shape


def lock_copy(connection, tables):
    quote = connection.dialect.identifier_preparer.quote
    for name in sorted(tables):
        connection.exec_driver_sql(f"LOCK TABLE public.{quote(name)} IN ACCESS EXCLUSIVE MODE")


def check_time(deadline):
    if monotonic() >= deadline:
        raise RecoveryDenied("recovery_snapshot_timed_out")


def snapshot_digest(connection, tables, deadline):
    digest = hashlib.sha256()
    for name, table in sorted(tables.items()):
        check_time(deadline)
        if not len(table.primary_key.columns):
            raise RecoveryDenied("project_table_identity_required")
        digest.update(canonical_json({"table": name, "shape": table_shape(connection, table)}))
        rows = connection.execute(select(table).order_by(*table.primary_key.columns).execution_options(yield_per=500))
        try:
            for batch in rows.mappings().partitions(500):
                check_time(deadline)
                for row in batch:
                    digest.update(b"\n" + canonical_json(dict(row)))
        finally:
            rows.close()
    quote = connection.dialect.identifier_preparer.quote
    for name in sorted(inspect(connection).get_sequence_names(schema="public")):
        if not NAME.fullmatch(name):
            raise RecoveryDenied("unexpected_project_sequence")
        state = connection.exec_driver_sql(f"SELECT last_value, is_called FROM public.{quote(name)}").one()
        digest.update(canonical_json({"sequence": name, "last_value": state[0], "is_called": state[1]}))
    return digest.hexdigest()


def restore_sequences(connection, tables):
    for table in tables.values():
        for column in table.primary_key.columns:
            sequence = connection.execute(text("SELECT pg_get_serial_sequence(:table_name, :column_name)"),
                {"table_name": "public." + table.name, "column_name": column.name}).scalar()
            if sequence:
                maximum = connection.execute(select(func.max(column))).scalar() or 0
                connection.execute(text("SELECT setval(CAST(:sequence AS regclass), :next_value, false)"),
                    {"sequence": sequence, "next_value": max(maximum + 1, 1)})


def candidates_in_copy(connection, organization_id, candidates):
    if candidates and (len(candidates) > 20 or len(set(candidates)) != len(candidates)):
        raise RecoveryDenied("select_at_most_twenty_exact_candidates")
    chosen = [selection_key(value) for value in candidates or []]
    records, more = [], False
    for kind, table in TABLES.items():
        query = select(table.c.payload).where(table.c.organization_id == organization_id, table.c.status == "pending")
        ids = [run_id for selected_kind, run_id in chosen if selected_kind == kind]
        if chosen:
            if not ids:
                continue
            payloads = connection.execute(query.where(table.c.id.in_(ids))).scalars().all()
            if len(payloads) != len(ids):
                raise RecoveryDenied("exact_legacy_candidate_unavailable")
        else:
            payloads = connection.execute(query.where(table.c.payload["worker_deadline_at"].as_string().is_(None))
                .order_by(table.c.started_at.desc(), table.c.id.desc()).limit(21)).scalars().all()
            more |= len(payloads) > 20
        for payload in payloads[:20]:
            run = CONTRACTS[kind].model_validate(payload)
            if run.status != "pending" or run.worker_deadline_at is not None:
                raise RecoveryDenied("only_unfenced_pending_candidates_supported")
            records.append(RecoverySelection(kind=kind, id=run.id, account_id=run.account_id,
                revision=run.revision, payload_hash=hashlib.sha256(canonical_json(payload)).hexdigest()))
    return records, more


def prepare_copy(source_url, destination_url, manifest_path, organization_id, *, candidates=None):
    if not isinstance(organization_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", organization_id):
        raise RecoveryDenied("invalid_recovery_organization")
    path = private_path(manifest_path)
    if path.exists():
        raise RecoveryDenied("new_private_manifest_path_required")
    # Exclusive reservation; failures leave the manifest/copy for inspection, never drop a DB.
    with path.open("x", encoding="utf-8") as output:
        source, destination = postgres_engine(source_url), None
        try:
            destination = postgres_engine(destination_url)
            deadline = monotonic() + 120
            with source.connect() as original, original.begin():
                transaction_limits(original, read_only=True)
                source_name, source_identity = database_identity(original)
                original_tables = schema_tables(original)
                revision = original.execute(text("SELECT version_num FROM public.alembic_version")).scalar_one()
                if revision != project_revision():
                    raise RecoveryDenied("matching_project_revision_required")
                prepared_at = original.execute(text("SELECT transaction_timestamp()")).scalar_one()
                with destination.connect() as copied, copied.begin():
                    transaction_limits(copied)
                    destination_name, destination_identity = database_identity(copied)
                    match = COPY_NAME.fullmatch(destination_name)
                    if (not match or source_name == destination_name or source_identity == destination_identity
                            or schema_tables(copied)):
                        raise RecoveryDenied("new_empty_distinct_recovery_database_required")
                # This verified empty destination is the only engine ever passed to migration.
                upgrade(destination)
                with destination.connect() as copied, copied.begin():
                    transaction_limits(copied)
                    PRIVATE_TABLES.create_all(copied)
                    target_tables = schema_tables(copied)
                    lock_copy(copied, target_tables)
                    base_names = set(target_tables) - {table.name for table in PRIVATE_TABLES.tables.values()}
                    if not base_names <= original_tables.keys() or original_tables.keys() - target_tables.keys():
                        raise RecoveryDenied("project_table_inventory_changed")
                    for name, table in original_tables.items():
                        if table_shape(original, table) != table_shape(copied, target_tables[name]):
                            raise RecoveryDenied("project_table_shape_changed")
                    if (sorted(inspect(original).get_sequence_names(schema="public"))
                            != sorted(inspect(copied).get_sequence_names(schema="public"))):
                        raise RecoveryDenied("project_sequence_inventory_changed")
                    for name, table in target_tables.items():
                        if name != "alembic_version" and copied.execute(select(table).limit(1)).first():
                            raise RecoveryDenied("recovery_destination_no_longer_empty")
                    for table in target_tables.values():
                        check_time(deadline)
                        if table.name == "alembic_version" or table.name not in original_tables:
                            continue
                        original_table = original_tables[table.name]
                        rows = original.execute(select(original_table).order_by(*original_table.primary_key.columns)
                            .execution_options(yield_per=500))
                        try:
                            for batch in rows.mappings().partitions(500):
                                check_time(deadline)
                                copied.execute(table.insert(), [dict(row) for row in batch])
                        finally:
                            rows.close()
                    copied.execute(delete(sessions))
                    restore_sequences(copied, target_tables)
                    isolation_id = UUID(match[1])
                    copied.execute(copy_fences.insert().values(isolation_id=str(isolation_id)))
                    records, more = candidates_in_copy(copied, organization_id, candidates)
                    manifest = PostgresManifest(isolation_id=isolation_id, source_identity_hash=source_identity,
                        destination_identity_hash=destination_identity, database_snapshot_sha256="0" * 64,
                        schema_revision=revision, organization_id=organization_id, prepared_at=prepared_at,
                        records=records, more_pending_records=more)
                    copied.execute(copy_manifests.insert().values(isolation_id=str(isolation_id),
                        binding_hash=manifest_binding(manifest)))
                    manifest.database_snapshot_sha256 = snapshot_digest(copied, target_tables, deadline)
            output.write(manifest.model_dump_json(indent=2) + "\n")
            return path, manifest
        finally:
            source.dispose()
            if destination is not None:
                destination.dispose()


def authenticate_admin(connection, username, password, organization_id):
    if not isinstance(username, str) or not isinstance(password, str) or len(username) > 80 or len(password) > 256:
        raise LoginFailure()
    user = connection.execute(select(users).where(users.c.username == username.lower()).with_for_update()).mappings().first()
    calculated = password_digest(password, user["password_salt"] if user else "00" * 16)
    now = int(datetime.now(UTC).timestamp())
    locked = bool(user and user["locked_until"] > now)
    valid = bool(user and hmac.compare_digest(calculated, user["password_hash"]) and user["enabled"] and not locked)
    if not valid:
        if user and not locked:
            count = user["failed_logins"] + 1 if user["locked_until"] == 0 else 1
            connection.execute(update(users).where(users.c.id == user["id"]).values(
                failed_logins=count, locked_until=now + 300 if count >= 5 else 0))
        raise LoginFailure(locked)
    if user["organization_id"] != organization_id or user["role"] != "admin":
        raise RecoveryDenied("recovery_organization_administrator_required")
    connection.execute(update(users).where(users.c.id == user["id"]).values(failed_logins=0, locked_until=0))
    return Actor(**{key: user[key] for key in ("id", "username", "organization_id", "role")})


def apply_copy(destination_url, manifest_path, selections, username, password, *, acknowledge_cutover=False):
    path = private_path(manifest_path, exists=True)
    if acknowledge_cutover is not True or path.stat().st_size > 65536:
        raise RecoveryDenied("explicit_offline_cutover_acknowledgement_required")
    manifest = PostgresManifest.model_validate(json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_fields))
    if not 1 <= len(selections) <= 20 or len(set(selections)) != len(selections):
        raise RecoveryDenied("select_one_to_twenty_exact_legacy_records")
    indexed = {f"{item.kind}:{item.id}": item for item in manifest.records}
    if len(indexed) != len(manifest.records) or any(item not in indexed for item in selections):
        raise RecoveryDenied("recovery_selection_not_in_manifest")
    engine = postgres_engine(destination_url)
    try:
        with engine.connect() as connection:
            try:
                connection.begin()
                transaction_limits(connection)
                name, identity = database_identity(connection)
                if (name != "vitaai_recovery_" + manifest.isolation_id.hex or identity != manifest.destination_identity_hash
                        or manifest.schema_revision != project_revision()):
                    raise RecoveryDenied("recovery_database_identity_changed")
                tables = schema_tables(connection)
                lock_copy(connection, tables)
                fence = connection.execute(select(copy_fences).where(
                    copy_fences.c.isolation_id == str(manifest.isolation_id)).with_for_update()).mappings().first()
                binding = connection.execute(select(copy_manifests.c.binding_hash).where(
                    copy_manifests.c.isolation_id == str(manifest.isolation_id))).scalar()
                if not fence or fence["consumed_at"] is not None or binding != manifest_binding(manifest):
                    raise RecoveryDenied("recovery_manifest_changed_or_copy_already_used")
                if snapshot_digest(connection, tables, monotonic() + 120) != manifest.database_snapshot_sha256:
                    raise RecoveryDenied("recovery_copy_changed")
                actor = authenticate_admin(connection, username, password, manifest.organization_id)
                now = datetime.now(UTC)
                consumed = connection.execute(update(copy_fences).where(
                    copy_fences.c.isolation_id == str(manifest.isolation_id), copy_fences.c.consumed_at.is_(None))
                    .values(consumed_at=now.isoformat()))
                if consumed.rowcount != 1:
                    raise RecoveryDenied("recovery_copy_already_used")
                for selection in selections:
                    expected = indexed[selection]
                    table = TABLES[expected.kind]
                    payload = connection.execute(select(table.c.payload).where(table.c.id == str(expected.id),
                        table.c.organization_id == actor.organization_id, table.c.status == "pending")).scalar()
                    if payload is None or hashlib.sha256(canonical_json(payload)).hexdigest() != expected.payload_hash:
                        raise RecoveryDenied("legacy_record_changed")
                    run = CONTRACTS[expected.kind].model_validate(payload)
                    if (run.worker_deadline_at is not None or run.revision != expected.revision
                            or run.account_id != expected.account_id or run.status != "pending"):
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
                    connection.execute(copy_records.insert().values(isolation_id=str(manifest.isolation_id),
                        kind=expected.kind, run_id=str(run.id), organization_id=actor.organization_id, actor_id=actor.id,
                        recovered_at=now.isoformat(), before_payload=canonical_json(payload).decode(),
                        after_payload=canonical_json(final).decode()))
                connection.execute(delete(sessions))
                connection.commit()
                return list(selections)
            except LoginFailure:
                # Only authentication counters changed before this branch; preserve lockout.
                connection.commit()
                raise
            except BaseException:
                connection.rollback()
                raise
    finally:
        engine.dispose()


def main():
    parser = argparse.ArgumentParser(description="Isolate unfenced PostgreSQL records in a new database; never finalize the source")
    commands = parser.add_subparsers(dest="command", required=True)
    prepare = commands.add_parser("prepare")
    prepare.add_argument("--manifest", required=True)
    prepare.add_argument("--organization", required=True)
    prepare.add_argument("--candidate", action="append")
    apply = commands.add_parser("apply")
    apply.add_argument("--manifest", required=True)
    apply.add_argument("--run", action="append", required=True)
    apply.add_argument("--username", required=True)
    apply.add_argument("--acknowledge-cutover", action="store_true")
    args = parser.parse_args()
    try:
        if args.command == "prepare":
            source_url = getpass.getpass("Source PostgreSQL+psycopg URL (read-only snapshot only): ")
            destination_url = getpass.getpass("New empty vitaai_recovery_<32 hex> PostgreSQL+psycopg URL: ")
            path, manifest = prepare_copy(source_url, destination_url, args.manifest, args.organization, candidates=args.candidate)
            print(json.dumps({"manifest": str(path), "isolation_id": str(manifest.isolation_id),
                "eligible_records": len(manifest.records), "more_pending_records": manifest.more_pending_records}))
        else:
            destination_url = getpass.getpass("Isolated recovery PostgreSQL+psycopg URL: ")
            password = getpass.getpass("Existing copied organization administrator password: ")
            recovered = apply_copy(destination_url, args.manifest, args.run, args.username, password,
                acknowledge_cutover=args.acknowledge_cutover)
            print(json.dumps({"recovered_in_copy": recovered, "provider_cancellation": "unproven", "automatic_cutover": False}))
    except (RecoveryDenied, LoginFailure, ValueError, OSError, SQLAlchemyError):
        raise SystemExit("Recovery was not confirmed. Source database was not changed. Preserve the destination/manifest for inspection; prepare a new copy after correcting the input.") from None


if __name__ == "__main__":
    main()
