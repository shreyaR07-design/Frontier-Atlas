"""LLM provider router with Gemini primary, optional fallbacks, chunk splitting, and Pydantic validation."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, Protocol

import httpx
from pydantic import ValidationError

from src.config.settings import Settings
from src.llm.chunking import chunk_text
from src.llm.extraction_prompts import (
    SYSTEM_INSTRUCTION,
    build_extraction_prompt,
    verify_extraction_against_source,
)
from src.llm.gemini_client import GeminiClient
from src.llm.retry_handler import (
    FatalProviderError,
    LLMError,
    MalformedJSONError,
    PayloadTooLargeError,
    RateLimitError,
    TransientProviderError,
    parse_json_response,
    run_with_retry,
)
from src.schemas import (
    JobRecord,
    NewsRecord,
    ProductRecord,
    ResearchPaperRecord,
    StartupRecord,
)
from src.utils.logging_config import get_logger

logger = get_logger("llm.router")

CATEGORY_MODEL_MAP = {
    "startups": StartupRecord,
    "products": ProductRecord,
    "research_papers": ResearchPaperRecord,
    "jobs": JobRecord,
    "news": NewsRecord,
}


class LLMProvider(Protocol):
    """Provider interface for JSON structured generation."""

    provider_name: str

    def is_configured(self) -> bool: ...

    async def generate_json(
        self, prompt: str, *, system_instruction: str = SYSTEM_INSTRUCTION
    ) -> dict[str, Any]: ...


class OpenAICompatibleProvider:
    """Optional fallback provider for Groq or DeepSeek REST APIs when configured."""

    def __init__(
        self,
        *,
        provider_name: str,
        api_key: Optional[str],
        model: str,
        endpoint_url: str,
        timeout_seconds: int = 30,
    ) -> None:
        self.provider_name = provider_name
        self.api_key = api_key
        self.model = model
        self.endpoint_url = endpoint_url
        self.timeout_seconds = timeout_seconds

    def is_configured(self) -> bool:
        return bool(self.api_key and self.api_key.strip())

    async def generate_json(
        self,
        prompt: str,
        *,
        system_instruction: str = SYSTEM_INSTRUCTION,
    ) -> dict[str, Any]:
        if not self.is_configured():
            raise FatalProviderError(f"{self.provider_name} API key is not configured")

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system_instruction},
                {"role": "user", "content": prompt},
            ],
            "response_format": {"type": "json_object"},
            "temperature": 0.0,
        }

        async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
            try:
                resp = await client.post(self.endpoint_url, headers=headers, json=payload)
            except httpx.TimeoutException as exc:
                raise TransientProviderError(f"{self.provider_name} timeout") from exc
            except httpx.HTTPError as exc:
                raise TransientProviderError(f"{self.provider_name} HTTP error: {exc}") from exc

        if resp.status_code in {401, 403}:
            raise FatalProviderError(f"{self.provider_name} auth error: HTTP {resp.status_code}")
        if resp.status_code == 413:
            raise PayloadTooLargeError(f"{self.provider_name} payload too large (413)")
        if resp.status_code == 429:
            raise RateLimitError(f"{self.provider_name} rate limit (429)")
        if resp.status_code >= 500:
            raise TransientProviderError(f"{self.provider_name} server error: HTTP {resp.status_code}")
        if resp.status_code >= 400:
            raise FatalProviderError(f"{self.provider_name} client error HTTP {resp.status_code}: {resp.text[:300]}")

        data = resp.json()
        choices = data.get("choices") or []
        if not choices:
            raise MalformedJSONError(f"{self.provider_name} returned no choices")
        content = (choices[0].get("message") or {}).get("content")
        parsed = parse_json_response(content)
        if not isinstance(parsed, dict):
            raise MalformedJSONError(f"{self.provider_name} returned non-object JSON")
        return parsed


@dataclass
class ExtractionResult:
    """Result of running LLM extraction + validation on source text."""

    category: str
    source_url: str
    validated_records: list[dict[str, Any]] = field(default_factory=list)
    failed_records: list[dict[str, Any]] = field(default_factory=list)
    provider_used: Optional[str] = None
    errors: list[str] = field(default_factory=list)


class LLMRouter:
    """Routes extraction requests to Gemini primary and optional configured fallbacks."""

    def __init__(
        self,
        providers: list[LLMProvider],
        *,
        max_input_tokens: int = 8000,
        overlap_tokens: int = 200,
    ) -> None:
        self.providers = providers
        self.max_input_tokens = max_input_tokens
        self.overlap_tokens = overlap_tokens

    @classmethod
    def from_settings(cls, settings: Settings) -> "LLMRouter":
        providers: list[LLMProvider] = [GeminiClient.from_settings(settings)]
        if settings.groq_api_key:
            providers.append(
                OpenAICompatibleProvider(
                    provider_name="groq",
                    api_key=settings.groq_api_key,
                    model=settings.groq_model,
                    endpoint_url="https://api.groq.com/openai/v1/chat/completions",
                    timeout_seconds=max(20, settings.request_timeout_seconds),
                )
            )
        if settings.llama3_api_key:
            providers.append(
                OpenAICompatibleProvider(
                    provider_name="llama3",
                    api_key=settings.llama3_api_key,
                    model=settings.llama3_model,
                    endpoint_url=settings.llama3_endpoint_url,
                    timeout_seconds=max(20, settings.request_timeout_seconds),
                )
            )
        if settings.deepseek_api_key:
            providers.append(
                OpenAICompatibleProvider(
                    provider_name="deepseek",
                    api_key=settings.deepseek_api_key,
                    model=settings.deepseek_model,
                    endpoint_url="https://api.deepseek.com/v1/chat/completions",
                    timeout_seconds=max(20, settings.request_timeout_seconds),
                )
            )
        return cls(
            providers=providers,
            max_input_tokens=settings.llm_max_input_tokens,
            overlap_tokens=settings.llm_chunk_overlap_tokens,
        )

    def configured_provider_names(self) -> list[str]:
        return [p.provider_name for p in self.providers if p.is_configured()]

    async def _call_providers(self, prompt: str) -> tuple[dict[str, Any], str]:
        configured = [p for p in self.providers if p.is_configured()]
        if not configured:
            raise FatalProviderError(
                "No LLM provider configured (set GEMINI_API_KEY, GROQ_API_KEY, LLAMA3_API_KEY, or DEEPSEEK_API_KEY)."
            )

        errors: list[str] = []
        for provider in configured:
            try:
                payload = await run_with_retry(
                    lambda p=provider: p.generate_json(prompt),
                    max_attempts=3,
                    provider_name=provider.provider_name,
                )
                return payload, provider.provider_name
            except PayloadTooLargeError:
                raise
            except LLMError as exc:
                errors.append(f"{provider.provider_name}: {exc}")
                logger.warning(
                    "LLM provider failed; evaluating next configured provider",
                    extra={"ctx": {"provider": provider.provider_name, "error": str(exc)}},
                )
        raise LLMError("All configured LLM providers failed: " + "; ".join(errors))

    async def _extract_chunk_recursive(
        self,
        *,
        category: str,
        source_url: str,
        text: str,
        token_budget: int,
        chunk_label: str,
        depth: int = 0,
    ) -> tuple[list[dict[str, Any]], Optional[str], list[str]]:
        prompt = build_extraction_prompt(category, source_url, text)
        try:
            payload, provider_used = await self._call_providers(prompt)
            recs = payload.get("records")
            if isinstance(recs, list):
                return [r for r in recs if isinstance(r, dict)], provider_used, []
            return [], provider_used, [f"{chunk_label}: missing 'records' list in response"]
        except PayloadTooLargeError as exc:
            if depth >= 3 or token_budget <= 600:
                return [], None, [f"{chunk_label}: {exc}"]
            next_budget = max(600, token_budget // 2)
            sub_chunks = chunk_text(
                text,
                max_tokens=next_budget,
                overlap_tokens=min(100, self.overlap_tokens),
            )
            merged: list[dict[str, Any]] = []
            errs: list[str] = []
            last_provider: Optional[str] = None
            for sub in sub_chunks:
                sub_recs, sub_prov, sub_errs = await self._extract_chunk_recursive(
                    category=category,
                    source_url=source_url,
                    text=sub.text,
                    token_budget=next_budget,
                    chunk_label=f"{chunk_label}_{sub.index}",
                    depth=depth + 1,
                )
                merged.extend(sub_recs)
                errs.extend(sub_errs)
                if sub_prov:
                    last_provider = sub_prov
            return merged, last_provider, errs
        except LLMError as exc:
            return [], None, [f"{chunk_label}: {exc}"]

    async def extract_structured(
        self,
        *,
        category: str,
        source_url: str,
        source_name: str,
        source_text: str,
    ) -> ExtractionResult:
        """Chunk source text, call LLM router, verify evidence, and validate with Pydantic."""
        result = ExtractionResult(category=category, source_url=source_url)
        if category not in CATEGORY_MODEL_MAP:
            result.errors.append(f"Unsupported category: {category}")
            return result

        if not source_text or not source_text.strip():
            result.errors.append("Empty source text")
            return result

        token_budget = self.max_input_tokens
        chunks = chunk_text(
            source_text,
            max_tokens=token_budget,
            overlap_tokens=self.overlap_tokens,
        )

        # Retry with recursive sub-chunks if provider returns 413 PayloadTooLargeError
        raw_extracted: list[dict[str, Any]] = []
        for chunk in chunks:
            recs, provider_used, chunk_errs = await self._extract_chunk_recursive(
                category=category,
                source_url=source_url,
                text=chunk.text,
                token_budget=token_budget,
                chunk_label=f"chunk_{chunk.index}",
            )
            if provider_used:
                result.provider_used = provider_used
            raw_extracted.extend(recs)
            result.errors.extend(chunk_errs)

        schema_cls = CATEGORY_MODEL_MAP[category]
        for raw_rec in raw_extracted:
            verification = verify_extraction_against_source(raw_rec, source_text)
            candidate = dict(raw_rec)
            candidate.pop("evidence", None)
            candidate.setdefault("source_url", source_url)
            candidate.setdefault("source_name", source_name)
            # Never mark a record as Verified solely because an LLM generated or accepted it
            candidate["verification_status"] = "Unverified"
            candidate["supported_fields"] = []
            meta = dict(candidate.get("source_metadata") or {})
            meta["llm_provider"] = result.provider_used
            meta["evidence_verification"] = verification
            candidate["source_metadata"] = meta

            try:
                model = schema_cls(**candidate)
                result.validated_records.append(model.model_dump())
            except ValidationError as exc:
                result.failed_records.append({"raw": raw_rec, "error": str(exc)})

        return result
