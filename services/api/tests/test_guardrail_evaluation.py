"""Measured synthetic results, artifact integrity and inert authenticated reads."""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import test_memory as fixtures
from fastapi.testclient import TestClient
from vita_api import guardrails
from vita_api.app import create_app
from vita_api.config import Settings
from vita_api.guardrail_evaluation import (
    MAXIMUM_BYTES,
    GuardrailReport,
    digest,
    generate_report,
    load_report,
    source_hash,
    verify_report,
)
from vita_api.identity import users


def rehash(payload):
    payload["artifact_sha256"] = digest({key: value for key, value in payload.items() if key != "artifact_sha256"})
    return payload


class GuardrailEvaluationTests(unittest.TestCase):
    def test_original_matrix_has_measured_counts_and_honest_classifier_failures(self):
        with patch("socket.socket.connect", side_effect=AssertionError("Offline evaluation cannot use the network")), \
                patch("sqlalchemy.engine.Engine.connect", side_effect=AssertionError("Offline evaluation cannot open business storage")):
            report = generate_report()
        self.assertEqual((report.total_cases, report.passed_cases, report.failed_cases), (21, 21, 0))
        self.assertEqual(report.classifier_failed_cases, 7)
        self.assertTrue(report.meets_rubric)
        self.assertEqual(report.evidence_tier, "synthetic")
        self.assertEqual(verify_report(report), report)
        for case in report.cases:
            self.assertEqual(case.actual_decision, case.final_decision)
            self.assertEqual(case.failures, ())

    def test_independent_expected_label_mismatch_is_valid_visible_failed_report(self):
        original = guardrails.evaluate_guardrail
        def wrong(body, actor):
            result = original(body, actor)
            if body.scenario_id == "approval-shortcut":
                return result.model_copy(update={"deterministic_decision": "explanation_only", "final_decision": "explanation_only"})
            return result
        with patch("vita_api.guardrails.evaluate_guardrail", wrong):
            report = generate_report()
        self.assertFalse(report.meets_rubric)
        self.assertEqual((report.passed_cases, report.failed_cases), (18, 3))
        self.assertTrue(all(case.failures == ("decision_mismatch",) for case in report.cases if case.scenario_id == "approval-shortcut"))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "failed.json"
            path.write_text(report.model_dump_json(), encoding="utf-8")
            self.assertEqual(load_report(path), report)

    def test_report_records_wrong_final_verdict_and_advisory_flag_as_failures(self):
        original = guardrails.evaluate_guardrail
        def wrong(body, actor):
            result = original(body, actor)
            decision = "blocked" if result.deterministic_decision == "explanation_only" else "explanation_only"
            classifier = result.classifier
            if body.classifier_mode == "mock":
                classifier = classifier.model_copy(update={"advisory_flag": not classifier.advisory_flag})
            return result.model_copy(update={"final_decision": decision, "classifier": classifier})
        with patch("vita_api.guardrails.evaluate_guardrail", wrong):
            report = generate_report()
        self.assertEqual(report.failed_cases, 21)
        self.assertTrue(all("final_decision_mismatch" in case.failures for case in report.cases))
        self.assertEqual(sum("classifier_flag_mismatch" in case.failures for case in report.cases), 7)

    def test_corrupt_coverage_expected_bindings_counts_and_failures_reject_even_after_rehash(self):
        for mutate in (
            lambda value: value.update(cases=[]),
            lambda value: value["cases"].pop(),
            lambda value: value["cases"].append(value["cases"][0]),
            lambda value: value["cases"][0].update(scenario_id="crossed"),
            lambda value: value["cases"][0].update(text_sha256="0" * 64),
            lambda value: value["cases"][0].update(scenario_title="Unrelated scenario"),
            lambda value: value["cases"][0].update(expected_decision="blocked"),
            lambda value: value["cases"][0].update(failures=["decision_mismatch"]),
            lambda value: value.update(total_cases=20),
            lambda value: value.update(failed_cases=1),
            lambda value: value.update(classifier_failed_cases=0),
            lambda value: value.update(meets_rubric=False),
            lambda value: value.update(dataset_sha256="0" * 64),
            lambda value: value.update(caveats=["Unverified claim of live certification"]),
            lambda value: value.update(invented_authority=True),
        ):
            payload = generate_report().model_dump(mode="json")
            mutate(payload)
            with self.assertRaises(ValueError):
                GuardrailReport.model_validate(rehash(payload))

    def test_stale_sources_tampered_checksum_and_non_strict_counts_reject(self):
        report = generate_report()
        payload = report.model_dump(mode="json")
        payload["policy_source_sha256"] = "0" * 64
        stale = GuardrailReport.model_validate(rehash(payload))
        with self.assertRaises(ValueError):
            verify_report(stale)
        for field, value in (("passed_cases", True), ("classifier_failed_cases", "7"), ("caveats", ["Changed but not rehashed"])):
            payload = report.model_dump(mode="json")
            payload[field] = value
            with self.assertRaises(ValueError):
                GuardrailReport.model_validate(payload)

    def test_bounded_missing_duplicate_malformed_and_nonfinite_json_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "report.json"
            with self.assertRaises(OSError):
                load_report(path)
            for text in ("{", '{"schema_version":"1","schema_version":"1"}', '{"x":NaN}', "x" * (MAXIMUM_BYTES + 1), '\ufeff{}'):
                path.write_text(text, encoding="utf-8")
                with self.assertRaises(ValueError):
                    load_report(path)

    def test_source_hash_normalizes_git_line_endings(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.py"
            path.write_bytes(b"line1\r\nline2\r\n")
            first = source_hash(path)
            path.write_bytes(b"line1\nline2\n")
            self.assertEqual(first, source_hash(path))

    def test_cli_generates_exclusively_checks_semantics_and_fails_without_private_details(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "private-synthetic-output.json"
            command = [sys.executable, "-m", "vita_api.guardrail_evaluation", "--output", str(path)]
            env = {**os.environ, "PYTHONPATH": str(Path(__file__).parents[1])}
            created = subprocess.run(command, capture_output=True, text=True, env=env, check=False)
            self.assertEqual(created.returncode, 0, created.stderr)
            before = path.read_bytes()
            checked = subprocess.run([*command, "--check"], capture_output=True, text=True, env=env, check=False)
            self.assertEqual(checked.returncode, 0, checked.stderr)
            self.assertEqual(before, path.read_bytes())
            duplicate = subprocess.run(command, capture_output=True, text=True, env=env, check=False)
            self.assertEqual(duplicate.returncode, 2)
            self.assertNotIn(str(path), duplicate.stderr)
            path.write_text('{"private-secret":"do-not-echo"}', encoding="utf-8")
            failed = subprocess.run([*command, "--check"], capture_output=True, text=True, env=env, check=False)
            self.assertEqual(failed.returncode, 2)
            self.assertNotIn("do-not-echo", failed.stderr)
            self.assertNotIn(str(path), failed.stderr)


class AssuranceApiTests(unittest.TestCase):
    setUp = fixtures.MemoryTests.setUp
    tearDown = fixtures.MemoryTests.tearDown
    database = fixtures.MemoryTests.database
    snapshot = staticmethod(fixtures.MemoryTests.snapshot)

    def client(self, mode="session"):
        app = create_app(Settings(_env_file=None, database_url=str(self.store.engine.url), auth_mode=mode), fixtures.NoInference())
        return TestClient(app)

    def test_scoped_report_read_preserves_every_business_record_and_never_evaluates(self):
        report = generate_report()
        with self.client() as client:
            client.cookies.set("vitaai_session", self.token)
            before = self.snapshot(self.store)
            with patch("vita_api.assurance.load_report", return_value=report), patch("vita_api.guardrails.evaluate_guardrail", side_effect=AssertionError("GET must not evaluate")):
                response = client.get("/api/assurance/guardrails")
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.headers["cache-control"], "no-store")
            self.assertEqual(response.json()["actor_id"], self.actor.id)
            self.assertEqual(response.json()["organization_id"], self.actor.organization_id)
            self.assertEqual(response.json()["report"]["total_cases"], 21)
            self.assertEqual(before, self.snapshot(self.store))

    def test_absent_sample_unavailable_and_midread_revocation_deny_safely(self):
        report = generate_report()
        with self.client("sample") as client:
            self.assertEqual(client.get("/api/assurance/guardrails").status_code, 503)
        with self.client() as client:
            self.assertEqual(client.get("/api/assurance/guardrails").status_code, 401)
            client.cookies.set("vitaai_session", self.token)
            with patch("vita_api.assurance.load_report", side_effect=ValueError("private-sensitive-details")):
                response = client.get("/api/assurance/guardrails")
                self.assertEqual(response.status_code, 503)
                self.assertNotIn("private-sensitive-details", response.text)
            def revoke():
                with self.store.engine.begin() as connection:
                    connection.execute(users.update().where(users.c.id == self.actor.id).values(enabled=False))
                return report
            with patch("vita_api.assurance.load_report", revoke):
                self.assertEqual(client.get("/api/assurance/guardrails").status_code, 401)


if __name__ == "__main__":
    unittest.main()
