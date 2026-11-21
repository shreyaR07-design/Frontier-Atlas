"""Phase 7 end-to-end tests (mocked full pipeline + opt-in live test)."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest

from src.config.settings import Settings
from src.crawler.async_crawler import AsyncCrawler, FetchResult
from src.pipeline.orchestrator import PipelineOrchestrator
from src.utils.date_utils import to_utc_iso


@dataclass
class E2EFakeCrawler:
    responses: dict[str, FetchResult]

    async def fetch(self, url: str, **kwargs: Any) -> FetchResult:
        for key, res in self.responses.items():
            if key in url:
                return res
        return FetchResult(url=url, status=404, ok=False, error="http_404")


@pytest.mark.asyncio
async def test_full_pipeline_orchestrator_end_to_end_mocked(tmp_path: Path) -> None:
    now = datetime.now(timezone.utc)
    recent_iso = to_utc_iso(now - timedelta(hours=2))
    stale_iso = to_utc_iso(now - timedelta(hours=40))

    yc_json = json.dumps(
        [
            {
                "name": "Nebula Compute",
                "one_liner": "Distributed inference runtime.",
                "website": "https://nebulacompute.example",
                "industry": "AI",
                "all_locations": "New York, NY",
                "slug": "nebula-compute",
            }
        ]
    )
    gh_search_json = json.dumps(
        {
            "items": [
                {
                    "name": "nebula-engine",
                    "description": "Fast inference engine",
                    "homepage": "https://nebulacompute.example",
                    "html_url": "https://github.com/nebula-compute/nebula-engine",
                    "topics": ["inference"],
                    "owner": {"login": "Nebula Compute Inc."},
                    "stargazers_count": 512,
                }
            ]
        }
    )
    arxiv_xml = """<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <id>http://arxiv.org/abs/2611.99999v1</id>
        <published>2026-11-21T01:00:00Z</published>
        <title>Fast Speculative Decoding</title>
        <summary>Implementation at https://github.com/nebula-compute/spec-decode.</summary>
        <author><name>Grace Hopper</name></author>
      </entry>
    </feed>
    """
    remotive_json = json.dumps(
        {
            "jobs": [
                {
                    "id": 101,
                    "title": "Systems Engineer",
                    "company_name": "Nebula Compute LLC",
                    "candidate_required_location": "Remote",
                    "job_type": "full_time",
                    "description": "<p>Low latency serving.</p>",
                    "publication_date": recent_iso,
                    "url": "https://remotive.com/jobs/101",
                },
                {
                    "id": 102,
                    "title": "Stale Role",
                    "company_name": "Old Co",
                    "publication_date": stale_iso,
                    "url": "https://remotive.com/jobs/102",
                },
            ]
        }
    )
    hn_news_json = json.dumps(
        {
            "hits": [
                {
                    "title": "Nebula Compute Open Sources Runtime",
                    "url": "https://nebulacompute.example/blog/open-source",
                    "created_at": recent_iso,
                    "objectID": "999",
                },
                {
                    "title": "Old Story",
                    "url": "https://old.example/story",
                    "created_at": stale_iso,
                    "objectID": "998",
                },
            ]
        }
    )

    crawler = E2EFakeCrawler(
        responses={
            "yc-oss.github.io": FetchResult(url="https://yc-oss.github.io/api/companies/all.json", status=200, content=yc_json, ok=True),
            "api.github.com/search/repositories": FetchResult(url="https://api.github.com/search/repositories", status=200, content=gh_search_json, ok=True),
            "export.arxiv.org": FetchResult(url="https://export.arxiv.org/api/query", status=200, content=arxiv_xml, ok=True),
            "api.github.com/repos/nebula-compute/spec-decode": FetchResult(
                url="https://api.github.com/repos/nebula-compute/spec-decode",
                status=200,
                content=json.dumps({"stargazers_count": 77}),
                ok=True,
            ),
            "remotive.com": FetchResult(url="https://remotive.com/api/remote-jobs", status=200, content=remotive_json, ok=True),
            "hn.algolia.com/api/v1/search_by_date?tags=story": FetchResult(
                url="https://hn.algolia.com/api/v1/search_by_date?tags=story",
                status=200,
                content=hn_news_json,
                ok=True,
            ),
        }
    )

    settings = Settings(
        base_dir=tmp_path,
        database_url=f"sqlite:///{tmp_path / 'data' / 'atlas.db'}",
    )
    orchestrator = PipelineOrchestrator(settings, crawler=crawler)  # type: ignore[arg-type]
    summary, report = await orchestrator.run(limit_per_category=10, export_csv=True, export_sheets=False)

    assert summary.database_counts["startups"] == 1
    assert summary.database_counts["products"] == 1
    assert summary.database_counts["research_papers"] == 1
    assert summary.database_counts["jobs"] == 1
    assert summary.database_counts["news"] == 1
    assert summary.database_counts["entity_mapping_log"] >= 3
    assert summary.quality_report_path is not None and summary.quality_report_path.exists()
    assert summary.csv_export_dir is not None and (summary.csv_export_dir / "jobs.csv").exists()
    assert report.categories["jobs"].freshness["rejected_older"] == 1
    assert report.categories["news"].freshness["rejected_older"] == 1


@pytest.mark.live
@pytest.mark.asyncio
async def test_live_public_collection_when_enabled(tmp_path: Path) -> None:
    if os.getenv("ENABLE_LIVE_TESTS", "false").lower() != "true":
        pytest.skip("Set ENABLE_LIVE_TESTS=true to run live public API integration test.")

    settings = Settings(
        base_dir=tmp_path,
        database_url=f"sqlite:///{tmp_path / 'data' / 'live.db'}",
    )
    async with AsyncCrawler.from_settings(settings) as crawler:
        orchestrator = PipelineOrchestrator(settings, crawler=crawler)
        summary, _ = await orchestrator.run(
            categories=("research_papers", "news"),
            limit_per_category=5,
            export_csv=True,
            export_sheets=False,
        )
        assert summary.database_counts["research_papers"] >= 1
