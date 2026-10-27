"""Recall policy uses original data, current scope and explicit repeat suppression."""
import unittest
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import test_memory as fixtures
from vita_api.memory import Memory
from vita_api.memory_contracts import MemoryLifecycle
from vita_api.memory_retrieval import RecallRequest, recall
from vita_api.scoring import assess


class RecallTests(unittest.TestCase):
    setUp = fixtures.MemoryTests.setUp
    tearDown = fixtures.MemoryTests.tearDown
    database = fixtures.MemoryTests.database
    snapshot = staticmethod(fixtures.MemoryTests.snapshot)
    assert_denied = fixtures.MemoryTests.assert_denied

    def body(self, **changes):
        account, facts, _ = next(row for row in self.store.account_records(fixtures.SAMPLE_ORG)
                                 if row[0].id == str(self.account_id))
        current = assess(account, facts, datetime.now(UTC).date())
        return RecallRequest(expected_snapshot_hash=current.snapshot_hash, **changes)

    def test_deterministic_score_explanation_scope_and_no_writes(self):
        item = self.memory.capture(self.account_id, self.request)
        before = self.snapshot(self.store)
        first, second = recall(self.memory, self.account_id, self.body()), recall(self.memory, self.account_id, self.body())
        self.assertEqual(first.items, second.items)
        chosen = first.items[0]
        self.assertEqual(chosen.memory, item)
        self.assertEqual(chosen.score, chosen.relevance + chosen.significance + chosen.confidence - chosen.decay_penalty)
        self.assertTrue(any("not factual certainty" in r for r in chosen.reasons))
        self.assertEqual(chosen.memory.source.started_at, fixtures.NOW)
        self.assertEqual(self.snapshot(self.store), before)
        self.assertEqual(recall(self.memory, self.account_id, self.body(query="absenttokenzz")).excluded, {"query_mismatch": 1})

    def test_lifecycle_repetition_and_historical_exclusions_preserve_caveats(self):
        item = self.memory.capture(self.account_id, self.request)
        result = recall(self.memory, self.account_id, self.body(served_ids=(item.id,)))
        self.assertEqual(result.items, ())
        self.assertEqual(result.excluded, {"already_served": 1})
        self.assertTrue(result.caveats)
        self.memory.lifecycle(item.id, MemoryLifecycle(expected_revision=1, state="archived", reason="history only"))
        self.assertEqual(recall(self.memory, self.account_id, self.body()).excluded, {"archived": 1})

    def test_stale_hash_foreign_account_and_future_source_never_become_current_advice(self):
        self.memory.capture(self.account_id, self.request)
        self.assert_denied("memory_snapshot_changed", recall, self.memory, self.account_id,
                           RecallRequest(expected_snapshot_hash="0" * 64))
        self.assert_denied("account_not_found", recall, self.memory, uuid4(), self.body())
        future = Memory(self.store, self.token, clock=lambda: fixtures.NOW - timedelta(days=1))
        account, facts, _ = next(row for row in self.store.account_records(fixtures.SAMPLE_ORG)
                                 if row[0].id == str(self.account_id))
        expected = assess(account, facts, (fixtures.NOW - timedelta(days=1)).date()).snapshot_hash
        result = recall(future, self.account_id, RecallRequest(expected_snapshot_hash=expected))
        self.assertEqual(result.excluded, {"future_source": 1})
        self.assertEqual(result.items, ())


if __name__ == "__main__":
    unittest.main()
