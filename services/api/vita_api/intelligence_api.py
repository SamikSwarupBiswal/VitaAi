"""Authenticated scenario and trend tools; no execution endpoint."""
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request

from .governance import PolicyDenied
from .intelligence import Intelligence
from .intelligence_contracts import (
    PromotedScenario,
    Scenario,
    ScenarioPromotion,
    ScenarioRequest,
    TrendReport,
    TrendRequest,
)

PREFIX = "/api/intelligence"


def install_intelligence_routes(app, store, settings):
    router = APIRouter(prefix=PREFIX)

    def service(request: Request):
        if settings.auth_mode != "session":
            raise PolicyDenied("session_identity_required", 503)
        return Intelligence(store, request.cookies.get("vitaai_session"))

    Service = Annotated[Intelligence, Depends(service)]

    @router.get("/accounts/{account_id}/scenarios", response_model=list[Scenario])
    def scenarios(account_id: UUID, service: Service):
        return service.list_records(account_id, "scenarios")

    @router.post("/accounts/{account_id}/scenarios", response_model=Scenario)
    def create_scenario(account_id: UUID, body: ScenarioRequest, service: Service):
        return service.create_scenario(account_id, body)

    @router.get("/scenarios/{scenario_id}", response_model=Scenario)
    def scenario(scenario_id: UUID, service: Service):
        return service.get_scenario(scenario_id)

    @router.get("/scenarios/{scenario_id}/promotion", response_model=PromotedScenario | None)
    def promotion(scenario_id: UUID, service: Service):
        return service.promotion(scenario_id)

    @router.post("/scenarios/{scenario_id}/promotion", response_model=PromotedScenario)
    def promote(scenario_id: UUID, body: ScenarioPromotion, service: Service):
        return service.promote(scenario_id, body)

    @router.get("/accounts/{account_id}/trends", response_model=list[TrendReport])
    def trends(account_id: UUID, service: Service):
        return service.list_records(account_id, "trends")

    @router.post("/accounts/{account_id}/trends", response_model=TrendReport)
    def create_trend(account_id: UUID, body: TrendRequest, service: Service):
        return service.create_trend(account_id, body)

    @router.get("/trends/{trend_id}", response_model=TrendReport)
    def trend(trend_id: UUID, service: Service):
        return service.get_trend(trend_id)

    app.include_router(router)
