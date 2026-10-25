"""Exact retained narrative scoring against independent human/synthetic judgments."""
import argparse
import json
from datetime import timedelta
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .factual_evaluation import Annotation, Hash, digest, load_private, text_digest
from .research import source_match
from .research_narrative import NarrativeRun

RUBRIC = "research-grounding-1"


class ResearchAnnotation(Annotation):
    reference_source_urls: list[str] = Field(max_length=5)


class SourceJudgment(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_url: str = Field(min_length=1, max_length=2048)
    source_sha256: Hash
    identity: Literal["consistent", "namesake_or_unrelated", "uncertain"]
    rationale: str = Field(min_length=1, max_length=2000, pattern=r"\S")


class ResearchDataset(BaseModel):
    model_config = ConfigDict(extra="forbid")
    rubric: Literal["research-grounding-1"] = RUBRIC
    dataset_id: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_.-]+$")
    version: str = Field(min_length=1, max_length=80)
    evaluator: str = Field(min_length=1, max_length=160)
    evidence_tier: Literal["synthetic_gold", "human_review"]
    artifact_sha256: Hash
    annotations: list[ResearchAnnotation] = Field(min_length=1, max_length=128)
    sources: list[SourceJudgment] = Field(min_length=1, max_length=5)


def narrative_units(run):
    units = {}
    if run.output is None:
        return units
    for index, hypothesis in enumerate(run.output.hypotheses):
        for field in ("interpretation", "verification_question"):
            units[f"hypotheses.{index}.{field}"] = (
                getattr(hypothesis, field), hypothesis.evidence_ids, hypothesis.source_urls)
    for index, text in enumerate(run.output.caveats):
        units[f"caveats.{index}"] = (text, [], [])
    return units


