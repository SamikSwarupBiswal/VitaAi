"""Separately authenticated Microsoft interface routes; no dispatch capability."""
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request

from .governance import PolicyDenied
from .platform_interfaces import (
    EntraVerifier,
    IdentityBinding,
    IdentityLink,
    PlatformContext,
    PlatformInterfaces,
    PlatformPreparation,
    PlatformReadiness,
    PlatformSettings,
    PreparationProposal,
    Principal,
    TeamsActivity,
    TeamsCard,
)

PREFIX = "/api/platform"
BEARER_POSTS = {PREFIX + "/preparation", PREFIX + "/teams/activity"}


def install_platform_routes(app, store, settings, config=None, transport=None):
    config = config or PlatformSettings()
    interfaces, verifier = PlatformInterfaces(store, config), EntraVerifier(config, transport)
    router = APIRouter(prefix=PREFIX)

    def principal(request: Request):
        if settings.auth_mode != "session":
            raise PolicyDenied("session_identity_required", 503)
        return verifier.verify(request.headers.get("authorization"))

    Verified = Annotated[Principal, Depends(principal)]

    @router.get("/readiness", response_model=PlatformReadiness)
    def readiness(request: Request):
        from .memory import Memory
        if settings.auth_mode != "session":
            raise PolicyDenied("session_identity_required", 503)
        with Memory(store, request.cookies.get("vitaai_session")).transaction():
            return PlatformReadiness(configured=bool(config.enabled and config.tenant_id and config.audience
                and config.client_ids and config.web_origin), tenant_id=config.tenant_id,
                audience=config.audience, delegated_scope=config.delegated_scope, web_origin=config.web_origin)

    @router.get("/identities", response_model=list[IdentityLink])
    def links(request: Request):
        if settings.auth_mode != "session":
            raise PolicyDenied("session_identity_required", 503)
        return interfaces.links(request.cookies.get("vitaai_session"))

    @router.post("/identities", response_model=IdentityLink)
    def link(request: Request, body: IdentityBinding):
        if settings.auth_mode != "session":
            raise PolicyDenied("session_identity_required", 503)
        return interfaces.link(request.cookies.get("vitaai_session"), body)

    @router.get("/context/{account_id}", response_model=PlatformContext, operation_id="platformContext")
    def context(account_id: UUID, actor: Verified):
        return interfaces.context(actor, account_id)

    @router.post("/preparation", response_model=PreparationProposal, operation_id="platformPreparation")
    def preparation(body: PlatformPreparation, actor: Verified):
        return interfaces.preparation(actor, body)

    @router.post("/teams/activity", response_model=TeamsCard)
    def teams(body: TeamsActivity, actor: Verified):
        return interfaces.teams(actor, body)

    app.include_router(router)
