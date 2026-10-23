"""Explicit ephemeral mapped-company connectivity checks; no staging or authority."""
from datetime import UTC, datetime
from typing import Literal
from uuid import UUID, uuid4

from pydantic import AwareDatetime, Field

from .governance import PolicyDenied
from .hubspot import HubSpot, HubSpotContract, HubSpotFailure
from .hubspot_refresh import RefreshAuthorizations


class HubSpotProbeRequest(HubSpotContract):
    expected_account_revision: int = Field(ge=1, strict=True)
    expected_configuration_hash: str = Field(pattern=r"^[a-f0-9]{64}$")


class HubSpotProbeReadiness(HubSpotContract):
    organization_id: str
    account_id: UUID
    account_revision: int
    configuration_hash: str
    can_probe: bool
    reason: Literal["ready", "probe_disabled", "admin_required", "unconfigured"]


class HubSpotProbeResult(HubSpotContract):
    id: UUID
    organization_id: str
    account_id: UUID
    account_revision: int
    actor_id: str
    configuration_hash: str
    portal_id: str
    company_id: str
    started_at: AwareDatetime
    finished_at: AwareDatetime
    status: Literal["succeeded", "failed"]
    error_code: str | None = None
    policy: Literal["ephemeral-mapped-company-probe-1"] = "ephemeral-mapped-company-probe-1"


class HubSpotProbe:
    def __init__(self, operation):
        self.operation = operation

    def readiness(self, account_id):
        with self.operation.transaction() as (connection, actor):
            account = self.operation.account(connection, actor, account_id, require_mapping=False)
            _, digest = RefreshAuthorizations(self.operation).binding(account_id)
            connector = self.operation.connector
            reason = ("admin_required" if actor.role != "admin" else
                "probe_disabled" if not connector.settings.hubspot_probe_enabled else
                "unconfigured" if not connector.configured or str(account_id) not in
                connector.settings.hubspot_company_map else "ready")
            return HubSpotProbeReadiness(organization_id=actor.organization_id, account_id=account_id,
                account_revision=account.revision, configuration_hash=digest,
                can_probe=reason == "ready", reason=reason)

    def run(self, account_id, body):
        original_actor = None
        original_settings = self.operation.connector.settings.model_copy(deep=True)

        def check():
            with self.operation.transaction(write=True) as (connection, actor):
                self.operation.account(connection, actor, account_id, body.expected_account_revision)
                connector = self.operation.connector
                if not connector.settings.hubspot_probe_enabled or not connector.configured:
                    raise PolicyDenied("hubspot_probe_unavailable", 409)
                binding, digest = RefreshAuthorizations(self.operation).binding(account_id)
                if (digest != body.expected_configuration_hash or connector.settings != original_settings
                        or (original_actor is not None and actor != original_actor)):
                    raise PolicyDenied("hubspot_probe_context_changed", 409)
                return actor, binding

        original_actor, binding = check()
        # Reuse fixed-host strict company validation without requesting normalization definitions.
        connector = HubSpot(original_settings.model_copy(update={"hubspot_property_map": {}}),
                            self.operation.connector.transport)
        started = datetime.now(UTC)
        error = None
        try:
            connector.read_company(binding["company_id"], before_request=check)
        except HubSpotFailure as failure:
            error = str(failure)
        check()
        return HubSpotProbeResult(id=uuid4(), organization_id=original_actor.organization_id,
            account_id=account_id, account_revision=body.expected_account_revision,
            actor_id=original_actor.id, configuration_hash=body.expected_configuration_hash,
            portal_id=binding["portal_id"], company_id=binding["company_id"],
            started_at=started, finished_at=datetime.now(UTC),
            status="failed" if error else "succeeded", error_code=error)
