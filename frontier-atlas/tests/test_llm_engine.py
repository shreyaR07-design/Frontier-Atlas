"""Phase 3 tests: Chunking, JSON parsing, retry behavior, provider routing, and evidence verification."""

from __future__ import annotations

from typing import Any

import pytest

from src.llm.chunking import chunk_text, estimate_tokens
from src.llm.extraction_prompts import verify_extraction_against_source
from src.llm.llm_router import LLMRouter
from src.llm.retry_handler import (
    FatalProviderError,
    MalformedJSONError,
    PayloadTooLargeError,
    RateLimitError,
    parse_json_response,
    run_with_retry,
)


class StubProvider:
    def __init__(
        self,
        name: str,
        configured: bool = True,
        responses: list[Any] | None = None,
    ) -> None:
        self.provider_name = name
        self._configured = configured
        self._responses = list(responses or [])
        self.calls = 0

    def is_configured(self) -> bool:
        return self._configured

    async def generate_json(self, prompt: str, *, system_instruction: str = "") -> dict[str, Any]:
        self.calls += 1
        item = self._responses.pop(0) if self._responses else {"records": []}
        if isinstance(item, Exception):
            raise item
        return item


def test_chunking_respects_token_limits_and_overlap() -> None:
    paragraph = "Frontier AI systems require verifiable entity resolution. " * 25
    full_text = "\n\n".join([paragraph] * 5)
    chunks = chunk_text(full_text, max_tokens=400, overlap_tokens=40)
    assert len(chunks) > 1
    assert all(c.estimated_tokens <= 450 for c in chunks)
    assert estimate_tokens("hello world") >= 1


def test_parse_json_response_handles_fences_and_rejects_garbage() -> None:
    fenced = '```json\n{"records": [{"name": "Aether"}]}\n```'
    assert parse_json_response(fenced) == {"records": [{"name": "Aether"}]}

    with pytest.raises(MalformedJSONError):
        parse_json_response("")

    with pytest.raises(MalformedJSONError):
        parse_json_response("not valid json at all")


@pytest.mark.asyncio
async def test_retry_recovers_from_rate_limit() -> None:
    attempts = {"count": 0}

    async def flaky() -> str:
        attempts["count"] += 1
        if attempts["count"] < 3:
            raise RateLimitError("429")
        return "ok"

    res = await run_with_retry(flaky, max_attempts=3, base_delay=0.01, max_delay=0.02)
    assert res == "ok"
    assert attempts["count"] == 3


@pytest.mark.asyncio
async def test_llm_router_fallback_and_validation() -> None:
    primary = StubProvider("gemini", configured=True, responses=[FatalProviderError("403")])
    fallback = StubProvider(
        "groq",
        configured=True,
        responses=[
            {
                "records": [
                    {
                        "name": "Orbital Labs",
                        "description": "Autonomous satellite telemetry.",
                        "website": "https://orbitallabs.example",
                        "industry": "Aerospace",
                        "location": "Denver, CO",
                        "founding_date": "2024",
                        "evidence": {"name": "Orbital Labs", "location": "Denver, CO"},
                    },
                    {
                        "name": "Invalid Record",
                        "website": "not-a-url",
                    },
                ]
            }
        ],
    )
    router = LLMRouter(providers=[primary, fallback], max_input_tokens=4000)
    source_text = "Orbital Labs is based in Denver, CO building autonomous satellite telemetry."
    res = await router.extract_structured(
        category="startups",
        source_url="https://orbitallabs.example/about",
        source_name="official_site",
        source_text=source_text,
    )
    assert res.provider_used == "groq"
    assert len(res.validated_records) == 1
    assert len(res.failed_records) == 1
    ev = res.validated_records[0]["source_metadata"]["evidence_verification"]
    assert "name" in ev["verified_fields"]
    assert "location" in ev["verified_fields"]


@pytest.mark.asyncio
async def test_llm_router_handles_413_by_subchunking() -> None:
    provider = StubProvider(
        "gemini",
        configured=True,
        responses=[
            PayloadTooLargeError("413"),
            {"records": [{"name": "SubChunk Co", "evidence": {"name": "SubChunk Co"}}]},
            {"records": []},
        ],
    )
    router = LLMRouter(providers=[provider], max_input_tokens=2000)
    text = ("SubChunk Co builds developer observability tools.\n\n" * 120).strip()
    res = await router.extract_structured(
        category="startups",
        source_url="https://subchunk.example",
        source_name="official_site",
        source_text=text,
    )
    assert provider.calls >= 2
    assert len(res.validated_records) == 1


@pytest.mark.asyncio
async def test_llm_router_fails_gracefully_without_keys() -> None:
    router = LLMRouter(providers=[StubProvider("gemini", configured=False)])
    res = await router.extract_structured(
        category="news",
        source_url="https://news.example/1",
        source_name="rss",
        source_text="Some news text.",
    )
    assert res.validated_records == []
    assert any("No LLM provider configured" in e for e in res.errors)


def test_evidence_verification_flags_unverified_claims() -> None:
    check = verify_extraction_against_source(
        {"name": "Acme AI", "evidence": {"name": "Acme AI", "location": "Mars Colony"}},
        "Acme AI builds tools in Austin, TX.",
    )
    assert "name" in check["verified_fields"]
    assert "location" in check["unverified_fields"]
