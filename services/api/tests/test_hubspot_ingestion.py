"""Synthetic associated staging tests, with temporary SQLite and injected HTTP."""
import copy
import hashlib
import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path
from threading import Event
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient
from sqlalchemy import select, update

from vita_api.app import create_app
from vita_api.config import Settings
from vita_api.hubspot import HubSpot, HubSpotFailure
from vita_api.hubspot_ingestion import (
    AssociatedReader,
    Ingestion,
    IngestionRequest,
    ingestions,
)
from vita_api.hubspot_sync import HubSpotSync
from vita_api.identity import Identity, users
from vita_api.sample import SAMPLE_ORG, sample_records

ACCOUNT = str(sample_records(datetime.now(UTC))[0][0].id)
HEADERS = {"X-VitaAi-Request": "1", "Origin": "http://127.0.0.1:3000"}
PREFIX = "/api/integrations/hubspot"
PATH = PREFIX + "/accounts/" + ACCOUNT + "/ingestions"
READINESS_PATH = PATH + "/readiness"


def configuration_hash(config):
    binding = {"portal_id": config.hubspot_portal_id, "company_id": config.hubspot_company_map.get(ACCOUNT, ""),
        "configuration_revision": config.hubspot_configuration_revision, "mapping_hash": HubSpot(config).mapping_hash}
    return hashlib.sha256(json.dumps({"organization_id": config.hubspot_organization_id, **binding},
        sort_keys=True, separators=(",", ":")).encode()).hexdigest()


ASSOCIATION = {"toObjectId": 789, "associationTypes": [
    {"category": "HUBSPOT_DEFINED", "typeId": 280, "label": None}]}
OBJECT = {"id": "789", "archived": False, "createdAt": "2026-09-01T00:00:00Z",
    "updatedAt": "2026-10-01T00:00:00Z", "properties": {"firstname": "Synthetic", "email": None}}


def settings(**changes):
    return Settings(_env_file=None, auth_mode="session", hubspot_enabled=True, hubspot_ingestion_enabled=True,
        hubspot_access_token="synthetic-token-only", hubspot_organization_id=SAMPLE_ORG,
        hubspot_portal_id="456", hubspot_company_map={ACCOUNT: "123"}, **changes)


BODY = {"expected_account_revision": 1, "expected_configuration_revision": 1,
    "expected_configuration_hash": configuration_hash(settings()), "object_type": "contacts"}


