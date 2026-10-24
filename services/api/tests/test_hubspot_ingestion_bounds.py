"""Configured complete-read bounds; synthetic transport and isolated persistence."""
import hashlib
import json
import unittest
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import httpx
import test_hubspot_ingestion as fixtures
from pydantic import ValidationError
from sqlalchemy import update
from vita_api.governance import PolicyDenied
from vita_api.hubspot import HubSpotFailure
from vita_api.hubspot_ingestion import (
    AssociatedReader,
    IngestionRequest,
    IngestionRun,
    ingestions,
)


class ConfiguredBoundsTests(unittest.TestCase):
    setUp = fixtures.ApiTests.setUp
    login = fixtures.ApiTests.login
    respond = fixtures.ApiTests.respond
    operation = fixtures.ApiTests.operation
    drop_postgres_schema = fixtures.ApiTests.drop_postgres_schema

    def test_settings_bounds_and_historical_default_digest(self):
        for field, values in (("hubspot_ingestion_object_limit", [0, 101]),
                              ("hubspot_ingestion_page_limit", [0, 11])):
            for value in values:
                with self.subTest(field=field, value=value), self.assertRaises(ValidationError):
                    fixtures.settings(**{field: value})
        baseline = self.operation().configuration_hash(fixtures.ACCOUNT)
        self.assertEqual(baseline, fixtures.configuration_hash(self.settings))
        for objects, pages in ((1, 1), (100, 10), (21, 5), (20, 6)):
            config = self.settings.model_copy(update={"hubspot_ingestion_object_limit": objects,
                "hubspot_ingestion_page_limit": pages})
            expected = hashlib.sha256(json.dumps({"configuration_hash": baseline,
                "object_limit": objects, "page_limit": pages}, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
            self.assertEqual(self.operation(config).configuration_hash(fixtures.ACCOUNT), expected)

    def test_hundred_objects_ten_pages_are_complete_unique_and_raw(self):
        calls = []
        config = self.settings.model_copy(update={"hubspot_ingestion_object_limit": 100,
            "hubspot_ingestion_page_limit": 10})

        def respond(request):
            calls.append(request)
            self.assertEqual((request.method, request.url.host), ("GET", "api.hubapi.com"))
            if request.url.path.startswith("/account"):
                data = {"portalId": 456}
            elif "/associations/" in request.url.path:
                page = int(request.url.params.get("after", "0"))
                self.assertEqual(request.url.params["limit"], "20")
                data = {"results": [{**fixtures.ASSOCIATION, "toObjectId": i}
                    for i in range(page * 10 + 1, page * 10 + 11)]}
                if page < 9:
                    data["paging"] = {"next": {"after": str(page + 1), "link": "https://untrusted.test/"}}
            else:
                data = {**fixtures.OBJECT, "id": request.url.path.rsplit("/", 1)[1],
                    "properties": {"firstname": "Raw 000", "email": None}}
            return httpx.Response(200, json=data)

        operation = self.operation(config)
        operation.operation.connector.transport = httpx.MockTransport(respond)
        body = IngestionRequest(**{**fixtures.BODY,
            "expected_configuration_hash": operation.configuration_hash(fixtures.ACCOUNT)})
        with self.assertRaises(PolicyDenied):
            operation.start(fixtures.ACCOUNT, IngestionRequest(**fixtures.BODY))
        self.assertEqual(calls, [])
        run = operation.start(fixtures.ACCOUNT, body)
        self.assertEqual((run.status, len(run.objects), run.object_limit, run.page_limit), ("succeeded", 100, 100, 10))
        self.assertEqual(len(calls), 111)
        self.assertEqual(len({item.object_id for item in run.objects}), 100)
        self.assertTrue(all(item.properties == {"firstname": "Raw 000", "email": None} for item in run.objects))
        self.assertEqual(operation.inspect(run.id), run)
        with self.assertRaises(ValidationError):
            IngestionRun.model_validate({**run.model_dump(mode="json"), "object_limit": 99})

    def test_exceeded_page_or_object_bounds_publish_nothing(self):
        for limit, pages, rows in ((1, 2, 2), (2, 1, 1)):
            calls = []
            config = self.settings.model_copy(update={"hubspot_ingestion_object_limit": limit,
                "hubspot_ingestion_page_limit": pages})

            def respond(request, calls=calls, rows=rows):
                calls.append(request)
                if request.url.path.startswith("/account"):
                    return httpx.Response(200, json={"portalId": 456})
                self.assertIn("/associations/", request.url.path)
                return httpx.Response(200, json={"results": [{**fixtures.ASSOCIATION, "toObjectId": i + 1}
                    for i in range(rows)], "paging": {"next": {"after": "next"}}})

            operation = self.operation(config)
            operation.operation.connector.transport = httpx.MockTransport(respond)
            body = IngestionRequest(**{**fixtures.BODY,
                "expected_configuration_hash": operation.configuration_hash(fixtures.ACCOUNT)})
            with patch("vita_api.hubspot_ingestion.datetime") as clock:
                clock.now.side_effect = lambda *_, offset=limit: datetime.now(UTC) + timedelta(minutes=offset)
                result = operation.start(fixtures.ACCOUNT, body)
            self.assertEqual((result.status, result.objects, result.fingerprint), ("failed", [], None))
            self.assertEqual(len(calls), 2)
        with self.assertRaises(HubSpotFailure):
            AssociatedReader(config, httpx.MockTransport(respond)).read("123", "contacts", before_request=lambda: None)

    def test_legacy_defaults_and_retained_limits_survive_configuration_changes(self):
        first = self.operation().start(fixtures.ACCOUNT, IngestionRequest(**fixtures.BODY))
        legacy = first.model_dump(mode="json")
        legacy.pop("object_limit")
        legacy.pop("page_limit")
        with self.app.state.store.engine.begin() as connection:
            connection.execute(update(ingestions).where(ingestions.c.id == str(first.id)).values(payload=legacy))
        config = self.settings.model_copy(update={"hubspot_ingestion_object_limit": 1,
            "hubspot_ingestion_page_limit": 1})
        operation = self.operation(config)
        self.assertEqual((operation.inspect(first.id).object_limit, operation.inspect(first.id).page_limit), (20, 5))
        real = datetime
        body = IngestionRequest(**{**fixtures.BODY,
            "expected_configuration_hash": operation.configuration_hash(fixtures.ACCOUNT)})
        with patch("vita_api.hubspot_ingestion.datetime") as clock:
            clock.now.side_effect = lambda *_: real.now(UTC) + timedelta(seconds=61)
            second = operation.start(fixtures.ACCOUNT, body)
        self.assertEqual((second.status, second.disposition, second.previous_run_id), ("succeeded", "baseline", None))
        self.assertEqual((second.object_limit, second.page_limit), (1, 1))
        self.assertEqual(operation.inspect(first.id), first)
