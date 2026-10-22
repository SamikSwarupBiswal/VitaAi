"""Bounded associated-object staging, separate from facts and workflow authority."""
import hashlib
import json
import re
from datetime import UTC, datetime, timedelta
from typing import Literal
from uuid import UUID, uuid4

import httpx
from pydantic import AwareDatetime, Field, ValidationError
from sqlalchemy import (
    JSON,
    Column,
    ForeignKeyConstraint,
    Integer,
    MetaData,
    String,
    Table,
    select,
    update,
)

from .governance import PolicyDenied
from .hubspot import HubSpot, HubSpotContract, HubSpotFailure
from .hubspot_refresh import RefreshAuthorizations
from .storage import accounts

ObjectType = Literal["contacts", "deals", "notes", "tasks", "calls", "meetings", "emails"]
PROPERTIES = {
    "contacts": ("firstname", "lastname", "email", "jobtitle"),
    "deals": ("dealname", "dealstage", "pipeline", "amount", "deal_currency_code", "closedate"),
    "calls": ("hs_call_title", "hs_call_body", "hs_call_status", "hs_call_direction", "hs_call_duration", "hs_timestamp"),
    "meetings": ("hs_meeting_title", "hs_meeting_body", "hs_meeting_start_time", "hs_meeting_end_time", "hs_meeting_outcome", "hs_timestamp"),
    "emails": ("hs_email_subject", "hs_email_text", "hs_email_direction", "hs_email_status", "hs_timestamp"),
    "notes": ("hs_note_body", "hs_timestamp"),
    "tasks": ("hs_task_subject", "hs_task_body", "hs_task_status", "hs_task_type", "hs_timestamp"),
}
metadata = MetaData()
accounts.to_metadata(metadata)
ingestions = Table("hubspot_ingestion_runs", metadata,
    Column("id", String(80), primary_key=True),
    Column("organization_id", String(80), nullable=False),
    Column("account_id", String(80), nullable=False),
    Column("sequence", Integer, nullable=False),
    Column("status", String(20), nullable=False),
    Column("payload", JSON, nullable=False),
    ForeignKeyConstraint(["organization_id", "account_id"], ["accounts.organization_id", "accounts.id"]))


class AssociationType(HubSpotContract):
    category: Literal["HUBSPOT_DEFINED", "USER_DEFINED", "INTEGRATOR_DEFINED"]
    type_id: int = Field(strict=True, ge=1)
    label: str | None = Field(max_length=200)


class AssociatedObject(HubSpotContract):
    object_id: str = Field(pattern=r"^[1-9][0-9]{0,19}$")
    created_at: AwareDatetime
    updated_at: AwareDatetime
    properties: dict[str, str | None]
    association_types: list[AssociationType] = Field(min_length=1, max_length=20)


class IngestionRequest(HubSpotContract):
    expected_account_revision: int = Field(strict=True, ge=1)
    expected_configuration_revision: int = Field(strict=True, ge=1)
    expected_configuration_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    object_type: ObjectType


class IngestionRun(HubSpotContract):
    id: UUID
    organization_id: str
    account_id: UUID
    account_revision: int
    actor_id: str
    portal_id: str
    company_id: str
    configuration_revision: int
    configuration_hash: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    object_type: ObjectType
    sequence: int
    revision: int = 1
    started_at: AwareDatetime
    worker_deadline_at: AwareDatetime
    finished_at: AwareDatetime | None = None
    status: Literal["pending", "succeeded", "failed", "interrupted"] = "pending"
    error_code: str | None = None
    fingerprint: str | None = None
    disposition: Literal["baseline", "unchanged", "changed"] | None = None
    previous_run_id: UUID | None = None
    objects: list[AssociatedObject] = Field(default_factory=list, max_length=20)
    recovered_by: str | None = None


class IngestionRecovery(HubSpotContract):
    expected_revision: int = Field(strict=True, ge=1)
    expected_account_revision: int = Field(strict=True, ge=1)
    expected_worker_deadline_at: AwareDatetime


class IngestionReadiness(HubSpotContract):
    organization_id: str
    account_id: UUID
    account_revision: int
    configuration_revision: int
    configuration_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    connector_configured: bool
    ingestion_enabled: bool
    can_start: bool
    reason: Literal["ready", "administrator_required", "hubspot_unconfigured", "hubspot_ingestion_disabled",
                    "company_mapping_unavailable", "ingestion_pending", "ingestion_cooldown"]
    pending_run_id: UUID | None = None
    cooldown_until: AwareDatetime | None = None


