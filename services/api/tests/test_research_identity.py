"""Synthetic reviewer decisions test identity eligibility, never establish live truth."""
import copy
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

import httpx
import test_research as fixtures
from sqlalchemy import select, update
from vita_api.config import ResearchTarget
from vita_api.research import Research, ResearchRequest, source_match
from vita_api.research_identity import ResearchIdentity, identity_decisions
from vita_api.research_service import ResearchService
from vita_api.storage import Store, accounts


class IdentityTests(unittest.TestCase):
    setUp = fixtures.ResearchApiTests.setUp
    tearDown = fixtures.ResearchApiTests.tearDown
    login = fixtures.ResearchApiTests.login
    respond = fixtures.ResearchApiTests.respond

    def prepare(self, title="Example update", text="Example develops software.", *, extra_source=False):
        target = ResearchTarget(company_name="Example Corporation", domain="example.test",
            publisher_domains=["publisher.test"])
        config = self.settings.model_copy(update={"research_account_map": {fixtures.ACCOUNT: target}})
        article = {**fixtures.ITEM, "url": "https://publisher.test/article", "title": title, "content": text,
            "published_date": (datetime.now(UTC) - timedelta(days=1)).isoformat()}
        def respond(request):
            self.calls.append(request)
            return httpx.Response(200, json={"results": [article, {**article, "url": "https://publisher.test/second"}]
                if extra_source else [article]})
        self.connector = Research(config, httpx.MockTransport(respond))
        self.operation = ResearchService(self.app.state.store, self.connector,
            self.client.cookies.get("vitaai_session"))
        self.run = self.operation.start(fixtures.ACCOUNT, ResearchRequest(expected_account_revision=1, mode="live"))
        self.identity_service = ResearchIdentity(self.operation)
        self.ready = self.identity_service.inspect(self.run.id)
        self.body = {"expected_revision": 0, "expected_run_revision": self.run.revision,
            "expected_account_revision": self.ready.account_revision, "expected_snapshot_hash": self.ready.snapshot_hash,
            "expected_sources_hash": self.ready.sources_hash, "source_index": 0, "source_url": self.run.sources[0].url,
            "decision": "corroborated", "source_subject": "Example", "note": " Synthetic identity adjudication only. ",
            "references": [{"url": "https://example.test/about", "subject": "Example Corporation",
                "excerpt": "Example Corporation develops software.", "relation": "The retained article subject is this company."}]}

    def decide(self, **changes):
        from vita_api.research_identity import IdentityRequest
        return self.identity_service.review(self.run.id, IdentityRequest(**{**self.body, **changes}))

    def test_broader_candidate_requires_exact_adjudication_and_unknown_suppresses_it(self):
        self.prepare()
        self.assertEqual(self.run.sources[0].match, "configured_publisher_identity_candidate")
        before = self.client.get("/api/portfolio").json()
        context = self.operation.context(self.run.id)
        self.assertEqual(context.status, "no_usable_sources")
        self.assertEqual(context.exclusions[0].reason, "identity_unresolved")
        first = self.decide()
        self.assertEqual(first.basis, "reviewer_adjudication")
        accepted = self.operation.context(self.run.id)
        self.assertEqual(accepted.status, "usable")
        self.assertEqual(accepted.identity_decisions, [first])
        self.assertEqual(accepted.factual_confidence, "unverified")
        for revision, decision in enumerate(["conflicting", "uncertain", "namesake_or_unrelated"], 1):
            saved = self.decide(expected_revision=revision, decision=decision)
            rejected = self.operation.context(self.run.id)
            self.assertEqual(rejected.status, "no_usable_sources")
            self.assertEqual(rejected.identity_decisions, [saved])
            self.assertEqual(rejected.exclusions[0].reason, "identity_unresolved")
        self.assertEqual(self.operation.get(self.run.id), self.run)
        self.assertEqual(self.client.get("/api/portfolio").json(), before)
        self.assertEqual(len(self.calls), 1)
        other = Store(self.settings.database_url)
        try:
            fresh = ResearchService(other, self.connector, self.client.cookies.get("vitaai_session"))
            self.assertEqual(fresh.context(self.run.id).identity_decisions, [saved])
        finally:
            other.engine.dispose()

    def test_negative_decision_suppresses_legacy_heuristic_and_expiry_is_not_renewed(self):
        self.prepare(title="Example Corporation update")
        self.assertEqual(self.operation.context(self.run.id).status, "usable")
        self.decide(decision="namesake_or_unrelated")
        self.assertEqual(self.operation.context(self.run.id).status, "no_usable_sources")
        self.decide(expected_revision=1)
        self.operation.clock = lambda: self.run.expires_at
        self.assertEqual(self.operation.context(self.run.id).status, "expired")
        self.assertEqual(self.operation.get(self.run.id).expires_at, self.run.expires_at)

    def test_bindings_reference_evidence_roles_and_replay(self):
        from pydantic import ValidationError
        from vita_api.governance import PolicyDenied
        self.prepare()
        for change in ({"expected_sources_hash": "0" * 64}, {"expected_snapshot_hash": "0" * 64},
                       {"expected_run_revision": 99}, {"expected_account_revision": 99},
                       {"source_url": "https://publisher.test/other"}, {"source_subject": "Invented entity"}):
            with self.subTest(change=change), self.assertRaises(PolicyDenied):
                self.decide(**change)
        for change in ({"source_index": True}, {"references": []}, {"note": " "},
                       {"references": [{**self.body["references"][0], "url": "https://user:secret@example.test"}]},
                       {"references": [{**self.body["references"][0], "url": "https://127.0.0.1/private"}]}):
            with self.subTest(change=change), self.assertRaises(ValidationError):
                self.decide(**change)
        self.decide()
        with self.assertRaises(PolicyDenied):
            self.decide()
        with self.app.state.store.engine.begin() as connection:
            payload = copy.deepcopy(connection.execute(select(accounts.c.payload).where(
                accounts.c.id == fixtures.ACCOUNT)).scalar_one())
            payload["revision"] += 1
            connection.execute(update(accounts).where(accounts.c.id == fixtures.ACCOUNT).values(revision=2, payload=payload))
        self.assertEqual(self.operation.context(self.run.id).status, "account_changed")
        self.assertFalse(self.identity_service.inspect(self.run.id).can_review)
        with self.assertRaises(PolicyDenied):
            self.decide(expected_revision=1)

    def test_concurrent_revision_has_one_winner_and_http_scope_is_enforced(self):
        from vita_api.governance import PolicyDenied
        self.prepare()
        def decide(_):
            try:
                return self.decide().revision
            except PolicyDenied as error:
                return error.status_code
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(decide, range(2))), [1, 409])
        path = f'{fixtures.PREFIX}/runs/{self.run.id}/identity-decisions'
        self.assertEqual(self.client.get(path).status_code, 200)
        for role in ("seller", "viewer"):
            self.identity.create_user(role, "test-password-long", fixtures.SAMPLE_ORG, role)
            self.login(role)
            self.assertFalse(self.client.get(path).json()["can_review"])
            self.assertEqual(self.client.post(path, headers=fixtures.HEADERS, json=self.body).status_code, 403)
        self.identity.create_user("foreign", "test-password-long", "foreign", "admin")
        self.login("foreign")
        self.assertEqual(self.client.get(path).status_code, 404)
        self.assertEqual(self.client.post(path, headers=fixtures.HEADERS, json=self.body).status_code, 404)
        with self.app.state.store.engine.connect() as connection:
            self.assertEqual(len(connection.execute(select(identity_decisions)).all()), 1)

    def test_namesakes_negation_competitor_mentions_and_acronyms_never_prove_identity(self):
        target = ResearchTarget(company_name="Example Systems Corporation", domain="example.test",
            publisher_domains=["publisher.test"])
        for text in ("Example Systems is not raising funding", "Example Systems is a competitor of the subject",
                     "ESC could refer to several companies", "Namesake Example Systems in the same city"):
            with self.subTest(text=text):
                self.assertEqual(source_match("https://publisher.test/article", text, "", target),
                    "configured_publisher_identity_candidate")
        self.assertIsNone(source_match("https://publisher.test.evil.test/article", "Example Systems", "", target))

    def test_other_source_corrections_cannot_hide_a_rejection_beyond_latest_twenty(self):
        self.prepare(extra_source=True)
        rejected = self.decide(source_index=1, source_url=self.run.sources[1].url, decision="namesake_or_unrelated")
        for revision in range(22):
            self.decide(expected_revision=revision)
        ready = self.identity_service.inspect(self.run.id)
        self.assertEqual(len(ready.history), 20)
        self.assertNotIn(rejected, ready.history)
        self.assertEqual([item.revision for item in ready.decisions], [22, 1])
        context = self.operation.context(self.run.id)
        self.assertEqual([item.url for item in context.usable_sources], [self.run.sources[0].url])
        self.assertEqual(context.exclusions[0].source_index, 1)

    def test_source_target_and_snapshot_changes_cannot_reuse_adjudication(self):
        from vita_api.research_context import build_context
        self.prepare()
        saved = self.decide()
        context = self.operation.context(self.run.id)
        changed_run = self.run.model_copy(deep=True)
        changed_run.sources[0].text += " Changed excerpt at same URL."
        changed = build_context(context.internal, changed_run, changed_run.target, enabled=True,
            now=context.evaluated_at, identity_decisions=[saved])
        self.assertEqual(changed.exclusions[0].reason, "identity_binding_changed")
        changed_view = context.internal.model_copy(deep=True)
        changed_view.assessment.snapshot_hash = "0" * 64
        changed = build_context(changed_view, self.run, self.run.target, enabled=True,
            now=context.evaluated_at, identity_decisions=[saved])
        self.assertEqual(changed.exclusions[0].reason, "identity_binding_changed")
        changed_target = self.run.target.model_copy(update={"company_aliases": ["Other alias"]})
        self.assertEqual(build_context(context.internal, self.run, changed_target, enabled=True,
            now=context.evaluated_at, identity_decisions=[saved]).status, "target_changed")

    def test_quality_consistency_does_not_admit_a_broader_candidate(self):
        from vita_api.research_quality import QualityRequest, ResearchQuality
        self.prepare()
        quality = ResearchQuality(self.operation)
        ready = quality.inspect(self.run.id)
        quality.review(self.run.id, QualityRequest(expected_revision=0, expected_run_revision=self.run.revision,
            expected_account_revision=ready.account_revision, expected_snapshot_hash=ready.snapshot_hash,
            expected_sources_hash=ready.sources_hash, source_index=0, source_url=self.run.sources[0].url,
            identity="consistent", factual_support="supported", citation_support="supports_excerpt", note="Synthetic quality only"))
        self.assertEqual(self.operation.context(self.run.id).status, "no_usable_sources")
