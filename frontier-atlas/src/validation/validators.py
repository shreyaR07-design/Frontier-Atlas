"""Schema validation, missing-field auditing, and failure preservation."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from typing import Any

from pydantic import ValidationError

from src.schemas import (
    JobRecord,
    NewsRecord,
    ProductRecord,
    ResearchPaperRecord,
    StartupRecord,
)

SCHEMA_BY_CATEGORY = {
    "startups": StartupRecord,
    "products": ProductRecord,
    "research_papers": ResearchPaperRecord,
    "jobs": JobRecord,
    "news": NewsRecord,
}

TRACKED_FIELDS_BY_CATEGORY: dict[str, tuple[str, ...]] = {
    "startups": ("description", "website", "industry", "location", "founding_date"),
    "products": ("description", "website", "category", "company_name"),
    "research_papers": ("abstract", "authors", "publication_date", "doi", "arxiv_id", "github_repository", "github_stars"),
    "jobs": ("location", "employment_type", "description"),
    "news": ("summary", "category"),
}


@dataclass
class ValidationOutcome:
    """Result of validating raw records against Pydantic schemas."""

    category: str
    validated: list[Any] = field(default_factory=list)
    rejected: list[dict[str, Any]] = field(default_factory=list)
    missing_fields: dict[str, int] = field(default_factory=dict)
    source_distribution: dict[str, int] = field(default_factory=dict)


class DatasetValidator:
    """Validates raw collected dictionaries against strict Pydantic dataset models."""

    def validate_batch(self, category: str, raw_records: list[dict[str, Any]]) -> ValidationOutcome:
        if category not in SCHEMA_BY_CATEGORY:
            raise ValueError(f"Unsupported validation category: {category!r}")

        schema_cls = SCHEMA_BY_CATEGORY[category]
        tracked_fields = TRACKED_FIELDS_BY_CATEGORY[category]
        outcome = ValidationOutcome(category=category)
        missing_counter: Counter[str] = Counter()
        source_counter: Counter[str] = Counter()

        for raw in raw_records:
            try:
                model = schema_cls(**raw)
            except (ValidationError, TypeError, ValueError) as exc:
                outcome.rejected.append(
                    {
                        "category": category,
                        "source_url": raw.get("source_url"),
                        "reason": str(exc),
                        "raw": raw,
                    }
                )
                continue

            outcome.validated.append(model)
            src = getattr(model, "source_name", None) or getattr(model, "publisher", "unknown")
            source_counter[src] += 1

            for field_name in tracked_fields:
                val = getattr(model, field_name, None)
                if (
                    val is None
                    or val == ""
                    or val == []
                    or (isinstance(val, str) and val.strip().lower() == "unknown")
                ):
                    missing_counter[field_name] += 1

        outcome.missing_fields = dict(missing_counter)
        outcome.source_distribution = dict(source_counter)
        return outcome
