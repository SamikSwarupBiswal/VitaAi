"""Offline, exact-output factual rubric scoring; entailment labels are human/gold inputs."""
import argparse
import hashlib
import json
from pathlib import Path
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from .governance import canonical_json
from .provider_comparison import ComparisonRun

Hash = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
RUBRIC = "factual-grounding-1"


class Annotation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: str = Field(min_length=1, max_length=180)
    text_sha256: Hash
    entailment: Literal["supported", "contradicted", "not_established", "not_a_factual_claim"]
    reference_evidence_ids: list[str] = Field(max_length=30)
    citation_supported: bool = Field(strict=True)
    uncertainty_preserved: bool = Field(strict=True)
    authority_preserved: bool = Field(strict=True)
    rationale: str = Field(min_length=1, max_length=2000, pattern=r"\S")


class EvaluationDataset(BaseModel):
    model_config = ConfigDict(extra="forbid")
    rubric: Literal["factual-grounding-1"] = RUBRIC
    dataset_id: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_.-]+$")
    version: str = Field(min_length=1, max_length=80)
    evaluator: str = Field(min_length=1, max_length=160)
    evidence_tier: Literal["synthetic_gold", "human_review"]
    artifact_sha256: Hash
    annotations: list[Annotation] = Field(min_length=1, max_length=128)


def digest(value):
    return hashlib.sha256(canonical_json(value)).hexdigest()


def text_digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def output_units(run):
    """Every retained output text, including proposals and caveats, needs an explicit judgment."""
    if len({result.id for result in run.results}) != len(run.results):
        raise ValueError("Retained result identities must be unique")
    units = {}
    for result in run.results:
        prefix = str(result.id)
        if result.analysis is not None:
            for section in ("findings", "next_steps"):
                for index, finding in enumerate(getattr(result.analysis, section)):
                    units[f"{prefix}.analysis.{section}.{index}"] = (finding.text, finding.evidence_ids)
            output = result.analysis
        elif result.drafts is not None:
            for section in ("email", "call_script", "voice_summary", "internal_note"):
                finding = getattr(result.drafts, section)
                if finding is not None:
                    units[f"{prefix}.drafts.{section}"] = (finding.text, finding.evidence_ids)
            output = result.drafts
        else:
            continue
        for index, value in enumerate(output.caveats):
            units[f"{prefix}.caveats.{index}"] = (value, [])
    return units


def evaluate_comparison(run: ComparisonRun, dataset: EvaluationDataset):
    artifact_hash = digest(run)
    if (run.status not in {"completed", "interrupted"} or artifact_hash != dataset.artifact_sha256
            or str(run.account_id) != run.snapshot.account.id or run.organization_id != run.snapshot.account.organization_id
            or run.account_revision != run.snapshot.account.revision or run.snapshot_hash != run.snapshot.assessment.snapshot_hash):
        raise ValueError("Evaluation requires the exact terminal retained artifact")
    units = output_units(run)
    indexed = {item.path: item for item in dataset.annotations}
    if not units or len(indexed) != len(dataset.annotations) or indexed.keys() != units.keys():
        raise ValueError("Annotate every retained output unit exactly once; empty runs are not quality passes")
    references = {item.id for item in run.snapshot.evidence}
    counts = dict.fromkeys(("supported", "contradicted", "not_established", "not_a_factual_claim"), 0)
    citation_failures = uncertainty_failures = authority_failures = 0
    for key, (text, citations) in units.items():
        annotation = indexed[key]
        if (annotation.text_sha256 != text_digest(text) or len(set(annotation.reference_evidence_ids)) != len(annotation.reference_evidence_ids)
                or not set(annotation.reference_evidence_ids) <= references or not set(citations) <= references):
            raise ValueError("Statement or evidence binding changed")
        factual = annotation.entailment != "not_a_factual_claim"
        if annotation.entailment in {"supported", "contradicted"} and not annotation.reference_evidence_ids:
            raise ValueError("Supported/contradicted judgments require retained evidence references")
        counts[annotation.entailment] += 1
        citation_failures += int(factual and (not citations or not annotation.citation_supported))
        uncertainty_failures += int(not annotation.uncertainty_preserved)
        authority_failures += int(not annotation.authority_preserved)
    factual_count = len(units) - counts["not_a_factual_claim"]
    return {"rubric": RUBRIC, "dataset_id": dataset.dataset_id, "dataset_version": dataset.version,
        "evaluator": dataset.evaluator, "evidence_tier": dataset.evidence_tier, "artifact_sha256": artifact_hash,
        "dataset_sha256": digest(dataset), "run_id": str(run.id), "snapshot_hash": run.snapshot_hash,
        "output_units": len(units), "annotated_units": len(indexed), "factual_units": factual_count, **counts,
        "supported_fraction": counts["supported"] / factual_count if factual_count else None,
        "citation_failures": citation_failures, "uncertainty_failures": uncertainty_failures, "authority_failures": authority_failures,
        "meets_rubric": factual_count > 0 and not any((counts["contradicted"], counts["not_established"],
            citation_failures, uncertainty_failures, authority_failures)),
        "factual_confidence": "unverified", "external_execution": False,
        "caveat": "Scores measure supplied human/gold judgments over exact retained text, not autonomous truth or workflow approval. Synthetic results do not establish live model quality."}


def load_private(path, maximum):
    resolved = Path(path).resolve(strict=True)
    if resolved.is_relative_to(Path(__file__).resolve().parents[3]) or resolved.stat().st_size > maximum:
        raise ValueError("Use a bounded private artifact outside the checkout")
    from .legacy_recovery import unique_fields
    return json.loads(resolved.read_text(encoding="utf-8"), object_pairs_hook=unique_fields)


def main():
    parser = argparse.ArgumentParser(description="Score exact comparison output against independent human/synthetic annotations")
    parser.add_argument("--artifact", required=True)
    parser.add_argument("--annotations", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        run = ComparisonRun.model_validate(load_private(args.artifact, 2_000_000))
        dataset = EvaluationDataset.model_validate(load_private(args.annotations, 1_000_000))
        report = evaluate_comparison(run, dataset)
        output = Path(args.output).resolve()
        if output.is_relative_to(Path(__file__).resolve().parents[3]):
            raise ValueError("Reports belong in a private directory outside the checkout")
        with output.open("x", encoding="utf-8") as stream:
            stream.write(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    except (OSError, ValueError, RecursionError):
        parser.exit(2, "Comparison evaluation failed; inspect private inputs and destination locally.\n")


if __name__ == "__main__":
    main()
