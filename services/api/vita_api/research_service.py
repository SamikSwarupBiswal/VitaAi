"""Session-bound research runs. No source promotion or downstream authority."""
import hashlib
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Request
from sqlalchemy import (
    JSON,
    Column,
    ForeignKeyConstraint,
    Integer,
    MetaData,
    String,
    Table,
    select,
    text,
    update,
)

from .contracts import Account, AccountSource, AccountView
from .governance import PolicyDenied
from .identity import Actor, sessions, token_digest, users
from .research import (
    PREFIX,
    Research,
    ResearchFailure,
    ResearchReadiness,
    ResearchRecovery,
    ResearchRecoveryReadiness,
    ResearchRecoveryRequest,
    ResearchRequest,
    ResearchRun,
    ResearchStatus,
)
from .research_context import ResearchContext, build_context
from .scoring import assess
from .storage import accounts, selected_evidence, selected_source

metadata = MetaData()
accounts.to_metadata(metadata)
research_runs = Table("research_runs", metadata,
    Column("id", String(80), primary_key=True), Column("organization_id", String(80), nullable=False),
    Column("account_id", String(80), nullable=False), Column("started_at", Integer, nullable=False),
    Column("status", String(20), nullable=False), Column("payload", JSON, nullable=False),
    ForeignKeyConstraint(["organization_id", "account_id"], ["accounts.organization_id", "accounts.id"]))

WORKER_BUDGET = timedelta(minutes=2)


