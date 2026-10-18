"""Bounded HubSpot task/note transport. No retries, target discovery or approval authority."""
import hashlib
import json
import re
from datetime import UTC, datetime

import httpx

from .governance import PolicyDenied, canonical_json
from .hubspot import HubSpot, HubSpotFailure
from .workflow_contracts import DestinationBinding

OBJECTS = "/crm/objects/2026-09"


def provider_request(payload, destination, prepared_at):
    if payload.kind == "hubspot_task_create":
        if payload.due_at is None or payload.due_at.microsecond % 1000:
            raise PolicyDenied("live_task_requires_millisecond_due_time")
        properties = {"hs_task_subject": payload.title, "hs_task_body": payload.body,
                      "hs_timestamp": payload.due_at.isoformat(timespec="milliseconds"),
                      "hs_task_status": "NOT_STARTED", "hs_task_type": "TODO"}
        association = 192
    elif payload.kind == "hubspot_note_create":
        properties = {"hs_note_body": payload.body,
                      "hs_timestamp": prepared_at.isoformat(timespec="milliseconds")}
        association = 190
    else:
        raise PolicyDenied("connector_kind_mismatch")
    return canonical_json({"properties": properties, "associations": [{
        "to": {"id": destination.target_resource_id},
        "types": [{"associationCategory": "HUBSPOT_DEFINED", "associationTypeId": association}]}]}).decode("utf-8")


class HubSpotWrites(HubSpot):
    def destination(self, organization_id, account_id, *, write=True):
        s = self.settings
        company = s.hubspot_company_map.get(str(account_id))
        if (not self.configured or organization_id != s.hubspot_organization_id or not company
                or (write and not s.hubspot_write_enabled)):
            raise PolicyDenied("hubspot_execution_unavailable", 503)
        return DestinationBinding(connector_id="hubspot-live", provider="hubspot",
            configuration_revision=s.hubspot_configuration_revision, tenant_id=s.hubspot_portal_id,
            target_account_id=account_id, target_resource_id=company)

    def client(self):
        return httpx.Client(base_url="https://api.hubapi.com", timeout=15, follow_redirects=False,
            transport=self.transport, headers={"Authorization": "Bearer " + self.settings.hubspot_access_token.get_secret_value()})

    def preflight(self, action, *, write=True):
        if action.destination != self.destination(action.organization_id, action.evidence.account_id, write=write):
            raise HubSpotFailure("hubspot_destination_changed")
        with self.client() as client:
            portal = self._get(client, "/account-info/v3/details").get("portalId")
            if type(portal) is not int or str(portal) != action.destination.tenant_id:
                raise HubSpotFailure("portal_mismatch")
            data = self._get(client, OBJECTS + "/companies/" + action.destination.target_resource_id)
            if data.get("id") != action.destination.target_resource_id or data.get("archived") is not False:
                raise HubSpotFailure("company_identity_or_archive_mismatch")

    @staticmethod
    def object_type(action):
        return "tasks" if action.payload.kind == "hubspot_task_create" else "notes"

    def create(self, action):
        # Once this function starts, all transport/invalid/ambiguous results retain the claim.
        try:
            with self.client() as client, client.stream("POST", OBJECTS + "/" + self.object_type(action),
                    content=action.provider_request.encode("utf-8"), headers={"Content-Type": "application/json"}) as response:
                if response.status_code in {400, 401, 403, 404, 422}:
                    return "failed", None, "hubspot_write_rejected"
                if response.status_code != 201:
                    return "result_unknown", None, "hubspot_write_ambiguous"
                body = bytearray()
                for chunk in response.iter_bytes():
                    body.extend(chunk)
                    if len(body) > 65536:
                        return "result_unknown", None, "hubspot_write_ambiguous"
                resource_id = json.loads(body).get("id")
                if not isinstance(resource_id, str) or not re.fullmatch(r"[1-9][0-9]{0,19}", resource_id):
                    return "result_unknown", None, "hubspot_write_ambiguous"
                return "result_unknown", resource_id, "provider_readback_pending"
        except (httpx.RequestError, ValueError, AttributeError, UnicodeError):
            return "result_unknown", None, "hubspot_write_ambiguous"

    def readback(self, action, resource_id):
        try:
            self.preflight(action, write=False)
            if not re.fullmatch(r"[1-9][0-9]{0,19}", resource_id):
                raise HubSpotFailure("invalid_resource_id")
            expected = json.loads(action.provider_request)["properties"]
            with self.client() as client:
                data = self._get(client, OBJECTS + "/" + self.object_type(action) + "/" + resource_id,
                    params={"properties": ",".join(sorted(expected)), "associations": "companies", "archived": "false"})
            actual = data.get("properties")
            association = "task_to_company" if self.object_type(action) == "tasks" else "note_to_company"
            links = data.get("associations", {}).get("companies", {})
            matches = (data.get("id") == resource_id and data.get("archived") is False and isinstance(actual, dict)
                and not links.get("paging") and links.get("results") == [{"id": action.destination.target_resource_id, "type": association}])
            for key, value in expected.items():
                observed = actual.get(key) if isinstance(actual, dict) else None
                if key == "hs_timestamp":
                    try:
                        stamp = datetime.fromisoformat(observed)
                        matches &= stamp.tzinfo is not None and stamp.astimezone(UTC) == datetime.fromisoformat(value)
                    except (TypeError, ValueError, OverflowError):
                        matches = False
                else:
                    matches &= observed == value
            if not matches:
                return "mismatch", None, "provider_readback_mismatch"
            return "verified", hashlib.sha256(action.provider_request.encode("utf-8")).hexdigest(), None
        except (HubSpotFailure, PolicyDenied, TypeError, AttributeError, ValueError):
            return "unavailable", None, "provider_readback_unavailable"
