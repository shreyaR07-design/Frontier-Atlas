"""Canonical URL, normalized organization name, domain, and identifier deduplication."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, TypeVar

from src.resolver.normalizer import is_specific_company_domain, normalize_entity_name
from src.schemas import (
    JobRecord,
    NewsRecord,
    ProductRecord,
    ResearchPaperRecord,
    StartupRecord,
)
from src.utils.url_utils import extract_domain

T = TypeVar("T", StartupRecord, ProductRecord, ResearchPaperRecord, JobRecord, NewsRecord)


@dataclass
class DeduplicationResult:
    """Result of deduplicating validated Pydantic records."""

    unique_records: list[Any] = field(default_factory=list)
    duplicates: list[dict[str, Any]] = field(default_factory=list)

    @property
    def duplicate_count(self) -> int:
        return len(self.duplicates)


class RecordDeduplicator:
    """Removes duplicate records and organizations using normalized names, domains, and identifiers."""

    @staticmethod
    def _dedup_keys(category: str, record: Any) -> list[str]:
        keys: list[str] = []
        if category == "startups":
            keys.append(f"id:{record.startup_id}")
            norm_name = normalize_entity_name(record.name)
            website = getattr(record, "official_website", None) or record.website
            domain = extract_domain(website) if website else None
            if is_specific_company_domain(domain):
                keys.append(f"org_domain:{domain}")
                if norm_name:
                    keys.append(f"org_site:{norm_name}|{domain}")
            if norm_name:
                keys.append(f"org_name:{norm_name}")
            keys.append(f"src:{(norm_name or record.name.lower())}|{record.source_url}")
        elif category == "products":
            keys.append(f"id:{record.product_id}")
            norm_name = normalize_entity_name(record.name) or record.name.lower()
            norm_company = normalize_entity_name(record.company_name) if record.company_name != "Unknown" else ""
            website = getattr(record, "official_website", None) or record.website
            domain = extract_domain(website) if website else None
            if is_specific_company_domain(domain):
                keys.append(f"prod_site:{norm_name}|{domain}")
            elif website:
                keys.append(f"prod_url:{norm_name}|{website}")
            if norm_company:
                keys.append(f"prod_org:{norm_name}|{norm_company}")
            keys.append(f"src:{norm_name}|{record.source_url}")
        elif category == "research_papers":
            if record.doi:
                keys.append(f"doi:{record.doi.lower()}")
            if record.arxiv_id:
                base_arxiv = record.arxiv_id.split("v")[0].lower()
                keys.append(f"arxiv:{base_arxiv}")
            keys.append(f"url:{record.source_url}")
        elif category == "jobs":
            keys.append(f"app:{record.application_url}")
            norm_company = normalize_entity_name(record.company)
            norm_title = normalize_entity_name(record.title) or record.title.lower()
            if norm_company and norm_company != "unknown":
                keys.append(f"job_org:{norm_company}|{norm_title}|{record.posted_at.date().isoformat()}")
        elif category == "news":
            keys.append(f"art:{record.article_url}")
        else:
            raise ValueError(f"Unsupported deduplication category: {category!r}")
        return keys

    def deduplicate(self, category: str, records: list[T]) -> DeduplicationResult:
        """Deduplicate records in order while preserving detailed duplicate telemetry."""
        seen_keys: set[str] = set()
        result = DeduplicationResult()

        for record in records:
            keys = self._dedup_keys(category, record)
            matched = next((k for k in keys if k in seen_keys), None)
            if matched is not None:
                dup_type = "organization" if matched.startswith("org_") else "record"
                result.duplicates.append(
                    {
                        "category": category,
                        "duplicate_type": dup_type,
                        "matched_key": matched,
                        "source_url": record.source_url,
                    }
                )
                continue
            seen_keys.update(keys)
            result.unique_records.append(record)

        return result
