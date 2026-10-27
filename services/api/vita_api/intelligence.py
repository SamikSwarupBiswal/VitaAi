"""Durable isolated what-if analysis and source-timed trends. No provider calls."""
import re
from datetime import timedelta
from itertools import pairwise
from uuid import uuid4

from pydantic import ValidationError
from sqlalchemy import (
    JSON,
    Column,
    ForeignKeyConstraint,
    Integer,
    String,
    Table,
    UniqueConstraint,
    select,
)

from .config import PROPERTY_SEMANTICS, Settings
from .contracts import AccountView
from .governance import PolicyDenied, check_plan, digest, evidence_binding
from .hubspot import HubSpot, HubSpotObservation
from .hubspot_normalize import normalize
from .intelligence_contracts import (
    MetricTrend,
    PromotedScenario,
    Scenario,
    ScenarioOption,
    ScenarioPromotion,
    ScenarioRequest,
    TrendPoint,
    TrendReport,
    TrendRequest,
)
from .memory import Memory
from .pipeline import PipelineRun
from .scoring import assess
from .storage import metadata, pipeline_runs
from .workflow import Workflow
from .workflow_contracts import Alternative, Plan, PlanRequest, PlanStep
from .workflow_storage import plans


def table(name, *columns):
    return Table(name, metadata, Column("id", String(80), primary_key=True),
        Column("organization_id", String(80), nullable=False), Column("account_id", String(80), nullable=False),
        Column("revision", Integer, nullable=False), Column("payload", JSON, nullable=False),
        UniqueConstraint("organization_id", "id"),
        ForeignKeyConstraint(["organization_id", "account_id"], ["accounts.organization_id", "accounts.id"]), *columns)


scenarios = table("intelligence_scenarios", Column("author_id", String(80), nullable=False),
    Column("request_id", String(80), nullable=False), UniqueConstraint("organization_id", "author_id", "request_id"))
promotions = table("intelligence_promotions", Column("scenario_id", String(80), nullable=False),
    UniqueConstraint("organization_id", "scenario_id"),
    ForeignKeyConstraint(["organization_id", "scenario_id"], ["intelligence_scenarios.organization_id", "intelligence_scenarios.id"]))
trends = table("intelligence_trends")
UNITS = {"usage_change": "percent", "support_cases": "count", "expansion": "score/100", "renewal": "days"}


def projection_hash(baseline, request, projected):
    return digest({"baseline": baseline.model_dump(mode="json"), "request": request.model_dump(mode="json"),
                   "projected": projected.model_dump(mode="json"), "policy": "what-if-1"})


