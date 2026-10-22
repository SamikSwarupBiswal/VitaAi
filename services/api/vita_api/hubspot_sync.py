"""Read-only staging and explicit local source promotion; no provider writes."""
import hashlib
import json
from contextlib import contextmanager
from datetime import UTC, datetime
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
    UniqueConstraint,
    select,
    text,
    update,
)

from .contracts import Account, AccountSource
from .governance import PolicyDenied
from .hubspot import (
    PREFIX,
    HubSpot,
    HubSpotFailure,
    HubSpotObservation,
    HubSpotStatus,
    HubSpotSyncRequest,
    HubSpotSyncRun,
)
from .hubspot_changes import (
    SourceDetection,
    SourceDetectionBatch,
    SourceDetectionRequest,
    detect,
    detections,
    snapshot,
)
from .hubspot_normalize import (
    AccountSourceVersion,
    HubSpotPreview,
    HubSpotPromoteRequest,
    normalize,
)
from .hubspot_refresh import (
    RefreshAuthorization,
    RefreshAuthorizations,
    RefreshGrantRequest,
    RefreshOccurrence,
    RefreshRecoveryReadiness,
    RefreshRecoveryRequest,
    RefreshRevokeRequest,
    RefreshScheduleView,
)
from .identity import Actor, sessions, token_digest, users
from .storage import accounts, selected_evidence, selected_source, source_versions

metadata = MetaData()
# Include the existing table only for composite FK resolution; this metadata never creates it.
accounts.to_metadata(metadata)
observations = Table("hubspot_observations", metadata,
    Column("id", String(80), primary_key=True), Column("organization_id", String(80), nullable=False),
    Column("account_id", String(80), nullable=False), Column("sequence", Integer, nullable=False),
    Column("payload", JSON, nullable=False),
    UniqueConstraint("organization_id", "id"),
    UniqueConstraint("organization_id", "account_id", "sequence"),
    ForeignKeyConstraint(["organization_id", "account_id"], ["accounts.organization_id", "accounts.id"]))
sync_runs = Table("hubspot_sync_runs", metadata,
    Column("id", String(80), primary_key=True), Column("organization_id", String(80), nullable=False),
    Column("account_id", String(80), nullable=False), Column("observation_id", String(80), nullable=True),
    Column("payload", JSON, nullable=False),
    ForeignKeyConstraint(["organization_id", "account_id"], ["accounts.organization_id", "accounts.id"]),
    ForeignKeyConstraint(["organization_id", "observation_id"], ["hubspot_observations.organization_id", "hubspot_observations.id"]))