class IngestionRecoveryReadiness(HubSpotContract):
    run: IngestionRun
    account_revision: int
    eligible: bool
    reason: Literal["eligible", "administrator_required", "not_pending", "worker_active"]


class AssociatedReader(HubSpot):
    def read(self, company_id, object_type, *, before_request):
        if not self.configured or not self.settings.hubspot_ingestion_enabled:
            raise HubSpotFailure("hubspot_ingestion_unconfigured")
        if company_id not in self.settings.hubspot_company_map.values() or object_type not in PROPERTIES:
            raise HubSpotFailure("object_not_allowed")
        token = self.settings.hubspot_access_token.get_secret_value()
        with httpx.Client(base_url="https://api.hubapi.com", timeout=15, follow_redirects=False,
                          transport=self.transport, headers={"Authorization": "Bearer " + token}) as client:
            def get(path, params=None):
                before_request()
                return self._get(client, path, params=params)

            portal = get("/account-info/v3/details").get("portalId")
            if type(portal) is not int or str(portal) != self.settings.hubspot_portal_id:
                raise HubSpotFailure("portal_mismatch")
            associations, after, seen = {}, None, set()
            for _ in range(5):
                data = get(f"/crm/v4/objects/companies/{company_id}/associations/{object_type}",
                           {"limit": 20, **({"after": after} if after else {})})
                rows = data.get("results")
                if not isinstance(rows, list) or len(rows) > 20:
                    raise HubSpotFailure("invalid_response")
                try:
                    for row in rows:
                        raw_id = row["toObjectId"]
                        if type(raw_id) not in (str, int) or not re.fullmatch(r"[1-9][0-9]{0,19}", str(raw_id)):
                            raise HubSpotFailure("invalid_response")
                        object_id = str(raw_id)
                        types = [AssociationType(category=item["category"], type_id=item["typeId"], label=item["label"])
                                 for item in row["associationTypes"]]
                        if not 1 <= len(types) <= 20:
                            raise HubSpotFailure("invalid_response")
                        types.sort(key=lambda item: (item.category, item.type_id, item.label or ""))
                        if object_id in associations and associations[object_id] != types:
                            raise HubSpotFailure("association_changed_during_read")
                        associations[object_id] = types
                    if len(associations) > 20:
                        raise HubSpotFailure("ingestion_limit_exceeded")
                    paging = data.get("paging", {})
                    if not isinstance(paging, dict):
                        raise HubSpotFailure("invalid_response")
                    if "next" not in paging:
                        break
                    after = paging["next"]["after"]
                    if (not isinstance(after, str) or not re.fullmatch(r"[A-Za-z0-9_=-]{1,200}", after)
                            or after in seen or not rows):
                        raise HubSpotFailure("invalid_pagination")
                    seen.add(after)
                except (KeyError, TypeError, ValidationError):
                    raise HubSpotFailure("invalid_response") from None
            else:
                raise HubSpotFailure("ingestion_limit_exceeded")
            result = []
            for object_id, types in sorted(associations.items()):
                object_prefix = "/crm/objects/2026-09" if object_type in {"calls", "meetings", "emails"} else "/crm/v3/objects"
                data = get(f"{object_prefix}/{object_type}/{object_id}",
                           {"properties": ",".join(PROPERTIES[object_type]), "archived": "false"})
                try:
                    if data["id"] != object_id or data["archived"] is not False:
                        raise HubSpotFailure("object_identity_or_archive_mismatch")
                    properties = data["properties"]
                    if not isinstance(properties, dict):
                        raise HubSpotFailure("invalid_response")
                    selected = {key: properties[key] for key in PROPERTIES[object_type] if key in properties}
                    if any(value is not None and (not isinstance(value, str) or len(value) > 8000
                                                  or token in value) for value in selected.values()):
                        raise HubSpotFailure("invalid_response")
                    if any(item.label and token in item.label for item in types):
                        raise HubSpotFailure("invalid_response")
                    record = AssociatedObject(object_id=object_id, created_at=data["createdAt"],
                        updated_at=data["updatedAt"], properties=selected, association_types=types)
                    if record.created_at > record.updated_at or record.updated_at > datetime.now(UTC):
                        raise HubSpotFailure("invalid_source_time")
                    result.append(record.model_copy(update={"created_at": record.created_at.astimezone(UTC),
                                                            "updated_at": record.updated_at.astimezone(UTC)}))
                except (KeyError, TypeError, ValidationError):
                    raise HubSpotFailure("invalid_response") from None
            return result


