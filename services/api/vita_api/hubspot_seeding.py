"""Explicit synthetic creation/archive: exact review, durable claims, no retry."""
import hashlib
import json
import re
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal
from uuid import UUID, uuid4

import httpx
from pydantic import AwareDatetime, Field
from sqlalchemy import (
    JSON,
    BigInteger,
    Column,
    ForeignKeyConstraint,
    Integer,
    MetaData,
    String,
    Table,
    UniqueConstraint,
    or_,
    select,
    text,
    update,
)

from .governance import PolicyDenied, canonical_json
from .hubspot import HubSpotContract, HubSpotFailure, _unique_object
from .hubspot_execution import HubSpotWrites
from .hubspot_refresh import RefreshAuthorizations
from .hubspot_seed import SeedPreview, SeedPreviewRequest, preview_seed
from .identity import sessions, users
from .storage import accounts

metadata = MetaData()
accounts.to_metadata(metadata)
seeds = Table("hubspot_seed_jobs", metadata,
    Column("id", String(80), primary_key=True), Column("organization_id", String(80), nullable=False),
    Column("account_id", String(80), nullable=False), Column("sequence", Integer, nullable=False),
    Column("revision", Integer, nullable=False), Column("status", String(30), nullable=False),
    Column("expires_us", BigInteger, nullable=False),
    Column("review_session_hash", String(64)), Column("payload", JSON, nullable=False),
    UniqueConstraint("organization_id", "id"), UniqueConstraint("organization_id", "account_id", "sequence"),
    ForeignKeyConstraint(["organization_id", "account_id"], ["accounts.organization_id", "accounts.id"]))
versions = Table("hubspot_seed_versions", metadata,
    Column("job_id", String(80), primary_key=True), Column("revision", Integer, primary_key=True),
    Column("organization_id", String(80), nullable=False), Column("payload", JSON, nullable=False),
    ForeignKeyConstraint(["organization_id", "job_id"], ["hubspot_seed_jobs.organization_id", "hubspot_seed_jobs.id"]))
ACTIVE = ("draft", "approved", "claimed", "executing", "result_unknown")
PATH = "/crm/v3/objects/companies"
ASSOCIATIONS = {"contacts": 279, "deals": 5, "notes": 190}


class SeedPrepare(SeedPreviewRequest):
    include_contacts: bool = Field(default=False, strict=True)
    include_notes: bool = Field(default=False, strict=True)
    include_deals: bool = Field(default=False, strict=True)


class SeedItem(HubSpotContract):
    index: int
    object_type: Literal["companies", "contacts", "notes", "deals"] = "companies"
    parent_index: int | None = Field(default=None, ge=0, le=11)
    association_type_id: int | None = None
    provider_request: str
    resolved_request: str | None = None
    status: Literal["ready", "dispatching", "succeeded", "failed", "result_unknown", "skipped"] = "ready"
    resource_id: str | None = None
    dispatched_at: AwareDatetime | None = None
    finished_at: AwareDatetime | None = None
    verification: Literal["not_run", "verified", "mismatch", "unavailable"] = "not_run"
    verified_at: AwareDatetime | None = None
    verified_request_hash: str | None = None
    error_code: str | None = None
    archive_selected: bool = False
    archive_target_id: str | None = Field(default=None, pattern=r"^[1-9][0-9]{0,19}$")


class SeedJob(HubSpotContract):
    id: UUID
    organization_id: str
    account_id: UUID
    account_revision: int
    sequence: int
    revision: int = 1
    status: Literal["draft", "approved", "rejected", "claimed", "executing", "succeeded", "failed", "result_unknown", "interrupted"] = "draft"
    preview: SeedPreview
    test_portal_id: str
    binding_hash: str
    expires_at: AwareDatetime
    items: list[SeedItem] = Field(min_length=1, max_length=12)
    reviewed_by: str | None = None
    reviewed_at: AwareDatetime | None = None
    review_expires_at: AwareDatetime | None = None
    review_reason: str | None = None
    claimed_by: str | None = None
    claimed_at: AwareDatetime | None = None
    worker_deadline_at: AwareDatetime | None = None
    finished_at: AwareDatetime | None = None
    recovered_by: str | None = None
    recovered_at: AwareDatetime | None = None
    last_event: str = "preview_saved"
    last_actor_id: str
    last_event_at: AwareDatetime
    policy: Literal["synthetic-company-seed-1"] = "synthetic-company-seed-1"
    operation: Literal["create", "archive"] = "create"
    source_job_id: UUID | None = None


