"""Governed synthetic seeding with isolated storage and a fake HubSpot transport."""
import hashlib
import json
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Event
from unittest.mock import patch

import httpx
import test_hubspot_ingestion as fixtures
from fastapi.testclient import TestClient
from sqlalchemy import select, update
from vita_api.governance import PolicyDenied
from vita_api.hubspot import HubSpot
from vita_api.hubspot_seeding import SeedBinding, Seeding, SeedJob, SeedRecovery, seeds
from vita_api.hubspot_sync import HubSpotSync
from vita_api.identity import users
from vita_api.storage import Store

PATH = fixtures.PREFIX + "/accounts/" + fixtures.ACCOUNT + "/seeds"
PREFIX = fixtures.PREFIX + "/seeds"


class SeedTests(unittest.TestCase):
    login = fixtures.ApiTests.login
    drop_postgres_schema = fixtures.ApiTests.drop_postgres_schema

    def setUp(self):
        self.resources, self.on_request, self.post_error, self.bad_association = {}, None, None, False
        self.archived, self.archive_error, self.extra_association = set(), None, False
        settings = fixtures.settings
        with patch.object(fixtures, "settings", side_effect=lambda **changes: settings(
                hubspot_write_enabled=True, hubspot_seed_enabled=True,
                hubspot_seed_test_portal_id="456", hubspot_seed_deal_pipeline="synthetic-pipeline",
                hubspot_seed_deal_stage="synthetic-stage", **changes)):
            fixtures.ApiTests.setUp(self)

    def restart(self, **changes):
        """Reinstall the connector's captured configuration against the same isolated data."""
        cookies = self.client.cookies
        self.settings = self.settings.model_copy(deep=True, update=changes)
        self.app = fixtures.create_app(self.settings, hubspot_transport=httpx.MockTransport(self.respond))
        self.client = TestClient(self.app).__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)
        self.client.cookies.update(cookies)

    def respond(self, request):
        self.calls.append(request)
        self.assertEqual(request.url.host, "api.hubapi.com")
        self.assertIn(request.method, {"GET", "POST", "DELETE"})
        if self.on_request and request.method != "POST":
            self.on_request(request)
        if request.method == "POST":
            payload = json.loads(request.content)
            with self.app.state.store.engine.connect() as connection:
                jobs = [SeedJob.model_validate(row) for row in connection.execute(select(seeds.c.payload)).scalars()]
            matching = [item for job in jobs for item in job.items
                if item.status == "dispatching" and item.resolved_request == request.content.decode()]
            self.assertEqual(len(matching), 1, "exact dispatch reservation must commit before POST")
            item = matching[0]
            self.assertEqual(request.url.path, "/crm/v3/objects/" + item.object_type)
            if self.on_request:
                self.on_request(request)
            if self.post_error:
                return self.post_error(request)
            resource = str(1000 + len(self.resources))
            self.resources[resource] = (item.object_type, payload)
            return httpx.Response(201, json={"id": resource})
        if request.url.path == "/account-info/v3/details":
            return httpx.Response(200, json={"portalId": 456})
        if request.method == "DELETE":
            resource = request.url.path.rsplit("/", 1)[1]
            with self.app.state.store.engine.connect() as connection:
                jobs = [SeedJob.model_validate(row) for row in connection.execute(select(seeds.c.payload)).scalars()]
            self.assertTrue(any(item.archive_target_id == resource and item.status == "dispatching"
                for job in jobs if job.operation == "archive" for item in job.items))
            if self.archive_error:
                return self.archive_error(request)
            self.archived.add(resource)
            return httpx.Response(204)
        if "/associations/" in request.url.path:
            resource = request.url.path.split("/")[5]
            kind, payload = self.resources[resource]
            if kind == "companies":
                linked = [key for key, (object_type, child) in self.resources.items()
                    if object_type == request.url.path.rsplit("/", 1)[1] and key not in self.archived
                    and child["associations"][0]["to"]["id"] == resource]
                return httpx.Response(200, json={"results": [{"toObjectId": int(key)} for key in linked]
                    + ([{"toObjectId": 9999}] if self.extra_association else [])})
            target = payload["associations"][0]["to"]["id"]
            data = {"results": [{"toObjectId": int(target), "associationTypes": [{
                "category": "HUBSPOT_DEFINED", "typeId": {"contacts": 279, "notes": 190, "deals": 5}[kind]}]}]}
            if self.bad_association:
                data["paging"] = {"next": {"after": "unread-page"}}
            return httpx.Response(200, json=data)
        resource = request.url.path.rsplit("/", 1)[1]
        _, payload = self.resources[resource]
        return httpx.Response(200, json={"id": resource, "archived": resource in self.archived, "properties": payload["properties"]})

    def cleanup(self, job, indices):
        return self.client.post(f'{PREFIX}/{job["id"]}/cleanup-preview', headers=fixtures.HEADERS,
            json={**self.binding(job), "item_indices": indices})

    def test_archive_requires_new_exact_review_child_first_and_independent_readback(self):
        original = self.execute(self.approved(include_contacts=True, include_notes=True, include_deals=True)).json()
        self.assertEqual(self.cleanup(original, [0, 1, 2, 3]).status_code, 409)
        self.restart(hubspot_cleanup_enabled=True)
        before = len(self.calls)
        self.assertEqual(self.cleanup(original, [0]).status_code, 409)
        self.assertEqual(self.cleanup(original, [1, 1]).status_code, 409)
        cleanup = self.cleanup(original, [0, 1, 2, 3]).json()
        self.assertEqual(len(self.calls), before)
        self.assertEqual((cleanup["operation"], cleanup["source_job_id"], cleanup["status"]),
            ("archive", original["id"], "draft"))
        self.assertNotEqual(cleanup["binding_hash"], original["binding_hash"])
        self.assertEqual(self.execute(cleanup).status_code, 409)
        reviewed = self.review(cleanup).json()
        result = self.execute(reviewed).json()
        self.assertEqual(result["status"], "succeeded")
        deleted = [request.url.path.rsplit("/", 1)[1] for request in self.calls if request.method == "DELETE"]
        self.assertCountEqual(deleted[:-1], [original["items"][i]["resource_id"] for i in [1, 2, 3]])
        self.assertEqual(deleted[-1], original["items"][0]["resource_id"])
        self.assertTrue(all(item["verification"] == "verified" for item in result["items"]))
        self.assertEqual(self.cleanup(original, [1]).status_code, 409)
        self.assertEqual(self.execute(result).status_code, 409)
        self.assertEqual(self.client.get(f'{PREFIX}/{original["id"]}').json()["job"], original)

    def test_verified_child_only_archive_allows_later_parent_without_repeating_delete(self):
        original = self.execute(self.approved(include_contacts=True)).json()
        self.restart(hubspot_cleanup_enabled=True)
        child = self.cleanup(original, [1]).json()
        result = self.execute(self.review(child).json()).json()
        self.assertEqual(result["status"], "succeeded")
        parent = self.cleanup(original, [0])
        self.assertEqual(parent.status_code, 200, parent.text)
        result = self.execute(self.review(parent.json()).json()).json()
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(len([call for call in self.calls if call.method == "DELETE"]), 2)

    def test_archive_preflight_remaining_association_denies_delete_and_claim_replay(self):
        original = self.execute(self.approved()).json()
        self.restart(hubspot_cleanup_enabled=True)
        cleanup = self.review(self.cleanup(original, [0]).json()).json()
        self.extra_association = True
        result = self.execute(cleanup).json()
        self.assertEqual(result["status"], "failed")
        self.assertEqual([call for call in self.calls if call.method == "DELETE"], [])
        self.assertEqual(self.cleanup(original, [0]).status_code, 409)

    def test_ambiguous_archive_stops_batch_and_never_repeats_delete(self):
        original = self.execute(self.approved(include_contacts=True)).json()
        self.restart(hubspot_cleanup_enabled=True)
        cleanup = self.review(self.cleanup(original, [0, 1]).json()).json()

        def timeout(request):
            raise httpx.ReadTimeout("Synthetic archive outcome unknown", request=request)

        self.archive_error = timeout
        result = self.execute(cleanup).json()
        self.assertEqual(result["status"], "result_unknown")
        self.assertEqual(result["items"][1]["status"], "result_unknown")
        self.assertEqual(result["items"][0]["status"], "skipped")
        self.assertEqual(len([call for call in self.calls if call.method == "DELETE"]), 1)
        self.assertEqual(self.execute(result).status_code, 409)
        self.assertEqual(self.cleanup(original, [1]).status_code, 409)

    def operation(self, store=None, config=None, token=None):
        return Seeding(HubSpotSync(store or self.app.state.store,
            HubSpot(config or self.settings, httpx.MockTransport(self.respond)),
            token or self.client.cookies.get("vitaai_session")))

    def prepare(self, **options):
        ready = self.client.get(PATH + "/readiness").json()
        return self.client.post(PATH, headers=fixtures.HEADERS, json={"expected_account_revision": 1,
            "expected_configuration_hash": ready["configuration_hash"], "count": 1, **options})

    @staticmethod
    def binding(job):
        return {"expected_revision": job["revision"], "expected_account_revision": 1,
            "binding_hash": job["binding_hash"]}

    def review(self, job, decision="approved"):
        return self.client.post(f'{PREFIX}/{job["id"]}/review', headers=fixtures.HEADERS,
            json={**self.binding(job), "decision": decision, "reason": "Explicit synthetic test review"})

    def execute(self, job):
        return self.client.post(f'{PREFIX}/{job["id"]}/execute', headers=fixtures.HEADERS, json=self.binding(job))

    def approved(self, **options):
        response = self.prepare(**options)
        self.assertEqual(response.status_code, 200, response.text)
        review = self.review(response.json())
        self.assertEqual(review.status_code, 200, review.text)
        return review.json()

    def test_prepare_is_synthetic_network_free_exact_and_strict(self):
        before = self.client.get("/api/portfolio").json()
        response = self.prepare(count=3, include_contacts=True, include_notes=True, include_deals=True)
        self.assertEqual(response.status_code, 200, response.text)
        job = response.json()
        self.assertEqual((job["status"], len(job["items"]), self.calls), ("draft", 12, []))
        self.assertEqual([item["parent_index"] for item in job["items"]], [None, 0, 0, 0, None, 4, 4, 4, None, 8, 8, 8])
        for item in job["items"]:
            properties = json.loads(item["provider_request"])["properties"]
            self.assertFalse({"email", "phone", "amount", "closedate", "deal_currency_code"} & properties.keys())
            self.assertIsNone(item["resolved_request"])
            self.assertIsNone(item["resource_id"])
        self.assertEqual(self.execute(job).status_code, 409)
        for changes in ({"count": 0}, {"count": True}, {"count": 4}, {"include_contacts": "true"},
                        {"organization_id": "foreign"}, {"expected_configuration_hash": "0" * 64}):
            self.assertIn(self.prepare(**changes).status_code, {409, 422})
        self.assertEqual(self.calls, [])
        self.assertEqual(self.client.get("/api/portfolio").json(), before)

    def test_full_child_batch_readback_versions_and_reconstruction(self):
        before = self.client.get("/api/portfolio").json()
        approved = self.approved(count=3, include_contacts=True, include_notes=True, include_deals=True)
        response = self.execute(approved)
        self.assertEqual(response.status_code, 200, response.text)
        job = response.json()
        self.assertEqual(job["status"], "succeeded")
        self.assertEqual(len([call for call in self.calls if call.method == "POST"]), 12)
        for item in job["items"]:
            self.assertEqual((item["status"], item["verification"]), ("succeeded", "verified"))
            self.assertEqual(item["verified_request_hash"], hashlib.sha256(item["resolved_request"].encode()).hexdigest())
            if item["parent_index"] is not None:
                parent = job["items"][item["parent_index"]]
                self.assertEqual(json.loads(item["resolved_request"])["associations"][0]["to"]["id"], parent["resource_id"])
        history = self.client.get(f'{PREFIX}/{job["id"]}/versions').json()
        self.assertEqual([row["revision"] for row in history], list(range(1, job["revision"] + 1)))
        self.assertEqual(history[1], approved)
        self.assertTrue(all(row["binding_hash"] == approved["binding_hash"] for row in history))
        self.assertNotIn("review_session_hash", json.dumps(history))
        count = len(self.calls)
        self.assertEqual(self.execute(approved).status_code, 409)
        separate = Store(self.settings.database_url)
        try:
            self.assertEqual(self.operation(separate).inspection(job["id"]).job.model_dump(mode="json"), job)
            self.assertEqual(self.operation(separate).history_versions(job["id"])[-1].model_dump(mode="json"), job)
        finally:
            separate.engine.dispose()
        self.assertEqual(self.client.get("/api/portfolio").json(), before)
        self.assertEqual(len(self.calls), count)

    def test_gates_test_portal_deal_configuration_and_role_deny_without_network(self):
        for field, value in (("hubspot_seed_enabled", False), ("hubspot_write_enabled", False),
                              ("hubspot_seed_test_portal_id", "999"), ("hubspot_seed_test_portal_id", "")):
            old = getattr(self.settings, field)
            self.restart(**{field: value})
            self.assertFalse(self.client.get(PATH + "/readiness").json()["can_prepare"])
            self.assertEqual(self.prepare().status_code, 409)
            self.restart(**{field: old})
        self.restart(hubspot_seed_deal_stage="")
        self.assertEqual(self.prepare(include_deals=True).status_code, 409)
        for role in ("seller", "reviewer", "viewer"):
            self.identity.create_user(role, "synthetic-password-long", fixtures.SAMPLE_ORG, role)
            self.login(role)
            self.assertEqual(self.prepare().status_code, 403)
        self.login("admin")
        job = self.prepare().json()
        self.identity.create_user("foreign", "synthetic-password-long", "other", "admin")
        self.login("foreign")
        self.assertEqual(self.client.get(f'{PREFIX}/{job["id"]}').status_code, 404)
        self.assertEqual(self.calls, [])

    def test_rejection_expiry_and_stale_review_grant_no_claim(self):
        job = self.prepare().json()
        self.assertEqual(self.execute(job).status_code, 409)
        self.assertEqual(self.review({**job, "binding_hash": "0" * 64}).status_code, 409)
        rejected = self.review(job, "rejected").json()
        self.assertEqual(rejected["status"], "rejected")
        self.assertEqual(self.execute(rejected).status_code, 409)
        self.assertEqual(self.review(job).status_code, 409)
        next_job = self.prepare().json()
        real = datetime
        with patch("vita_api.hubspot_seeding.datetime") as clock:
            clock.now.side_effect = lambda *_: real.fromisoformat(next_job["expires_at"])
            self.assertEqual(self.review(next_job).status_code, 409)
        self.assertEqual(self.calls, [])

    def test_reviewer_session_revocation_and_configuration_change_deny_dispatch(self):
        job = self.approved(include_deals=True)
        token = self.client.cookies.get("vitaai_session")
        self.identity.create_user("executor", "synthetic-password-long", fixtures.SAMPLE_ORG, "admin")
        self.login("executor")
        original = self.settings.hubspot_seed_deal_stage
        self.restart(hubspot_seed_deal_stage="changed")
        self.assertEqual(self.execute(job).status_code, 409)
        self.restart(hubspot_seed_deal_stage=original)
        self.identity.logout(token)
        self.assertEqual(self.execute(job).status_code, 409)
        self.assertEqual(self.calls, [])

    def test_definite_rejection_stops_children_and_has_no_post_replay(self):
        job = self.approved(include_contacts=True, include_notes=True)
        self.post_error = lambda _: httpx.Response(403, json={"error": "synthetic-token-only"})
        result = self.execute(job).json()
        self.assertEqual((result["status"], [item["status"] for item in result["items"]]),
            ("failed", ["failed", "skipped", "skipped"]))
        self.assertNotIn("synthetic-token-only", json.dumps(result))
        self.assertEqual(len([request for request in self.calls if request.method == "POST"]), 1)
        self.assertEqual(self.execute(result).status_code, 409)

    def test_timeout_without_id_retains_claim_and_never_unblocks_by_age(self):
        job = self.approved(include_contacts=True)

        def timeout(request):
            raise httpx.ReadTimeout("synthetic ambiguous write", request=request)

        self.post_error = timeout
        result = self.execute(job).json()
        self.assertEqual((result["status"], result["items"][0]["resource_id"]), ("result_unknown", None))
        real = datetime
        with patch("vita_api.hubspot_seeding.datetime") as clock:
            clock.now.side_effect = lambda *_: real.now(UTC) + timedelta(days=1)
            self.assertEqual(self.client.get(PATH + "/readiness").json()["blocking_job_id"], job["id"])
        self.assertEqual(self.client.post(f'{PREFIX}/{job["id"]}/reconcile', headers=fixtures.HEADERS,
            json=self.binding(result)).status_code, 409)
        self.assertEqual(self.execute(result).status_code, 409)
        self.assertEqual(len([request for request in self.calls if request.method == "POST"]), 1)

    def test_deep_bounded_create_json_retains_unknown_instead_of_escaping_parser(self):
        job = self.approved(include_contacts=True)
        self.post_error = lambda _: httpx.Response(201, content=b'{"id":"123","extra":' + b'[' * 20000 + b'0' + b']' * 20000 + b'}')
        response = self.execute(job)
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertEqual(result["status"], "result_unknown")
        self.assertEqual([item["status"] for item in result["items"]], ["result_unknown", "skipped"])
        self.assertIsNone(result["items"][0]["resource_id"])
        self.assertEqual(self.execute(result).status_code, 409)
        self.assertEqual(len([request for request in self.calls if request.method == "POST"]), 1)

    def test_unknown_child_association_reconciles_with_writes_disabled_without_resuming(self):
        job = self.approved(include_contacts=True, include_notes=True)
        self.bad_association = True
        unknown = self.execute(job).json()
        self.assertEqual((unknown["status"], [item["status"] for item in unknown["items"]]),
            ("result_unknown", ["succeeded", "result_unknown", "skipped"]))
        self.assertEqual(unknown["items"][1]["verification"], "mismatch")
        self.restart(hubspot_write_enabled=False, hubspot_seed_enabled=False)
        self.bad_association = False
        count = len([request for request in self.calls if request.method == "POST"])
        response = self.client.post(f'{PREFIX}/{job["id"]}/reconcile', headers=fixtures.HEADERS,
            json=self.binding(unknown))
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertEqual((result["status"], [item["status"] for item in result["items"]]),
            ("failed", ["succeeded", "succeeded", "skipped"]))
        self.assertEqual(result["claimed_at"], unknown["claimed_at"])
        self.assertEqual(result["worker_deadline_at"], unknown["worker_deadline_at"])
        self.assertEqual(len([request for request in self.calls if request.method == "POST"]), count)

    def test_requester_loss_after_dispatch_retains_id_and_stops_remaining_writes(self):
        job = self.approved(include_contacts=True)

        def revoke(request):
            if request.method == "POST":
                with self.app.state.store.engine.begin() as connection:
                    connection.execute(update(users).where(users.c.id == self.admin.id).values(enabled=False))

        self.on_request = revoke
        response = self.execute(job)
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertEqual((result["status"], result["items"][0]["status"], result["items"][1]["status"]),
            ("result_unknown", "result_unknown", "skipped"))
        self.assertIsNotNone(result["items"][0]["resource_id"])
        self.assertEqual(len([request for request in self.calls if request.method == "POST"]), 1)

    def test_concurrent_claim_original_deadline_recovery_and_late_worker_fencing(self):
        approved = self.approved(include_contacts=True)
        entered, release = Event(), Event()
        self.addCleanup(release.set)

        def block(request):
            if request.method == "POST":
                entered.set()
                self.assertTrue(release.wait(20))

        self.on_request = block
        separate = Store(self.settings.database_url)
        try:
            with ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(self.execute, approved)
                try:
                    self.assertTrue(entered.wait(10))
                    other = self.operation(separate)
                    with self.assertRaises(PolicyDenied):
                        other.execute(approved["id"], SeedBinding(**self.binding(approved)))
                    saved = other.inspection(approved["id"]).job
                    body = SeedRecovery(**self.binding(saved.model_dump(mode="json")),
                        expected_worker_deadline_at=saved.worker_deadline_at)
                    with self.assertRaises(PolicyDenied):
                        other.recover(saved.id, body)
                    with patch("vita_api.hubspot_seeding.datetime") as clock:
                        clock.now.side_effect = lambda *_: saved.worker_deadline_at
                        with self.assertRaises(PolicyDenied):
                            other.recover(saved.id, body.model_copy(update={
                                "expected_worker_deadline_at": saved.worker_deadline_at + timedelta(seconds=1)}))
                        terminal = other.recover(saved.id, body)
                        with self.assertRaises(PolicyDenied):
                            other.recover(saved.id, body)
                    self.assertEqual([item.status for item in terminal.items], ["result_unknown", "skipped"])
                    self.assertEqual(terminal.worker_deadline_at, saved.worker_deadline_at)
                finally:
                    release.set()
                self.assertEqual(future.result(timeout=10).status_code, 409)
            self.assertEqual(other.inspection(terminal.id).job, terminal)
            self.assertEqual(len([request for request in self.calls if request.method == "POST"]), 1)
        finally:
            separate.engine.dispose()