class ResearchService:
    def __init__(self, store, connector, token, *, clock=None):
        self.engine, self.connector, self.token = store.engine, connector, token
        self.clock = clock or (lambda: datetime.now(UTC))

    @staticmethod
    def load(connection, organization_id, run_id):
        payload = connection.execute(select(research_runs.c.payload).where(
            research_runs.c.organization_id == organization_id, research_runs.c.id == str(run_id))).scalar()
        if payload is None:
            raise PolicyDenied("record_not_found", 404)
        return ResearchRun.model_validate(payload)

    def worker_check(self, connection, run):
        saved = self.load(connection, run.organization_id, run.id)
        if saved.status != "pending" or saved.revision != run.revision:
            raise PolicyDenied("research_worker_fenced", 409)
        if run.worker_deadline_at is None or self.clock() >= run.worker_deadline_at:
            raise PolicyDenied("research_worker_expired", 409)

    @contextmanager
    def transaction(self, *, authenticate=True):
        with self.engine.connect() as connection:
            try:
                if self.engine.dialect.name == "sqlite":
                    connection.exec_driver_sql("BEGIN IMMEDIATE")
                else:
                    connection.begin()
                    key = int.from_bytes(hashlib.sha256(self.connector.settings.research_organization_id.encode())
                                         .digest()[:8], "big", signed=True)
                    connection.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": key})
                actor = None
                if authenticate:
                    row = connection.execute(select(users).join(sessions, sessions.c.user_id == users.c.id).where(
                        sessions.c.token_hash == token_digest(self.token or ""),
                        sessions.c.expires_at > int(datetime.now(UTC).timestamp()), users.c.enabled.is_(True))
                        .with_for_update()).mappings().first()
                    if row is None:
                        raise PolicyDenied("authentication_required", 401)
                    actor = Actor(**{key: row[key] for key in ("id", "username", "organization_id", "role")})
                yield connection, actor
                connection.commit()
            except BaseException:
                connection.rollback()
                raise

    def account(self, connection, actor, account_id, expected=None):
        payload = connection.execute(select(accounts.c.payload).where(
            accounts.c.organization_id == actor.organization_id, accounts.c.id == str(account_id))
            .with_for_update()).scalar()
        if payload is None:
            raise PolicyDenied("record_not_found", 404)
        account = Account.model_validate(payload)
        if expected is not None and account.revision != expected:
            raise PolicyDenied("stale_account_revision", 409)
        return account

    def get(self, run_id):
        with self.transaction() as (connection, actor):
            run = self.load(connection, actor.organization_id, run_id)
            self.account(connection, actor, run.account_id)
            return run

    def history(self, account_id):
        with self.transaction() as (connection, actor):
            self.account(connection, actor, account_id)
            return [ResearchRun.model_validate(payload) for payload in connection.execute(
                select(research_runs.c.payload).where(research_runs.c.organization_id == actor.organization_id,
                    research_runs.c.account_id == str(account_id))
                .order_by(research_runs.c.started_at.desc(), research_runs.c.id.desc()).limit(20)).scalars()]

    def context(self, run_id):
        with self.transaction() as (connection, actor):
            return self.context_in_transaction(connection, actor, run_id)

    def context_in_transaction(self, connection, actor, run_id):
        run = self.load(connection, actor.organization_id, run_id)
        account = self.account(connection, actor, run.account_id)
        facts = selected_evidence(connection, actor.organization_id, account.id)
        source = selected_source(connection, actor.organization_id, account.id)
        now = self.clock()
        view = AccountView(account=account, evidence=facts, assessment=assess(account, facts, now.date()),
            renewal_days=(account.renewal_date - now.date()).days if account.renewal_date else None,
            source=AccountSource.model_validate(source["selection"]) if source else None)
        settings = self.connector.settings
        target = settings.research_account_map.get(account.id) if (
            actor.organization_id == settings.research_organization_id) else None
        return build_context(view, run, target, enabled=self.connector.status(actor.organization_id).enabled, now=now)

    def start(self, account_id, body):
        settings = self.connector.settings
        with self.transaction() as (connection, actor):
            account = self.account(connection, actor, account_id, body.expected_account_revision)
            if actor.role == "viewer":
                raise PolicyDenied("research_writer_required", 403)
            target = settings.research_account_map.get(str(account_id))
            if actor.organization_id != settings.research_organization_id or target is None:
                raise PolicyDenied("research_account_unmapped", 409)
            scope = (research_runs.c.organization_id == actor.organization_id,
                     research_runs.c.account_id == str(account_id))
            pending = connection.execute(select(research_runs.c.id).where(
                *scope, research_runs.c.status == "pending").limit(1)).first()
            latest = connection.execute(select(research_runs.c.started_at).where(*scope)
                .order_by(research_runs.c.started_at.desc()).limit(1)).scalar()
            now = self.clock()
            if pending:
                raise PolicyDenied("research_in_progress", 409)
            if latest is not None and int(now.timestamp()) - latest < 60:
                raise PolicyDenied("research_rate_limited", 429)
            mode = "disabled" if not settings.research_enabled else body.mode
            if mode == "live" and not self.connector.configured:
                mode = "fallback"
            run = ResearchRun(id=uuid4(), organization_id=actor.organization_id, account_id=account_id,
                account_revision=account.revision, actor_id=actor.id, requested_mode=body.mode,
                mode=mode, status="pending", target=target, started_at=now, worker_deadline_at=now + WORKER_BUDGET)
            connection.execute(research_runs.insert().values(id=str(run.id), organization_id=actor.organization_id,
                account_id=str(account_id), started_at=int(now.timestamp()), status="pending",
                payload=run.model_dump(mode="json")))
        # The sole search reservation is durable. A reserved request may still begin/finish after recovery.
        sources, error = [], None
        try:
            def before_request():
                with self.transaction() as (connection, current):
                    self.worker_check(connection, run)
                    if current.id != actor.id or current.organization_id != actor.organization_id or current.role == "viewer":
                        raise PolicyDenied("research_authority_changed", 403)
                    self.account(connection, current, account_id, account.revision)

            before_request()
            if mode == "live":
                try:
                    sources = self.connector.search(target, before_request=before_request)
                except ResearchFailure as failure:
                    mode, error = "fallback", str(failure)
            elif mode == "fallback":
                error = "research_unconfigured"
            elif mode == "disabled":
                error = "research_disabled"
            with self.transaction() as (connection, current):
                self.worker_check(connection, run)
                if current.id != actor.id or current.organization_id != actor.organization_id or current.role == "viewer":
                    raise PolicyDenied("research_authority_changed", 403)
                self.account(connection, current, account_id, account.revision)
                run.mode, run.error_code, run.sources = mode, error, sources
                run.status = "unavailable" if mode in {"disabled", "fallback"} else "succeeded"
                run.finished_at = datetime.now(UTC)
                run.expires_at = run.finished_at + timedelta(minutes=15)
                self.finish(connection, run)
                return run
        except PolicyDenied as failure:
            # Persist only this existing run's discard, never text after authority loss.
            with self.transaction(authenticate=False) as (connection, _):
                saved = self.load(connection, run.organization_id, run.id)
                if saved.status == "pending" and saved.revision == run.revision and failure.code != "research_worker_expired":
                    saved.status, saved.sources, saved.error_code = "discarded", [], "research_context_changed"
                    saved.finished_at = self.clock()
                    self.finish(connection, saved)
            raise

    def recovery_readiness(self, run_id):
        with self.transaction() as (connection, actor):
            run = self.load(connection, actor.organization_id, run_id)
            account = self.account(connection, actor, run.account_id)
            reason = ("role_denied" if actor.role == "viewer" else "terminal" if run.status != "pending"
                else "legacy_worker" if run.worker_deadline_at is None
                else "worker_active" if self.clock() < run.worker_deadline_at else "eligible")
            return ResearchRecoveryReadiness(organization_id=actor.organization_id, account_id=run.account_id,
                account_revision=account.revision, run_id=run.id, run_revision=run.revision,
                can_recover=reason == "eligible", reason=reason, recover_after=run.worker_deadline_at)

    def recover(self, run_id, body):
        with self.transaction() as (connection, actor):
            run = self.load(connection, actor.organization_id, run_id)
            self.account(connection, actor, run.account_id, body.expected_account_revision)
            if actor.role == "viewer":
                raise PolicyDenied("research_writer_required", 403)
            if run.status != "pending" or run.revision != body.expected_revision:
                raise PolicyDenied("research_recovery_state_changed", 409)
            now = self.clock()
            if run.worker_deadline_at is None or now < run.worker_deadline_at:
                raise PolicyDenied("research_worker_not_recoverable", 409)
            run.recovery = ResearchRecovery(actor_id=actor.id, recovered_at=now, previous_revision=run.revision)
            run.status, run.error_code, run.finished_at = "interrupted", "research_interrupted", now
            self.finish(connection, run)
            return run

    def readiness(self, account_id):
        with self.transaction() as (connection, actor):
            account = self.account(connection, actor, account_id)
            status = self.connector.status(actor.organization_id)
            target = self.connector.settings.research_account_map.get(str(account_id)) if (
                actor.organization_id == self.connector.settings.research_organization_id) else None
            scope = (research_runs.c.organization_id == actor.organization_id,
                     research_runs.c.account_id == str(account_id))
            pending = connection.execute(select(research_runs.c.id).where(
                *scope, research_runs.c.status == "pending").limit(1)).scalar()
            latest = connection.execute(select(research_runs.c.started_at).where(*scope)
                .order_by(research_runs.c.started_at.desc()).limit(1)).scalar()
            next_start = datetime.fromtimestamp(latest, UTC) + timedelta(seconds=60) if latest is not None else None
            return ResearchReadiness(**status.model_dump(), organization_id=actor.organization_id,
                account_id=account_id, account_revision=account.revision, target=target,
                can_start=bool(status.enabled and target and actor.role != "viewer" and not pending
                    and (next_start is None or datetime.now(UTC) >= next_start)),
                pending_run_id=pending, next_start_at=next_start)

    @staticmethod
    def finish(connection, run):
        result = connection.execute(update(research_runs).where(research_runs.c.id == str(run.id),
            research_runs.c.organization_id == run.organization_id, research_runs.c.status == "pending",
            research_runs.c.payload["revision"].as_integer() == run.revision)
            .values(status=run.status, payload=run.model_copy(update={"revision": run.revision + 1}).model_dump(mode="json")))
        if result.rowcount != 1:
            raise PolicyDenied("research_already_finished", 409)
        run.revision += 1


