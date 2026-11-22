"""News collector using official RSS/Atom feeds and public Hacker News API."""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import Any, Optional

from bs4 import BeautifulSoup

from src.collectors.base_collector import BaseCollector, CollectionBatch, CollectorStats
from src.utils.date_utils import parse_utc_datetime, utc_now


@dataclass(frozen=True)
class RSSSource:
    """Configuration for a public RSS/Atom news feed."""

    name: str
    url: str
    publisher: str
    category: str = "Technology"


DEFAULT_RSS_SOURCES: tuple[RSSSource, ...] = (
    RSSSource(
        name="huggingface_blog",
        url="https://huggingface.co/blog/feed.xml",
        publisher="Hugging Face Blog",
        category="AI Research & Engineering",
    ),
    RSSSource(
        name="mit_news_ai",
        url="https://news.mit.edu/topic/mitartificial-intelligence2-rss.xml",
        publisher="MIT News",
        category="AI Research",
    ),
    RSSSource(
        name="google_blog",
        url="https://blog.google/technology/ai/rss/",
        publisher="Google AI Blog",
        category="AI",
    ),
    RSSSource(
        name="techcrunch_ai",
        url="https://techcrunch.com/category/artificial-intelligence/feed/",
        publisher="TechCrunch",
        category="Startups & AI",
    ),
    RSSSource(
        name="devto_ai",
        url="https://dev.to/feed/tag/ai",
        publisher="DEV Community",
        category="AI Engineering",
    ),
)


