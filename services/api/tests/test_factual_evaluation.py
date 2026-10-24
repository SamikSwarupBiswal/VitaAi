"""Independent synthetic gold judgments expose factual failures despite valid schemas."""
import copy
import json
import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

from vita_api.contracts import AccountView, Analysis, CommunicationDrafts
from vita_api.factual_evaluation import (
    EvaluationDataset,
    digest,
    evaluate_comparison,
    main,
    output_units,
    text_digest,
)
from vita_api.provider_comparison import ComparisonResult, ComparisonRun
from vita_api.sample import SAMPLE_ORG, sample_records
from vita_api.scoring import assess


class FactualEvaluationTests(unittest.TestCase):
    def artifact(self):
        now = datetime.now(UTC)
        account, evidence = sample_records(now)[0]
        view = AccountView(account=account, evidence=evidence, assessment=assess(account, evidence, now.date()), renewal_days=10)
        output = Analysis(findings=[{"text": evidence[0].fact,
            "evidence_ids": [evidence[0].id]}], next_steps=[{"text": "Review the retained evidence before preparing an action.",
            "evidence_ids": [evidence[0].id]}], caveats=["No customer action or outcome is established."])
        run = ComparisonRun(id=uuid4(), organization_id=SAMPLE_ORG, account_id=account.id, actor_id="synthetic-evaluator",
            account_revision=1, snapshot_hash=view.assessment.snapshot_hash, started_at=now, finished_at=now,
            status="completed", snapshot=view, results=[ComparisonResult(provider="openai", requested_mode="live", mode="live",
                configuration_revision=1, model="synthetic-model", expected_response_model="synthetic-model", response_model="synthetic-model",
                status="succeeded", validation="schema_and_references_valid", analysis=output)])
        annotations = []
        for key, (value, citations) in output_units(run).items():
            annotations.append({"path": key, "text_sha256": text_digest(value),
                "entailment": "supported" if ".findings." in key else "not_a_factual_claim",
                "reference_evidence_ids": citations, "citation_supported": True,
                "uncertainty_preserved": True, "authority_preserved": True,
                "rationale": "Independent synthetic gold: check literal statement against retained account and evidence; proposals are not completed actions."})
        return run, {"dataset_id": "comparison-factual-synthetic", "version": "1", "evaluator": "synthetic-gold-author",
            "evidence_tier": "synthetic_gold", "artifact_sha256": digest(run), "annotations": annotations}

    def test_supported_gold_scores_and_preserves_exact_artifact(self):
        run, raw = self.artifact()
        original = run.model_dump_json()
        report = evaluate_comparison(run, EvaluationDataset.model_validate(raw))
        self.assertEqual((report["supported"], report["not_a_factual_claim"], report["factual_units"]), (1, 2, 1))
        self.assertEqual(report["supported_fraction"], 1)
        self.assertTrue(report["meets_rubric"])
        self.assertEqual(report["factual_confidence"], "unverified")
        self.assertFalse(report["external_execution"])
        self.assertEqual(run.model_dump_json(), original)

    def test_schema_valid_unsupported_contradicted_uncertainty_and_authority_fail_rubric(self):
        run, raw = self.artifact()
        for changes in ({"entailment": "contradicted"}, {"entailment": "not_established"},
                        {"citation_supported": False}, {"uncertainty_preserved": False}, {"authority_preserved": False}):
            with self.subTest(changes=changes):
                candidate = copy.deepcopy(raw)
                candidate["annotations"][0].update(changes)
                report = evaluate_comparison(run, EvaluationDataset.model_validate(candidate))
                self.assertFalse(report["meets_rubric"])
                self.assertEqual(run.results[0].validation, "schema_and_references_valid")

    def test_missing_duplicate_crossed_text_artifact_and_foreign_evidence_reject(self):
        run, raw = self.artifact()
        for change in ("missing", "duplicate", "text", "artifact", "evidence", "no_reference"):
            candidate = copy.deepcopy(raw)
            if change == "missing":
                candidate["annotations"].pop()
            elif change == "duplicate":
                candidate["annotations"].append(candidate["annotations"][0])
            elif change == "text":
                candidate["annotations"][0]["text_sha256"] = "0" * 64
            elif change == "artifact":
                candidate["artifact_sha256"] = "0" * 64
            else:
                candidate["annotations"][0]["reference_evidence_ids"] = ["foreign"] if change == "evidence" else []
            with self.subTest(change=change), self.assertRaises(ValueError):
                evaluate_comparison(run, EvaluationDataset.model_validate(candidate))

    def test_only_nonfactual_output_is_not_a_factual_quality_pass(self):
        run, raw = self.artifact()
        raw["annotations"][0]["entailment"] = "not_a_factual_claim"
        report = evaluate_comparison(run, EvaluationDataset.model_validate(raw))
        self.assertFalse(report["meets_rubric"])
        self.assertIsNone(report["supported_fraction"])

    def test_duplicate_result_identity_cannot_hide_unreviewed_output(self):
        run, raw = self.artifact()
        other = run.results[0].model_copy(deep=True)
        run.results[0].analysis.findings[0].text = "Unsupported statement that must never disappear."
        run.results.append(other)
        raw["artifact_sha256"] = digest(run)
        with self.assertRaisesRegex(ValueError, "identities must be unique"):
            evaluate_comparison(run, EvaluationDataset.model_validate(raw))

    def test_drafts_extract_every_output_and_cli_preserves_exclusive_private_report(self):
        run, _ = self.artifact()
        finding = run.results[0].analysis.findings[0]
        run.results[0].analysis = None
        run.results[0].drafts = CommunicationDrafts(action_kind="follow_up", email=finding, call_script=finding,
            voice_summary=finding, internal_note=finding, caveats=["Synthetic; no execution occurred."])
        run.task, run.action_kind = "drafts", "follow_up"
        units = output_units(run)
        self.assertEqual(len(units), 5)
        raw = {"dataset_id": "draft-gold", "version": "1", "evaluator": "synthetic-gold-author", "evidence_tier": "synthetic_gold",
            "artifact_sha256": digest(run), "annotations": [{"path": key, "text_sha256": text_digest(value),
                "entailment": "supported" if citations else "not_a_factual_claim", "reference_evidence_ids": citations,
                "citation_supported": True, "uncertainty_preserved": True, "authority_preserved": True,
                "rationale": "Synthetic literal evidence comparison."} for key, (value, citations) in units.items()]}
        with tempfile.TemporaryDirectory() as directory:
            artifact, annotations, output = [Path(directory) / name for name in ("run.json", "labels.json", "report.json")]
            artifact.write_text(run.model_dump_json(), encoding="utf8")
            annotations.write_text(json.dumps(raw), encoding="utf8")
            argv = ["factual_evaluation", "--artifact", str(artifact), "--annotations", str(annotations), "--output", str(output)]
            with patch("sys.argv", argv):
                main()
                report = json.loads(output.read_text(encoding="utf8"))
                self.assertEqual(report["output_units"], 5)
                self.assertTrue(report["meets_rubric"])
                with self.assertRaises(FileExistsError):
                    main()
