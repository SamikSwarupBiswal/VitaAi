"""Populated historical upgrades; SQLite by default, isolated PostgreSQL opt-in."""
import os
import unittest
from pathlib import Path
from uuid import uuid4

import httpx
import test_stage2 as fixtures
from alembic import command
from alembic.config import Config
from sqlalchemy import MetaData, inspect, select
from sqlalchemy.engine import make_url
from sqlalchemy.schema import CreateSchema, DropSchema
from vita_api.config import Settings
from vita_api.governance import PolicyDenied
from vita_api.hubspot import HubSpot
from vita_api.hubspot_seeding import Seeding, SeedPrepare, SeedReview
from vita_api.hubspot_sync import HubSpotSync
from vita_api.identity import Identity
from vita_api.sample import SAMPLE_ORG
from vita_api.storage import Store
from vita_api.workflow import Workflow


class PopulatedMigrationTests(unittest.TestCase):
    setUp = fixtures.Stage2Tests.setUp
    tearDown = fixtures.Stage2Tests.tearDown
    prepare = fixtures.Stage2Tests.prepare
    approve = fixtures.Stage2Tests.approve

    @staticmethod
    def rows_snapshot(engine):
        metadata = MetaData()
        metadata.reflect(engine)
        with engine.connect() as connection:
            return {table.name: [dict(row) for row in connection.execute(select(table)
                .order_by(*table.primary_key.columns)).mappings()]
                for table in metadata.sorted_tables if table.name != "alembic_version"}

    def test_populated_0017_0018_0019_preserves_exact_history_and_unknown_claim(self):
        request = self.approve()
        self.workflow.simulation_profile = "timeout_after"
        execution = self.workflow.execute(self.seller.id, self.action.id, request)
        self.assertEqual(execution.status, "result_unknown")
        identity = Identity(self.store.engine)
        identity.create_user("migration-admin", "synthetic-password-long", SAMPLE_ORG, "admin")
        _, token = identity.login("migration-admin", "synthetic-password-long", 8)
        source = self.rows_snapshot(self.store.engine)
        schema = None
        url = f"sqlite:///{Path(self.temp.name) / 'populated0017.sqlite'}"
        if self.pg_admin is not None:
            schema = "vitaai_populated_" + uuid4().hex
            with self.pg_admin.begin() as connection:
                connection.execute(CreateSchema(schema))
            url = make_url(os.environ["VITAAI_POSTGRES_TEST_URL"]).update_query_dict({
                "options": "-csearch_path=" + schema}).render_as_string(hide_password=False)
        legacy = Store(url)
        config = Config()
        config.set_main_option("script_location", str(Path(__file__).parents[1] / "migrations"))
        try:
            with legacy.engine.begin() as connection:
                config.attributes["connection"] = connection
                command.upgrade(config, "0017")
            old = MetaData()
            old.reflect(legacy.engine)
            with legacy.engine.begin() as connection:
                for table in old.sorted_tables:
                    if source.get(table.name):
                        connection.execute(table.insert(), source[table.name])
            historical = self.rows_snapshot(legacy.engine)
            self.assertEqual(historical, {name: rows for name, rows in source.items() if name in historical})
            with legacy.engine.begin() as connection:
                config.attributes["connection"] = connection
                command.upgrade(config, "0018")
            upgraded = self.rows_snapshot(legacy.engine)
            self.assertEqual({name: upgraded[name] for name in historical}, historical)
            self.assertEqual(upgraded["hubspot_seed_jobs"], [])
            self.assertEqual(upgraded["hubspot_seed_versions"], [])
            self.assertNotIn("research_quality_reviews", upgraded)

            calls = []
            def deny_network(request):
                calls.append(request)
                raise AssertionError("Migration preview/review must not access a provider")
            settings = Settings(_env_file=None, auth_mode="session", hubspot_enabled=True,
                hubspot_write_enabled=True, hubspot_seed_enabled=True, hubspot_seed_test_portal_id="456",
                hubspot_access_token="synthetic-token-only", hubspot_organization_id=SAMPLE_ORG,
                hubspot_portal_id="456", hubspot_company_map={str(self.account.id): "123"})
            seeds = Seeding(HubSpotSync(legacy, HubSpot(settings, httpx.MockTransport(deny_network)), token))
            ready = seeds.readiness(self.account.id)
            job = seeds.prepare(self.account.id, SeedPrepare(expected_account_revision=1,
                expected_configuration_hash=ready.configuration_hash, count=1, include_contacts=True))
            reviewed = seeds.review(job.id, SeedReview(expected_revision=job.revision,
                expected_account_revision=1, binding_hash=job.binding_hash, decision="approved",
                reason="  Exact synthetic preview inspected before schema upgrade.\n "))
            before_0019 = self.rows_snapshot(legacy.engine)
            legacy.initialize()
            after_0019 = self.rows_snapshot(legacy.engine)
            self.assertEqual({name: after_0019[name] for name in before_0019}, before_0019)
            self.assertEqual(after_0019["research_quality_reviews"], [])
            self.assertEqual(seeds.history(self.account.id), [reviewed])
            self.assertEqual(seeds.history_versions(job.id), [job, reviewed])
            self.assertEqual(calls, [])

            legacy.engine.dispose()
            restarted = Store(url)
            try:
                restarted.initialize()
                self.assertEqual(self.rows_snapshot(restarted.engine), after_0019)
                workflow = Workflow(restarted, clock=lambda: self.now)
                self.assertEqual(workflow.get_action(self.seller.id, self.action.id), self.action)
                self.assertEqual(workflow.execute(self.seller.id, self.action.id, request), execution)
                with self.assertRaises(PolicyDenied):
                    workflow.execute(self.seller.id, self.action.id,
                        request.model_copy(update={"idempotency_key": "different-after-upgrade"}))
                self.assertTrue({"hubspot_seed_jobs", "hubspot_seed_versions", "research_quality_reviews"}
                    <= set(inspect(restarted.engine).get_table_names()))
                if restarted.engine.dialect.name == "sqlite":
                    with restarted.engine.connect() as connection:
                        self.assertEqual(connection.exec_driver_sql("PRAGMA foreign_keys").scalar(), 1)
                        self.assertEqual(connection.exec_driver_sql("PRAGMA foreign_key_check").all(), [])
            finally:
                restarted.engine.dispose()
        finally:
            legacy.engine.dispose()
            if schema:
                with self.pg_admin.begin() as connection:
                    connection.execute(DropSchema(schema, cascade=True))