class Ingestion:
    def __init__(self, operation):
        self.operation = operation

    def read_run(self, connection, actor, record_id):
        payload = connection.execute(select(ingestions.c.payload).where(
            ingestions.c.organization_id == actor.organization_id, ingestions.c.id == str(record_id))).scalar()
        if payload is None:
            raise PolicyDenied("record_not_found", 404)
        run = IngestionRun.model_validate(payload)
        self.operation.account(connection, actor, run.account_id, require_mapping=False)
        return run

    def inspect(self, record_id):
        with self.operation.transaction() as (connection, actor):
            return self.read_run(connection, actor, record_id)

    def history(self, account_id):
        with self.operation.transaction() as (connection, actor):
            self.operation.account(connection, actor, account_id, require_mapping=False)
            return [IngestionRun.model_validate(value) for value in connection.execute(select(ingestions.c.payload).where(
                ingestions.c.organization_id == actor.organization_id, ingestions.c.account_id == str(account_id))
                .order_by(ingestions.c.sequence.desc()).limit(20)).scalars()]

    def readiness(self, account_id):
        with self.operation.transaction() as (connection, actor):
            account = self.operation.account(connection, actor, account_id, require_mapping=False)
            settings = self.operation.connector.settings
            _, digest = RefreshAuthorizations(self.operation).binding(account_id)
            scope = (ingestions.c.organization_id == actor.organization_id,
                     ingestions.c.account_id == str(account_id))
            pending = connection.execute(select(ingestions.c.id).where(
                *scope, ingestions.c.status == "pending").order_by(ingestions.c.sequence.desc()).limit(1)).scalar()
            latest = connection.execute(select(ingestions.c.payload).where(*scope)
                .order_by(ingestions.c.sequence.desc()).limit(1)).scalar()
            now = datetime.now(UTC)
            cooldown_until = None
            if latest:
                last_started = IngestionRun.model_validate(latest).started_at + timedelta(seconds=60)
                if last_started > now:
                    cooldown_until = last_started
            if pending:
                reason = "ingestion_pending"
            elif actor.role != "admin":
                reason = "administrator_required"
            elif not self.operation.connector.configured:
                reason = "hubspot_unconfigured"
            elif not settings.hubspot_ingestion_enabled:
                reason = "hubspot_ingestion_disabled"
            elif str(account_id) not in settings.hubspot_company_map:
                reason = "company_mapping_unavailable"
            elif cooldown_until:
                reason = "ingestion_cooldown"
            else:
                reason = "ready"
            return IngestionReadiness(organization_id=actor.organization_id, account_id=account_id,
                account_revision=account.revision, configuration_revision=settings.hubspot_configuration_revision,
                configuration_hash=digest, connector_configured=self.operation.connector.configured,
                ingestion_enabled=settings.hubspot_ingestion_enabled, can_start=reason == "ready", reason=reason,
                pending_run_id=pending, cooldown_until=cooldown_until)

    def recovery_readiness(self, record_id):
        with self.operation.transaction() as (connection, actor):
            run = self.read_run(connection, actor, record_id)
            account = self.operation.account(connection, actor, run.account_id, require_mapping=False)
            if actor.role != "admin":
                reason = "administrator_required"
            elif run.status != "pending":
                reason = "not_pending"
            elif datetime.now(UTC) < run.worker_deadline_at:
                reason = "worker_active"
            else:
                reason = "eligible"
            return IngestionRecoveryReadiness(run=run, account_revision=account.revision,
                eligible=reason == "eligible", reason=reason)

    def save(self, connection, run):
        changed = run.model_copy(update={"revision": run.revision + 1})
        if connection.execute(update(ingestions).where(ingestions.c.id == str(run.id), ingestions.c.status == "pending",
                ingestions.c.payload["revision"].as_integer() == run.revision)
                .values(status=changed.status, payload=changed.model_dump(mode="json"))).rowcount != 1:
            raise PolicyDenied("ingestion_changed", 409)
        return changed

    def recover(self, record_id, body):
        with self.operation.transaction(write=True) as (connection, actor):
            run = self.read_run(connection, actor, record_id)
            self.operation.account(connection, actor, run.account_id, body.expected_account_revision, require_mapping=False)
            if (run.status != "pending" or run.revision != body.expected_revision
                    or run.worker_deadline_at != body.expected_worker_deadline_at):
                raise PolicyDenied("ingestion_changed", 409)
            if datetime.now(UTC) < run.worker_deadline_at:
                raise PolicyDenied("ingestion_worker_active", 409)
            return self.save(connection, run.model_copy(update={"status": "interrupted",
                "error_code": "ingestion_interrupted", "finished_at": datetime.now(UTC), "recovered_by": actor.id}))

    def start(self, account_id, body):
        op = self.operation
        settings = op.connector.settings.model_copy(deep=True)
        if not op.connector.configured or not settings.hubspot_ingestion_enabled:
            raise PolicyDenied("hubspot_ingestion_unconfigured", 503)
        with op.transaction(write=True) as (connection, actor):
            account = op.account(connection, actor, account_id, body.expected_account_revision)
            _, configuration_hash = RefreshAuthorizations(op).binding(account_id)
            if (op.connector.settings != settings
                    or settings.hubspot_configuration_revision != body.expected_configuration_revision
                    or configuration_hash != body.expected_configuration_hash):
                raise PolicyDenied("ingestion_configuration_changed", 409)
            scope = (ingestions.c.organization_id == actor.organization_id, ingestions.c.account_id == str(account_id))
            if connection.execute(select(ingestions.c.id).where(*scope, ingestions.c.status == "pending").limit(1)).first():
                raise PolicyDenied("ingestion_pending", 409)
            latest = connection.execute(select(ingestions.c.payload).where(*scope)
                .order_by(ingestions.c.sequence.desc()).limit(1)).scalar()
            now = datetime.now(UTC)
            previous = IngestionRun.model_validate(latest) if latest else None
            if previous and now < previous.started_at + timedelta(seconds=60):
                raise PolicyDenied("ingestion_cooldown", 409)
            last_success = connection.execute(select(ingestions.c.payload).where(*scope,
                ingestions.c.status == "succeeded", ingestions.c.payload["object_type"].as_string() == body.object_type)
                .order_by(ingestions.c.sequence.desc()).limit(1)).scalar()
            prior = IngestionRun.model_validate(last_success) if last_success else None
            run = IngestionRun(id=uuid4(), organization_id=actor.organization_id, account_id=account_id,
                account_revision=account.revision, actor_id=actor.id, portal_id=settings.hubspot_portal_id,
                company_id=settings.hubspot_company_map[str(account_id)],
                configuration_revision=settings.hubspot_configuration_revision, object_type=body.object_type,
                sequence=previous.sequence + 1 if previous else 1, started_at=now,
                worker_deadline_at=now + timedelta(minutes=2))
            run.configuration_hash = configuration_hash
            connection.execute(ingestions.insert().values(id=str(run.id), organization_id=run.organization_id,
                account_id=str(account_id), sequence=run.sequence, status="pending", payload=run.model_dump(mode="json")))

        def guard():
            with op.transaction(write=True) as (connection, current):
                retained = self.read_run(connection, current, run.id)
                op.account(connection, current, account_id, run.account_revision)
                if (op.connector.settings != settings or current.id != run.actor_id
                        or retained.status != "pending" or retained.revision != run.revision
                        or datetime.now(UTC) >= run.worker_deadline_at):
                    raise PolicyDenied("ingestion_authority_changed", 409)

        error, objects = None, []
        try:
            reader = AssociatedReader(settings, op.connector.transport)
            objects = reader.read(run.company_id, run.object_type, before_request=guard)
        except HubSpotFailure as failure:
            error = str(failure)
        guard()
        with op.transaction(write=True) as (connection, current):
            retained = self.read_run(connection, current, run.id)
            op.account(connection, current, account_id, run.account_revision)
            if (op.connector.settings != settings or current.id != run.actor_id or retained.status != "pending"
                    or retained.revision != run.revision or datetime.now(UTC) >= run.worker_deadline_at):
                raise PolicyDenied("ingestion_authority_changed", 409)
            run.finished_at = datetime.now(UTC)
            if error:
                run.status, run.error_code = "failed", error
            else:
                compatible = (prior and prior.configuration_hash is not None
                    and prior.configuration_hash == run.configuration_hash
                    and (prior.portal_id, prior.company_id, prior.configuration_revision) == (
                        run.portal_id, run.company_id, run.configuration_revision))
                if compatible:
                    old = {item.object_id: item for item in prior.objects}
                    for item in objects:
                        if item.object_id in old and (item.updated_at < old[item.object_id].updated_at or
                                item.created_at != old[item.object_id].created_at):
                            run.status, run.error_code = "failed", "ingestion_source_time_conflict"
                            return self.save(connection, run)
                run.fingerprint = hashlib.sha256(json.dumps([item.model_dump(mode="json") for item in objects],
                    sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
                run.status, run.objects = "succeeded", objects
                run.previous_run_id = prior.id if compatible else None
                run.disposition = ("unchanged" if compatible and run.fingerprint == prior.fingerprint
                                   else "changed" if compatible else "baseline")
            return self.save(connection, run)