class HubSpotSync:
    def __init__(self, store, connector, token, *, session_hash=None):
        self.engine, self.connector, self.token = store.engine, connector, token
        self.session_hash = session_hash if session_hash is not None else token_digest(token or "")

    @contextmanager
    def transaction(self, *, write=False):
        with self.engine.connect() as connection:
            try:
                if self.engine.dialect.name == "sqlite":
                    connection.exec_driver_sql("BEGIN IMMEDIATE" if write else "BEGIN")
                else:
                    connection.begin()
                    # Match Workflow's organization lock, then current user/session/account.
                    key = int.from_bytes(hashlib.sha256((self.connector.settings.hubspot_organization_id)
                                                       .encode()).digest()[:8], "big", signed=True)
                    connection.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": key})
                row = connection.execute(select(users).join(sessions, sessions.c.user_id == users.c.id).where(
                    sessions.c.token_hash == self.session_hash,
                    sessions.c.expires_at > int(datetime.now(UTC).timestamp()), users.c.enabled.is_(True))
                    .with_for_update()).mappings().first()
                if row is None:
                    raise PolicyDenied("authentication_required", 401)
                actor = Actor(**{key: row[key] for key in ("id", "username", "organization_id", "role")})
                if actor.organization_id != self.connector.settings.hubspot_organization_id:
                    raise PolicyDenied("record_not_found", 404)
                if write and actor.role != "admin":
                    raise PolicyDenied("hubspot_admin_required", 403)
                yield connection, actor
                connection.commit()
            except BaseException:
                connection.rollback()
                raise

    def account(self, connection, actor, account_id, expected=None, *, require_mapping=True):
        payload = connection.execute(select(accounts.c.payload).where(
            accounts.c.organization_id == actor.organization_id, accounts.c.id == str(account_id))
            .with_for_update()).scalar()
        if payload is None or (require_mapping and str(account_id) not in self.connector.settings.hubspot_company_map):
            raise PolicyDenied("record_not_found", 404)
        account = Account.model_validate(payload)
        if expected is not None and account.revision != expected:
            raise PolicyDenied("stale_account_revision", 409)
        return account

    def latest(self, connection, organization_id, account_id):
        payload = connection.execute(select(observations.c.payload).where(
            observations.c.organization_id == organization_id, observations.c.account_id == str(account_id))
            .order_by(observations.c.sequence.desc()).limit(1)).scalar()
        return HubSpotObservation.model_validate(payload) if payload else None

    def get(self, table, record_id, contract):
        with self.transaction() as (connection, actor):
            payload = connection.execute(select(table.c.payload).where(
                table.c.organization_id == actor.organization_id, table.c.id == str(record_id))).scalar()
            if payload is None:
                raise PolicyDenied("record_not_found", 404)
            record = contract.model_validate(payload)
            self.account(connection, actor, record.account_id)
            return record

    def sync(self, account_id, expected, *, guard=None, run_id=None):
        if not self.connector.configured:
            raise PolicyDenied("hubspot_unconfigured", 503)
        with self.transaction(write=True) as (connection, actor):
            account = self.account(connection, actor, account_id, expected)
            if guard:
                guard(connection, actor)
            previous = self.latest(connection, actor.organization_id, account_id)
        company_id = self.connector.settings.hubspot_company_map[str(account_id)]
        started = datetime.now(UTC)
        result, error_code = None, None
        def before_request():
            with self.transaction(write=True) as (connection, current):
                self.account(connection, current, account_id, account.revision)
                guard(connection, current)
        try:
            # Both provider GETs run outside database transactions/locks. No automatic retry.
            result = (self.connector.read_company(company_id, before_request=before_request) if guard
                      else self.connector.read_company(company_id))
        except HubSpotFailure as error:
            error_code = str(error)
        with self.transaction(write=True) as (connection, current):
            if current.id != actor.id or current.organization_id != actor.organization_id:
                raise PolicyDenied("membership_changed", 409)
            self.account(connection, current, account_id, account.revision)
            if guard:
                guard(connection, current)
            latest = self.latest(connection, current.organization_id, account_id)
            run = HubSpotSyncRun(id=run_id or uuid4(), organization_id=current.organization_id, account_id=account_id,
                actor_id=current.id, account_revision=account.revision,
                portal_id=self.connector.settings.hubspot_portal_id, company_id=company_id,
                started_at=started, finished_at=datetime.now(UTC), status="failed", error_code=error_code)
            if result is not None:
                fingerprint = hashlib.sha256(json.dumps({"portal_id": run.portal_id,
                    **result.model_dump(mode="json")}, sort_keys=True, separators=(",", ":"),
                    ensure_ascii=False).encode()).hexdigest()
                if latest and latest.portal_id == run.portal_id and latest.company_id == company_id and latest.fingerprint == fingerprint:
                    run.disposition, run.observation_id = "unchanged", latest.id
                else:
                    if (latest.id if latest else None) != (previous.id if previous else None):
                        raise PolicyDenied("observation_changed_during_sync", 409)
                    if (latest and latest.portal_id == run.portal_id and latest.company_id == company_id
                            and result.updated_at < latest.provider_updated_at):
                        raise PolicyDenied("source_time_regressed", 409)
                    observation = HubSpotObservation(id=uuid4(), organization_id=current.organization_id,
                        account_id=account_id, account_revision=account.revision, portal_id=run.portal_id,
                        company_id=company_id, source_record=f"https://api.hubapi.com/crm/v3/objects/companies/{company_id}",
                        provider_created_at=result.created_at, provider_updated_at=result.updated_at,
                        fetched_at=run.finished_at, fingerprint=fingerprint,
                        sequence=latest.sequence + 1 if latest else 1, properties=result.properties,
                        property_types=result.property_types, mapping_hash=result.mapping_hash,
                        property_mapping=result.property_mapping)
                    connection.execute(observations.insert().values(id=str(observation.id),
                        organization_id=current.organization_id, account_id=str(account_id), sequence=observation.sequence,
                        payload=observation.model_dump(mode="json")))
                    run.disposition, run.observation_id = "changed" if latest else "baseline", observation.id
                run.status = "succeeded"
            connection.execute(sync_runs.insert().values(id=str(run.id), organization_id=current.organization_id,
                account_id=str(account_id), observation_id=str(run.observation_id) if run.observation_id else None,
                payload=run.model_dump(mode="json")))
            return run

    def _preview(self, connection, actor, account):
        observation = self.latest(connection, actor.organization_id, account.id)
        if observation is None:
            raise PolicyDenied("observation_not_available", 409)
        if (observation.portal_id != self.connector.settings.hubspot_portal_id
                or observation.company_id != self.connector.settings.hubspot_company_map[account.id]
                or observation.mapping_hash != self.connector.mapping_hash
                or observation.property_mapping != self.connector.settings.hubspot_property_map
                or observation.property_types != self.connector.property_types()):
            raise PolicyDenied("observation_configuration_changed", 409)
        return normalize(account, observation, self.connector), observation

    def preview(self, account_id):
        with self.transaction() as (connection, actor):
            account = self.account(connection, actor, account_id)
            preview, _ = self._preview(connection, actor, account)
            return preview

    def _select(self, connection, actor, previous, target, facts, selection):
        version = AccountSourceVersion(account_id=previous.id, selection=selection, account=target, evidence=facts,
            previous_account=previous, previous_evidence=selected_evidence(connection, actor.organization_id, previous.id))
        changed = connection.execute(update(accounts).where(accounts.c.id == previous.id,
            accounts.c.organization_id == actor.organization_id, accounts.c.revision == previous.revision)
            .values(revision=target.revision, payload=target.model_dump(mode="json")))
        if changed.rowcount != 1:
            raise PolicyDenied("stale_account_revision", 409)
        connection.execute(source_versions.insert().values(id=selection.id, organization_id=actor.organization_id,
            account_id=previous.id, account_revision=target.revision, payload=version.model_dump(mode="json")))
        return selection

    def promote(self, account_id, body):
        if not self.connector.configured:
            raise PolicyDenied("hubspot_unconfigured", 503)
        with self.transaction(write=True) as (connection, actor):
            account = self.account(connection, actor, account_id, body.expected_account_revision)
            preview, observation = self._preview(connection, actor, account)
            if observation.id != body.observation_id or preview.preview_hash != body.preview_hash:
                raise PolicyDenied("normalization_preview_changed", 409)
            current = selected_source(connection, actor.organization_id, account.id)
            if (current and current["selection"]["kind"] == "hubspot"
                    and current["selection"]["observation_id"] == str(observation.id)
                    and current["selection"]["account_revision"] == account.revision
                    and current["selection"]["mapping_hash"] == preview.mapping_hash):
                return AccountSource.model_validate(current["selection"])
            # Reselecting an unchanged observation requires a read at the current revision.
            bound_runs = connection.execute(select(sync_runs.c.payload).where(
                sync_runs.c.organization_id == actor.organization_id,
                sync_runs.c.account_id == account.id, sync_runs.c.observation_id == str(observation.id))).scalars()
            if not any(run.get("account_revision") == account.revision and run["status"] == "succeeded"
                       for run in bound_runs):
                raise PolicyDenied("observation_account_revision_changed", 409)
            selection = AccountSource(id=str(uuid4()), kind="hubspot", account_revision=preview.account.revision,
                actor_id=actor.id, selected_at=datetime.now(UTC), observation_id=str(observation.id),
                provider_updated_at=observation.provider_updated_at, mapping_hash=preview.mapping_hash,
                field_status=preview.field_status)
            return self._select(connection, actor, account, preview.account, preview.evidence, selection)

    def restore_sample(self, account_id, expected):
        with self.transaction(write=True) as (connection, actor):
            account = self.account(connection, actor, account_id, expected)
            current = selected_source(connection, actor.organization_id, account_id)
            if current is None:
                raise PolicyDenied("source_not_selected", 409)
            if current["selection"]["kind"] == "local_sample":
                return AccountSource.model_validate(current["selection"])
            original = connection.execute(select(source_versions.c.payload).where(
                source_versions.c.organization_id == actor.organization_id,
                source_versions.c.account_id == str(account_id)).order_by(source_versions.c.account_revision).limit(1)).scalar_one()
            version = AccountSourceVersion.model_validate(original)
            if not version.previous_account.synthetic or not all(item.synthetic for item in version.previous_evidence):
                raise PolicyDenied("sample_snapshot_not_available", 409)
            restored = version.previous_account.model_copy(update={"revision": account.revision + 1})
            selection = AccountSource(id=str(uuid4()), kind="local_sample", account_revision=restored.revision,
                actor_id=actor.id, selected_at=datetime.now(UTC))
            return self._select(connection, actor, account, restored, version.previous_evidence, selection)

    def source_version(self, source_id):
        with self.transaction() as (connection, actor):
            payload = connection.execute(select(source_versions.c.payload).where(
                source_versions.c.organization_id == actor.organization_id, source_versions.c.id == str(source_id))).scalar()
            if payload is None:
                raise PolicyDenied("record_not_found", 404)
            version = AccountSourceVersion.model_validate(payload)
            self.account(connection, actor, version.account_id)
            return version

    def _source_snapshot(self, connection, version):
        observation = None
        if version.selection.observation_id:
            payload = connection.execute(select(observations.c.payload).where(
                observations.c.organization_id == version.account.organization_id,
                observations.c.account_id == str(version.account_id),
                observations.c.id == version.selection.observation_id)).scalar()
            observation = HubSpotObservation.model_validate(payload) if payload else None
        return snapshot(version, observation)

    def detect_changes(self, account_id, body):
        with self.transaction(write=True) as (connection, actor):
            account = self.account(connection, actor, account_id, body.expected_account_revision)
            current = selected_source(connection, actor.organization_id, account.id)
            if current is None or current["selection"]["id"] != str(body.expected_source_id):
                raise PolicyDenied("source_selection_changed", 409)
            cursor = connection.execute(select(detections.c.account_revision).where(
                detections.c.organization_id == actor.organization_id, detections.c.account_id == account.id)
                .order_by(detections.c.account_revision.desc()).limit(1)).scalar()
            pending = connection.execute(select(source_versions.c.payload).where(
                source_versions.c.organization_id == actor.organization_id, source_versions.c.account_id == account.id,
                source_versions.c.account_revision > (cursor or 0))
                .order_by(source_versions.c.account_revision).limit(21)).scalars().all()
            previous = None
            if cursor is not None:
                previous = connection.execute(select(source_versions.c.payload).where(
                    source_versions.c.organization_id == actor.organization_id, source_versions.c.account_id == account.id,
                    source_versions.c.account_revision == cursor)).scalar_one()
            before = self._source_snapshot(connection, AccountSourceVersion.model_validate(previous)) if previous else None
            processed, detected_at = [], datetime.now(UTC)
            for payload in pending[:20]:
                after = self._source_snapshot(connection, AccountSourceVersion.model_validate(payload))
                result = detect(actor.organization_id, account.id, actor.id, before, after, detected_at)
                connection.execute(detections.insert().values(id=str(result.id), organization_id=actor.organization_id,
                    account_id=account.id, source_version_id=str(after.source_version_id),
                    account_revision=after.account_revision, payload=result.model_dump(mode="json")))
                processed.append(result)
                before, cursor = after, after.account_revision
            return SourceDetectionBatch(organization_id=actor.organization_id, account_id=account.id,
                account_revision=account.revision, selected_source_id=body.expected_source_id,
                processed=processed, last_processed_revision=cursor, has_more=len(pending) > 20)

    def detection_history(self, account_id):
        with self.transaction() as (connection, actor):
            self.account(connection, actor, account_id)
            payloads = connection.execute(select(detections.c.payload).where(
                detections.c.organization_id == actor.organization_id, detections.c.account_id == str(account_id))
                .order_by(detections.c.account_revision.desc()).limit(20)).scalars()
            return [SourceDetection.model_validate(payload) for payload in payloads]


