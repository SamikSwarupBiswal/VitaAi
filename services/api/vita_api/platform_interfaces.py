"""Tenant-bound delegated Microsoft interfaces over the same VitaAi records.

The platform can read context and propose preparation. It cannot approve, dispatch,
send, alter facts, or assert a VitaAi actor. No token is stored or returned.
"""
import json
import re
from datetime import UTC, datetime, timedelta
from threading import Lock
from time import monotonic
from typing import Literal
from urllib.parse import urlsplit
from uuid import UUID

import httpx
import jwt
from pydantic import AwareDatetime, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    Integer,
    String,
    Table,
    UniqueConstraint,
    select,
)

from .collaboration import Collaboration
from .contracts import AccountView
from .governance import PolicyDenied, digest
from .memory import Memory
from .pipeline import action_role, governance_role
from .scoring import assess
from .storage import metadata, selected_evidence
from .workflow import Workflow
from .workflow_contracts import Hash, Reference, Revision, WorkflowContract

identities = Table("platform_identities", metadata,
    Column("tenant_id", String(80), primary_key=True), Column("object_id", String(80), primary_key=True),
    Column("organization_id", String(80), nullable=False), Column("user_id", String(80), nullable=False),
    Column("revision", Integer, nullable=False), Column("enabled", Boolean, nullable=False),
    Column("payload", JSON, nullable=False), UniqueConstraint("organization_id", "user_id"))
activities = Table("platform_activities", metadata,
    Column("organization_id", String(80), primary_key=True), Column("user_id", String(80), primary_key=True),
    Column("activity_id", String(200), primary_key=True), Column("request_hash", String(64), nullable=False),
    Column("payload", JSON, nullable=False))


class PlatformSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="VITAAI_PLATFORM_", extra="ignore")
    enabled: bool = False
    tenant_id: UUID | None = None
    audience: UUID | None = None
    client_ids: tuple[UUID, ...] = Field(default=(), max_length=10)
    delegated_scope: str = Field(default="access_as_user", pattern=r"^[A-Za-z][A-Za-z0-9_.-]{0,79}$")
    web_origin: str = ""

    @field_validator("web_origin")
    @classmethod
    def origin(cls, value):
        if not value:
            return value
        parsed = urlsplit(value)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
                or parsed.path not in {"", "/"} or parsed.query or parsed.fragment or parsed.port not in {None, 443}):
            raise ValueError("Platform web origin must be an HTTPS origin")
        return value.rstrip("/")

    def require(self):
        if not (self.enabled and self.tenant_id and self.audience and self.client_ids and self.web_origin):
            raise PolicyDenied("platform_not_configured", 503)


class Principal(WorkflowContract):
    tenant_id: UUID
    object_id: UUID


class IdentityBinding(WorkflowContract):
    tenant_id: UUID
    object_id: UUID
    user_id: UUID
    expected_revision: int = Field(ge=0, le=100)
    enabled: bool


class IdentityLink(WorkflowContract):
    tenant_id: UUID
    object_id: UUID
    user_id: UUID
    organization_id: Reference
    revision: Revision
    enabled: bool
    linked_by: Reference
    updated_at: AwareDatetime


class PlatformReadiness(WorkflowContract):
    configured: bool
    tenant_id: UUID | None
    audience: UUID | None
    delegated_scope: str
    web_origin: str
    live_verified: Literal[False] = False
    notes: tuple[str, ...] = ("Configuration is not tenant validation. Deploy and validate the app package in an authorized tenant.",)


class PlatformContext(WorkflowContract):
    account: AccountView
    workspace_url: str
    approval_available: Literal[False] = False
    execution_available: Literal[False] = False
    caveats: tuple[str, ...] = ("Source observations and advisory proposals are not verified business outcomes.",)


class PlatformPreparation(WorkflowContract):
    account_id: UUID
    expected_snapshot_hash: Hash
    expected_account_revision: Revision


