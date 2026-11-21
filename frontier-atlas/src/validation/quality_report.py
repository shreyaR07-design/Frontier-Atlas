"""Data quality report generator covering verification status, rejection counts, and traceability."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Optional

from src.schemas.base import VerificationStatus
from src.utils.date_utils import to_utc_iso, utc_now


@dataclass
class CategoryQualityStats:
    """Per-dataset quality and verification metrics."""

    discovered: int = 0
    extracted: int = 0
    validated: int = 0
    rejected: int = 0
    duplicates: int = 0
    persisted_total: int = 0
    target_minimum: Optional[int] = None
    target_met: Optional[bool] = None
    verification_breakdown: dict[str, int] = field(
        default_factory=lambda: {
            VerificationStatus.VERIFIED.value: 0,
            VerificationStatus.PARTIALLY_VERIFIED.value: 0,
            VerificationStatus.UNVERIFIED.value: 0,
            VerificationStatus.SOURCE_UNAVAILABLE.value: 0,
            VerificationStatus.REJECTED.value: 0,
        }
    )
    missing_fields: dict[str, int] = field(default_factory=dict)
    source_distribution: dict[str, int] = field(default_factory=dict)
    freshness: Optional[dict[str, Any]] = None
    sample_rejection_reasons: list[str] = field(default_factory=list)


@dataclass
class QualityReport:
    """Comprehensive pipeline quality and verification audit report."""

    generated_at_utc: str
    categories: dict[str, CategoryQualityStats] = field(default_factory=dict)
    entity_resolution: dict[str, int] = field(default_factory=dict)
    verification_summary: dict[str, int] = field(default_factory=dict)
    unavailable_sources: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "generated_at_utc": self.generated_at_utc,
            "categories": {k: asdict(v) for k, v in self.categories.items()},
            "entity_resolution": self.entity_resolution,
            "verification_summary": self.verification_summary,
            "unavailable_sources": self.unavailable_sources,
        }

    def write_json(self, output_path: Path) -> Path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(self.to_dict(), indent=2), encoding="utf-8")
        return output_path


class QualityReportGenerator:
    """Builds verifiable QualityReport objects from pipeline stage outputs."""

    def build(
        self,
        *,
        category_stats: dict[str, CategoryQualityStats],
        entity_resolution_stats: dict[str, int],
        unavailable_sources: list[str],
        verification_summary: Optional[dict[str, int]] = None,
    ) -> QualityReport:
        if verification_summary is None:
            totals = {
                VerificationStatus.VERIFIED.value: 0,
                VerificationStatus.PARTIALLY_VERIFIED.value: 0,
                VerificationStatus.UNVERIFIED.value: 0,
                VerificationStatus.SOURCE_UNAVAILABLE.value: 0,
                VerificationStatus.REJECTED.value: 0,
            }
            for cat in category_stats.values():
                for status_key in (
                    VerificationStatus.VERIFIED.value,
                    VerificationStatus.PARTIALLY_VERIFIED.value,
                    VerificationStatus.UNVERIFIED.value,
                    VerificationStatus.SOURCE_UNAVAILABLE.value,
                ):
                    totals[status_key] += int(cat.verification_breakdown.get(status_key, 0))
                totals[VerificationStatus.REJECTED.value] += int(cat.rejected) + int(
                    cat.verification_breakdown.get(VerificationStatus.REJECTED.value, 0)
                )
            verification_summary = totals

        return QualityReport(
            generated_at_utc=to_utc_iso(utc_now()) or "",
            categories=category_stats,
            entity_resolution=entity_resolution_stats,
            verification_summary=verification_summary,
            unavailable_sources=sorted(set(unavailable_sources)),
        )