def install_hubspot_routes(app, store, identity, settings, transport=None):
    connector = HubSpot(settings, transport)
    router = APIRouter(prefix=PREFIX)

    def current(request: Request):
        if settings.auth_mode != "session":
            raise PolicyDenied("session_identity_required", 503)
        actor = identity.resolve(request.cookies.get("vitaai_session"))
        if actor is None:
            raise PolicyDenied("authentication_required", 401)
        return actor

    def service(request: Request):
        return HubSpotSync(store, connector, request.cookies.get("vitaai_session"))

    Current = Annotated[Actor, Depends(current)]
    Service = Annotated[HubSpotSync, Depends(service)]

    @router.get("", response_model=HubSpotStatus)
    def status(actor: Current):
        return connector.status(actor.organization_id)

    @router.post("/accounts/{account_id}/sync", response_model=HubSpotSyncRun)
    def sync(account_id: UUID, body: HubSpotSyncRequest, actor: Current, operation: Service):
        return operation.sync(account_id, body.expected_account_revision)

    @router.get("/accounts/{account_id}/refresh-schedule", response_model=RefreshScheduleView)
    def refresh_schedule(account_id: UUID, actor: Current, operation: Service):
        return RefreshAuthorizations(operation).view(account_id)

    @router.post("/accounts/{account_id}/refresh-schedule", response_model=RefreshAuthorization)
    def authorize_refresh(account_id: UUID, body: RefreshGrantRequest, actor: Current, operation: Service):
        return RefreshAuthorizations(operation).grant(account_id, body)

    @router.post("/accounts/{account_id}/refresh-schedule/revoke", response_model=RefreshAuthorization)
    def revoke_refresh(account_id: UUID, body: RefreshRevokeRequest, actor: Current, operation: Service):
        return RefreshAuthorizations(operation).revoke(account_id, body)

    @router.get("/accounts/{account_id}/refresh-occurrences", response_model=list[RefreshOccurrence])
    def refresh_history(account_id: UUID, actor: Current, operation: Service):
        return RefreshAuthorizations(operation).history(account_id)

    @router.get("/refresh-occurrences/{record_id}", response_model=RefreshOccurrence)
    def refresh_occurrence(record_id: UUID, actor: Current, operation: Service):
        return RefreshAuthorizations(operation).inspect(record_id)

    @router.get("/refresh-occurrences/{record_id}/recovery-readiness", response_model=RefreshRecoveryReadiness)
    def refresh_recovery_readiness(record_id: UUID, actor: Current, operation: Service):
        return RefreshAuthorizations(operation).recovery_readiness(record_id)

    @router.post("/refresh-occurrences/{record_id}/recover", response_model=RefreshOccurrence)
    def refresh_recover(record_id: UUID, body: RefreshRecoveryRequest, actor: Current, operation: Service):
        return RefreshAuthorizations(operation).recover(record_id, body)

    @router.get("/runs/{run_id}", response_model=HubSpotSyncRun)
    def get_run(run_id: UUID, actor: Current, operation: Service):
        return operation.get(sync_runs, run_id, HubSpotSyncRun)

    @router.get("/observations/{observation_id}", response_model=HubSpotObservation)
    def get_observation(observation_id: UUID, actor: Current, operation: Service):
        return operation.get(observations, observation_id, HubSpotObservation)

    @router.get("/accounts/{account_id}/preview", response_model=HubSpotPreview)
    def preview(account_id: UUID, actor: Current, operation: Service):
        return operation.preview(account_id)

    @router.post("/accounts/{account_id}/promote", response_model=AccountSource)
    def promote(account_id: UUID, body: HubSpotPromoteRequest, actor: Current, operation: Service):
        return operation.promote(account_id, body)

    @router.post("/accounts/{account_id}/restore-sample", response_model=AccountSource)
    def restore_sample(account_id: UUID, body: HubSpotSyncRequest, actor: Current, operation: Service):
        return operation.restore_sample(account_id, body.expected_account_revision)

    @router.get("/sources/{source_id}", response_model=AccountSourceVersion)
    def source_version(source_id: UUID, actor: Current, operation: Service):
        return operation.source_version(source_id)

    @router.post("/accounts/{account_id}/detect-changes", response_model=SourceDetectionBatch)
    def detect_changes(account_id: UUID, body: SourceDetectionRequest, actor: Current, operation: Service):
        return operation.detect_changes(account_id, body)

    @router.get("/accounts/{account_id}/detections", response_model=list[SourceDetection])
    def detection_history(account_id: UUID, actor: Current, operation: Service):
        return operation.detection_history(account_id)

    @router.get("/detections/{detection_id}", response_model=SourceDetection)
    def detection(detection_id: UUID, actor: Current, operation: Service):
        return operation.get(detections, detection_id, SourceDetection)

    app.include_router(router)
