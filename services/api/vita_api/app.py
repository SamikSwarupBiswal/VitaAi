from contextlib import asynccontextmanager
from datetime import UTC, datetime
from threading import Lock
from time import monotonic
from typing import Annotated

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .config import Settings
from .contracts import AccountView, AnalyzeRequest, ModelRun, Portfolio, ProviderStatus
from .hubspot import PREFIX as HUBSPOT_PREFIX
from .hubspot_sync import install_hubspot_routes
from .identity import Actor, Identity, LoginFailure, LoginRequest, SessionView
from .microsoft import PREFIX as MICROSOFT_PREFIX
from .microsoft import Microsoft
from .models import AdvisoryProvider
from .nebius import Nebius
from .pipeline import Pipeline, PipelineRequest, PipelineRun
from .provider_catalog import PREFIX as COMPARISON_PREFIX
from .provider_catalog import install_catalog_routes
from .research import PREFIX as RESEARCH_PREFIX
from .research_service import install_research_routes
from .sample import SAMPLE_ORG, sample_records
from .scoring import assess
from .storage import Store
from .workflow_api import WORKFLOW_PREFIXES, install_workflow_routes, safe_error


def create_app(settings: Settings | None = None, provider: AdvisoryProvider | None = None,
               *, hubspot_transport: httpx.BaseTransport | None = None,
               microsoft_transport: httpx.BaseTransport | None = None, microsoft_client_factory=None,
               research_transport: httpx.BaseTransport | None = None,
               comparison_transport: httpx.BaseTransport | None = None) -> FastAPI:
    settings = settings or Settings()
    store = Store(settings.database_url)
    provider = provider or Nebius(settings)
    identity = Identity(store.engine)
    microsoft = Microsoft(store, settings, microsoft_transport, client_factory=microsoft_client_factory)
    login_lock = Lock()
    login_attempts: list[float] = []

    @asynccontextmanager
    async def lifespan(app):
        store.initialize()
        store.seed(sample_records(datetime.now(UTC)))
        yield
        store.engine.dispose()

    app = FastAPI(title="VitaAi local foundation", version="0.1.0", lifespan=lifespan)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "testserver"])
    app.state.store = store

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, error: RequestValidationError):
        if request.url.path == "/api/auth/login":
            return JSONResponse({"detail": "Invalid sign-in request"}, status_code=422)
        if request.url.path.startswith((*WORKFLOW_PREFIXES, HUBSPOT_PREFIX, MICROSOFT_PREFIX, RESEARCH_PREFIX,
                                        COMPARISON_PREFIX)):
            return safe_error("invalid_workflow_request", 422)
        from fastapi.exception_handlers import request_validation_exception_handler
        return await request_validation_exception_handler(request, error)

    @app.middleware("http")
    async def local_origin(request: Request, call_next):
        if request.url.path == MICROSOFT_PREFIX + "/callback":
            # Remove OAuth codes/state from the ASGI scope before access logging and errors.
            query = request.scope.get("query_string", b"")
            request.state.microsoft_response = dict(request.query_params) if len(query) <= 16384 else {}
            request.scope["query_string"] = b""
        origin = request.headers.get("origin")
        if request.method == "POST" and origin and origin not in {
            "http://127.0.0.1:3000", "http://localhost:3000",
        }:
            return JSONResponse({"detail": "Untrusted request origin"}, status_code=403)
        if (request.method == "POST" and settings.auth_mode == "session"
                and request.headers.get("x-vitaai-request") != "1"):
            return JSONResponse({"detail": "Expected same-origin application request"}, status_code=403)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        if request.url.path == MICROSOFT_PREFIX + "/callback":
            response.headers["Referrer-Policy"] = "no-referrer"
        return response

    def actor(request: Request) -> Actor:
        if settings.auth_mode == "sample":
            return Actor(id="local-sample", username="Local sample", organization_id=SAMPLE_ORG, role="seller")
        current = identity.resolve(request.cookies.get("vitaai_session"))
        if current is None:
            raise HTTPException(401, "Sign in to access this workspace")
        return current

    def writer(current: Annotated[Actor, Depends(actor)]) -> Actor:
        if current.role == "viewer":
            raise HTTPException(403, "This role cannot start analysis or preparation")
        return current

    @app.get("/api/auth/session", response_model=SessionView)
    def session(request: Request):
        return SessionView(mode=settings.auth_mode, actor=identity.resolve(request.cookies.get("vitaai_session"))
                           if settings.auth_mode == "session" else None)

    @app.post("/api/auth/login", response_model=SessionView)
    def login(body: LoginRequest, request: Request, response: Response):
        if settings.auth_mode != "session":
            raise HTTPException(409, "Session identity is disabled in sample mode")
        now = monotonic()
        with login_lock:
            login_attempts[:] = [t for t in login_attempts if now - t < 60]
            if len(login_attempts) >= 30:
                raise HTTPException(429, "Too many sign-in attempts; retry later")
            login_attempts.append(now)
        try:
            current, token = identity.login(body.username, body.password.get_secret_value(), settings.session_hours,
                                            request.cookies.get("vitaai_session"))
        except LoginFailure as failure:
            raise HTTPException(429 if failure.locked else 401, "Sign-in failed; check credentials or retry later") from None
        response.set_cookie("vitaai_session", token, httponly=True, samesite="strict",
                            secure=settings.session_cookie_secure, max_age=settings.session_hours * 3600, path="/")
        return SessionView(mode="session", actor=current)

    @app.post("/api/auth/logout", response_model=SessionView)
    def logout(request: Request, response: Response):
        identity.logout(request.cookies.get("vitaai_session"))
        response.delete_cookie("vitaai_session", path="/", httponly=True, samesite="strict",
                               secure=settings.session_cookie_secure)
        return SessionView(mode=settings.auth_mode)

    def views(organization_id: str) -> list[AccountView]:
        as_of = datetime.now(UTC).date()
        result = []
        for account, facts, source in store.account_records(organization_id):
            result.append(AccountView(
                account=account, evidence=facts, assessment=assess(account, facts, as_of),
                renewal_days=(account.renewal_date - as_of).days if account.renewal_date is not None else None,
                latest_run=store.latest_run(organization_id, account.id),
                source=source,
            ))
        return sorted(result, key=lambda item: (-item.assessment.risk, item.account.id))

    def account_view(organization_id: str, account_id: str) -> AccountView:
        view = next((item for item in views(organization_id) if item.account.id == account_id), None)
        if view is None:
            raise HTTPException(404, "Account not found")
        return view

    @app.get("/health")
    def health():
        store.list_accounts(SAMPLE_ORG)
        return {"status": "ok", "identity": settings.auth_mode, "mode": "local_sample", "external_execution": False}

    @app.get("/api/portfolio", response_model=Portfolio)
    def portfolio(current: Annotated[Actor, Depends(actor)]):
        items = views(current.organization_id)
        values = [item.account.annual_value for item in items if item.account.annual_value is not None]
        return Portfolio(
            organization_id=current.organization_id, as_of=datetime.now(UTC).date(), accounts=items,
            mode=("mixed" if any(item.account.synthetic for item in items) else "hubspot")
            if any(item.source and item.source.kind == "hubspot" for item in items) else "local_sample",
            annual_value=sum(values) if values or not items else None,
            annual_value_missing_count=len(items) - len(values),
            attention_count=sum(item.assessment.needs_attention for item in items),
            growth_count=sum(item.assessment.growth_signal for item in items),
        )

    @app.get("/api/accounts/{account_id}", response_model=AccountView)
    def account(account_id: str, current: Annotated[Actor, Depends(actor)]):
        return account_view(current.organization_id, account_id)

    @app.get("/api/providers/nebius", response_model=ProviderStatus)
    def provider_status(current: Annotated[Actor, Depends(actor)]):
        return provider.status()

    @app.post("/api/providers/nebius/discover", response_model=ProviderStatus)
    def discover(current: Annotated[Actor, Depends(writer)]):
        if settings.auth_mode == "session" and current.role != "admin":
            raise HTTPException(403, "Provider discovery requires an administrator")
        return provider.discover()

    @app.post("/api/accounts/{account_id}/analyze", response_model=ModelRun)
    def analyze(account_id: str, body: AnalyzeRequest, current: Annotated[Actor, Depends(writer)]):
        view = account_view(current.organization_id, account_id)
        if (body.expected_revision != view.account.revision
                or body.expected_snapshot_hash != view.assessment.snapshot_hash):
            raise HTTPException(409, "Account snapshot changed; refresh before analysis")
        run = provider.analyze(view)
        store.save_run(run)
        return run

    @app.post("/api/pipeline", response_model=PipelineRun)
    def run_pipeline(body: PipelineRequest, current: Annotated[Actor, Depends(writer)]):
        records = [(account, facts) for account, facts, _ in store.account_records(current.organization_id)]
        run = Pipeline(provider).run(current.organization_id,
                                     current.id if settings.auth_mode == "session" else None,
                                     records, datetime.now(UTC).date(), body)
        store.save_pipeline(run)
        return run

    @app.get("/api/pipeline/{run_id}", response_model=PipelineRun)
    def get_pipeline(run_id: str, current: Annotated[Actor, Depends(actor)]):
        run = store.get_pipeline(current.organization_id, run_id)
        if run is None:
            raise HTTPException(404, "Pipeline run not found")
        return run

    install_workflow_routes(app, store, identity, settings, provider, hubspot_transport, microsoft)
    install_hubspot_routes(app, store, identity, settings, hubspot_transport)
    install_research_routes(app, store, identity, settings, research_transport)
    install_catalog_routes(app, store, identity, settings, comparison_transport)
    return app


app = create_app()
