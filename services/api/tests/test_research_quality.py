"""Manual quality reports retain bindings/history without certifying source truth."""
import unittest
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import test_research as fixtures
from sqlalchemy import select
from vita_api.research_quality import quality_reviews


class QualityTests(unittest.TestCase):
    setUp = fixtures.ResearchApiTests.setUp
    tearDown = fixtures.ResearchApiTests.tearDown
    login = fixtures.ResearchApiTests.login
    respond = fixtures.ResearchApiTests.respond
    search = fixtures.ResearchApiTests.search

    def report(self):
        run = self.search().json()
        self.assertEqual(run["status"], "succeeded")
        self.path = f'{fixtures.PREFIX}/runs/{run["id"]}/quality-reviews'
        ready = self.client.get(self.path).json()
        return run, ready, {"expected_revision": ready["latest_revision"],
            "expected_run_revision": ready["run_revision"], "expected_account_revision": ready["account_revision"],
            "expected_snapshot_hash": ready["snapshot_hash"], "expected_sources_hash": ready["sources_hash"],
            "source_index": 0, "source_url": run["sources"][0]["url"], "identity": "uncertain",
            "factual_support": "contradicted", "citation_support": "does_not_support", "note": "  Manual report only  ",
            "references": ["https://reference.example/report"]}

    def post(self, body):
        return self.client.post(self.path, headers=fixtures.HEADERS, json=body)

    def test_append_only_exact_source_reports_preserve_facts_run_context_and_history(self):
        run, ready, body = self.report()
        before = self.client.get("/api/portfolio").json()
        context = self.client.get(f'{fixtures.PREFIX}/runs/{run["id"]}/context').json()
        calls = len(self.calls)
        self.assertTrue(ready["can_review"])
        response = self.post(body)
        self.assertEqual(response.status_code, 200, response.text)
        first = response.json()
        self.assertEqual((first["basis"], first["factual_confidence"], first["external_execution"]),
            ("manual_report", "unverified", False))
        self.assertEqual(first["report"]["note"], body["note"])
        self.assertEqual(first["source"], run["sources"][0])
        self.assertEqual(first["actor_id"], self.admin.id)
        self.assertEqual(self.post(body).status_code, 409)
        second = self.post({**body, "expected_revision": 1, "note": "Correction with retained prior report"}).json()
        self.assertEqual(second["supersedes_id"], first["id"])
        history = self.client.get(self.path).json()
        self.assertEqual(history["reviews"], [first, second])
        self.assertEqual(self.client.get(f'{fixtures.PREFIX}/runs/{run["id"]}').json(), run)
        after = self.client.get(f'{fixtures.PREFIX}/runs/{run["id"]}/context').json()
        for key in ("retained_run", "internal", "usable_sources", "status", "brief"):
            self.assertEqual(after[key], context[key])
        self.assertEqual(self.client.get("/api/portfolio").json(), before)
        self.assertEqual(len(self.calls), calls)

    def test_stale_crossed_source_digest_roles_scope_and_unsafe_references_deny(self):
        _, _, body = self.report()
        for changes in ({"expected_sources_hash": "0" * 64}, {"expected_snapshot_hash": "0" * 64},
                        {"expected_run_revision": 99}, {"expected_account_revision": 99}, {"source_index": 4},
                        {"source_url": "https://other.example/changed"}):
            self.assertEqual(self.post({**body, **changes}).status_code, 409)
        for changes in ({"source_index": True}, {"note": "  "}, {"references": ["http://reference.example"]},
                        {"references": ["https://user:password@reference.example"]},
                        {"references": ["https://reference.example/?secret=1"]}, {"approved": True}):
            self.assertEqual(self.post({**body, **changes}).status_code, 422)
        for role in ("seller", "viewer"):
            self.identity.create_user(role, "test-password-long", fixtures.SAMPLE_ORG, role)
            self.login(role)
            self.assertFalse(self.client.get(self.path).json()["can_review"])
            self.assertEqual(self.post(body).status_code, 403)
        self.identity.create_user("foreign", "test-password-long", "foreign", "admin")
        self.login("foreign")
        self.assertEqual(self.client.get(self.path).status_code, 404)
        self.assertEqual(self.post(body).status_code, 404)
        with self.app.state.store.engine.connect() as connection:
            self.assertEqual(connection.execute(select(quality_reviews)).all(), [])

    def test_concurrent_exact_report_revision_has_one_winner(self):
        _, _, body = self.report()
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(self.post, [body, body]))
        self.assertEqual(sorted(response.status_code for response in responses), [200, 409])
        history = self.client.get(self.path).json()
        self.assertEqual((history["latest_revision"], len(history["reviews"])), (1, 1))
        self.assertEqual(self.client.get(f'{fixtures.PREFIX}/runs/{uuid4()}/quality-reviews').status_code, 404)
