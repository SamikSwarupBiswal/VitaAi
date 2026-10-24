"""Private synthetic copies; database creation requires separate PostgreSQL opt-in."""
import json
import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from time import monotonic
from uuid import uuid4

from sqlalchemy import MetaData, create_engine, select, text, update
from sqlalchemy.engine import make_url
from sqlalchemy.exc import OperationalError
from vita_api import legacy_postgres_recovery as postgres
from vita_api import legacy_recovery as sqlite
from vita_api.config import ResearchTarget
from vita_api.contracts import AccountView
from vita_api.identity import Identity, LoginFailure, sessions
from vita_api.provider_comparison import ComparisonResult, ComparisonRun, comparisons
from vita_api.research import ResearchRun
from vita_api.research_service import research_runs
from vita_api.sample import SAMPLE_ORG, sample_records
from vita_api.scoring import assess
from vita_api.storage import Store


class SQLiteRecoveryTests(unittest.TestCase):
    pg = False

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        if self.pg:
            self.admin = create_engine(os.environ["VITAAI_LEGACY_POSTGRES_TEST_URL"], isolation_level="AUTOCOMMIT")
            self.addCleanup(self.admin.dispose)
            self.source_url = self.new_database("vitaai_legacy_source_" + uuid4().hex)
        else:
            self.source_file = self.root / "source.sqlite"
            self.source_url = f"sqlite:///{self.source_file.as_posix()}"
        self.store = Store(self.source_url)
        self.addCleanup(self.store.engine.dispose)
        self.store.initialize()
        now = datetime.now(UTC)
        self.store.seed(sample_records(now))
        identity = Identity(self.store.engine)
        self.actor = identity.create_user("admin", "synthetic-password-long", SAMPLE_ORG, "admin")
        identity.create_user("seller", "synthetic-password-long", SAMPLE_ORG, "seller")
        identity.login("admin", "synthetic-password-long", 8)
        account = self.store.list_accounts(SAMPLE_ORG)[0]
        evidence = self.store.account_evidence(SAMPLE_ORG, account.id)
        view = AccountView(account=account, evidence=evidence, assessment=assess(account, evidence, now.date()), renewal_days=10)
        research = ResearchRun(id=uuid4(), organization_id=SAMPLE_ORG, account_id=account.id,
            account_revision=1, actor_id=self.actor.id, requested_mode="live", mode="live", status="pending",
            target=ResearchTarget(company_name="Synthetic Company", domain="example.test"), started_at=now)
        comparison = ComparisonRun(id=uuid4(), organization_id=SAMPLE_ORG, account_id=account.id,
            actor_id=self.actor.id, account_revision=1, snapshot_hash=view.assessment.snapshot_hash,
            started_at=now, snapshot=view, results=[
                ComparisonResult(provider="openai", requested_mode="live", mode="live", configuration_revision=1,
                    model="synthetic-model", expected_response_model="synthetic-model", status="succeeded",
                    request_id="retained-known-result"),
                ComparisonResult(provider="anthropic", requested_mode="live", mode="live", configuration_revision=1,
                    model="synthetic-model", expected_response_model="synthetic-model")])
        with self.store.engine.begin() as connection:
            for table, run in ((research_runs, research), (comparisons, comparison)):
                connection.execute(table.insert().values(id=str(run.id), organization_id=SAMPLE_ORG,
                    account_id=account.id, started_at=int(now.timestamp()), status="pending", payload=run.model_dump(mode="json")))
        self.keys = [f"research:{research.id}", f"comparison:{comparison.id}"]
        self.original = self.snapshot(self.store.engine)

    def new_database(self, name):
        self.assertRegex(name, r"^vitaai_(legacy_source|recovery)_[a-f0-9]{32}$")
        with self.admin.connect() as connection:
            connection.exec_driver_sql('CREATE DATABASE "' + name + '"')
        url = make_url(os.environ["VITAAI_LEGACY_POSTGRES_TEST_URL"]).set(database=name).render_as_string(hide_password=False)

        def cleanup():
            with self.admin.connect() as connection:
                connection.exec_driver_sql('DROP DATABASE "' + name + '" WITH (FORCE)')

        self.addCleanup(cleanup)
        return url

    @staticmethod
    def snapshot(engine):
        metadata = MetaData()
        with engine.connect() as connection:
            metadata.reflect(bind=connection)
            return {table.name: [dict(row) for row in connection.execute(select(table)
                .order_by(*table.primary_key.columns)).mappings()] for table in metadata.sorted_tables}

    def prepare(self, source=None, candidates=None):
        if self.pg:
            target = self.new_database("vitaai_recovery_" + uuid4().hex)
            path = self.root / (uuid4().hex + ".json")
            path, manifest = postgres.prepare_copy(source or self.source_url, target, path, SAMPLE_ORG, candidates=candidates)
        else:
            target = self.root / (uuid4().hex + ".sqlite")
            path, manifest = sqlite.prepare_copy(source or self.source_file, target, SAMPLE_ORG, candidates=candidates)
        return target, path, manifest

    def engine(self, target):
        engine = create_engine(target if self.pg else f"sqlite:///{target.as_posix()}")
        self.addCleanup(engine.dispose)
        return engine

    def apply(self, target, path, keys, username="admin", password="synthetic-password-long", acknowledge=True):
        args = [target, path] if self.pg else [path]
        return (postgres if self.pg else sqlite).apply_copy(*args, keys, username, password,
            acknowledge_cutover=acknowledge)

    def test_copy_exact_recovery_audit_replay_and_original_unchanged(self):
        target, path, manifest = self.prepare()
        copied = self.engine(target)
        with copied.connect() as connection:
            self.assertEqual(connection.execute(select(sessions)).all(), [])
        self.assertNotIn("synthetic-password", path.read_text())
        self.assertEqual({f"{record.kind}:{record.id}" for record in manifest.records}, set(self.keys))
        with self.assertRaises(sqlite.RecoveryDenied):
            self.apply(target, path, self.keys, acknowledge=False)
        self.assertEqual(self.apply(target, path, self.keys), self.keys)
        with copied.connect() as connection:
            rows = connection.execute(text("SELECT before_payload,after_payload FROM legacy_recovery_records")).all()
            self.assertEqual(len(rows), 2)
            for before, after in rows:
                old, new = json.loads(before), json.loads(after)
                self.assertEqual((old["status"], new["status"]), ("pending", "interrupted"))
                self.assertEqual(new["started_at"], old["started_at"])
                self.assertEqual(new["recovery"]["reason"], "isolated_database_copy")
                self.assertEqual(new["recovery"]["isolation_id"], str(manifest.isolation_id))
                if "results" in new:
                    self.assertEqual(new["results"][0], old["results"][0])
                    self.assertEqual(new["results"][1]["status"], "discarded")
            self.assertEqual(connection.execute(select(sessions)).all(), [])
        with self.assertRaises(sqlite.RecoveryDenied):
            self.apply(target, path, self.keys)
        self.assertEqual(self.snapshot(self.store.engine), self.original)

    def test_tamper_authentication_scope_and_manifest_selection_deny(self):
        target, path, _ = self.prepare()
        with self.assertRaises(sqlite.RecoveryDenied):
            self.apply(target, path, ["research:" + str(uuid4())])
        with self.assertRaises((sqlite.RecoveryDenied, LoginFailure)):
            self.apply(target, path, self.keys, username="seller")
        target, path, _ = self.prepare()
        with self.assertRaises(LoginFailure):
            self.apply(target, path, self.keys, password="incorrect-synthetic-password")
        target, path, _ = self.prepare()
        with self.engine(target).begin() as connection:
            connection.execute(update(comparisons).values(status="completed"))
        with self.assertRaises(sqlite.RecoveryDenied):
            self.apply(target, path, self.keys)
        self.assertEqual(self.snapshot(self.store.engine), self.original)

    def test_concurrent_one_use_and_descendant_preserve_prior_audit(self):
        target, path, manifest = self.prepare()

        def apply_once(_):
            try:
                self.apply(target, path, self.keys[:1])
                return "recovered"
            except sqlite.RecoveryDenied:
                return "denied"

        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(apply_once, range(2))), ["denied", "recovered"])
        descendant, new_path, new_manifest = self.prepare(source=target, candidates=self.keys[1:])
        self.assertNotEqual(new_manifest.isolation_id, manifest.isolation_id)
        self.assertEqual(self.apply(descendant, new_path, self.keys[1:]), self.keys[1:])
        with self.engine(descendant).connect() as connection:
            self.assertEqual(connection.execute(text("SELECT count(*) FROM legacy_recovery_records")).scalar_one(), 2)
        self.assertEqual(self.snapshot(self.store.engine), self.original)


@unittest.skipUnless(os.environ.get("VITAAI_LEGACY_POSTGRES_TEST_URL"), "Requires separately opted-in disposable database server")
class PostgreSQLRecoveryTests(SQLiteRecoveryTests):
    pg = True

    def test_destination_migration_advisory_lock_wait_is_bounded(self):
        target = self.new_database("vitaai_recovery_" + uuid4().hex)
        engine = self.engine(target)
        with engine.connect() as blocker:
            blocker.execute(text("SELECT pg_advisory_lock(71420863)"))
            try:
                start = monotonic()
                with self.assertRaises(OperationalError):
                    postgres.prepare_copy(self.source_url, target, self.root / "locked.json", SAMPLE_ORG)
                self.assertLess(monotonic() - start, 15)
            finally:
                blocker.execute(text("SELECT pg_advisory_unlock(71420863)"))
        self.assertEqual(self.snapshot(self.store.engine), self.original)
