"""Phase 1 tests: Settings, URL/date utilities, Pydantic schemas, and SQLite repository."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from pydantic import ValidationError

from src.config.settings import Settings
from src.schemas import (
    EntityMappingLog,
    EntityType,
    JobRecord,
    MatchDecision,
    NewsRecord,
    ProductRecord,
    ResearchPaperRecord,
    StartupRecord,
)
from src.storage.database import DatabaseManager
from src.storage.repository import AtlasRepository
from src.utils.date_utils import is_within_freshness_window, parse_utc_datetime
from src.utils.url_utils import extract_domain, extract_github_repo_slug, normalize_url


def test_url_normalization_strips_tracking_and_trailing_slash() -> None:
    raw = "HTTPS://Example.COM:443/blog/post/?utm_source=hn&b=2&a=1#top"
    assert normalize_url(raw) == "https://example.com/blog/post?a=1&b=2"
    assert extract_domain("https://www.OpenAI.com/research") == "openai.com"
    assert extract_github_repo_slug("https://github.com/google/gemini-cli.git") == "google/gemini-cli"


def test_date_parsing_and_freshness() -> None:
    now = datetime(2026, 11, 21, 12, 0, 0, tzinfo=timezone.utc)
    recent = parse_utc_datetime("2026-11-21T06:00:00Z")
    stale = parse_utc_datetime("2026-11-19T12:00:00Z")
    future = now + timedelta(hours=3)

    assert is_within_freshness_window(recent, reference_time=now) == (True, "fresh")
    assert is_within_freshness_window(stale, reference_time=now) == (False, "older_than_24h")
    assert is_within_freshness_window(future, reference_time=now) == (False, "future_publication_date")
    assert is_within_freshness_window(None, reference_time=now) == (False, "missing_published_at")


def test_all_six_schemas_validate_and_generate_deterministic_ids() -> None:
    ts = datetime(2026, 11, 21, 10, 0, 0, tzinfo=timezone.utc)

    startup = StartupRecord(
        name="Anthropic",
        website="https://www.anthropic.com/",
        source_name="yc_directory",
        source_url="https://www.ycombinator.com/companies/anthropic",
        collected_at=ts,
    )
    assert startup.startup_id.startswith("stp_")
    assert startup.website == "https://www.anthropic.com/"

    product = ProductRecord(
        name="Claude",
        company_name="Anthropic",
        website="https://claude.ai/",
        source_name="official_site",
        source_url="https://claude.ai/",
        collected_at=ts,
    )
    assert product.product_id.startswith("prd_")

    paper = ResearchPaperRecord(
        title="Attention Is All You Need",
        authors=["Ashish Vaswani", "Noam Shazeer"],
        doi="https://doi.org/10.48550/arXiv.1706.03762",
        arxiv_id="1706.03762",
        github_repository="https://github.com/tensorflow/tensor2tensor",
        github_stars=15000,
        source_name="arxiv",
        source_url="https://arxiv.org/abs/1706.03762",
        collected_at=ts,
    )
    assert paper.doi == "10.48550/arXiv.1706.03762"
    assert paper.paper_id.startswith("pap_")

    job = JobRecord(
        title="Staff AI Engineer",
        company="Example Labs",
        posted_at=ts,
        application_url="https://example.com/jobs/123?utm_source=board",
        source_name="greenhouse",
        source_url="https://boards-api.greenhouse.io/v1/boards/example/jobs",
        collected_at=ts,
    )
    assert job.application_url == "https://example.com/jobs/123"

    news = NewsRecord(
        headline="Open Model Benchmark Released",
        publisher="Tech Wire",
        published_at=ts,
        article_url="https://news.example.com/article-1/",
        source_url="https://news.example.com/rss.xml",
        collected_at=ts,
    )
    assert news.article_url == "https://news.example.com/article-1"

    mapping = EntityMappingLog(
        raw_name="OpenAI Inc.",
        normalized_name="openai",
        canonical_name="OpenAI",
        canonical_id="ent_1234567890abcdef",
        source_url="https://openai.com",
        match_method="alias_exact",
        confidence=0.98,
        decision=MatchDecision.AUTO_MERGE,
        entity_type=EntityType.COMPANY,
        timestamp=ts,
    )
    assert mapping.mapping_id.startswith("map_")


def test_invalid_urls_rejected_by_schemas() -> None:
    with pytest.raises(ValidationError):
        StartupRecord(
            name="Bad Co",
            source_name="test",
            source_url="not-a-valid-url",
        )


def test_sqlite_repository_upsert_prevents_duplicates(tmp_path: Path) -> None:
    db_file = tmp_path / "test_atlas.db"
    db = DatabaseManager(database_url=f"sqlite:///{db_file}", base_dir=tmp_path)
    db.initialize_schema()
    repo = AtlasRepository(db)

    now = datetime(2026, 11, 21, 10, 0, 0, tzinfo=timezone.utc)
    s1 = StartupRecord(
        name="Alpha Robotics",
        website="https://alpharobotics.example",
        source_name="dir_a",
        source_url="https://dir.example/alpha",
        collected_at=now,
    )
    s1_updated = StartupRecord(
        name="Alpha Robotics",
        website="https://alpharobotics.example",
        industry="Robotics",
        source_name="dir_a",
        source_url="https://dir.example/alpha",
        collected_at=now + timedelta(minutes=5),
    )

    repo.upsert_startups([s1])
    repo.upsert_startups([s1_updated])

    counts = repo.count_records()
    assert counts["startups"] == 1
    rows = repo.fetch_dataset("startups")
    assert rows[0]["industry"] == "Robotics"


def test_settings_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_MODEL", "gemini-4-hydrogen")
    monkeypatch.setenv("MAX_CONCURRENCY", "4")
    settings = Settings.from_env()
    assert settings.gemini_model == "gemini-4-hydrogen"
    assert settings.max_concurrency == 4
