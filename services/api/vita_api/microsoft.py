"""Durable delegated OAuth and bounded Graph drafts; no send operation."""
import hashlib
import json
import re
import secrets
from datetime import UTC, datetime
from urllib.parse import quote, urlsplit
from uuid import UUID, uuid4

import httpx
import msal
from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import (
    Boolean,
    Column,
    Integer,
    String,
    Table,
    Text,
    delete,
    select,
    update,
)

from .contracts import Contract
from .governance import PolicyDenied, canonical_json
from .identity import sessions, token_digest
from .storage import metadata
from .workflow_contracts import DestinationBinding

PREFIX = "/api/integrations/microsoft"
SCOPES = ["https://graph.microsoft.com/User.Read", "https://graph.microsoft.com/Mail.ReadWrite"]
COOKIE = "vitaai_microsoft_flow"
flows = Table("microsoft_flows", metadata,
    Column("id", String(64), primary_key=True), Column("organization_id", String(80), nullable=False),
    Column("actor_id", String(80), nullable=False), Column("session_hash", String(64), nullable=False),
    Column("configuration", String(64), nullable=False), Column("expires_at", Integer, nullable=False),
    Column("consumed", Boolean, nullable=False), Column("encrypted_flow", Text, nullable=False))
bindings = Table("microsoft_bindings", metadata,
    Column("id", String(80), primary_key=True), Column("organization_id", String(80), nullable=False),
    Column("actor_id", String(80), nullable=False), Column("session_hash", String(64), nullable=False),
    Column("configuration", String(64), nullable=False), Column("mailbox_id", String(80), nullable=False),
    Column("expires_at", Integer, nullable=False), Column("revoked", Boolean, nullable=False),
    Column("encrypted_token", Text, nullable=False))


class MicrosoftStatus(Contract):
    configured: bool
    connected: bool
    write_configured: bool
    binding_id: str | None = None
    mailbox_id: str | None = None
    expires_at: int | None = None
    connection_origin: str


class MicrosoftActionReadiness(Contract):
    action_id: UUID
    action_revision: int
    binding_hash: str
    can_write: bool
    can_reconcile: bool


class MicrosoftExecutionReadiness(Contract):
    mission_id: UUID
    mission_revision: int
    account_id: UUID
    account_revision: int
    organization_id: str
    can_prepare: bool
    destination: DestinationBinding | None
    actions: tuple[MicrosoftActionReadiness, ...]


class MicrosoftStart(Contract):
    authorization_url: str


def draft_request(payload):
    if payload.kind != "outlook_draft_create":
        raise PolicyDenied("connector_kind_mismatch")
    return canonical_json({"subject": payload.subject,
        "body": {"contentType": "Text", "content": payload.body_text},
        "toRecipients": [{"emailAddress": {"address": address}} for address in payload.to]}).decode("utf-8")


