"""Network-free synthetic company seed previews; no execution or approval authority."""
import hashlib
from datetime import UTC, datetime
from typing import Literal
from uuid import UUID, uuid4

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

from .governance import PolicyDenied, canonical_json
from .hubspot import HubSpotContract
from .hubspot_refresh import RefreshAuthorizations


class SeedPreviewRequest(HubSpotContract):
    expected_account_revision: int = Field(ge=1, strict=True)
    expected_configuration_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    count: int = Field(ge=1, le=3, strict=True)


class SyntheticCompany(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str
    description: str


class SeedPreview(HubSpotContract):
    id: UUID
    organization_id: str
    actor_id: str
    account_id: UUID
    account_revision: int
    configuration_hash: str
    portal_id: str
    created_at: AwareDatetime
    mode: Literal["preview"] = "preview"
    execution_available: Literal[False] = False
    method: Literal["POST"] = "POST"
    path: Literal["/crm/v3/objects/companies"] = "/crm/v3/objects/companies"
    companies: tuple[SyntheticCompany, ...] = Field(min_length=1, max_length=3)
    preview_hash: str
    policy: Literal["synthetic-company-seed-preview-1"] = "synthetic-company-seed-preview-1"


def preview_seed(operation, account_id, body):
    with operation.transaction(write=True) as (connection, actor):
        account = operation.account(connection, actor, account_id, body.expected_account_revision)
        if not operation.connector.configured:
            raise PolicyDenied("hubspot_seed_preview_unavailable", 409)
        binding, digest = RefreshAuthorizations(operation).binding(account_id)
        if digest != body.expected_configuration_hash:
            raise PolicyDenied("hubspot_seed_preview_context_changed", 409)
        preview_id = uuid4()
        companies = tuple(SyntheticCompany(
            name=f"VitaAi synthetic demo {preview_id} / {index + 1}",
            description=f"Synthetic VitaAi demonstration only. Seed preview {preview_id}, record {index + 1}. "
                        "No customer facts or measured business results.") for index in range(body.count))
        retained = {"id": str(preview_id), "organization_id": actor.organization_id, "actor_id": actor.id,
            "account_id": str(account.id), "account_revision": account.revision, "configuration_hash": digest,
            "portal_id": binding["portal_id"], "created_at": datetime.now(UTC),
            "companies": companies}
        # Checksum for inspecting this preview, never an approval or dispatch token.
        encoded = {**retained, "created_at": retained["created_at"].isoformat(),
                   "companies": [company.model_dump() for company in companies]}
        return SeedPreview(**retained, preview_hash=hashlib.sha256(canonical_json(encoded)).hexdigest())
