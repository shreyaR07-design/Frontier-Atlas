"""Validation, source verification, freshness, deduplication, and quality reporting package."""

from src.validation.deduplication import DeduplicationResult, RecordDeduplicator
from src.validation.freshness import FreshnessFilter, FreshnessOutcome, FreshnessStats
from src.validation.quality_report import CategoryQualityStats, QualityReport, QualityReportGenerator
from src.validation.source_verifier import (
    SourceVerifier,
    VerificationSummary,
    assess_location_evidence,
    text_supports_claim,
)
from src.validation.validators import DatasetValidator, ValidationOutcome

__all__ = [
    "CategoryQualityStats",
    "DatasetValidator",
    "DeduplicationResult",
    "FreshnessFilter",
    "FreshnessOutcome",
    "FreshnessStats",
    "QualityReport",
    "QualityReportGenerator",
    "RecordDeduplicator",
    "SourceVerifier",
    "ValidationOutcome",
    "VerificationSummary",
    "assess_location_evidence",
    "text_supports_claim",
]
