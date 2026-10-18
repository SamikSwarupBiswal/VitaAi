"""Bounded search context. Retrieved text is untrusted advisory data."""
import ipaddress
import json
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from typing import Literal
from urllib.parse import urlsplit
from uuid import UUID

import httpx
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

from .config import ResearchTarget, Settings

PREFIX = "/api/integrations/research"
CAVEAT = "Untrusted advisory search context; verify sources. Never facts, scores, approval or execution authority."


class ResearchContract(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal["1"] = "1"


class ResearchRequest(ResearchContract):
    expected_account_revision: int = Field(ge=1)
    mode: Literal["mock", "live"] = "mock"


class ResearchStatus(ResearchContract):
    enabled: bool
    live_status: Literal["unconfigured", "configured_unverified"]
    provider: Literal["tavily"] = "tavily"


class ResearchSource(ResearchContract):
    url: str = Field(min_length=1, max_length=2048)
    title: str = Field(min_length=1, max_length=500)
    text: str = Field(max_length=4000)
    provider_relevance: float = Field(ge=0, le=1, allow_inf_nan=False)
    match: Literal["configured_domain"] = "configured_domain"
    published_at: AwareDatetime | None
    fetched_at: AwareDatetime
    freshness_at_fetch: Literal["fresh", "stale", "unknown"]
    factual_confidence: Literal["unverified"] = "unverified"


class ResearchRun(ResearchContract):
    id: UUID
    organization_id: str
    account_id: UUID
    account_revision: int = Field(ge=1)
    actor_id: str
    provider: Literal["tavily"] = "tavily"
    requested_mode: Literal["mock", "live"]
    mode: Literal["disabled", "mock", "live", "fallback"]
    status: Literal["pending", "succeeded", "unavailable", "discarded"]
    target: ResearchTarget
    started_at: AwareDatetime
    finished_at: AwareDatetime | None = None
    expires_at: AwareDatetime | None = None
    sources: list[ResearchSource] = Field(default_factory=list, max_length=5)
    error_code: str | None = None
    caveat: str = CAVEAT


class ResearchFailure(Exception):
    """Fixed safe codes only, never provider bodies or exception messages."""


def source_url(value: str, domain: str) -> bool:
    try:
        url = urlsplit(value)
        host = url.hostname or ""
        if (url.scheme != "https" or url.username or url.password or url.port not in (None, 443)
                or url.fragment or url.query or any(ord(c) < 33 for c in value)
                or not (host == domain or host.endswith("." + domain))):
            return False
        try:
            ipaddress.ip_address(host)
            return False
        except ValueError:
            return True
    except (ValueError, TypeError):
        return False


def publication(value, fetched):
    if value is None:
        return None
    if not isinstance(value, str):
        raise ResearchFailure("invalid_source_time")
    try:
        try:
            result = datetime.fromisoformat(value)
        except ValueError:
            result = parsedate_to_datetime(value)
        if result.tzinfo is None or result > fetched:
            raise ValueError
        return result.astimezone(UTC)
    except (ValueError, TypeError, OverflowError):
        raise ResearchFailure("invalid_source_time") from None


class Research:
    def __init__(self, settings: Settings, transport: httpx.BaseTransport | None = None):
        self.settings = settings.model_copy(deep=True)
        self.transport = transport

    @property
    def configured(self):
        s = self.settings
        return bool(s.research_enabled and s.research_live_enabled and s.research_api_key.get_secret_value()
                    and s.research_organization_id and s.research_account_map)

    def status(self, organization_id):
        allowed = organization_id == self.settings.research_organization_id
        return ResearchStatus(enabled=allowed and self.settings.research_enabled,
            live_status="configured_unverified" if allowed and self.configured else "unconfigured")

    def search(self, target: ResearchTarget) -> list[ResearchSource]:
        if not self.configured:
            raise ResearchFailure("research_unconfigured")
        try:
            # Fixed endpoint, no redirects/retries or subsequent fetch of returned URLs.
            with (httpx.Client(timeout=15, follow_redirects=False, transport=self.transport,
                    headers={"Authorization": "Bearer " + self.settings.research_api_key.get_secret_value()}) as client,
                client.stream("POST", "https://api.tavily.com/search", json={
                    "query": target.company_name + " company news", "topic": "general",
                    "search_depth": "basic", "max_results": 5, "auto_parameters": False,
                    "include_answer": False, "include_raw_content": False, "include_images": False,
                    "include_published_date": True, "include_domains": [target.domain],
                    "include_domains_mode": "restrict",
                }) as response):
                if response.status_code != 200:
                    raise ResearchFailure(f"research_http_{response.status_code}")
                body = bytearray()
                for chunk in response.iter_bytes():
                    body.extend(chunk)
                    if len(body) > 65536:
                        raise ResearchFailure("response_too_large")
            data = json.loads(body)
            if not isinstance(data, dict) or not isinstance(data.get("results"), list) or len(data["results"]) > 5:
                raise ResearchFailure("invalid_response")
            fetched = datetime.now(UTC)
            sources, seen = [], set()
            for item in data["results"]:
                if not isinstance(item, dict) or not isinstance(item.get("url"), str):
                    raise ResearchFailure("invalid_response")
                url = item["url"]
                if not source_url(url, target.domain) or url in seen:
                    continue
                seen.add(url)
                published = publication(item.get("published_date"), fetched)
                if (not isinstance(item.get("title"), str) or not isinstance(item.get("content"), str)
                        or type(item.get("score")) not in (float, int)):
                    raise ResearchFailure("invalid_response")
                sources.append(ResearchSource(url=url, title=item["title"], text=item["content"],
                    provider_relevance=item["score"], published_at=published, fetched_at=fetched,
                    freshness_at_fetch="unknown" if published is None else
                        "stale" if published < fetched - timedelta(days=30) else "fresh"))
            return sources
        except httpx.TimeoutException:
            raise ResearchFailure("research_timeout") from None
        except httpx.RequestError:
            raise ResearchFailure("research_network_error") from None
        except (ValueError, UnicodeError, RecursionError):
            raise ResearchFailure("invalid_response") from None
