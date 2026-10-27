"""Independent source lineage and correction acceptance for persisted trends."""
import unittest
from datetime import timedelta
from uuid import uuid4

import test_memory as fixtures

from vita_api.config import HubSpotProperty, Settings
from vita_api.hubspot import HubSpot, HubSpotObservation
from vita_api.hubspot_normalize import normalize
from vita_api.hubspot_sync import observations
from vita_api.identity import sessions, token_digest
from vita_api.intelligence import Intelligence
from vita_api.intelligence_contracts import TrendRequest
from vita_api.pipeline import Pipeline, PipelineRequest
from vita_api.storage import Store


class TrendLineageTests(unittest.TestCase):
    def setUp(self):
        fixtures.MemoryTests.setUp(self)
        # Isolated future-clock scenarios require a session valid at that clock.
        with self.store.engine.begin() as connection:
            connection.execute(sessions.update().where(sessions.c.token_hash == token_digest(self.token)).values(
                expires_at=int((fixtures.NOW + timedelta(days=121)).timestamp())))

    tearDown = fixtures.MemoryTests.tearDown
    database = fixtures.MemoryTests.database
    snapshot = staticmethod(fixtures.MemoryTests.snapshot)
    assert_denied = fixtures.MemoryTests.assert_denied

    def observation(self, value, measured, fetched, *, portal="123", company="456", property_name="product_usage", sequence=1):
        mapping = {"usage_change": HubSpotProperty(property=property_name, type="number", unit="percent",
            meaning="product_usage_change", observed_at_property="usage_measured_at")}
        connector = HubSpot(Settings(_env_file=None, hubspot_property_map=mapping))
        original = HubSpotObservation(id=uuid4(), organization_id=fixtures.SAMPLE_ORG, account_id=self.account_id,
            account_revision=1, portal_id=portal, company_id=company, source_record=f"https://api.hubapi.com/crm/v3/objects/companies/{company}",
            provider_created_at=fixtures.NOW - timedelta(days=90), provider_updated_at=fetched - timedelta(minutes=1),
            fetched_at=fetched, fingerprint="a" * 64, sequence=sequence,
            properties={property_name: str(value), "usage_measured_at": measured.isoformat(), "name": "Synthetic normalized company", "industry": "Synthetic"},
            property_types={property_name: "number", "usage_measured_at": "datetime"}, mapping_hash=connector.mapping_hash,
            property_mapping=mapping)
        account = next(account for account, _, _ in self.store.account_records(fixtures.SAMPLE_ORG) if account.id == str(self.account_id))
        preview = normalize(account, original, connector)
        self.assertEqual(len(preview.evidence), 1)
        with self.store.engine.begin() as connection:
            connection.execute(observations.insert().values(id=str(original.id), organization_id=fixtures.SAMPLE_ORG,
                account_id=str(self.account_id), sequence=sequence, payload=original.model_dump(mode="json")))
        return original, preview.account, preview.evidence

    def saved_run(self, records, started):
        run = Pipeline(fixtures.NoInference()).run(fixtures.SAMPLE_ORG, self.actor.id, records, started.date(), PipelineRequest(limit=6))
        run = run.model_copy(update={"started_at": started})
        self.store.save_pipeline(run)
        return run

    def hubspot_run(self, value, measured, fetched, **options):
        original, account, facts = self.observation(value, measured, fetched, **options)
        return self.saved_run([(account, facts)], fetched + timedelta(minutes=1)), original

    def result(self, *runs):
        service = Intelligence(self.store, self.token, clock=lambda: fixtures.NOW + timedelta(days=120))
        report = service.create_trend(self.account_id, TrendRequest(pipeline_ids=tuple(run.id for run in runs),
            start=fixtures.NOW - timedelta(days=100), end=fixtures.NOW + timedelta(days=100)))
        return report, next(metric for metric in report.metrics if metric.metric == "usage_change")

    def test_original_observation_correction_lineage_and_old_pipeline_replay(self):
        measured = fixtures.NOW - timedelta(days=1)
        first, original = self.hubspot_run(10, measured, fixtures.NOW, sequence=1)
        correction, corrected = self.hubspot_run(20, measured, fixtures.NOW + timedelta(hours=1), sequence=2)
        next_day, _ = self.hubspot_run(30, measured + timedelta(days=1), fixtures.NOW + timedelta(days=1), sequence=3)
        old_saved_later = first.model_copy(update={"id": str(uuid4()), "started_at": fixtures.NOW + timedelta(days=2)})
        self.store.save_pipeline(old_saved_later)
        before = self.snapshot(self.store)
        report, trend = self.result(first, correction, next_day, old_saved_later)
        self.assertEqual(trend.status, "observed")
        self.assertEqual([point.value for point in trend.points], [20, 30])
        self.assertEqual(trend.delta, 10)
        self.assertEqual(trend.per_day, 10)
        self.assertEqual(trend.corrected_count, 1)
        self.assertEqual(trend.duplicate_count, 1)
        self.assertTrue(all(point.lineage_key == trend.points[0].lineage_key for point in trend.points))
        self.assertEqual(trend.points[0].source_version_at, corrected.fetched_at)
        self.assertTrue(any(str(original.id) in point.source_record for point in trend.superseded_points))
        after = self.snapshot(self.store)
        for table in before:
            if table != "intelligence_trends":
                self.assertEqual(before[table], after[table], table)
        restored = Store(self.store.engine.url); self.stores.append(restored)
        self.assertEqual(Intelligence(restored, self.token).get_trend(report.id), report)

    def test_portal_company_property_or_measurement_mapping_change_suppresses_slope(self):
        first, _ = self.hubspot_run(10, fixtures.NOW - timedelta(days=1), fixtures.NOW, sequence=1)
        for sequence, changes in enumerate([{"portal": "789"}, {"company": "987"}, {"property_name": "other_usage"}], 2):
            with self.subTest(changes=changes):
                later, _ = self.hubspot_run(20, fixtures.NOW, fixtures.NOW + timedelta(days=1), sequence=sequence, **changes)
                _, trend = self.result(first, later)
                self.assertEqual(trend.status, "incompatible_sources")
                self.assertIsNone(trend.delta)
                self.assertIsNone(trend.per_day)
                self.assertNotEqual(trend.points[0].lineage_key, trend.points[1].lineage_key)

    def test_unavailable_or_corrupt_mapping_unit_never_becomes_an_observed_trend(self):
        first, _ = self.hubspot_run(10, fixtures.NOW - timedelta(days=1), fixtures.NOW, sequence=1)
        later, original = self.hubspot_run(20, fixtures.NOW, fixtures.NOW + timedelta(days=1), sequence=2)
        payload = original.model_dump(mode="json")
        payload["property_mapping"]["usage_change"]["unit"] = "count"
        with self.store.engine.begin() as connection:
            connection.execute(observations.update().where(observations.c.id == str(original.id)).values(payload=payload))
        _, trend = self.result(first, later)
        self.assertEqual(trend.status, "incompatible_sources")
        self.assertEqual(trend.excluded_count, 1)
        self.assertIsNone(trend.per_day)
        with self.store.engine.begin() as connection:
            connection.execute(observations.delete().where(observations.c.id == str(original.id)))
        _, trend = self.result(first, later)
        self.assertEqual(trend.status, "incompatible_sources")

    def test_simultaneous_conflicting_source_values_do_not_infer_a_correction_order(self):
        first, _ = self.hubspot_run(10, fixtures.NOW - timedelta(days=1), fixtures.NOW, sequence=1)
        second, _ = self.hubspot_run(20, fixtures.NOW - timedelta(days=1), fixtures.NOW, sequence=2)
        _, trend = self.result(first, second)
        self.assertEqual(trend.status, "conflicting")
        self.assertIsNone(trend.delta)
        self.assertIsNone(trend.per_day)
        self.assertEqual(trend.corrected_count, 1)
        self.assertEqual(len(trend.superseded_points), 1)

    def test_synthetic_lineage_dedup_gap_and_temporal_exclusions(self):
        account, facts = next((account, facts) for account, facts in fixtures.sample_records(fixtures.NOW) if account.id == str(self.account_id))
        fact = next(fact for fact in facts if fact.metric == "usage_change")
        first = self.saved_run([(account, [fact])], fixtures.NOW)
        duplicate = self.saved_run([(account, [fact])], fixtures.NOW + timedelta(hours=1))
        later_fact = fact.model_copy(update={"value": 20, "observed_at": fixtures.NOW + timedelta(days=40), "ingested_at": fixtures.NOW + timedelta(days=41)})
        later = self.saved_run([(account, [later_fact])], fixtures.NOW + timedelta(days=41))
        _, trend = self.result(first, duplicate, later)
        self.assertEqual(trend.status, "gapped")
        self.assertIsNone(trend.per_day)
        self.assertEqual(trend.duplicate_count, 1)
        stale_fact = fact.model_copy(update={"observed_at": fixtures.NOW - timedelta(days=50)})
        stale = self.saved_run([(account, [stale_fact])], fixtures.NOW)
        future_fact = fact.model_copy(update={"observed_at": fixtures.NOW + timedelta(days=1)})
        future = self.saved_run([(account, [future_fact])], fixtures.NOW)
        _, excluded = self.result(first, stale, future)
        self.assertEqual(excluded.status, "insufficient")
        self.assertEqual(excluded.excluded_count, 2)
        self.assertIsNone(excluded.per_day)
        other_fact = later_fact.model_copy(update={"source_record": "sample:other-property:usage_change"})
        other = self.saved_run([(account, [other_fact])], fixtures.NOW + timedelta(days=41))
        _, incompatible = self.result(first, other)
        self.assertEqual(incompatible.status, "incompatible_sources")


if __name__ == "__main__":
    unittest.main()
