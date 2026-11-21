"""Phase 5 tests: Freshness filtering, deduplication, schema validation, and quality report."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

from src.schemas import NewsRecord, ResearchPaperRecord
from src.validation import (
    CategoryQualityStats,
    DatasetValidator,
    FreshnessFilter,
    QualityReportGenerator,
    RecordDeduplicator,
)


def test_freshness_filter_rejects_old_missing_and_future_dates() -> None:
    ref = datetime(2026, 11, 21, 12, 0, 0, tzinfo=timezone.utc)
    records = [
        {"headline": "Fresh News", "published_at": ref - timedelta(hours=4)},
        {"headline": "Old News", "published_at": ref - timedelta(hours=30)},
        {"headline": "Missing Date"},
        {"headline": "Future Date", "published_at": ref + timedelta(hours=2)},
    ]
    outcome = FreshnessFilter(window_hours=24).filter_records("news", records, reference_time=ref)
    assert len(outcome.accepted) == 1
    assert outcome.accepted[0]["headline"] == "Fresh News"
    assert outcome.stats.rejected_older == 1
    assert outcome.stats.rejected_missing_date == 1
    assert outcome.stats.rejected_future_date == 1


def test_deduplicator_catches_doi_arxiv_and_canonical_url_duplicates() -> None:
    ts = datetime(2026, 11, 21, 10, 0, 0, tzinfo=timezone.utc)
    p1 = ResearchPaperRecord(
        title="Paper One",
        doi="10.1000/xyz",
        source_name="openalex",
        source_url="https://openalex.org/W1",
        collected_at=ts,
    )
    p2 = ResearchPaperRecord(
        title="Paper One Duplicate via Crossref",
        doi="https://doi.org/10.1000/xyz",
        source_name="crossref",
        source_url="https://crossref.org/W1",
        collected_at=ts,
    )
    res = RecordDeduplicator().deduplicate("research_papers", [p1, p2])
    assert len(res.unique_records) == 1
    assert res.duplicate_count == 1

    n1 = NewsRecord(
        headline="Article",
        publisher="Wire",
        published_at=ts,
        article_url="https://news.example/post?utm_source=x",
        source_url="https://news.example/rss",
        collected_at=ts,
    )
    n2 = NewsRecord(
        headline="Article",
        publisher="Wire",
        published_at=ts,
        article_url="https://news.example/post/",
        source_url="https://news.example/rss",
        collected_at=ts,
    )
    news_res = RecordDeduplicator().deduplicate("news", [n1, n2])
    assert len(news_res.unique_records) == 1
    assert news_res.duplicate_count == 1


def test_dataset_validator_and_quality_report(tmp_path: Path) -> None:
    raw_startups = [
        {
            "name": "Valid Startup",
            "website": "https://valid.example",
            "source_name": "yc",
            "source_url": "https://yc.example/valid",
        },
        {
            "name": "Invalid Startup",
            "source_name": "yc",
            "source_url": "bad-url",
        },
    ]
    val_out = DatasetValidator().validate_batch("startups", raw_startups)
    assert len(val_out.validated) == 1
    assert len(val_out.rejected) == 1
    assert val_out.missing_fields["description"] == 1

    report = QualityReportGenerator().build(
        category_stats={
            "startups": CategoryQualityStats(
                discovered=2,
                extracted=2,
                validated=1,
                rejected=1,
                duplicates=0,
                persisted_total=1,
                target_minimum=1000,
                target_met=False,
                missing_fields=val_out.missing_fields,
                source_distribution=val_out.source_distribution,
            )
        },
        entity_resolution_stats={"total_logged": 1, "new_entity": 1},
        unavailable_sources=[],
    )
    out_file = report.write_json(tmp_path / "quality_report.json")
    assert out_file.exists()
    assert report.to_dict()["categories"]["startups"]["target_met"] is False