class SeedBinding(HubSpotContract):
    expected_revision: int = Field(strict=True, ge=1)
    expected_account_revision: int = Field(strict=True, ge=1)
    binding_hash: str = Field(pattern=r"^[a-f0-9]{64}$")


class SeedReview(SeedBinding):
    decision: Literal["approved", "rejected"]
    reason: str = Field(min_length=1, max_length=1000, pattern=r"\S")


class SeedRecovery(SeedBinding):
    expected_worker_deadline_at: AwareDatetime


class SeedCleanup(SeedBinding):
    item_indices: list[Annotated[int, Field(strict=True, ge=0, le=11)]] = Field(min_length=1, max_length=12)


class SeedReadiness(HubSpotContract):
    organization_id: str
    account_id: UUID
    account_revision: int
    configuration_hash: str
    portal_id: str
    test_portal_id: str
    configured: bool
    can_prepare: bool
    deal_pipeline: str
    deal_stage: str
    deal_seed_available: bool
    blocking_job_id: UUID | None = None


class SeedInspection(HubSpotContract):
    job: SeedJob
    account_revision: int
    can_review: bool
    can_execute: bool
    can_reconcile: bool
    can_recover: bool
    can_prepare_cleanup: bool = False


class SeedTransport(HubSpotWrites):
    def verify_cleanup_target(self, item, before_request):
        verification, error = self.verify_item(item, before_request)
        if verification != "verified" or item.object_type != "companies":
            return verification, error
        try:
            # Never archive a company now linked to unrelated or remaining active records.
            for object_type in ("contacts", "deals", "notes", "tasks", "calls", "meetings", "emails"):
                before_request()
                with self.client() as client:
                    data = self._get(client, f"/crm/v4/objects/companies/{item.archive_target_id}/associations/{object_type}",
                        params={"limit": "100"})
                if data.get("paging") or data.get("results") != []:
                    return "mismatch", "seed_cleanup_associations_remaining"
            return "verified", None
        except HubSpotFailure:
            return "unavailable", "seed_cleanup_associations_unavailable"

    def archive_item(self, item):
        try:
            with self.client() as client, client.stream("DELETE",
                    f"/crm/v3/objects/{item.object_type}/{item.archive_target_id}") as response:
                if response.status_code in {400, 401, 403, 404, 422}:
                    return "failed", item.archive_target_id, "seed_archive_rejected"
                if response.status_code != 204:
                    return "result_unknown", item.archive_target_id, "seed_archive_ambiguous"
                return "result_unknown", item.archive_target_id, "seed_archive_readback_pending"
        except httpx.RequestError:
            return "result_unknown", item.archive_target_id, "seed_archive_ambiguous"

    def verify_archived(self, item, before_request):
        try:
            self.verify_portal(before_request)
            before_request()
            expected = json.loads(item.resolved_request)["properties"]
            with self.client() as client:
                data = self._get(client, f"/crm/v3/objects/{item.object_type}/{item.archive_target_id}",
                    params={"properties": ",".join(sorted(expected)), "archived": "true"})
            if (data.get("id") != item.archive_target_id or data.get("archived") is not True
                    or not isinstance(data.get("properties"), dict)
                    or any(not self.property_matches(key, data["properties"].get(key), value)
                        for key, value in expected.items())):
                return "mismatch", "seed_archive_readback_mismatch"
            return "verified", None
        except (HubSpotFailure, ValueError, TypeError, AttributeError):
            return "unavailable", "seed_archive_readback_unavailable"

    def verify_portal(self, before_request):
        before_request()
        with self.client() as client:
            portal = self._get(client, "/account-info/v3/details").get("portalId")
        if type(portal) is not int or str(portal) != self.settings.hubspot_portal_id:
            raise HubSpotFailure("seed_portal_mismatch")

    def create_item(self, item):
        try:
            path = "/crm/v3/objects/" + item.object_type
            with self.client() as client, client.stream("POST", path, content=item.resolved_request.encode("utf-8"),
                    headers={"Content-Type": "application/json"}) as response:
                if response.status_code in {400, 401, 403, 404, 422}:
                    return "failed", None, "seed_write_rejected"
                if response.status_code != 201:
                    return "result_unknown", None, "seed_write_ambiguous"
                body = bytearray()
                for chunk in response.iter_bytes():
                    body.extend(chunk)
                    if len(body) > 65536:
                        return "result_unknown", None, "seed_write_ambiguous"
                data = json.loads(body, object_pairs_hook=_unique_object)
                resource_id = data.get("id")
                if (not isinstance(resource_id, str) or not re.fullmatch(r"[1-9][0-9]{0,19}", resource_id)
                        or self.settings.hubspot_access_token.get_secret_value() in body.decode("utf-8")):
                    return "result_unknown", None, "seed_write_ambiguous"
                return "result_unknown", resource_id, "seed_readback_pending"
        except (httpx.RequestError, ValueError, AttributeError, UnicodeError, RecursionError):
            return "result_unknown", None, "seed_write_ambiguous"

    def verify_item(self, item, before_request):
        if not item.resource_id or not re.fullmatch(r"[1-9][0-9]{0,19}", item.resource_id):
            return "unavailable", "seed_resource_id_missing"
        try:
            self.verify_portal(before_request)
            before_request()
            expected = json.loads(item.resolved_request)["properties"]
            with self.client() as client:
                data = self._get(client, "/crm/v3/objects/" + item.object_type + "/" + item.resource_id,
                    params={"properties": ",".join(sorted(expected)), "archived": "false"})
            properties = data.get("properties")
            if (data.get("id") != item.resource_id or data.get("archived") is not False
                    or not isinstance(properties, dict)
                    or any(not self.property_matches(key, properties.get(key), value) for key, value in expected.items())):
                return "mismatch", "seed_readback_mismatch"
            if item.object_type != "companies":
                before_request()
                with self.client() as client:
                    links = self._get(client, f"/crm/v4/objects/{item.object_type}/{item.resource_id}/associations/companies",
                        params={"limit": "100"})
                target = json.loads(item.resolved_request)["associations"][0]["to"]["id"]
                rows = links.get("results")
                if (links.get("paging") or not isinstance(rows, list) or len(rows) != 1
                        or type(rows[0].get("toObjectId")) is not int or str(rows[0]["toObjectId"]) != target
                        or not isinstance(rows[0].get("associationTypes"), list)
                        or not any(link.get("category") == "HUBSPOT_DEFINED"
                            and type(link.get("typeId")) is int and link["typeId"] == item.association_type_id
                            for link in rows[0]["associationTypes"] if isinstance(link, dict))):
                    return "mismatch", "seed_association_mismatch"
            return "verified", None
        except (HubSpotFailure, ValueError, TypeError, AttributeError):
            return "unavailable", "seed_readback_unavailable"

    @staticmethod
    def property_matches(key, observed, expected):
        if key != "hs_timestamp":
            return observed == expected
        try:
            value = datetime.fromisoformat(observed)
            return value.tzinfo is not None and value.astimezone(UTC) == datetime.fromisoformat(expected)
        except (ValueError, TypeError, OverflowError):
            return False


