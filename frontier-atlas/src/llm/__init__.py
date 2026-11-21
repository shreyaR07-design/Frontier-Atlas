"""LLM extraction, chunking, retry, and provider routing package."""

from src.llm.chunking import TextChunk, chunk_text, estimate_tokens
from src.llm.gemini_client import GeminiClient
from src.llm.llm_router import ExtractionResult, LLMProvider, LLMRouter, OpenAICompatibleProvider
from src.llm.retry_handler import (
    FatalProviderError,
    LLMError,
    MalformedJSONError,
    PayloadTooLargeError,
    RateLimitError,
    TransientProviderError,
    parse_json_response,
)

__all__ = [
    "ExtractionResult",
    "FatalProviderError",
    "GeminiClient",
    "LLMError",
    "LLMProvider",
    "LLMRouter",
    "MalformedJSONError",
    "OpenAICompatibleProvider",
    "PayloadTooLargeError",
    "RateLimitError",
    "TextChunk",
    "TransientProviderError",
    "chunk_text",
    "estimate_tokens",
    "parse_json_response",
]