class NewsCollector(BaseCollector):
    """Collects recent news articles from RSS/Atom feeds and public APIs."""

    category = "news"

    def __init__(self, settings: Any, crawler: Any, rss_sources: tuple[RSSSource, ...] = DEFAULT_RSS_SOURCES) -> None:
        super().__init__(settings, crawler)
        self.rss_sources = rss_sources

    @staticmethod
    def parse_rss_or_atom(xml_text: str, source: RSSSource) -> list[dict[str, Any]]:
        """Parse RSS 2.0 or Atom XML feed text into normalized raw news dicts."""
        records: list[dict[str, Any]] = []
        root = ET.fromstring(xml_text)
        now = utc_now()

        # RSS 2.0 (<rss><channel><item>)
        channel = root.find("channel")
        if channel is not None:
            for item in channel.findall("item"):
                title = (item.findtext("title") or "").strip()
                link = (item.findtext("link") or "").strip()
                pub_raw = item.findtext("pubDate") or item.findtext("{http://purl.org/dc/elements/1.1/}date")
                pub_dt = parse_utc_datetime(pub_raw)
                content_raw = (item.findtext("{http://purl.org/rss/1.0/modules/content/}encoded") or "").strip()
                desc_raw = (item.findtext("description") or "").strip()
                best_raw = content_raw if len(content_raw) > len(desc_raw) else desc_raw
                if best_raw and ("<" in best_raw and ">" in best_raw):
                    summary = BeautifulSoup(best_raw, "html.parser").get_text(" ", strip=True) or None
                else:
                    summary = best_raw or None
                if not title or not link or pub_dt is None:
                    continue
                records.append(
                    {
                        "headline": title,
                        "summary": summary[:2000] if summary else None,
                        "publisher": source.publisher,
                        "published_at": pub_dt,
                        "article_url": link,
                        "category": source.category,
                        "source_name": source.name,
                        "source_url": source.url,
                        "collected_at": now,
                        "source_metadata": {"feed_type": "rss"},
                    }
                )
            return records

        # Atom (<feed><entry>)
        ns = {"atom": "http://www.w3.org/2005/Atom"}
        entries = root.findall("atom:entry", ns) or root.findall("entry")
        for entry in entries:
            title_el = entry.find("atom:title", ns) or entry.find("title")
            title = (title_el.text or "").strip() if title_el is not None and title_el.text else ""
            link_el = entry.find("atom:link", ns) or entry.find("link")
            link = ""
            if link_el is not None:
                link = (link_el.attrib.get("href") or link_el.text or "").strip()
            pub_el = (
                entry.find("atom:published", ns)
                or entry.find("atom:updated", ns)
                or entry.find("published")
                or entry.find("updated")
            )
            pub_dt = parse_utc_datetime(pub_el.text if pub_el is not None else None)
            sum_el = entry.find("atom:summary", ns) or entry.find("summary") or entry.find("atom:content", ns)
            summary = (
                BeautifulSoup(sum_el.text, "html.parser").get_text(" ", strip=True)
                if sum_el is not None and sum_el.text
                else None
            )
            if not title or not link or pub_dt is None:
                continue
            records.append(
                {
                    "headline": title,
                    "summary": summary[:2000] if summary else None,
                    "publisher": source.publisher,
                    "published_at": pub_dt,
                    "article_url": link,
                    "category": source.category,
                    "source_name": source.name,
                    "source_url": source.url,
                    "collected_at": now,
                    "source_metadata": {"feed_type": "atom"},
                }
            )
        return records

    async def collect_hn_stories(self, limit: int = 100, *, start_page: int = 1) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """Collect recent stories from Hacker News Algolia API."""
        hn_page = max(0, start_page - 1)
        url = f"https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage={min(100, max(20, limit))}&page={hn_page}"
        res = await self.crawler.fetch(url, deduplicate=False, check_robots=False)
        if not res.ok:
            return [], [{"source": "hn_algolia", "url": url, "error": res.error}]

        try:
            payload = json.loads(res.content)
        except ValueError as exc:
            return [], [{"source": "hn_algolia", "url": url, "error": f"invalid_json: {exc}"}]

        records: list[dict[str, Any]] = []
        now = utc_now()
        for hit in payload.get("hits") or []:
            title = (hit.get("title") or "").strip()
            article_url = (hit.get("url") or "").strip()
            pub_dt = parse_utc_datetime(hit.get("created_at"))
            if not title or not article_url or pub_dt is None:
                continue
            obj_id = hit.get("objectID")
            item_source_url = f"https://news.ycombinator.com/item?id={obj_id}" if obj_id else url
            records.append(
                {
                    "headline": title,
                    "summary": None,
                    "publisher": "Hacker News",
                    "published_at": pub_dt,
                    "article_url": article_url,
                    "category": "Technology",
                    "source_name": "hn_algolia",
                    "source_url": item_source_url,
                    "collected_at": now,
                    "source_metadata": {"points": hit.get("points"), "objectID": obj_id, "api_url": url},
                }
            )
        return records[:limit], []

    async def collect(self, limit: Optional[int] = None, page: int = 1) -> CollectionBatch:
        """Collect recent news items from RSS/Atom feeds and Hacker News API sorted newest-first."""
        safe_page = max(1, page)
        records: list[dict[str, Any]] = []
        errors: list[dict[str, Any]] = []

        if safe_page == 1:
            for source in self.rss_sources:
                res = await self.crawler.fetch(source.url, deduplicate=False, check_robots=True)
                if not res.ok:
                    errors.append({"source": source.name, "url": source.url, "error": res.error})
                    continue
                try:
                    parsed = self.parse_rss_or_atom(res.content, source)
                    records.extend(parsed)
                except ET.ParseError as exc:
                    errors.append({"source": source.name, "url": source.url, "error": f"xml_parse_error: {exc}"})

        hn_recs, hn_errs = await self.collect_hn_stories(limit=max(50, limit or 100), start_page=safe_page)
        records.extend(hn_recs)
        errors.extend(hn_errs)

        records.sort(key=lambda r: r.get("published_at") or utc_now(), reverse=True)
        discovered_count = len(records)
        if limit is not None:
            has_more = len(records) > limit or bool(hn_recs)
            records = records[:limit]
        else:
            has_more = bool(hn_recs)

        stats = CollectorStats(
            source_category=self.category,
            discovered=discovered_count,
            extracted=len(records),
            failed=len(errors),
            unavailable_sources=[e["source"] for e in errors],
            page=safe_page,
            has_more=has_more,
            next_page=(safe_page + 1) if has_more else None,
        )
        return CollectionBatch(category=self.category, records=records, stats=stats, errors=errors)