class Seeding:
    def __init__(self, operation):
        self.operation = operation
        self.transport = SeedTransport(operation.connector.settings, operation.connector.transport)

    def available(self, operation="create"):
        s = self.operation.connector.settings
        enabled = s.hubspot_cleanup_enabled if operation == "archive" else s.hubspot_seed_enabled
        return bool(self.operation.connector.configured and enabled and s.hubspot_write_enabled
            and s.hubspot_seed_test_portal_id and s.hubspot_seed_test_portal_id == s.hubspot_portal_id)

    def blocking(self, connection, actor, account_id):
        # Age releases only unclaimed previews, never claimed or unknown work.
        return connection.execute(select(seeds.c.id).where(seeds.c.organization_id == actor.organization_id,
            seeds.c.account_id == str(account_id), seeds.c.status.in_(ACTIVE),
            or_(seeds.c.status.in_(("claimed", "executing", "result_unknown")),
                seeds.c.expires_us > int(datetime.now(UTC).timestamp() * 1_000_000)))
            .order_by(seeds.c.sequence.desc()).limit(1)).scalar()

    def readiness(self, account_id):
        with self.operation.transaction() as (connection, actor):
            account = self.operation.account(connection, actor, account_id, require_mapping=False)
            _, digest = RefreshAuthorizations(self.operation).binding(account_id)
            blocking = self.blocking(connection, actor, account_id)
            return SeedReadiness(organization_id=actor.organization_id, account_id=account_id,
                account_revision=account.revision, configuration_hash=digest,
                portal_id=self.transport.settings.hubspot_portal_id,
                test_portal_id=self.transport.settings.hubspot_seed_test_portal_id,
                configured=self.available(), can_prepare=self.available() and actor.role == "admin"
                    and str(account_id) in self.transport.settings.hubspot_company_map and blocking is None,
                deal_pipeline=self.transport.settings.hubspot_seed_deal_pipeline,
                deal_stage=self.transport.settings.hubspot_seed_deal_stage,
                deal_seed_available=bool(self.transport.settings.hubspot_seed_deal_pipeline
                    and self.transport.settings.hubspot_seed_deal_stage),
                blocking_job_id=blocking)

    def load(self, connection, actor, job_id):
        row = connection.execute(select(seeds).where(seeds.c.id == str(job_id),
            seeds.c.organization_id == actor.organization_id)).mappings().first()
        if not row:
            raise PolicyDenied("record_not_found", 404)
        job = SeedJob.model_validate(row["payload"])
        account = self.operation.account(connection, actor, job.account_id, require_mapping=False)
        return job, account, row["review_session_hash"]

    def context_matches(self, job, account, *, readback=False):
        _, digest = RefreshAuthorizations(self.operation).binding(job.account_id)
        deals_match = all(json.loads(item.provider_request)["properties"].get("pipeline")
                == self.transport.settings.hubspot_seed_deal_pipeline
            and json.loads(item.provider_request)["properties"].get("dealstage")
                == self.transport.settings.hubspot_seed_deal_stage for item in job.items if item.object_type == "deals")
        return ((readback or (account.revision == job.account_revision and (job.operation == "archive" or deals_match))) and digest == job.preview.configuration_hash
            and job.test_portal_id == self.transport.settings.hubspot_seed_test_portal_id
            and job.test_portal_id == self.transport.settings.hubspot_portal_id)

    def reviewer_valid(self, connection, job, session_hash):
        return bool(session_hash and connection.execute(select(users.c.id).join(sessions,
            sessions.c.user_id == users.c.id).where(sessions.c.token_hash == session_hash,
            sessions.c.expires_at > int(datetime.now(UTC).timestamp()), users.c.id == job.reviewed_by,
            users.c.organization_id == job.organization_id, users.c.role == "admin", users.c.enabled.is_(True))).scalar())

    def inspection(self, job_id):
        with self.operation.transaction() as (connection, actor):
            job, account, session_hash = self.load(connection, actor, job_id)
            now = datetime.now(UTC)
            current = actor.role == "admin" and self.context_matches(job, account) and self.available(job.operation)
            return SeedInspection(job=job, account_revision=account.revision,
                can_review=current and job.status == "draft" and now < job.expires_at,
                can_execute=current and job.status == "approved" and now < job.expires_at
                    and job.review_expires_at is not None and now < job.review_expires_at
                    and self.reviewer_valid(connection, job, session_hash),
                can_reconcile=actor.role == "admin" and job.status == "result_unknown"
                    and self.transport.configured and self.context_matches(job, account, readback=True)
                    and any(item.status == "result_unknown" and item.resource_id for item in job.items),
                can_recover=actor.role == "admin" and job.status in {"claimed", "executing"}
                    and job.worker_deadline_at is not None and now >= job.worker_deadline_at,
                can_prepare_cleanup=actor.role == "admin" and job.operation == "create"
                    and job.status in {"succeeded", "failed"} and self.available("archive")
                    and self.context_matches(job, account, readback=True)
                    and self.blocking(connection, actor, job.account_id) is None
                    and any(item.status == "succeeded" and item.verification == "verified" for item in job.items))

    @staticmethod
    def archive_claims(connection, job, *, verified_only=False):
        rows = connection.execute(select(seeds.c.payload).where(seeds.c.organization_id == job.organization_id,
            seeds.c.account_id == str(job.account_id), seeds.c.payload["operation"].as_string() == "archive",
            seeds.c.payload["source_job_id"].as_string() == str(job.source_job_id),
            seeds.c.payload["claimed_at"].as_string().is_not(None)).limit(13)).scalars().all()
        if len(rows) > 12:
            raise PolicyDenied("seed_archive_history_unavailable", 409)
        return {item.archive_target_id for payload in rows for item in SeedJob.model_validate(payload).items
            if item.archive_selected and (not verified_only or item.status == "succeeded" and item.verification == "verified")}

    def prepare_cleanup(self, job_id, body):
        with self.operation.transaction(write=True) as (connection, actor):
            original, account, _ = self.load(connection, actor, job_id)
            self.check_body(original, account, body)
            chosen = set(body.item_indices)
            if (len(chosen) != len(body.item_indices) or any(type(index) is not int or index < 0
                    or index >= len(original.items) for index in chosen)
                    or original.operation != "create" or original.status not in {"succeeded", "failed"}
                    or not self.available("archive") or not self.context_matches(original, account, readback=True)
                    or self.blocking(connection, actor, original.account_id)):
                raise PolicyDenied("seed_cleanup_preview_unavailable", 409)
            if any(original.items[index].status != "succeeded" or original.items[index].verification != "verified"
                    or not original.items[index].resource_id for index in chosen):
                raise PolicyDenied("seed_cleanup_requires_verified_resources", 409)
            archived = self.archive_claims(connection, original.model_copy(update={"source_job_id": original.id}), verified_only=True)
            for index in chosen:
                if original.items[index].object_type == "companies" and any(
                        item.parent_index == index and item.resource_id and item.index not in chosen
                        and item.resource_id not in archived
                        for item in original.items):
                    raise PolicyDenied("seed_cleanup_requires_all_children", 409)
            now = datetime.now(UTC)
            expiry = connection.execute(select(sessions.c.expires_at).where(
                sessions.c.token_hash == self.operation.session_hash)).scalar_one()
            sequence = connection.execute(select(seeds.c.sequence).where(seeds.c.organization_id == actor.organization_id,
                seeds.c.account_id == str(original.account_id)).order_by(seeds.c.sequence.desc()).limit(1)).scalar_one()
            items = [item.model_copy(deep=True, update={"archive_selected": item.index in chosen,
                "archive_target_id": item.resource_id if item.status == "succeeded" and item.verification == "verified" else None,
                "status": "ready" if item.index in chosen else "skipped", "resource_id": None,
                "dispatched_at": None, "finished_at": None, "verification": "not_run", "verified_at": None,
                "verified_request_hash": None, "error_code": None}) for item in original.items]
            job = SeedJob(id=uuid4(), organization_id=actor.organization_id, account_id=original.account_id,
                account_revision=account.revision, sequence=sequence + 1, preview=original.preview,
                test_portal_id=original.test_portal_id, binding_hash="", expires_at=min(now + timedelta(minutes=10),
                    datetime.fromtimestamp(expiry, UTC)), items=items, operation="archive", source_job_id=original.id,
                last_event="cleanup_preview_saved", last_actor_id=actor.id, last_event_at=now)
            claimed = self.archive_claims(connection, job)
            if any(item.archive_selected and item.archive_target_id in claimed for item in items):
                raise PolicyDenied("seed_archive_already_claimed", 409)
            job.binding_hash = hashlib.sha256(canonical_json(job.model_dump(mode="json", exclude={"binding_hash"}))).hexdigest()
            self.save(connection, job)
            return job

    def history(self, account_id):
        with self.operation.transaction() as (connection, actor):
            self.operation.account(connection, actor, account_id, require_mapping=False)
            rows = connection.execute(select(seeds.c.payload).where(seeds.c.organization_id == actor.organization_id,
                seeds.c.account_id == str(account_id)).order_by(seeds.c.sequence.desc()).limit(20)).scalars()
            return [SeedJob.model_validate(payload) for payload in rows]

    def history_versions(self, job_id):
        with self.operation.transaction() as (connection, actor):
            self.load(connection, actor, job_id)
            rows = connection.execute(select(versions.c.payload).where(
                versions.c.organization_id == actor.organization_id, versions.c.job_id == str(job_id))
                .order_by(versions.c.revision.desc()).limit(100)).scalars().all()
            return [SeedJob.model_validate(payload) for payload in reversed(rows)]

    @staticmethod
    def save(connection, job, *, previous=None, session_hash=None):
        fields = {"revision": job.revision, "status": job.status, "payload": job.model_dump(mode="json")}
        if previous is None:
            connection.execute(seeds.insert().values(id=str(job.id), organization_id=job.organization_id,
                account_id=str(job.account_id), sequence=job.sequence,
                expires_us=int(job.expires_at.timestamp() * 1_000_000), **fields))
        else:
            if session_hash is not None:
                fields["review_session_hash"] = session_hash
            changed = connection.execute(update(seeds).where(seeds.c.id == str(job.id),
                seeds.c.organization_id == job.organization_id, seeds.c.revision == previous.revision,
                seeds.c.status == previous.status).values(**fields))
            if changed.rowcount != 1:
                raise PolicyDenied("seed_revision_changed", 409)
        connection.execute(versions.insert().values(job_id=str(job.id), organization_id=job.organization_id,
            revision=job.revision, payload=job.model_dump(mode="json")))

    @staticmethod
    def changed(job, event, actor_id, **changes):
        return job.model_copy(deep=True, update={"revision": job.revision + 1, "last_event": event,
            "last_actor_id": actor_id, "last_event_at": datetime.now(UTC), **changes})

    @staticmethod
    def check_body(job, account, body):
        if (job.revision != body.expected_revision or job.binding_hash != body.binding_hash
                or account.revision != body.expected_account_revision):
            raise PolicyDenied("seed_binding_changed", 409)

    def prepare(self, account_id, body: SeedPrepare):
        preview = preview_seed(self.operation, account_id, body)
        with self.operation.transaction(write=True) as (connection, actor):
            self.operation.account(connection, actor, account_id, body.expected_account_revision)
            _, digest = RefreshAuthorizations(self.operation).binding(account_id)
            if not self.available() or digest != preview.configuration_hash or self.blocking(connection, actor, account_id):
                raise PolicyDenied("seed_preparation_unavailable", 409)
            expiry = connection.execute(select(sessions.c.expires_at).where(
                sessions.c.token_hash == self.operation.session_hash)).scalar_one()
            now = datetime.now(UTC)
            sequence = connection.execute(select(seeds.c.sequence).where(seeds.c.organization_id == actor.organization_id,
                seeds.c.account_id == str(account_id)).order_by(seeds.c.sequence.desc()).limit(1)).scalar() or 0
            if body.include_deals and not (self.transport.settings.hubspot_seed_deal_pipeline
                    and self.transport.settings.hubspot_seed_deal_stage):
                raise PolicyDenied("seed_deal_configuration_required", 409)
            items = []
            def add(object_type, properties, parent_index=None):
                items.append(SeedItem(index=len(items), object_type=object_type, parent_index=parent_index,
                    association_type_id=ASSOCIATIONS.get(object_type),
                    provider_request=canonical_json({"properties": properties}).decode("utf-8")))
            for company in preview.companies:
                parent = len(items)
                add("companies", company.model_dump())
                if body.include_contacts:
                    add("contacts", {"firstname": "VitaAi synthetic", "lastname": company.name,
                        "jobtitle": "Synthetic demonstration only; no real contact"}, parent)
                if body.include_notes:
                    add("notes", {"hs_note_body": company.description,
                        "hs_timestamp": preview.created_at.isoformat(timespec="milliseconds")}, parent)
                if body.include_deals:
                    add("deals", {"dealname": company.name + " synthetic deal",
                        "pipeline": self.transport.settings.hubspot_seed_deal_pipeline,
                        "dealstage": self.transport.settings.hubspot_seed_deal_stage}, parent)
            expires_at = min(now + timedelta(minutes=10), datetime.fromtimestamp(expiry, UTC))
            test_portal = self.transport.settings.hubspot_seed_test_portal_id
            binding = hashlib.sha256(canonical_json({"preview": preview.model_dump(mode="json"),
                "requests": [item.model_dump(mode="json") for item in items], "test_portal_id": test_portal,
                "expires_at": expires_at.isoformat(), "policy": "synthetic-company-seed-1"})).hexdigest()
            job = SeedJob(id=preview.id, organization_id=actor.organization_id, account_id=account_id,
                account_revision=body.expected_account_revision, sequence=sequence + 1, preview=preview,
                test_portal_id=test_portal, expires_at=expires_at, binding_hash=binding,
                items=items, last_actor_id=actor.id, last_event_at=now)
            self.save(connection, job)
            return job

    def review(self, job_id, body):
        with self.operation.transaction(write=True) as (connection, actor):
            job, account, _ = self.load(connection, actor, job_id)
            self.check_body(job, account, body)
            if (job.status != "draft" or datetime.now(UTC) >= job.expires_at
                    or not self.available(job.operation) or not self.context_matches(job, account)):
                raise PolicyDenied("seed_review_unavailable", 409)
            expiry = connection.execute(select(sessions.c.expires_at).where(
                sessions.c.token_hash == self.operation.session_hash)).scalar_one()
            now = datetime.now(UTC)
            final = self.changed(job, "review_" + body.decision, actor.id, status=body.decision,
                reviewed_by=actor.id, reviewed_at=now, review_reason=body.reason,
                review_expires_at=min(job.expires_at, now + timedelta(minutes=30), datetime.fromtimestamp(expiry, UTC)))
            self.save(connection, final, previous=job, session_hash=self.operation.session_hash)
            return final

    def guard(self, job, *, readback=False):
        with self.operation.transaction(write=True) as (connection, actor):
            current, account, session_hash = self.load(connection, actor, job.id)
            if (current.revision != job.revision or current.status != job.status
                    or (actor.id != job.claimed_by and not readback)
                    or not self.context_matches(current, account, readback=readback)):
                raise PolicyDenied("seed_worker_fenced", 409)
            if readback:
                if not self.transport.configured:
                    raise PolicyDenied("seed_readback_unavailable", 503)
            elif (not self.available(current.operation) or current.worker_deadline_at is None
                    or datetime.now(UTC) >= current.worker_deadline_at
                    or current.review_expires_at is None or datetime.now(UTC) >= current.review_expires_at
                    or not self.reviewer_valid(connection, current, session_hash)):
                raise PolicyDenied("seed_authority_changed", 409)

    @contextmanager
    def result_transaction(self, job):
        # Store only an already-claimed result after requester/session loss; never grant dispatch.
        with self.operation.engine.connect() as connection:
            try:
                if self.operation.engine.dialect.name == "sqlite":
                    connection.exec_driver_sql("BEGIN IMMEDIATE")
                else:
                    connection.begin()
                    key = int.from_bytes(hashlib.sha256(job.organization_id.encode()).digest()[:8], "big", signed=True)
                    connection.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": key})
                current = SeedJob.model_validate(connection.execute(select(seeds.c.payload).where(
                    seeds.c.id == str(job.id), seeds.c.organization_id == job.organization_id)).scalar_one())
                if current.revision != job.revision or current.status != job.status:
                    raise PolicyDenied("seed_worker_fenced", 409)
                yield connection
                connection.commit()
            except BaseException:
                connection.rollback()
                raise

    def progress(self, job, event, **changes):
        final = self.changed(job, event, job.claimed_by, **changes)
        with self.result_transaction(job) as connection:
            self.save(connection, final, previous=job)
        return final

    @staticmethod
    def aggregate(items, operation="create"):
        if operation == "archive":
            items = [item for item in items if item.archive_selected]
        if any(item.status in {"dispatching", "result_unknown"} for item in items):
            return "result_unknown"
        return "succeeded" if all(item.status == "succeeded" for item in items) else "failed"

    @staticmethod
    def resolve_request(job, item):
        if job.operation == "archive":
            if not item.archive_selected or not item.archive_target_id or not item.resolved_request:
                raise PolicyDenied("seed_archive_binding_invalid", 409)
            return item.resolved_request
        payload = json.loads(item.provider_request)
        if item.object_type != "companies":
            if item.parent_index is None or item.parent_index >= item.index:
                raise PolicyDenied("seed_parent_binding_invalid", 409)
            parent = job.items[item.parent_index]
            if (item.association_type_id != ASSOCIATIONS[item.object_type]
                    or parent.object_type != "companies" or parent.status != "succeeded"
                    or parent.verification != "verified" or not parent.resource_id):
                raise PolicyDenied("seed_parent_unverified", 409)
            payload["associations"] = [{"to": {"id": parent.resource_id}, "types": [{
                "associationCategory": "HUBSPOT_DEFINED", "associationTypeId": item.association_type_id}]}]
        elif item.parent_index is not None or item.association_type_id is not None:
            raise PolicyDenied("seed_parent_binding_invalid", 409)
        return canonical_json(payload).decode("utf-8")

    def execute(self, job_id, body):
        with self.operation.transaction(write=True) as (connection, actor):
            job, account, session_hash = self.load(connection, actor, job_id)
            self.check_body(job, account, body)
            now = datetime.now(UTC)
            if (job.status != "approved" or job.claimed_at is not None or not self.available(job.operation)
                    or not self.context_matches(job, account) or now >= job.expires_at
                    or job.review_expires_at is None or now >= job.review_expires_at
                    or not self.reviewer_valid(connection, job, session_hash)):
                raise PolicyDenied("seed_execution_unavailable", 409)
            if job.operation == "archive" and any(item.archive_selected
                    and item.archive_target_id in self.archive_claims(connection, job) for item in job.items):
                raise PolicyDenied("seed_archive_already_claimed", 409)
            claimed = self.changed(job, "claimed", actor.id, status="claimed", claimed_by=actor.id,
                claimed_at=now, worker_deadline_at=min(now + timedelta(minutes=2), job.review_expires_at))
            self.save(connection, claimed, previous=job)
        job = claimed
        try:
            self.transport.verify_portal(lambda: self.guard(job))
        except HubSpotFailure:
            items = [item.model_copy(update={"status": "skipped", "error_code": "seed_preflight_failed"}) for item in job.items]
            return self.progress(job, "preflight_failed", status="failed", items=items, finished_at=datetime.now(UTC))
        order = reversed(range(len(job.items))) if job.operation == "archive" else range(len(job.items))
        for index in order:
            if job.items[index].status != "ready":
                continue
            self.guard(job)
            items = [item.model_copy(deep=True) for item in job.items]
            items[index].resolved_request = self.resolve_request(job, items[index])
            items[index].status, items[index].dispatched_at = "dispatching", datetime.now(UTC)
            job = self.progress(job, "dispatch_reserved", status="executing", items=items)
            self.guard(job)
            if job.operation == "archive":
                target = job.items[index].model_copy(update={"resource_id": job.items[index].archive_target_id})
                verification, error = self.transport.verify_cleanup_target(target, lambda current=job: self.guard(current))
                if verification != "verified":
                    status, resource_id, error = "failed", target.resource_id, "seed_archive_preflight_failed"
                else:
                    self.guard(job)
                    status, resource_id, error = self.transport.archive_item(target)
            else:
                status, resource_id, error = self.transport.create_item(job.items[index])
            items = [item.model_copy(deep=True) for item in job.items]
            item = items[index]
            item.status, item.resource_id, item.error_code = status, resource_id, error
            item.finished_at = datetime.now(UTC)
            job = self.progress(job, "write_result_retained", items=items)
            if resource_id and status != "failed":
                try:
                    verify = self.transport.verify_archived if job.operation == "archive" else self.transport.verify_item
                    verification, error = verify(job.items[index], lambda current=job: self.guard(current))
                    self.guard(job)
                except PolicyDenied:
                    verification, error = "unavailable", "seed_authority_changed"
                items = [item.model_copy(deep=True) for item in job.items]
                item = items[index]
                item.verification, item.error_code = verification, error
                if verification == "verified":
                    item.status, item.verified_at = "succeeded", datetime.now(UTC)
                    item.verified_request_hash = hashlib.sha256(item.resolved_request.encode("utf-8")).hexdigest()
                job = self.progress(job, "independent_readback", items=items)
            if job.items[index].status != "succeeded":
                break
        items = [item.model_copy(deep=True) for item in job.items]
        for item in items:
            if item.status == "ready":
                item.status, item.error_code = "skipped", "seed_batch_stopped"
        return self.progress(job, "execution_finished", status=self.aggregate(items, job.operation), items=items, finished_at=datetime.now(UTC))

    def recover(self, job_id, body):
        with self.operation.transaction(write=True) as (connection, actor):
            job, account, _ = self.load(connection, actor, job_id)
            self.check_body(job, account, body)
            now = datetime.now(UTC)
            if (job.status not in {"claimed", "executing"} or job.worker_deadline_at is None
                    or job.worker_deadline_at != body.expected_worker_deadline_at or now < job.worker_deadline_at):
                raise PolicyDenied("seed_recovery_unavailable", 409)
            items = [item.model_copy(deep=True) for item in job.items]
            for item in items:
                if item.status == "dispatching":
                    item.status, item.error_code = "result_unknown", "seed_worker_interrupted"
                elif item.status == "ready":
                    item.status, item.error_code = "skipped", "seed_worker_interrupted"
            status = self.aggregate(items, job.operation)
            if status == "failed" and not any(item.dispatched_at for item in items):
                status = "interrupted"
            final = self.changed(job, "worker_finalized", actor.id, status=status, items=items,
                recovered_by=actor.id, recovered_at=now, finished_at=now)
            self.save(connection, final, previous=job)
            return final

    def reconcile(self, job_id, body):
        with self.operation.transaction(write=True) as (connection, actor):
            job, account, _ = self.load(connection, actor, job_id)
            self.check_body(job, account, body)
            if (job.status != "result_unknown" or not self.transport.configured
                    or not self.context_matches(job, account, readback=True)
                    or not any(item.status == "result_unknown" and item.resource_id for item in job.items)):
                raise PolicyDenied("seed_reconciliation_unavailable", 409)
        items = [item.model_copy(deep=True) for item in job.items]
        for item in items:
            if item.status != "result_unknown" or not item.resource_id:
                continue
            verify = self.transport.verify_archived if job.operation == "archive" else self.transport.verify_item
            verification, error = verify(item, lambda: self.guard(job, readback=True))
            item.verification, item.error_code = verification, error
            if verification == "verified":
                item.status, item.verified_at = "succeeded", datetime.now(UTC)
                item.verified_request_hash = hashlib.sha256(item.resolved_request.encode("utf-8")).hexdigest()
        with self.operation.transaction(write=True) as (connection, current):
            retained, account, _ = self.load(connection, current, job_id)
            self.check_body(retained, account, body)
            if current.id != actor.id or not self.context_matches(retained, account, readback=True):
                raise PolicyDenied("seed_reconciliation_changed", 409)
            final = self.changed(retained, "reconciled", current.id, items=items,
                status=self.aggregate(items, job.operation), finished_at=datetime.now(UTC))
            self.save(connection, final, previous=retained)
            return final