class TransportTests(unittest.TestCase):
    def test_paginated_deduplication_and_fixed_host_gets(self):
        calls, guards = [], []
        def respond(request):
            calls.append(request)
            self.assertEqual((request.method, request.url.host), ("GET", "api.hubapi.com"))
            if request.url.path.startswith("/account"):
                return httpx.Response(200, json={"portalId": 456})
            if "/associations/" in request.url.path:
                return httpx.Response(200, json={"results": [ASSOCIATION], **({"paging": {
                    "next": {"after": "cursor_2", "link": "https://untrusted.test"}}}
                    if "after" not in request.url.params else {})})
            return httpx.Response(200, json={**OBJECT, "extra": "discarded"})
        reader = AssociatedReader(settings(), httpx.MockTransport(respond))
        result = reader.read("123", "contacts", before_request=lambda: guards.append(1))
        self.assertEqual((len(calls), len(guards), len(result)), (4, 4, 1))
        self.assertEqual(result[0].properties, OBJECT["properties"])
        self.assertEqual(result[0].updated_at, datetime(2026, 10, 1, tzinfo=UTC))

    def test_malformed_pagination_identity_times_and_credentials_reject(self):
        cases = [({"results": [ASSOCIATION], "paging": {"next": {"after": "https://bad"}}}, OBJECT),
                 ({"results": [{**ASSOCIATION, "toObjectId": True}]}, OBJECT),
                 ({"results": [ASSOCIATION]}, {**OBJECT, "id": "999"}),
                 ({"results": [ASSOCIATION]}, {**OBJECT, "archived": True}),
                 ({"results": [ASSOCIATION]}, {**OBJECT, "updatedAt": "2030-01-01T00:00:00Z"}),
                 ({"results": [ASSOCIATION]}, {**OBJECT, "updatedAt": "2026-10-01T00:00:00"}),
                 ({"results": [ASSOCIATION]}, {**OBJECT, "properties": {"email": "synthetic-token-only"}}),
                 ({"results": [ASSOCIATION], "paging": {"next": {"after": "same"}}}, OBJECT),
                 ({"results": [{**ASSOCIATION, "toObjectId": i} for i in range(1, 22)]}, OBJECT)]
        for page, record in cases:
            def respond(request, page=page, record=record):
                value = {"portalId": 456} if request.url.path.startswith("/account") else (
                    page if "/associations/" in request.url.path else record)
                return httpx.Response(200, json=value)
            with self.subTest(page=page, record=record), self.assertRaises(HubSpotFailure):
                AssociatedReader(settings(), httpx.MockTransport(respond)).read("123", "contacts", before_request=lambda: None)

    def test_safe_errors_no_retry_and_gates(self):
        calls = []
        def reject(request):
            calls.append(request)
            return httpx.Response(429, json={"message": "synthetic-token-only"})
        with self.assertRaisesRegex(HubSpotFailure, "^hubspot_http_429$"):
            AssociatedReader(settings(), httpx.MockTransport(reject)).read("123", "contacts", before_request=lambda: None)
        self.assertEqual(len(calls), 1)
        for company, kind in (("../123", "contacts"), ("123", "companies")):
            with self.assertRaises(HubSpotFailure):
                AssociatedReader(settings(), httpx.MockTransport(reject)).read(company, kind, before_request=lambda: None)
        self.assertEqual(len(calls), 1)


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.settings = settings(database_url=f"sqlite:///{Path(self.temp.name) / 'ingestion.sqlite'}")
        self.record, self.page = copy.deepcopy(OBJECT), {"results": [copy.deepcopy(ASSOCIATION)]}
        self.calls, self.callback = [], None
        self.app = create_app(self.settings, hubspot_transport=httpx.MockTransport(self.respond))
        self.client = TestClient(self.app).__enter__()
        self.identity = Identity(self.app.state.store.engine)
        self.admin = self.identity.create_user("admin", "synthetic-password-long", SAMPLE_ORG, "admin")
        self.login("admin")

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.temp.cleanup()

    def login(self, name):
        self.client.cookies.clear()
        self.assertEqual(self.client.post("/api/auth/login", headers=HEADERS,
            json={"username": name, "password": "synthetic-password-long"}).status_code, 200)

    def respond(self, request):
        self.calls.append(request)
        self.assertEqual(request.method, "GET")
        if self.callback:
            self.callback(request)
        value = {"portalId": 456} if request.url.path.startswith("/account") else (
            self.page if "/associations/" in request.url.path else self.record)
        return httpx.Response(200, json=value)

    def start(self, **changes):
        return self.client.post(PATH, headers=HEADERS, json={**BODY, **changes})

    def test_readiness_is_network_free_and_start_binds_displayed_configuration(self):
        readiness = self.client.get(READINESS_PATH).json()
        self.assertEqual((readiness["account_id"], readiness["account_revision"], readiness["can_start"],
                          readiness["reason"]), (ACCOUNT, 1, True, "ready"))
        self.assertEqual((readiness["configuration_revision"], readiness["configuration_hash"], self.calls),
                         (1, BODY["expected_configuration_hash"], []))
        for changed in ({"expected_configuration_revision": 2}, {"expected_configuration_hash": "0" * 64}):
            self.assertEqual(self.start(**changed).status_code, 409)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.start().status_code, 200)
        count = len(self.calls)
        after = self.client.get(READINESS_PATH).json()
        self.assertEqual((after["can_start"], after["reason"], after["pending_run_id"]),
                         (False, "ingestion_cooldown", None))
        self.assertEqual(len(self.calls), count)

    def test_pending_readiness_and_recovery_readiness_survive_disabled_remapping(self):
        with patch.object(AssociatedReader, "read", side_effect=RuntimeError("synthetic worker loss")), self.assertRaises(RuntimeError):
            self.start()
        pending = self.client.get(READINESS_PATH).json()
        self.assertEqual((pending["reason"], pending["can_start"]), ("ingestion_pending", False))
        self.assertIsNotNone(pending["pending_run_id"])
        self.assertEqual(pending["pending_run_id"], self.client.get(PATH).json()[0]["id"])
        record_id = pending["pending_run_id"]
        disabled = self.settings.model_copy(update={"hubspot_ingestion_enabled": False, "hubspot_company_map": {}})
        app = create_app(disabled, hubspot_transport=httpx.MockTransport(lambda _: self.fail("Unexpected network")))
        readiness_path = PREFIX + "/ingestions/" + record_id + "/recovery-readiness"
        real = datetime
        with TestClient(app) as client, patch("vita_api.hubspot_ingestion.datetime") as clock:
            client.cookies.set("vitaai_session", self.client.cookies.get("vitaai_session"))
            clock.now.side_effect = lambda *_: real.now(UTC) + timedelta(minutes=3)
            response = client.get(readiness_path)
            self.assertEqual(response.status_code, 200, response.text)
            saved = response.json()
            self.assertEqual((saved["run"]["id"], saved["eligible"], saved["reason"]),
                             (record_id, True, "eligible"))
            self.assertEqual(self.calls, [])

    def test_legacy_hashless_history_is_readable_but_starts_a_new_baseline(self):
        first = self.start().json()
        with self.app.state.store.engine.begin() as connection:
            legacy = {key: value for key, value in first.items() if key != "configuration_hash"}
            connection.execute(update(ingestions).where(ingestions.c.id == first["id"]).values(payload=legacy))
        saved = self.client.get(PREFIX + "/ingestions/" + first["id"]).json()
        self.assertIsNone(saved["configuration_hash"])
        real = datetime
        with patch("vita_api.hubspot_ingestion.datetime") as clock:
            clock.now.side_effect = lambda *_: real.now(UTC) + timedelta(seconds=61)
            second = self.start().json()
        self.assertEqual((second["status"], second["disposition"], second["previous_run_id"]),
                         ("succeeded", "baseline", None))

    def operation(self, settings_override=None):
        return Ingestion(HubSpotSync(self.app.state.store,
            HubSpot(settings_override or self.settings, httpx.MockTransport(self.respond)),
            self.client.cookies.get("vitaai_session")))

    def test_configuration_change_fences_next_get_and_publication(self):
        operation = self.operation()
        def change(request):
            if request.url.path.startswith("/account"):
                operation.operation.connector.settings.hubspot_ingestion_enabled = False
        self.callback = change
        from vita_api.governance import PolicyDenied
        with self.assertRaises(PolicyDenied):
            operation.start(ACCOUNT, IngestionRequest(**BODY))
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.client.get(PATH).json()[0]["status"], "pending")

    def test_authority_loss_after_last_get_discards_output(self):
        def disable(request):
            if request.url.path.startswith("/crm/v3/objects/"):
                with self.app.state.store.engine.begin() as connection:
                    connection.execute(update(users).where(users.c.id == self.admin.id).values(role="viewer"))
        self.callback = disable
        self.assertEqual(self.start().status_code, 403)
        with self.app.state.store.engine.connect() as connection:
            saved = connection.execute(select(ingestions.c.payload)).scalar_one()
        self.assertEqual((len(self.calls), saved["status"], saved["objects"]), (3, "pending", []))

    def test_failed_second_object_never_publishes_partial_snapshot(self):
        self.page["results"].append({**ASSOCIATION, "toObjectId": 790})
        result = self.start().json()
        self.assertEqual((result["status"], result["objects"]), ("failed", []))
        self.assertEqual(len(self.calls), 4)

    def test_original_deadline_recovery_fences_late_worker(self):
        operation = self.operation()
        final = []
        def finalize(request):
            if request.url.path.startswith("/crm/v3/objects/"):
                pending = operation.history(ACCOUNT)[0]
                from vita_api.hubspot_ingestion import IngestionRecovery
                real = datetime
                with patch("vita_api.hubspot_ingestion.datetime") as clock:
                    clock.now.side_effect = lambda *_: real.now(UTC) + timedelta(minutes=3)
                    final.append(self.operation().recover(pending.id, IngestionRecovery(
                        expected_revision=pending.revision, expected_account_revision=1,
                        expected_worker_deadline_at=pending.worker_deadline_at)))
        self.callback = finalize
        from vita_api.governance import PolicyDenied
        with self.assertRaises(PolicyDenied):
            operation.start(ACCOUNT, IngestionRequest(**BODY))
        self.assertEqual(operation.inspect(final[0].id), final[0])
        self.assertEqual(final[0].objects, [])

    def test_recovery_after_reconstruction_disabled_gate_exact_bindings(self):
        with patch.object(AssociatedReader, "read", side_effect=RuntimeError("synthetic loss")), self.assertRaises(RuntimeError):
            self.start()
        pending = self.client.get(PATH).json()[0]
        disabled = self.settings.model_copy(update={"hubspot_ingestion_enabled": False, "hubspot_company_map": {}})
        app = create_app(disabled, hubspot_transport=httpx.MockTransport(lambda _: self.fail("Unexpected network")))
        body = {"expected_revision": pending["revision"], "expected_account_revision": 1,
                "expected_worker_deadline_at": pending["worker_deadline_at"]}
        path = PREFIX + "/ingestions/" + pending["id"] + "/recover"
        real = datetime
        with TestClient(app) as client, patch("vita_api.hubspot_ingestion.datetime") as clock:
            client.cookies.set("vitaai_session", self.client.cookies.get("vitaai_session"))
            clock.now.side_effect = lambda *_: real.now(UTC) + timedelta(minutes=3)
            for changed in ({"expected_account_revision": 2}, {"expected_revision": 2},
                            {"expected_worker_deadline_at": "2026-10-01T00:00:00Z"}):
                self.assertEqual(client.post(path, headers=HEADERS, json={**body, **changed}).status_code, 409)
            result = client.post(path, headers=HEADERS, json=body)
            self.assertEqual(result.status_code, 200, result.text)
            self.assertEqual(result.json()["worker_deadline_at"], pending["worker_deadline_at"])
        self.assertEqual(self.calls, [])

    def test_corrections_removals_and_backward_time_preserve_history(self):
        first = self.start().json()
        real = datetime
        for seconds, properties, timestamp, expected in (
            (61, {"firstname": "Corrected"}, "2026-10-02T00:00:00Z", "changed"),
            (122, {"firstname": "Old"}, "2026-09-30T00:00:00Z", None),
        ):
            self.record.update(properties=properties, updatedAt=timestamp)
            with patch("vita_api.hubspot_ingestion.datetime") as clock:
                clock.now.side_effect = lambda *_, seconds=seconds: real.now(UTC) + timedelta(seconds=seconds)
                result = self.start().json()
            self.assertEqual(result["disposition"], expected)
            if expected is None:
                self.assertEqual((result["status"], result["error_code"], result["objects"]),
                    ("failed", "ingestion_source_time_conflict", []))
        self.page = {"results": []}
        with patch("vita_api.hubspot_ingestion.datetime") as clock:
            clock.now.side_effect = lambda *_: real.now(UTC) + timedelta(seconds=183)
            result = self.start().json()
        self.assertEqual((result["status"], result["disposition"], result["objects"]), ("succeeded", "changed", []))
        self.assertEqual(self.client.get(PREFIX + "/ingestions/" + first["id"]).json(), first)

    def test_concurrent_durable_claim_blocks_second_operation(self):
        entered, release = Event(), Event()
        def pause(request):
            if request.url.path.startswith("/account"):
                entered.set()
                self.assertTrue(release.wait(10))
        self.callback = pause
        operation = self.operation()
        from vita_api.governance import PolicyDenied
        with ThreadPoolExecutor(max_workers=1) as pool:
            first = pool.submit(operation.start, ACCOUNT, IngestionRequest(**BODY))
            try:
                self.assertTrue(entered.wait(5))
                with self.assertRaises(PolicyDenied) as denied:
                    self.operation().start(ACCOUNT, IngestionRequest(**BODY))
                self.assertEqual(str(denied.exception), "ingestion_pending")
            finally:
                release.set()
            self.assertEqual(first.result(timeout=10).status, "succeeded")
        self.assertEqual(len(self.calls), 3)

    def test_failure_discards_partial_and_disabled_history_survives_reconstruction(self):
        self.record["id"] = "999"
        first = self.start().json()
        self.assertEqual((first["status"], first["objects"]), ("failed", []))
        disabled = self.settings.model_copy(update={"hubspot_ingestion_enabled": False, "hubspot_company_map": {}})
        app = create_app(disabled, hubspot_transport=httpx.MockTransport(lambda _: self.fail("Unexpected GET")))
        with TestClient(app) as client:
            client.cookies.set("vitaai_session", self.client.cookies.get("vitaai_session"))
            self.assertEqual(client.get(PREFIX + "/ingestions/" + first["id"]).json(), first)
            self.assertEqual(client.get(PATH).json(), [first])
            self.assertEqual(client.post(PATH, headers=HEADERS, json=BODY).status_code, 503)

    def test_immutable_baseline_unchanged_and_no_fact_mutation(self):
        before = self.client.get("/api/accounts/" + ACCOUNT).json()
        response = self.start()
        self.assertEqual(response.status_code, 200, response.text)
        first = response.json()
        self.assertEqual(first["disposition"], "baseline")
        self.assertEqual(first["objects"][0]["properties"]["email"], None)
        self.assertEqual(self.start().status_code, 409)
        real = datetime
        with patch("vita_api.hubspot_ingestion.datetime") as clock:
            clock.now.side_effect = lambda *_: real.now(UTC) + timedelta(seconds=61)
            second = self.start().json()
        self.assertEqual(second["disposition"], "unchanged")
        self.assertEqual(second["previous_run_id"], first["id"])
        self.assertEqual(self.client.get(PREFIX + "/ingestions/" + first["id"]).json(), first)
        self.assertEqual(self.client.get("/api/accounts/" + ACCOUNT).json(), before)
        self.assertEqual(len(self.client.get(PATH).json()), 2)

    def test_all_types_preserve_raw_units_dates_and_missing_values(self):
        for kind in ("contacts", "deals", "notes", "tasks"):
            self.record["properties"] = {"amount": "120.50", "deal_currency_code": None,
                "closedate": None, "hs_timestamp": None, "hs_task_body": "Untrusted text", "hs_note_body": "Note"}
            result = AssociatedReader(self.settings, httpx.MockTransport(self.respond)).read("123", kind, before_request=lambda: None)
            self.assertEqual(len(result), 1)
            if kind == "deals":
                self.assertEqual(result[0].properties, {"amount": "120.50", "deal_currency_code": None, "closedate": None})

    def test_strict_requests_roles_and_scope_before_network(self):
        for body in ({"object_type": "companies"}, {"expected_account_revision": True},
                     {"expected_account_revision": 2}, {"extra": "reject"}):
            self.assertIn(self.start(**body).status_code, (409, 422))
        for name, org, role in (("viewer", SAMPLE_ORG, "viewer"), ("seller", SAMPLE_ORG, "seller"),
                                ("foreign", "foreign", "admin")):
            self.identity.create_user(name, "synthetic-password-long", org, role)
            self.login(name)
            self.assertIn(self.start().status_code, (403, 404))
        self.assertEqual(self.calls, [])

    def test_authority_loss_between_gets_leaves_pending_without_output(self):
        def disable(request):
            if request.url.path.startswith("/account"):
                with self.app.state.store.engine.begin() as connection:
                    connection.execute(update(users).where(users.c.id == self.admin.id).values(role="viewer"))
        self.callback = disable
        self.assertEqual(self.start().status_code, 403)
        self.assertEqual(len(self.calls), 1)
        with self.app.state.store.engine.connect() as connection:
            saved = connection.execute(select(ingestions.c.payload)).scalar_one()
        self.assertEqual((saved["status"], saved["objects"]), ("pending", []))

    def test_worker_loss_pending_recovery_and_terminal_replay(self):
        with patch.object(AssociatedReader, "read", side_effect=RuntimeError("synthetic worker loss")), self.assertRaises(RuntimeError):
            self.start()
        pending = self.client.get(PATH).json()[0]
        self.assertEqual(self.start().status_code, 409)
        path = PREFIX + "/ingestions/" + pending["id"] + "/recover"
        body = {"expected_revision": pending["revision"], "expected_account_revision": 1,
                "expected_worker_deadline_at": pending["worker_deadline_at"]}
        self.assertEqual(self.client.post(path, headers=HEADERS, json=body).status_code, 409)
        real = datetime
        with patch("vita_api.hubspot_ingestion.datetime") as clock:
            clock.now.side_effect = lambda *_: real.now(UTC) + timedelta(minutes=3)
            result = self.client.post(path, headers=HEADERS, json=body)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()["status"], "interrupted")
        self.assertEqual(result.json()["recovered_by"], self.admin.id)
        self.assertEqual(self.client.post(path, headers=HEADERS, json=body).status_code, 409)
        self.assertEqual(self.calls, [])
