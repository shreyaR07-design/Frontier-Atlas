"""Google Gemini extraction client using the official google-genai Python SDK."""

from __future__ import annotations

import asyncio
from typing import Any, Optional

from src.config.settings import Settings
from src.llm.extraction_prompts import SYSTEM_INSTRUCTION
from src.llm.retry_handler import (
    FatalProviderError,
    MalformedJSONError,
    PayloadTooLargeError,
    RateLimitError,
    TransientProviderError,
    parse_json_response,
)
from src.utils.logging_config import get_logger

logger = get_logger("llm.gemini")


class GeminiClient:
    """Reusable async wrapper around the official google-genai Python SDK."""

    provider_name = "gemini"

    def __init__(
        self,
        api_key: Optional[str],
        model: str = "gemini-4-hydrogen",
        timeout_seconds: int = 30,
    ) -> None:
        self.api_key = api_key
        self.model = model
        self.timeout_seconds = timeout_seconds
        self._client: Any = None

    @classmethod
    def from_settings(cls, settings: Settings) -> "GeminiClient":
        return cls(
            api_key=settings.gemini_api_key,
            model=settings.gemini_model,
            timeout_seconds=max(20, settings.request_timeout_seconds),
        )

    def is_configured(self) -> bool:
        return bool(self.api_key and self.api_key.strip())

    def _get_client(self) -> Any:
        if not self.is_configured():
            raise FatalProviderError("GEMINI_API_KEY is not configured")
        if self._client is None:
            from google import genai

            self._client = genai.Client(api_key=self.api_key)
        return self._client

    def _classify_sdk_exception(self, exc: Exception) -> Exception:
        message = str(exc)
        lower = message.lower()
        status_code = getattr(exc, "code", None) or getattr(exc, "status_code", None)

        if status_code in {401, 403} or "api_key_invalid" in lower or "permission_denied" in lower:
            return FatalProviderError(f"Gemini authentication/permission error: {message}")
        if status_code == 413 or "too large" in lower or "token" in lower and "limit" in lower:
            return PayloadTooLargeError(f"Gemini payload too large (413): {message}")
        if status_code == 429 or "resource_exhausted" in lower or "429" in lower or "rate limit" in lower:
            return RateLimitError(f"Gemini rate limit (429): {message}")
        if status_code in {500, 502, 503, 504} or "unavailable" in lower or "timeout" in lower:
            return TransientProviderError(f"Gemini transient server error: {message}")
        return TransientProviderError(f"Gemini SDK error: {message}")

    def _sync_generate(self, prompt: str, system_instruction: str) -> str:
        from google.genai import types

        client = self._get_client()
        config = types.GenerateContentConfig(
            system_instruction=system_instruction,
            response_mime_type="application/json",
        )
        response = client.models.generate_content(
            model=self.model,
            contents=prompt,
            config=config,
        )
        return getattr(response, "text", None) or ""

    async def generate_json(
        self,
        prompt: str,
        *,
        system_instruction: str = SYSTEM_INSTRUCTION,
    ) -> dict[str, Any]:
        """Generate and parse JSON output from Gemini."""
        if not self.is_configured():
            raise FatalProviderError("GEMINI_API_KEY is not configured")

        try:
            raw_text = await asyncio.wait_for(
                asyncio.to_thread(self._sync_generate, prompt, system_instruction),
                timeout=self.timeout_seconds,
            )
        except FatalProviderError:
            raise
        except asyncio.TimeoutError as exc:
            raise TransientProviderError("Gemini request timed out") from exc
        except Exception as exc:
            raise self._classify_sdk_exception(exc) from exc

        parsed = parse_json_response(raw_text)
        if not isinstance(parsed, dict):
            raise MalformedJSONError("Expected top-level JSON object from Gemini")
        return parsed
