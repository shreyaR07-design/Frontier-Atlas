"""Phase 2 tests: AsyncCrawler, ContentExtractor, RobotsPolicyManager, and all 5 collectors."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import pytest

from src.collectors import (
    JobCollector,
    NewsCollector,
    ProductCollector,
    ResearchCollector,
    StartupCollector,
)
from src.collectors.news_collector import RSSSource
from src.config.settings import Settings
from src.crawler.async_crawler import AsyncCrawler, FetchResult
from src.crawler.content_extractor import ContentExtractor


@dataclass
class FakeCrawler:
    """Deterministic fake crawler returning pre-registered responses by URL substring."""

    responses: dict[str, FetchResult]

    async def fetch(self, url: str, **kwargs: Any) -> FetchResult:
        for key, res in self.responses.items():
            if key in url:
                return res
        return FetchResult(url=url, status=404, ok=False, error="http_404")


def test_content_extractor_parses_html_and_github_links() -> None:
    html = """
    <html>
      <head>
        <title>Frontier AI Lab</title>
        <meta name="description" content="Building verifiable AI systems." />
        <link rel="canonical" href="https://frontier.example/about" />
        <script>console.log("ignore me");</script>
      </head>
      <body>
        <h1>Welcome</h1>
        <p>Check our code at <a href="https://github.com/frontier-org/atlas-core.git">GitHub</a>.</p>
      </body>
    </html>
    """
    page = ContentExtractor().extract(html, "https://frontier.example/about?utm_source=x")
    assert page.title == "Frontier AI Lab"
    assert page.description == "Building verifiable AI systems."
    assert page.canonical_url == "https://frontier.example/about"
    assert "ignore me" not in page.text
    assert page.github_links == ["https://github.com/frontier-org/atlas-core"]


@pytest.mark.asyncio
async def test_async_crawler_deduplication_and_invalid_url() -> None:
    async with AsyncCrawler(respect_robots_txt=False) as crawler:
        bad = await crawler.fetch("ftp://invalid.example/file")
        assert not bad.ok
        assert bad.error == "invalid_url"

        # Pre-seed seen URLs to verify deduplication without network IO
        crawler._seen_urls.add("https://example.com/already-seen")
        dup = await crawler.fetch("https://example.com/already-seen")
        assert dup.skipped_duplicate is True
        assert dup.error == "duplicate_url"


@pytest.mark.asyncio
async def test_research_collector_arxiv_openalex_and_github_stars() -> None:
    arxiv_xml = """<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
      <entry>
        <id>http://arxiv.org/abs/2611.00001v1</id>
        <published>2026-11-20T18:00:00Z</published>
        <title>Verifiable Entity Resolution at Scale</title>
        <summary>Code released at https://github.com/example-ai/entity-scale for reproducible benchmarks.</summary>
        <author><name>Ada Lovelace</name></author>
        <arxiv:comment>12 pages</arxiv:comment>
      </entry>
    </feed>
    """
    openalex_json = json.dumps(
        {
            "meta": {"next_cursor": None},
            "results": [
                {
                    "id": "https://openalex.org/W123",
                    "title": "Structured LLM Extraction",
                    "publication_date": "2026-11-19",
                    "doi": "https://doi.org/10.1000/test",
                    "abstract_inverted_index": {"Structured": [0], "extraction": [1], "pipeline": [2]},
                    "authorships": [{"author": {"display_name": "Alan Turing"}}],
                    "primary_location": {"landing_page_url": "https://papers.example/w123"},
                    "cited_by_count": 5,
                    "type": "article",
                }
            ],
        }
    )
    crossref_json = json.dumps({"message": {"items": []}})
    github_json = json.dumps({"stargazers_count": 420})

    crawler = FakeCrawler(
        responses={
            "export.arxiv.org": FetchResult(url="https://export.arxiv.org/api/query", status=200, content=arxiv_xml, ok=True),
            "api.openalex.org": FetchResult(url="https://api.openalex.org/works", status=200, content=openalex_json, ok=True),
            "api.crossref.org": FetchResult(url="https://api.crossref.org/works", status=200, content=crossref_json, ok=True),
            "api.github.com/repos/example-ai/entity-scale": FetchResult(
                url="https://api.github.com/repos/example-ai/entity-scale", status=200, content=github_json, ok=True
            ),
        }
    )
    collector = ResearchCollector(Settings(), crawler)
    batch = await collector.collect(limit=10)
    assert len(batch.records) == 2
    arxiv_rec = batch.records[0]
    assert arxiv_rec["arxiv_id"] == "2611.00001v1"
    assert arxiv_rec["github_repository"] == "https://github.com/example-ai/entity-scale"
    assert arxiv_rec["github_stars"] == 420
    assert batch.records[1]["abstract"] == "Structured extraction pipeline"


@pytest.mark.asyncio
async def test_news_collector_rss_and_hn() -> None:
    rss_xml = """<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0">
      <channel>
        <title>AI Feed</title>
        <item>
          <title>New Open Weights Release</title>
          <link>https://news.example/open-weights</link>
          <pubDate>Sat, 21 Nov 2026 08:00:00 GMT</pubDate>
          <description>&lt;p&gt;Full weights released today.&lt;/p&gt;</description>
        </item>
      </channel>
    </rss>
    """
    hn_json = json.dumps(
        {
            "hits": [
                {
                    "title": "FrontierAtlas Benchmarks",
                    "url": "https://example.org/benchmarks",
                    "created_at": "2026-11-21T07:30:00Z",
                    "points": 88,
                    "objectID": "42",
                }
            ]
        }
    )
    source = RSSSource(name="example_feed", url="https://news.example/rss.xml", publisher="Example News")
    crawler = FakeCrawler(
        responses={
            "news.example/rss.xml": FetchResult(url=source.url, status=200, content=rss_xml, ok=True),
            "hn.algolia.com": FetchResult(url="https://hn.algolia.com/api/v1/search_by_date", status=200, content=hn_json, ok=True),
        }
    )
    collector = NewsCollector(Settings(), crawler, rss_sources=(source,))
    batch = await collector.collect(limit=10)
    assert len(batch.records) == 2
    assert batch.records[0]["summary"] == "Full weights released today."


@pytest.mark.asyncio
async def test_job_startup_product_collectors_with_mocked_apis() -> None:
    remotive_json = json.dumps(
        {
            "jobs": [
                {
                    "id": 1,
                    "title": "ML Platform Engineer",
                    "company_name": "VectorForge",
                    "candidate_required_location": "Remote",
                    "job_type": "full_time",
                    "description": "<p>Build distributed pipelines.</p>",
                    "publication_date": "2026-11-21T05:00:00Z",
                    "url": "https://remotive.com/jobs/1",
                }
            ]
        }
    )
    yc_json = json.dumps(
        [
            {
                "name": "VectorForge",
                "one_liner": "High-throughput vector indexing.",
                "website": "https://vectorforge.example",
                "industry": "AI Infrastructure",
                "all_locations": "San Francisco, CA",
                "slug": "vectorforge",
            }
        ]
    )
    gh_search_json = json.dumps(
        {
            "items": [
                {
                    "name": "atlas-cli",
                    "description": "Data intelligence CLI",
                    "homepage": "https://atlas-cli.example",
                    "html_url": "https://github.com/vectorforge/atlas-cli",
                    "topics": ["ai"],
                    "owner": {"login": "vectorforge"},
                    "stargazers_count": 300,
                }
            ]
        }
    )
    crawler = FakeCrawler(
        responses={
            "remotive.com": FetchResult(url="https://remotive.com/api/remote-jobs", status=200, content=remotive_json, ok=True),
            "yc-oss.github.io": FetchResult(url=StartupCollector.YC_OSS_URL, status=200, content=yc_json, ok=True),
            "api.github.com/search/repositories": FetchResult(url="https://api.github.com/search/repositories", status=200, content=gh_search_json, ok=True),
        }
    )

    jobs_batch = await JobCollector(Settings(), crawler, greenhouse_boards=()).collect(limit=10)
    assert len(jobs_batch.records) == 1
    assert jobs_batch.records[0]["company"] == "VectorForge"

    startups_batch = await StartupCollector(Settings(), crawler).collect(limit=10)
    assert len(startups_batch.records) == 1
    assert startups_batch.records[0]["industry"] == "AI Infrastructure"

    products_batch = await ProductCollector(Settings(), crawler).collect(limit=10)
    assert len(products_batch.records) == 1
    assert products_batch.records[0]["name"] == "atlas-cli"


@pytest.mark.asyncio
async def test_collector_pagination_and_newest_first_ordering() -> None:
    yc_json = json.dumps(
        [
            {
                "name": "DefunctCo 2011",
                "one_liner": "Old defunct startup.",
                "website": "https://defunct.example",
                "status": "Inactive",
                "launched_at": 1300000000,
                "slug": "defunct-2011",
            },
            {
                "name": "ActiveAlpha 2026",
                "one_liner": "Newest active startup.",
                "website": "https://alpha.example",
                "status": "Active",
                "launched_at": 1790000000,
                "slug": "active-alpha",
            },
            {
                "name": "ActiveBeta 2025",
                "one_liner": "Second active startup.",
                "website": "https://beta.example",
                "status": "Active",
                "launched_at": 1750000000,
                "slug": "active-beta",
            },
        ]
    )
    rss_xml = """<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0">
      <channel>
        <title>Mixed Dates</title>
        <item>
          <title>Older Archive Post</title>
          <link>https://news.example/old</link>
          <pubDate>Mon, 01 Jan 2024 08:00:00 GMT</pubDate>
          <description>Historical post.</description>
        </item>
      </channel>
    </rss>
    """
    hn_page0 = json.dumps(
        {
            "hits": [
                {
                    "title": "Breaking Live AI Benchmark",
                    "url": "https://news.example/fresh",
                    "created_at": "2026-11-21T10:30:00Z",
                    "objectID": "101",
                }
            ]
        }
    )
    hn_page1 = json.dumps(
        {
            "hits": [
                {
                    "title": "Page Two AI Post",
                    "url": "https://news.example/page2",
                    "created_at": "2026-11-21T09:30:00Z",
                    "objectID": "102",
                }
            ]
        }
    )

    class PageAwareCrawler(FakeCrawler):
        async def fetch(self, url: str, **kwargs: Any) -> FetchResult:
            if "hn.algolia.com" in url and "page=1" in url:
                return FetchResult(url=url, status=200, content=hn_page1, ok=True)
            if "hn.algolia.com" in url and "page=0" in url:
                return FetchResult(url=url, status=200, content=hn_page0, ok=True)
            return await super().fetch(url, **kwargs)

    crawler = PageAwareCrawler(
        responses={
            "yc-oss.github.io": FetchResult(url=StartupCollector.YC_OSS_URL, status=200, content=yc_json, ok=True),
            "news.example/rss.xml": FetchResult(url="https://news.example/rss.xml", status=200, content=rss_xml, ok=True),
        }
    )

    startup_col = StartupCollector(Settings(), crawler)
    p1 = await startup_col.collect(limit=1, page=1)
    p2 = await startup_col.collect(limit=1, page=2)
    assert p1.records[0]["name"] == "ActiveAlpha 2026"
    assert p1.stats.has_more is True
    assert p1.stats.next_page == 2
    assert p2.records[0]["name"] == "ActiveBeta 2025"

    source = RSSSource(name="mixed_feed", url="https://news.example/rss.xml", publisher="Mixed News")
    news_col = NewsCollector(Settings(), crawler, rss_sources=(source,))
    news_p1 = await news_col.collect(limit=1, page=1)
    news_p2 = await news_col.collect(limit=1, page=2)
    # Newest-first ordering guarantees fresh HN item is NOT starved by 2024 RSS item
    assert news_p1.records[0]["headline"] == "Breaking Live AI Benchmark"
    assert news_p2.records[0]["headline"] == "Page Two AI Post"