def evaluate_narrative(run: NarrativeRun, dataset: ResearchDataset):
    context, artifact_hash = run.context, digest(run)
    parent, view = context.retained_run, context.internal
    if (run.status != "succeeded" or run.mode != "live" or run.output is None
            or run.validation != "schema_and_references_valid" or artifact_hash != dataset.artifact_sha256
            or run.research_run_id != parent.id or run.account_id != parent.account_id
            or str(run.account_id) != view.account.id or run.organization_id != parent.organization_id
            or run.organization_id != view.account.organization_id or parent.account_revision != view.account.revision
            or parent.status != "succeeded" or parent.mode != "live"):
        raise ValueError("Evaluation requires the exact successful retained narrative and parent context")
    evidence = {item.id for item in view.evidence}
    if len(evidence) != len(view.evidence) or any(
            item.account_id != view.account.id or item.organization_id != view.account.organization_id for item in view.evidence):
        raise ValueError("Internal evidence scope or identity changed")
    retained = {item.url: item for item in parent.sources}
    sources = {item.url: item for item in context.usable_sources}
    if (not sources or len(retained) != len(parent.sources) or len(sources) != len(context.usable_sources)
            or any(url not in retained or source != retained[url]
                or source_match(source.url, source.title, source.text, parent.target) != source.match
                for url, source in sources.items())):
        raise ValueError("Public sources must be unique exact retained parent sources")
    judgments = {item.source_url: item for item in dataset.sources}
    if (len(judgments) != len(dataset.sources) or judgments.keys() != sources.keys()
            or any(item.source_sha256 != digest(sources[url]) for url, item in judgments.items())):
        raise ValueError("Annotate every retained usable source identity exactly once")
    units = narrative_units(run)
    annotations = {item.path: item for item in dataset.annotations}
    if len(annotations) != len(dataset.annotations) or annotations.keys() != units.keys():
        raise ValueError("Annotate every interpretation, question and caveat exactly once")
    counts = dict.fromkeys(("supported", "contradicted", "not_established", "not_a_factual_claim"), 0)
    citation_failures = uncertainty_failures = authority_failures = 0
    cited_sources = set()
    for path, (text, cited_evidence, cited_urls) in units.items():
        annotation = annotations[path]
        if (annotation.text_sha256 != text_digest(text)
                or len(set(annotation.reference_evidence_ids)) != len(annotation.reference_evidence_ids)
                or len(set(annotation.reference_source_urls)) != len(annotation.reference_source_urls)
                or len(set(cited_evidence)) != len(cited_evidence) or len(set(cited_urls)) != len(cited_urls)
                or not set(annotation.reference_evidence_ids) <= evidence
                or not set(annotation.reference_source_urls) <= sources.keys()
                or not set(cited_evidence) <= evidence or not set(cited_urls) <= sources.keys()):
            raise ValueError("Statement or citation binding changed")
        if annotation.entailment in {"supported", "contradicted"} and not (
                annotation.reference_evidence_ids or annotation.reference_source_urls):
            raise ValueError("Supported/contradicted judgments require exact retained references")
        factual = annotation.entailment != "not_a_factual_claim"
        counts[annotation.entailment] += 1
        citation_failures += int(factual and (not (cited_evidence or cited_urls) or not annotation.citation_supported))
        uncertainty_failures += int(not annotation.uncertainty_preserved)
        authority_failures += int(not annotation.authority_preserved)
        cited_sources.update(cited_urls)
    identity_failures = sum(judgments[url].identity != "consistent" for url in cited_sources)
    # Evaluate the original generation window, never renew it from evaluation wall time.
    temporal_eligible = bool(context.status == "usable" and parent.finished_at and parent.expires_at and run.finished_at
        and parent.started_at <= parent.finished_at <= context.evaluated_at <= run.started_at <= run.finished_at < run.worker_deadline_at
        and run.finished_at < parent.expires_at <= parent.finished_at + timedelta(minutes=15)
        and all(source.published_at is not None and source.freshness_at_fetch == "fresh"
            and parent.started_at <= source.fetched_at <= parent.finished_at
            and run.finished_at - timedelta(days=30) <= source.published_at <= source.fetched_at
            for source in sources.values()))
    factual_count = len(units) - counts["not_a_factual_claim"]
    factual_pass = factual_count > 0 and not any((counts["contradicted"], counts["not_established"],
        citation_failures, uncertainty_failures, authority_failures))
    return {"rubric": RUBRIC, "dataset_id": dataset.dataset_id, "dataset_version": dataset.version,
        "evaluator": dataset.evaluator, "evidence_tier": dataset.evidence_tier,
        "artifact_sha256": artifact_hash, "dataset_sha256": digest(dataset), "run_id": str(run.id),
        "research_run_id": str(parent.id), "snapshot_hash": view.assessment.snapshot_hash,
        "output_units": len(units), "factual_units": factual_count, **counts,
        "supported_fraction": counts["supported"] / factual_count if factual_count else None,
        "citation_failures": citation_failures, "uncertainty_failures": uncertainty_failures,
        "authority_failures": authority_failures, "source_identity_failures": identity_failures,
        "temporally_eligible_at_generation": temporal_eligible, "meets_factual_rubric": factual_pass,
        "meets_current_context_rubric": factual_pass and not identity_failures and temporal_eligible,
        "factual_confidence": "unverified", "external_execution": False,
        "caveat": "Scores measure supplied independent human/gold judgments over exact retained text and source identities. "
            "They do not establish autonomous truth, current configuration, workflow approval or general model quality. "
            "Questions containing factual presuppositions require factual labels. Synthetic cases are not live acceptance."}


def main():
    parser = argparse.ArgumentParser(description="Score a retained research narrative against independent judgments")
    parser.add_argument("--artifact", required=True)
    parser.add_argument("--annotations", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        run = NarrativeRun.model_validate(load_private(args.artifact, 2_000_000))
        dataset = ResearchDataset.model_validate(load_private(args.annotations, 1_000_000))
        report = evaluate_narrative(run, dataset)
        output = Path(args.output).resolve()
        if output.is_relative_to(Path(__file__).resolve().parents[3]):
            raise ValueError("Reports belong in a private directory outside the checkout")
        with output.open("x", encoding="utf-8") as stream:
            stream.write(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    except (OSError, ValueError, RecursionError):
        parser.exit(2, "Research evaluation failed; inspect private inputs and destination locally.\n")


if __name__ == "__main__":
    main()
