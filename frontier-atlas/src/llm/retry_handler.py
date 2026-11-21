"""Controlled retry, JSON parsing, and error classification for LLM providers."""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any, Awaitable, Callable, TypeVar

from src.utils.logging_config import get_logger

logger = get_logger("llm.retry")
T = TypeVar("T")

CODE_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL | re.IGNORECASE)


class LLMError(RuntimeError):
    """Base error for LLM orchestration."""


class RateLimitError(LLMError):
    """HTTP 429 / RESOURCE_EXHAUSTED."""


class PayloadTooLargeError(LLMError):
    """HTTP 413 / token context length exceeded."""


class TransientProviderError(LLMError):
    """HTTP 5xx or transient network issue."""


class MalformedJSONError(LLMError):
    """Provider returned empty or unparseable JSON."""


class FatalProviderError(LLMError):
    """Non-retryable configuration or authentication error (e.g., 401/403/missing key)."""


def parse_json_response(raw_text: str | None) -> Any:
    """Parse JSON safely from LLM text, stripping optional markdown code fences."""
    if raw_text is None or not raw_text.strip():
        raise MalformedJSONError("LLM returned empty response")

    candidate = raw_text.strip()
    fence_match = CODE_FENCE_RE.search(candidate)
    if fence_match:
        candidate = fence_match.group(1).strip()

    try:
        return json.loads(candidate)
    except json.JSONDecodeError:
        # Attempt recovery when leading/trailing prose wraps a JSON object or array
        obj_start = candidate.find("{")
        arr_start = candidate.find("[")
        starts = [idx for idx in (obj_start, arr_start) if idx != -1]
        if starts:
            start = min(starts)
            end_char = "}" if candidate[start] == "{" else "]"
            end = candidate.rfind(end_char)
            if end > start:
                try:
                    return json.loads(candidate[start : end + 1])
                except json.JSONDecodeError as exc:
                    raise MalformedJSONError(f"Malformed JSON payload: {exc}") from exc
        raise MalformedJSONError("Malformed JSON payload: unable to locate valid JSON structure")


async def run_with_retry(
    operation: Callable[[], Awaitable[T]],
    *,
    max_attempts: int = 3,
    base_delay: float = 1.0,
    max_delay: float = 16.0,
    provider_name: str = "llm",
) -> T:
    """Execute an async LLM call with exponential backoff on transient/rate-limit errors."""
    last_error: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            return await operation()
        except (FatalProviderError, PayloadTooLargeError):
            raise
        except (RateLimitError, TransientProviderError, MalformedJSONError, asyncio.TimeoutError) as exc:
            last_error = exc
            if attempt == max_attempts:
                break
            delay = min(max_delay, base_delay * (2 ** (attempt - 1)))
            logger.warning(
                "Retrying LLM operation",
                extra={
                    "ctx": {
                        "provider": provider_name,
                        "attempt": attempt,
                        "max_attempts": max_attempts,
                        "delay_seconds": delay,
                        "error": str(exc),
                    }
                },
            )
            await asyncio.sleep(delay)
    assert last_error is not None
    raise last_error
