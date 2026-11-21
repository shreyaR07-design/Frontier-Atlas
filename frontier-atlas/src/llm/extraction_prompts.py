"""Prompt templates and source-evidence verification for structured extraction."""

from __future__ import annotations

import re
from typing import Any

SYSTEM_INSTRUCTION = (
    "You are a precision data extraction engine for FrontierAtlas. "
    "Return ONLY valid JSON matching the requested schema. "
    "NEVER fabricate facts, URLs, dates, star counts, or company attributes. "
    "NEVER assume a company's headquarters from a factory, manufacturing plant, warehouse, or branch office location. "
    "If any field is missing or uncertain in the provided source text, output null. "
    "For key extracted fields, include verbatim short excerpts from the source text in the 'evidence' object."
)

CATEGORY_SCHEMAS: dict[str, str] = {
    "startups": (
        '{"records": [{"name": str, "description": str|null, "website": str|null, '
        '"industry": str|null, "location": str|null, "founding_date": str|null, '
        '"evidence": {"name": str, "description": str|null, "location": str|null}}]}'
    ),
    "products": (
        '{"records": [{"name": str, "description": str|null, "website": str|null, '
        '"category": str|null, "company_name": str|null, '
        '"evidence": {"name": str, "company_name": str|null}}]}'
    ),
    "research_papers": (
        '{"records": [{"title": str, "abstract": str|null, "authors": [str], '
        '"publication_date": str|null, "doi": str|null, "arxiv_id": str|null, '
        '"github_repository": str|null, "evidence": {"title": str, "github_repository": str|null}}]}'
    ),
    "jobs": (
        '{"records": [{"title": str, "company": str, "location": str|null, '
        '"employment_type": str|null, "description": str|null, "posted_at": str|null, '
        '"application_url": str|null, "evidence": {"title": str, "posted_at": str|null}}]}'
    ),
    "news": (
        '{"records": [{"headline": str, "summary": str|null, "publisher": str|null, '
        '"published_at": str|null, "article_url": str|null, "category": str|null, '
        '"evidence": {"headline": str, "published_at": str|null}}]}'
    ),
}

WS_RE = re.compile(r"\s+")


def build_extraction_prompt(category: str, source_url: str, text_chunk: str) -> str:
    """Build a strict JSON extraction prompt for a given FrontierAtlas category."""
    if category not in CATEGORY_SCHEMAS:
        raise ValueError(f"Unsupported extraction category: {category!r}")
    schema_hint = CATEGORY_SCHEMAS[category]
    return (
        f"Category: {category}\n"
        f"Source URL: {source_url}\n"
        f"Expected JSON structure:\n{schema_hint}\n\n"
        "Rules:\n"
        "1. Output ONLY valid JSON.\n"
        "2. Use null for any missing or uncertain field — never guess or invent values.\n"
        "3. Do NOT assume a company's headquarters from a factory, plant, warehouse, or branch office.\n"
        "4. Populate 'evidence' with short verbatim substrings copied from Source Text.\n\n"
        f"Source Text:\n{text_chunk}"
    )


def verify_extraction_against_source(record: dict[str, Any], source_text: str) -> dict[str, Any]:
    """Verify claimed evidence excerpts and key fields against the original source text."""
    normalized_source = WS_RE.sub(" ", (source_text or "")).lower()
    evidence = record.get("evidence") or {}
    verified_fields: list[str] = []
    unverified_fields: list[str] = []

    if isinstance(evidence, dict):
        for field_name, quote in evidence.items():
            if not quote:
                continue
            norm_quote = WS_RE.sub(" ", str(quote)).strip().lower()
            if norm_quote and norm_quote in normalized_source:
                verified_fields.append(field_name)
            else:
                unverified_fields.append(field_name)

    # Also verify primary title/name exists in source when evidence omitted
    for primary_key in ("name", "title", "headline"):
        val = record.get(primary_key)
        if val and primary_key not in verified_fields and primary_key not in unverified_fields:
            norm_val = WS_RE.sub(" ", str(val)).strip().lower()
            if norm_val and norm_val in normalized_source:
                verified_fields.append(primary_key)
            else:
                unverified_fields.append(primary_key)

    return {
        "verified_fields": verified_fields,
        "unverified_fields": unverified_fields,
        "evidence": evidence if isinstance(evidence, dict) else {},
    }