def install_research_routes(app, store, identity, settings, transport=None):
    connector = Research(settings, transport)
    router = APIRouter(prefix=PREFIX)

    def current(request: Request):
        if settings.auth_mode != "session":
            raise PolicyDenied("session_identity_required", 503)
        actor = identity.resolve(request.cookies.get("vitaai_session"))
        if actor is None:
            raise PolicyDenied("authentication_required", 401)
        return actor

    def service(request: Request):
        return ResearchService(store, connector, request.cookies.get("vitaai_session"))

    Current = Annotated[Actor, Depends(current)]
    Service = Annotated[ResearchService, Depends(service)]

    @router.get("", response_model=ResearchStatus)
    def status(actor: Current):
        return connector.status(actor.organization_id)

    @router.post("/accounts/{account_id}/search", response_model=ResearchRun)
    def search(account_id: UUID, body: ResearchRequest, actor: Current, operation: Service):
        return operation.start(account_id, body)

    @router.get("/runs/{run_id}", response_model=ResearchRun)
    def get_run(run_id: UUID, actor: Current, operation: Service):
        return operation.get(run_id)

    @router.get("/runs/{run_id}/context", response_model=ResearchContext)
    def context(run_id: UUID, actor: Current, operation: Service):
        return operation.context(run_id)

    @router.get("/runs/{run_id}/recovery-readiness", response_model=ResearchRecoveryReadiness)
    def recovery_readiness(run_id: UUID, actor: Current, operation: Service):
        return operation.recovery_readiness(run_id)

    @router.post("/runs/{run_id}/recover", response_model=ResearchRun)
    def recover(run_id: UUID, body: ResearchRecoveryRequest, actor: Current, operation: Service):
        return operation.recover(run_id, body)

    @router.get("/accounts/{account_id}/readiness", response_model=ResearchReadiness)
    def readiness(account_id: UUID, actor: Current, operation: Service):
        return operation.readiness(account_id)

    @router.get("/accounts/{account_id}/runs", response_model=list[ResearchRun])
    def history(account_id: UUID, actor: Current, operation: Service):
        return operation.history(account_id)

    app.include_router(router)