def trend_provenance(connection, actor, account, fact):
    """Resolve a normalized measurement's declared source, never its display label."""
    if fact.synthetic:
        if fact.source == "HubSpot" or fact.source_record.startswith("hubspot:"):
            raise PolicyDenied("trend_source_provenance_unavailable", 409)
        return (digest({"kind": "synthetic", "organization": actor.organization_id, "account": account.id,
                        "source": fact.source, "record": fact.source_record, "metric": fact.metric}),
                fact.ingested_at, None, UNITS[fact.metric])
    match = re.fullmatch(r"hubspot:([1-9][0-9]{0,19}):([1-9][0-9]{0,19}):([0-9a-f-]{36}):([a-z][a-z0-9_]{0,99})", fact.source_record)
    if fact.source != "HubSpot" or match is None:
        raise PolicyDenied("trend_source_provenance_unavailable", 409)
    from .hubspot_sync import observations
    portal, company, identity, property_name = match.groups()
    row = connection.execute(select(observations).where(observations.c.organization_id == actor.organization_id,
        observations.c.account_id == account.id, observations.c.id == identity)).mappings().first()
    if row is None:
        raise PolicyDenied("trend_source_provenance_unavailable", 409)
    try:
        observation = HubSpotObservation.model_validate(row["payload"])
        target = "renewal_date" if fact.metric == "renewal" else fact.metric
        mapping = observation.property_mapping.get(target)
        connector = HubSpot(Settings(_env_file=None, hubspot_property_map=observation.property_mapping))
        if (str(observation.id) != identity or observation.organization_id != actor.organization_id
                or str(observation.account_id) != account.id or observation.sequence != row["sequence"]
                or observation.portal_id != portal or observation.company_id != company or mapping is None
                or mapping.property != property_name or observation.mapping_hash != connector.mapping_hash
                or (mapping.type, mapping.unit, mapping.meaning) != PROPERTY_SEMANTICS[target]
                or not observation.provider_created_at <= observation.provider_updated_at <= observation.fetched_at):
            raise ValueError("Invalid source mapping")
        normalized = normalize(account, observation, connector)
        matches = [item for item in normalized.evidence if item.id == fact.id]
        if matches != [fact]:
            raise ValueError("Saved evidence differs from original normalized source")
        lineage = digest({"kind": "hubspot", "organization": actor.organization_id, "account": account.id,
            "portal": portal, "company": company, "metric": fact.metric, "property": property_name,
            "measurement_property": mapping.observed_at_property, "mapping_hash": observation.mapping_hash,
            "unit": mapping.unit, "meaning": mapping.meaning})
        return lineage, observation.fetched_at, observation.sequence, UNITS[fact.metric]
    except (ValidationError, ValueError, TypeError, KeyError):
        raise PolicyDenied("trend_source_provenance_unavailable", 409) from None