class Microsoft:
    def __init__(self, store, settings, transport=None, *, clock=None, client_factory=None):
        self.store, self.settings, self.transport = store, settings, transport
        self.clock = clock or (lambda: datetime.now(UTC))
        self.client_factory = client_factory or msal.ConfidentialClientApplication

    @property
    def configured(self):
        s = self.settings
        if not (s.microsoft_enabled and s.auth_mode == "session" and s.microsoft_organization_id
                and s.microsoft_tenant_id and s.microsoft_client_id and s.microsoft_client_secret.get_secret_value()):
            return False
        try:
            self.cipher()
            return True
        except (ValueError, TypeError):
            return False

    def cipher(self):
        return Fernet(self.settings.microsoft_token_key.get_secret_value().encode("ascii"))

    @property
    def connection_origin(self):
        return "http://" + urlsplit(self.settings.microsoft_redirect_uri).hostname + ":3000"

    def seal(self, value):
        return self.cipher().encrypt(canonical_json(value)).decode("ascii")

    def unseal(self, value):
        try:
            return json.loads(self.cipher().decrypt(value.encode("ascii")))
        except (InvalidToken, ValueError, UnicodeError, TypeError):
            raise PolicyDenied("microsoft_reconnect_required", 409) from None

    def fingerprint(self):
        s = self.settings
        return hashlib.sha256(canonical_json([str(s.microsoft_client_id), str(s.microsoft_tenant_id),
            s.microsoft_organization_id, s.microsoft_configuration_revision, s.microsoft_redirect_uri])).hexdigest()

    def _tx(self, actor_id, session_token=None, *, authenticated=True, write=True):
        from .workflow import Workflow
        return Workflow(self.store, clock=self.clock, session_token=session_token,
                        session_required=authenticated)._transaction(actor_id, write=write)

    def allowed(self, actor):
        if not self.configured or actor.organization_id != self.settings.microsoft_organization_id:
            raise PolicyDenied("microsoft_unavailable", 503)

    def oauth(self):
        return self.client_factory(str(self.settings.microsoft_client_id),
            authority="https://login.microsoftonline.com/" + str(self.settings.microsoft_tenant_id),
            client_credential=self.settings.microsoft_client_secret.get_secret_value(),
            exclude_scopes=["offline_access"], timeout=15, instance_discovery=False)

    def begin(self, actor_id, session_token):
        cookie = secrets.token_urlsafe(32)
        flow_id = token_digest(cookie)
        with self._tx(actor_id, session_token) as (connection, actor):
            self.allowed(actor)
            organization = actor.organization_id
            connection.execute(delete(flows).where(flows.c.actor_id == actor.id))
            connection.execute(flows.insert().values(id=flow_id, organization_id=organization,
                actor_id=actor.id, session_hash=token_digest(session_token), configuration=self.fingerprint(),
                expires_at=int(self.clock().timestamp()) + 600, consumed=False, encrypted_flow=""))
        try:
            flow = self.oauth().initiate_auth_code_flow(SCOPES, redirect_uri=self.settings.microsoft_redirect_uri,
                                                       prompt="select_account")
            if not isinstance(flow["state"], str) or not 16 <= len(flow["state"]) <= 256:
                raise ValueError("Invalid state")
            encrypted = self.seal(flow)
        except (ValueError, KeyError, OSError, httpx.HTTPError):
            raise PolicyDenied("microsoft_authorization_unavailable", 503) from None
        with self._tx(actor_id, session_token) as (connection, actor):
            self.allowed(actor)
            if actor.organization_id != organization:
                raise PolicyDenied("membership_changed", 409)
            pending = connection.execute(select(flows).where(flows.c.id == flow_id)).mappings().first()
            self._pending(connection, actor, pending, consumed=False)
            connection.execute(update(flows).where(flows.c.id == flow_id).values(encrypted_flow=encrypted))
        return MicrosoftStart(authorization_url=flow["auth_uri"]), cookie

    def complete(self, cookie, response):
        # Lax flow cookie on cross-site callback; original Strict application session checked in DB.
        with self.store.engine.connect() as connection:
            pending = connection.execute(select(flows).where(flows.c.id == token_digest(cookie or ""))).mappings().first()
        if pending is None:
            raise PolicyDenied("microsoft_state_invalid", 409)
        actor_id, flow_id = pending["actor_id"], pending["id"]
        with self._tx(actor_id, authenticated=False) as (connection, actor):
            self.allowed(actor)
            pending = connection.execute(select(flows).where(flows.c.id == flow_id)).mappings().first()
            self._pending(connection, actor, pending, consumed=False)
            flow = self.unseal(pending["encrypted_flow"])
            if response.get("state") != flow.get("state"):
                raise PolicyDenied("microsoft_state_invalid", 409)
            connection.execute(update(flows).where(flows.c.id == flow_id).values(consumed=True))
        try:
            result = self.oauth().acquire_token_by_auth_code_flow(flow, response, scopes=SCOPES)
            received_at = int(self.clock().timestamp())
            claims = result.get("id_token_claims", {})
            if (claims.get("tid") != str(self.settings.microsoft_tenant_id)
                    or not isinstance(claims.get("oid"), str) or str(UUID(claims["oid"])) != claims["oid"]
                    or not {"User.Read", "Mail.ReadWrite"} <= set(result.get("scope", "").split())
                    or result.get("token_type", "").lower() != "bearer"
                    or not isinstance(result.get("access_token"), str) or not result["access_token"]
                    or type(result.get("expires_in")) is not int or result["expires_in"] <= 60):
                raise ValueError("Invalid delegated result")
            if self.get(result["access_token"], "/me", params={"$select": "id"}).get("id") != claims["oid"]:
                raise ValueError("Mailbox changed")
            encrypted = self.seal({"access_token": result["access_token"]})
        except (ValueError, KeyError, TypeError, AttributeError, OSError, httpx.HTTPError, PolicyDenied):
            raise PolicyDenied("microsoft_authorization_failed", 409) from None
        with self._tx(actor_id, authenticated=False) as (connection, actor):
            self.allowed(actor)
            current = connection.execute(select(flows).where(flows.c.id == flow_id)).mappings().first()
            self._pending(connection, actor, current, consumed=True)
            connection.execute(delete(flows).where(flows.c.id == flow_id))
            connection.execute(update(bindings).where(bindings.c.actor_id == actor.id).values(revoked=True, encrypted_token=""))
            connection.execute(bindings.insert().values(id=str(uuid4()), organization_id=actor.organization_id,
                actor_id=actor.id, session_hash=current["session_hash"], configuration=self.fingerprint(),
                mailbox_id=claims["oid"], expires_at=received_at + min(result["expires_in"] - 60, 3600),
                revoked=False, encrypted_token=encrypted))

    def _pending(self, connection, actor, pending, *, consumed):
        if (pending is None or pending["consumed"] != consumed or pending["expires_at"] <= self.clock().timestamp()
                or pending["organization_id"] != actor.organization_id or pending["configuration"] != self.fingerprint()
                or not self.session_valid(connection, actor.id, pending["session_hash"])):
            raise PolicyDenied("microsoft_state_invalid", 409)

    def session_valid(self, connection, actor_id, session_hash):
        return connection.execute(select(sessions.c.user_id).where(sessions.c.user_id == actor_id,
            sessions.c.token_hash == session_hash, sessions.c.expires_at > int(self.clock().timestamp()))).scalar() is not None

    def binding(self, connection, actor):
        self.allowed(actor)
        if actor.role == "viewer":
            raise PolicyDenied("microsoft_reconnect_required", 409)
        row = connection.execute(select(bindings).where(bindings.c.actor_id == actor.id,
            bindings.c.organization_id == actor.organization_id, bindings.c.revoked.is_(False),
            bindings.c.configuration == self.fingerprint(), bindings.c.expires_at > int(self.clock().timestamp()))).mappings().first()
        if row is None or not self.session_valid(connection, actor.id, row["session_hash"]):
            raise PolicyDenied("microsoft_reconnect_required", 409)
        return row

    def destination(self, connection, actor, account_id, *, write=True):
        if write and not self.settings.microsoft_write_enabled:
            raise PolicyDenied("microsoft_execution_unavailable", 503)
        row = self.binding(connection, actor)
        return DestinationBinding(connector_id="microsoft-live", provider="microsoft",
            configuration_revision=self.settings.microsoft_configuration_revision,
            tenant_id=str(self.settings.microsoft_tenant_id), target_account_id=account_id,
            target_resource_id=row["id"], delegated_user_id=row["mailbox_id"], mailbox_id=row["mailbox_id"])

    def status(self, actor_id, session_token):
        with self._tx(actor_id, session_token, write=False) as (connection, actor):
            configured = self.configured and actor.organization_id == self.settings.microsoft_organization_id
            try:
                row = self.binding(connection, actor)
            except PolicyDenied:
                row = None
            return MicrosoftStatus(configured=configured, connected=row is not None,
                write_configured=configured and self.settings.microsoft_write_enabled,
                binding_id=row["id"] if row else None, mailbox_id=row["mailbox_id"] if row else None,
                expires_at=row["expires_at"] if row else None, connection_origin=self.connection_origin)

    def signout(self, actor_id, session_token):
        with self._tx(actor_id, session_token, write=False) as (connection, actor):
            connection.execute(delete(flows).where(flows.c.actor_id == actor.id))
            connection.execute(update(bindings).where(bindings.c.actor_id == actor.id).values(revoked=True, encrypted_token=""))

    def credential(self, action, *, write=False):
        with self._tx(action.preparer_id, authenticated=False, write=False) as (connection, actor):
            destination = self.destination(connection, actor, action.evidence.account_id, write=write)
            # Reauthorization to the exact same mailbox may verify an old retained resource ID.
            # A replacement binding never authorizes another write under the old approval.
            compared = destination if write else destination.model_copy(update={
                "target_resource_id": action.destination.target_resource_id})
            if compared != action.destination or actor.organization_id != action.organization_id:
                raise PolicyDenied("microsoft_destination_changed", 409)
            return self.unseal(self.binding(connection, actor)["encrypted_token"])["access_token"]

    def client(self, token):
        return httpx.Client(base_url="https://graph.microsoft.com/v1.0", transport=self.transport,
            timeout=15, follow_redirects=False, headers={"Authorization": "Bearer " + token,
                "Prefer": 'IdType="ImmutableId", outlook.body-content-type="text"'})

    @staticmethod
    def data(response):
        body = bytearray()
        for chunk in response.iter_bytes():
            body.extend(chunk)
            if len(body) > 262144:
                raise ValueError("Oversized Graph response")
        value = json.loads(body)
        if not isinstance(value, dict):
            raise TypeError("Invalid Graph response")
        return value

    def get(self, token, path, **kwargs):
        with self.client(token) as client, client.stream("GET", path, **kwargs) as response:
            if response.status_code != 200:
                raise PolicyDenied("microsoft_read_unavailable", 503)
            return self.data(response)

    def preflight(self, action):
        try:
            token = self.credential(action, write=True)
            if self.get(token, "/me", params={"$select": "id"}).get("id") != action.destination.mailbox_id:
                raise ValueError("Mailbox changed")
        except (ValueError, TypeError, httpx.HTTPError):
            raise PolicyDenied("microsoft_preflight_failed", 409) from None

    def create(self, action):
        try:
            token = self.credential(action, write=True)
        except PolicyDenied:
            return "failed", None, "microsoft_authority_changed"
        try:
            with self.client(token) as client, client.stream("POST", "/me/messages",
                    content=action.provider_request.encode("utf-8"), headers={"Content-Type": "application/json"}) as response:
                if response.status_code in {400, 401, 403, 404, 422}:
                    return "failed", None, "microsoft_write_rejected"
                if response.status_code != 201:
                    return "result_unknown", None, "microsoft_write_ambiguous"
                resource_id = self.data(response).get("id")
                if not isinstance(resource_id, str) or not re.fullmatch(r"[A-Za-z0-9_+=/-]{1,2048}", resource_id):
                    raise ValueError("Invalid message ID")
                return "result_unknown", resource_id, "provider_readback_pending"
        except (httpx.HTTPError, ValueError, TypeError):
            return "result_unknown", None, "microsoft_write_ambiguous"

    def readback(self, action, resource_id):
        try:
            token = self.credential(action)
            if not re.fullmatch(r"[A-Za-z0-9_+=/-]{1,2048}", resource_id):
                raise ValueError("Invalid message ID")
            if self.get(token, "/me", params={"$select": "id"}).get("id") != action.destination.mailbox_id:
                raise ValueError("Mailbox changed")
            data = self.get(token, "/me/messages/" + quote(resource_id, safe=""),
                params={"$select": "id,isDraft,subject,body,toRecipients,ccRecipients,bccRecipients"})
            expected = json.loads(action.provider_request)
            body = data.get("body", {})
            actual = {"subject": data.get("subject"), "body": {
                "contentType": "Text" if body.get("contentType", "").lower() == "text" else body.get("contentType"),
                "content": body.get("content")},
                "toRecipients": [{"emailAddress": {"address": r["emailAddress"]["address"]}} for r in data.get("toRecipients", [])]}
            if (data.get("id") != resource_id or data.get("isDraft") is not True or data.get("ccRecipients") != []
                    or data.get("bccRecipients") != [] or actual != expected):
                return "mismatch", None, "provider_readback_mismatch"
            return "verified", hashlib.sha256(action.provider_request.encode("utf-8")).hexdigest(), None
        except (PolicyDenied, httpx.HTTPError, ValueError, TypeError, KeyError, AttributeError):
            return "unavailable", None, "provider_readback_unavailable"