class PreparationProposal(WorkflowContract):
    context: PlatformContext
    action_kind: str
    rationale: str
    evidence_ids: tuple[str, ...]
    allowed: bool
    preparation_url: str
    status: Literal["proposal_only"] = "proposal_only"
    caveats: tuple[str, ...] = ("Review preparation in VitaAi. No plan, approval, customer action or receipt was created.",)


class TeamsActivity(WorkflowContract):
    activity_id: Reference
    timestamp: AwareDatetime
    tenant_id: UUID
    object_id: UUID
    account_id: UUID
    type: Literal["message"]
    command: Literal["context"]
    conversation_type: Literal["personal"]


class TeamsCard(WorkflowContract):
    activity_id: Reference
    mode: Literal["sourced_read_only"] = "sourced_read_only"
    context: PlatformContext
    card: dict


def unique_json(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON field")
        result[key] = value
    return result


class EntraVerifier:
    """Fixed-tenant v2 delegated JWT validation with bounded fixed-host JWKS reads."""
    def __init__(self, config: PlatformSettings, transport=None):
        self.config, self.transport = config, transport
        self.keys, self.expires, self.lock = [], 0, Lock()

    def public_key(self, kid):
        with self.lock:
            if monotonic() >= self.expires:
                url = f"https://login.microsoftonline.com/{self.config.tenant_id}/discovery/v2.0/keys"
                try:
                    with (httpx.Client(transport=self.transport, timeout=10, follow_redirects=False, trust_env=False) as client,
                          client.stream("GET", url) as response):
                        response.raise_for_status()
                        content = bytearray()
                        for chunk in response.iter_bytes():
                            content.extend(chunk)
                            if len(content) > 262144:
                                raise ValueError("Oversized keys")
                    data = json.loads(content, object_pairs_hook=unique_json)
                    keys = data["keys"]
                    if not isinstance(keys, list) or len(keys) > 30 or any(not isinstance(key, dict) for key in keys):
                        raise ValueError("Invalid keys")
                    self.keys, self.expires = keys, monotonic() + 3600
                except (httpx.HTTPError, ValueError, KeyError):
                    raise PolicyDenied("platform_auth_unavailable", 503) from None
            matches = [key for key in self.keys if key.get("kid") == kid and key.get("kty") == "RSA"
                and key.get("use", "sig") == "sig" and key.get("alg", "RS256") == "RS256"]
            if len(matches) != 1:
                raise PolicyDenied("platform_token_invalid", 401)
            try:
                return jwt.PyJWK(matches[0], algorithm="RS256").key
            except (jwt.PyJWTError, ValueError, KeyError):
                raise PolicyDenied("platform_token_invalid", 401) from None

    def verify(self, authorization):
        self.config.require()
        if not authorization or not re.fullmatch(r"Bearer [A-Za-z0-9_.-]{1,16384}", authorization):
            raise PolicyDenied("platform_authentication_required", 401)
        token = authorization[7:]
        try:
            header = jwt.get_unverified_header(token)
            if header.get("alg") != "RS256" or header.get("typ") != "JWT" or not isinstance(header.get("kid"), str):
                raise ValueError("Invalid header")
            claims = jwt.decode(token, self.public_key(header["kid"]), algorithms=["RS256"],
                audience=str(self.config.audience), issuer=f"https://login.microsoftonline.com/{self.config.tenant_id}/v2.0",
                options={"require": ["exp", "nbf", "iat", "aud", "iss", "tid", "oid", "scp", "ver", "azp"]})
            if (claims["tid"] != str(self.config.tenant_id) or claims["ver"] != "2.0"
                    or claims["azp"] not in {str(value) for value in self.config.client_ids}
                    or not isinstance(claims["scp"], str) or self.config.delegated_scope not in claims["scp"].split()):
                raise ValueError("Invalid claims")
            return Principal(tenant_id=claims["tid"], object_id=claims["oid"])
        except (jwt.PyJWTError, ValueError, KeyError, TypeError):
            raise PolicyDenied("platform_token_invalid", 401) from None


class PlatformWorkflow(Workflow):
    def __init__(self, store, principal, config):
        super().__init__(store)
        self.principal, self.config = principal, config

    def _actor(self, connection, actor_id):
        actor = super()._actor(connection, actor_id)
        row = connection.execute(select(identities).where(identities.c.tenant_id == str(self.principal.tenant_id),
            identities.c.object_id == str(self.principal.object_id), identities.c.enabled.is_(True))
            .with_for_update()).mappings().first()
        if row is None or row["user_id"] != actor.id or row["organization_id"] != actor.organization_id:
            raise PolicyDenied("platform_identity_unbound", 403)
        return actor


class PlatformInterfaces:
    def __init__(self, store, config):
        self.store, self.config = store, config

    def link(self, token, body: IdentityBinding):
        if body.enabled:
            self.config.require()
            if body.tenant_id != self.config.tenant_id:
                raise PolicyDenied("platform_tenant_denied", 403)
        with Memory(self.store, token).transaction(write=True, review=True) as (connection, actor):
            if actor.role != "admin":
                raise PolicyDenied("platform_admin_required", 403)
            row = connection.execute(select(identities).where(identities.c.tenant_id == str(body.tenant_id),
                identities.c.object_id == str(body.object_id)).with_for_update()).mappings().first()
            if row and (row["organization_id"] != actor.organization_id or row["user_id"] != str(body.user_id)):
                raise PolicyDenied("platform_identity_conflict", 409)
            if row is None and not body.enabled:
                raise PolicyDenied("platform_identity_changed", 409)
            # Revocation must remain possible after a linked member is disabled,
            # demoted or moved. Enabling always requires current membership.
            if body.enabled or row is None:
                member = Collaboration.member(connection, actor.organization_id, body.user_id)
                member_id = member.id
            else:
                member_id = row["user_id"]
            if body.expected_revision != (row["revision"] if row else 0):
                raise PolicyDenied("platform_identity_changed", 409)
            other = connection.execute(select(identities.c.object_id).where(
                identities.c.organization_id == actor.organization_id, identities.c.user_id == member_id)).scalar()
            if other and other != str(body.object_id):
                raise PolicyDenied("platform_identity_conflict", 409)
            item = IdentityLink(tenant_id=body.tenant_id, object_id=body.object_id, user_id=body.user_id,
                organization_id=actor.organization_id, revision=body.expected_revision + 1, enabled=body.enabled,
                linked_by=actor.id, updated_at=datetime.now(UTC))
            values = {"organization_id": actor.organization_id, "user_id": member_id, "revision": item.revision,
                "enabled": item.enabled, "payload": item.model_dump(mode="json")}
            if row:
                connection.execute(identities.update().where(identities.c.tenant_id == str(body.tenant_id),
                    identities.c.object_id == str(body.object_id), identities.c.revision == body.expected_revision).values(**values))
            else:
                connection.execute(identities.insert().values(tenant_id=str(body.tenant_id), object_id=str(body.object_id), **values))
            return item

    def links(self, token):
        with Memory(self.store, token).transaction() as (connection, actor):
            if actor.role != "admin":
                raise PolicyDenied("platform_admin_required", 403)
            rows = connection.execute(select(identities).where(identities.c.organization_id == actor.organization_id)
                .order_by(identities.c.tenant_id, identities.c.object_id).limit(101)).mappings().all()
            if len(rows) > 100:
                raise PolicyDenied("platform_identity_window_exceeded", 409)
            result = []
            for row in rows:
                value = IdentityLink.model_validate(row["payload"])
                if (str(value.tenant_id) != row["tenant_id"] or str(value.object_id) != row["object_id"]
                        or str(value.user_id) != row["user_id"] or value.revision != row["revision"]
                        or value.organization_id != actor.organization_id or value.enabled != row["enabled"]):
                    raise PolicyDenied("platform_identity_unavailable", 409)
                result.append(value)
            return result

    def workflow(self, principal):
        self.config.require()
        if principal.tenant_id != self.config.tenant_id:
            raise PolicyDenied("platform_tenant_denied", 403)
        with self.store.engine.connect() as connection:
            actor_id = connection.execute(select(identities.c.user_id).where(
                identities.c.tenant_id == str(principal.tenant_id), identities.c.object_id == str(principal.object_id),
                identities.c.enabled.is_(True))).scalar()
        if actor_id is None:
            raise PolicyDenied("platform_identity_unbound", 403)
        return PlatformWorkflow(self.store, principal, self.config), actor_id

    def context_in(self, workflow, connection, actor, account_id):
        account = Memory.account(connection, actor, account_id)
        facts = selected_evidence(connection, actor.organization_id, account_id)
        if len({f.id for f in facts}) != len(facts) or any(f.organization_id != actor.organization_id
                or f.account_id != str(account_id) for f in facts):
            raise PolicyDenied("platform_evidence_unavailable", 409)
        assessment = assess(account, facts, workflow.clock().date())
        view = AccountView(account=account, evidence=facts, assessment=assessment,
            renewal_days=(account.renewal_date - workflow.clock().date()).days if account.renewal_date else None)
        return PlatformContext(account=view, workspace_url=self.config.web_origin + "/accounts?account=" + str(account_id))

    def context(self, principal, account_id):
        workflow, actor_id = self.workflow(principal)
        with workflow._transaction(actor_id, write=False) as (connection, actor):
            return self.context_in(workflow, connection, actor, account_id)

    def preparation(self, principal, body: PlatformPreparation):
        workflow, actor_id = self.workflow(principal)
        with workflow._transaction(actor_id, write=True) as (connection, actor):
            context = self.context_in(workflow, connection, actor, body.account_id)
            view = context.account
            if view.account.revision != body.expected_account_revision or view.assessment.snapshot_hash != body.expected_snapshot_hash:
                raise PolicyDenied("platform_snapshot_changed", 409)
            policy = governance_role(view.assessment)
            action = action_role(view, policy)
            return PreparationProposal(context=context, action_kind=action.kind, rationale=action.rationale,
                evidence_ids=tuple(action.evidence_ids), allowed=policy.status != "review_required" and action.kind != "monitor",
                preparation_url=self.config.web_origin + "/missions?account=" + str(body.account_id))

    def teams(self, principal, body: TeamsActivity):
        if body.tenant_id != principal.tenant_id or body.object_id != principal.object_id:
            raise PolicyDenied("platform_activity_identity_changed", 403)
        workflow, actor_id = self.workflow(principal)
        with workflow._transaction(actor_id, write=True) as (connection, actor):
            now = workflow.clock()
            if not now - timedelta(minutes=5) <= body.timestamp <= now + timedelta(seconds=30):
                raise PolicyDenied("platform_activity_expired", 409)
            request_hash = digest(body.model_dump(mode="json"))
            row = connection.execute(select(activities).where(activities.c.organization_id == actor.organization_id,
                activities.c.user_id == actor.id, activities.c.activity_id == body.activity_id)).mappings().first()
            if row:
                if row["request_hash"] != request_hash:
                    raise PolicyDenied("platform_activity_conflict", 409)
                return TeamsCard.model_validate(row["payload"])
            context = self.context_in(workflow, connection, actor, body.account_id)
            view = context.account
            card = {"type": "AdaptiveCard", "version": "1.5", "body": [
                {"type": "TextBlock", "text": view.account.name, "weight": "Bolder", "wrap": True},
                {"type": "TextBlock", "text": f"Risk {view.assessment.risk}/100; opportunity {view.assessment.opportunity}/100. "
                    f"Assessment {view.assessment.as_of}; {view.assessment.snapshot_hash}", "wrap": True},
                {"type": "TextBlock", "text": "Read-only sourced context. Review and approve exact actions in VitaAi.", "wrap": True}],
                "actions": [{"type": "Action.OpenUrl", "title": "Open sourced account", "url": context.workspace_url}]}
            result = TeamsCard(activity_id=body.activity_id, context=context, card=card)
            connection.execute(activities.insert().values(organization_id=actor.organization_id, user_id=actor.id,
                activity_id=body.activity_id, request_hash=request_hash, payload=result.model_dump(mode="json")))
            return result