class Intelligence(Memory):
    def __init__(self, store, session_token, *, clock=None):
        super().__init__(store, session_token, clock=clock)
        self.workflow = Workflow(store, session_token=session_token, session_required=True, clock=self.clock)

    def base(self, actor, account_id):
        return {"id": uuid4(), "organization_id": actor.organization_id, "account_id": account_id,
                "created_at": self.clock(), "revision": 1, "correlation_id": uuid4()}

    @staticmethod
    def saved_view(connection, actor, account_id, pipeline_id):
        row = connection.execute(select(pipeline_runs.c.payload).where(
            pipeline_runs.c.organization_id == actor.organization_id, pipeline_runs.c.id == str(pipeline_id))).scalar()
        if row is None:
            raise PolicyDenied("pipeline_not_found", 404)
        try:
            run = PipelineRun.model_validate(row)
            contexts = [item for item in run.contexts if item.account.id == str(account_id)]
            if (run.organization_id != actor.organization_id or run.id != str(pipeline_id)
                    or run.started_at.utcoffset() is None or len(contexts) != 1):
                raise ValueError("Invalid source scope")
            context = contexts[0]
            if (context.account.organization_id != actor.organization_id
                    or len({item.id for item in context.evidence}) != len(context.evidence)
                    or any(item.account_id != str(account_id) or item.organization_id != actor.organization_id
                           or item.observed_at.utcoffset() is None for item in context.evidence)):
                raise ValueError("Invalid evidence scope")
            assessment = assess(context.account, context.evidence, run.as_of)
            selected = [item for item in run.recommendations if item.account_id == str(account_id)]
            if len(selected) > 1 or (selected and selected[0].assessment != assessment):
                raise ValueError("Changed saved assessment")
            return run, AccountView(account=context.account, evidence=context.evidence, assessment=assessment,
                renewal_days=(context.account.renewal_date - run.as_of).days if context.account.renewal_date else None)
        except (ValidationError, ValueError, TypeError):
            raise PolicyDenied("intelligence_source_unavailable", 409) from None

    @staticmethod
    def put(connection, target, item, **columns):
        connection.execute(target.insert().values(id=str(item.id), organization_id=item.organization_id,
            account_id=str(item.account_id), revision=item.revision, payload=item.model_dump(mode="json"), **columns))

    def record(self, connection, actor, target, identity, contract):
        row = connection.execute(select(target).where(target.c.organization_id == actor.organization_id,
            target.c.id == str(identity))).mappings().first()
        if row is None:
            raise PolicyDenied("intelligence_record_not_found", 404)
        try:
            value = contract.model_validate(row["payload"])
            if (str(value.id) != row["id"] or value.organization_id != actor.organization_id
                    or str(value.account_id) != row["account_id"] or value.revision != row["revision"]):
                raise ValueError("Changed record")
        except (ValidationError, ValueError):
            raise PolicyDenied("intelligence_record_unavailable", 409) from None
        self.account(connection, actor, value.account_id)
        if isinstance(value, Scenario):
            _, baseline = self.saved_view(connection, actor, value.account_id, value.request.pipeline_id)
            if (baseline != value.baseline or value.projected != self.project(baseline, value.request)
                    or projection_hash(baseline, value.request, value.projected) != value.projection_hash
                    or value.author_id != row["author_id"] or str(value.request.request_id) != row["request_id"]):
                raise PolicyDenied("intelligence_record_unavailable", 409)
        return value

    @staticmethod
    def project(baseline, body):
        account, facts = baseline.account.model_copy(deep=True), [item.model_copy(deep=True) for item in baseline.evidence]
        factors = {item.metric: item for item in baseline.assessment.factors}
        for name, value in body.overrides.model_dump(exclude={"schema_version"}, exclude_none=True).items():
            metric = "renewal" if name == "renewal_days" else name
            factor = factors.get(metric)
            if factor is None or factor.value is None or not factor.evidence_id:
                raise PolicyDenied("scenario_missing_baseline_metric", 422)
            fact = next((item for item in facts if item.id == factor.evidence_id), None)
            if fact is None:
                raise PolicyDenied("scenario_missing_baseline_metric", 422)
            fact.value = value
            fact.fact = f"What-if assumption only: {metric}={value} {UNITS[metric]}"
            if metric == "renewal":
                account.renewal_date = baseline.assessment.as_of + timedelta(days=value)
        return assess(account, facts, baseline.assessment.as_of)

    def create_scenario(self, account_id, body: ScenarioRequest):
        with self.transaction(write=True) as (connection, actor):
            self.account(connection, actor, account_id)
            existing = connection.execute(select(scenarios.c.id).where(
                scenarios.c.organization_id == actor.organization_id, scenarios.c.author_id == actor.id,
                scenarios.c.request_id == str(body.request_id))).scalar()
            if existing:
                item = self.record(connection, actor, scenarios, existing, Scenario)
                if str(item.account_id) != str(account_id) or item.request != body:
                    raise PolicyDenied("scenario_request_conflict", 409)
                return item
            run, baseline = self.saved_view(connection, actor, account_id, body.pipeline_id)
            if baseline.assessment.snapshot_hash != body.expected_snapshot_hash:
                raise PolicyDenied("scenario_snapshot_changed", 409)
            if run.started_at > self.clock() or run.as_of > self.clock().date():
                raise PolicyDenied("scenario_future_baseline", 422)
            projected = self.project(baseline, body)
            item = Scenario(**self.base(actor, account_id), author_id=actor.id, request=body,
                source_started_at=run.started_at, source_author_id=run.actor_id, baseline=baseline, projected=projected,
                projection_hash=projection_hash(baseline, body, projected),
                alternatives=(ScenarioOption(id="verify_assumptions", description="Verify assumptions against independent sources before preparation."),
                              ScenarioOption(id="prepare_review", description="Prepare an unapproved internal review plan using current evidence.", depends_on=("verify_assumptions",))),
                caveats=("Simulation of baseline scoring only; projected scores are not observed facts, business outcomes or causal estimates.",
                         "Human assumptions are unverified. Baseline missing data and source caveats remain applicable.",
                         "No rank, source fact, confidence claim, mission, approval or execution is changed."))
            self.put(connection, scenarios, item, author_id=actor.id, request_id=str(body.request_id))
            return item

    def get_scenario(self, scenario_id):
        with self.transaction() as (connection, actor):
            return self.record(connection, actor, scenarios, scenario_id, Scenario)

    def list_records(self, account_id, kind):
        target, contract = (scenarios, Scenario) if kind == "scenarios" else (trends, TrendReport)
        with self.transaction() as (connection, actor):
            self.account(connection, actor, account_id)
            ids = connection.execute(select(target.c.id).where(target.c.organization_id == actor.organization_id,
                target.c.account_id == str(account_id)).order_by(target.c.id).limit(20)).scalars().all()
            return [self.record(connection, actor, target, identity, contract) for identity in ids]

    def promote(self, scenario_id, body: ScenarioPromotion):
        with self.transaction(write=True) as (connection, actor):
            item = self.record(connection, actor, scenarios, scenario_id, Scenario)
            if item.revision != body.expected_revision:
                raise PolicyDenied("scenario_revision_changed", 409)
            existing = connection.execute(select(promotions.c.id).where(promotions.c.organization_id == actor.organization_id,
                promotions.c.scenario_id == str(item.id))).scalar()
            if existing:
                saved = self.record(connection, actor, promotions, existing, PromotedScenario)
                if saved.assumption_acknowledgement != body.assumption_acknowledgement:
                    raise PolicyDenied("scenario_promotion_conflict", 409)
                return saved
            current = self.workflow._view(connection, actor, item.account_id)
            view, _ = self.workflow._planning_view(connection, actor, PlanRequest(account_id=item.account_id,
                expected_revision=current.account.revision, expected_snapshot_hash=body.expected_current_snapshot_hash,
                intent="attention"))
            binding = evidence_binding(view)
            content = (f"Review scenario {item.id} (projection {item.projection_hash}). "
                       "Assumptions are unverified; investigate against current evidence before any customer action.")
            step = PlanStep(id=uuid4(), kind="hubspot_task_create", content=content, evidence_ids=binding.evidence_ids)
            alternative = Alternative(id=uuid4(), rationale=content, evidence_ids=binding.evidence_ids, steps=(step,),
                risks=("What-if projection is not observed fact or an approved customer action.",))
            plan = Plan(**self.workflow._base(actor), account_id=item.account_id, evidence=binding, author_id=actor.id,
                pipeline_run_id=item.request.pipeline_id, source="deterministic", status="valid", validation="valid",
                alternatives=(alternative,), selected_alternative_id=alternative.id,
                caveats=tuple(dict.fromkeys([*view.assessment.caveats, *item.caveats,
                    f"Scenario provenance: {item.id}; {item.projection_hash}; what-if-1."])))
            check_plan(plan, view)
            self.workflow._put(connection, plans, plan, new=True, account_id=str(item.account_id))
            self.workflow._audit(connection, actor, plan, "scenario_plan_prepared")
            result = PromotedScenario(**self.base(actor, item.account_id), scenario_id=item.id, actor_id=actor.id,
                scenario_projection_hash=item.projection_hash, assumption_acknowledgement=body.assumption_acknowledgement, plan=plan)
            self.put(connection, promotions, result, scenario_id=str(item.id))
            return result

    def promotion(self, scenario_id):
        with self.transaction() as (connection, actor):
            item = self.record(connection, actor, scenarios, scenario_id, Scenario)
            identity = connection.execute(select(promotions.c.id).where(promotions.c.organization_id == actor.organization_id,
                promotions.c.scenario_id == str(item.id))).scalar()
            return self.record(connection, actor, promotions, identity, PromotedScenario) if identity else None

    def create_trend(self, account_id, body: TrendRequest):
        with self.transaction(write=True) as (connection, actor):
            self.account(connection, actor, account_id)
            if body.end > self.clock():
                raise PolicyDenied("trend_future_range", 422)
            views = [self.saved_view(connection, actor, account_id, identity) for identity in body.pipeline_ids]
            metrics = []
            for metric, unit in UNITS.items():
                candidates, excluded, unavailable = [], 0, 0
                for run, view in views:
                    for fact in view.evidence:
                        if fact.metric != metric:
                            continue
                        age = (run.as_of - fact.observed_at.date()).days
                        if (not body.start <= fact.observed_at <= body.end or fact.observed_at > run.started_at or run.started_at > self.clock()
                                or run.as_of > self.clock().date() or age < 0 or age > 30):
                            excluded += 1
                            continue
                        try:
                            lineage, version_at, sequence, source_unit = trend_provenance(connection, actor, view.account, fact)
                            if version_at.utcoffset() is None or version_at > run.started_at:
                                raise PolicyDenied("trend_source_provenance_unavailable", 409)
                        except PolicyDenied:
                            excluded += 1
                            unavailable += 1
                            continue
                        candidates.append(TrendPoint(pipeline_id=run.id, snapshot_hash=view.assessment.snapshot_hash,
                            evidence_id=fact.id, source_record=fact.source_record, source=fact.source,
                            observed_at=fact.observed_at, saved_at=run.started_at, value=fact.value,
                            lineage_key=lineage, source_version_at=version_at, source_version_sequence=sequence, source_unit=source_unit))
                points, duplicates, corrections, conflict, superseded = {}, 0, 0, False, []
                for point in sorted(candidates, key=lambda p: (p.source_version_at, p.source_version_sequence or 0,
                        p.saved_at, str(p.pipeline_id))):
                    key = (point.lineage_key, point.observed_at)
                    previous = points.get(key)
                    if previous:
                        if previous.value == point.value:
                            duplicates += 1
                            points[key] = point
                            continue
                        corrections += 1
                        superseded.append(previous)
                        if previous.source_version_at == point.source_version_at:
                            conflict = True
                    points[key] = point
                ordered = sorted(points.values(), key=lambda p: (p.observed_at, p.source_record))
                same_time = {}
                for point in ordered:
                    if point.observed_at in same_time and same_time[point.observed_at] != point.value:
                        conflict = True
                    same_time[point.observed_at] = point.value
                status, delta, slope = "insufficient", None, None
                if unavailable or len({(point.lineage_key, point.source_unit) for point in ordered}) > 1:
                    status = "incompatible_sources"
                elif conflict:
                    status = "conflicting"
                elif len(ordered) >= 2:
                    gap = any((b.observed_at - a.observed_at) > timedelta(days=31) for a, b in pairwise(ordered))
                    duration = (ordered[-1].observed_at - ordered[0].observed_at).total_seconds() / 86400
                    if duration > 0:
                        delta = round(ordered[-1].value - ordered[0].value, 8)
                        status = "gapped" if gap else "unchanged" if delta == 0 else "observed"
                        slope = None if gap else round(delta / duration, 8)
                elif ordered and duplicates:
                    status, delta = "unchanged", 0.0
                metrics.append(MetricTrend(metric=metric, unit=unit, status=status, points=tuple(ordered), delta=delta,
                    per_day=slope, duplicate_count=duplicates, corrected_count=corrections, excluded_count=excluded,
                    superseded_points=tuple(superseded)))
            result = TrendReport(**self.base(actor, account_id), author_id=actor.id, request=body,
                mode="synthetic_history" if any(view.account.synthetic or any(f.synthetic for f in view.evidence) for _, view in views) else "observed_history",
                input_count=len(body.pipeline_ids), available_count=len(views), metrics=tuple(metrics),
                caveats=("Selected saved observations only; omitted observations and gaps are not interpolated.",
                         "Corrections replace the same logical source property/time using original observation ingestion order; old references remain in superseded_points.",
                         "HubSpot portal/company/property/measurement mapping/unit lineage is reconstructed from immutable observations; incompatible or unavailable provenance suppresses calculation.",
                         "Observed change is not causation, predicted business impact or permission to change facts, ranking or approvals."))
            self.put(connection, trends, result)
            return result

    def get_trend(self, identity):
        with self.transaction() as (connection, actor):
            return self.record(connection, actor, trends, identity, TrendReport)
