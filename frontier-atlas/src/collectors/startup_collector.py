"""Startup collector using public startup datasets and official company websites."""

from __future__ import annotations

import json
from typing import Any, Optional

from src.collectors.base_collector import BaseCollector, CollectionBatch, CollectorStats
from src.crawler.content_extractor import ContentExtractor
from src.utils.date_utils import parse_utc_datetime, utc_now
from src.utils.url_utils import is_valid_http_url


class StartupCollector(BaseCollector):
    """Collects startup records from public YC OSS directory API and official websites."""

    category = "startups"
    YC_OSS_URL = "https://yc-oss.github.io/api/companies/all.json"

    def __init__(self, settings: Any, crawler: Any, enrich_websites: bool = False) -> None:
        super().__init__(settings, crawler)
        self.enrich_websites = enrich_websites
        self.extractor = ContentExtractor()

    async def collect_yc_directory(
        self,
        limit: int = 1000,
        *,
        page: int = 1,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]], bool]:
        """Collect paginated startup records from the YC OSS directory JSON dataset."""
        res = await self.crawler.fetch(self.YC_OSS_URL, deduplicate=False, check_robots=False)
        if not res.ok:
            return [], [{"source": "yc_oss_directory", "url": self.YC_OSS_URL, "error": res.error}], False

        try:
            companies = json.loads(res.content)
        except ValueError as exc:
            return [], [{"source": "yc_oss_directory", "url": self.YC_OSS_URL, "error": f"invalid_json: {exc}"}], False

        if not isinstance(companies, list):
            return [], [{"source": "yc_oss_directory", "url": self.YC_OSS_URL, "error": "unexpected_payload_shape"}], False

        # Prefer active companies with recent launch timestamps so Page 1 prioritizes live companies
        def _sort_key(item: dict[str, Any]) -> tuple[int, int]:
            is_active = 1 if str(item.get("status") or "").lower() == "active" else 0
            launched_raw = item.get("launched_at")
            launched_ts = int(launched_raw) if isinstance(launched_raw, (int, float)) else 0
            return (is_active, launched_ts)

        ordered = sorted(
            (c for c in companies if isinstance(c, dict) and (c.get("name") or "").strip()),
            key=_sort_key,
            reverse=True,
        )
        safe_page = max(1, page)
        start_idx = (safe_page - 1) * limit
        page_slice = ordered[start_idx : start_idx + limit]
        has_more = (start_idx + limit) < len(ordered)

        records: list[dict[str, Any]] = []
        now = utc_now()
        for item in page_slice:
            name = (item.get("name") or "").strip()
            if not name:
                continue

            website = (item.get("website") or "").strip() or None
            if website and not is_valid_http_url(website):
                website = None

            slug = item.get("slug") or item.get("id")
            source_url = (
                (item.get("url") or "").strip()
                or (f"https://www.ycombinator.com/companies/{slug}" if slug else self.YC_OSS_URL)
            )
            if not is_valid_http_url(source_url):
                source_url = self.YC_OSS_URL

            launched_dt = parse_utc_datetime(item.get("launched_at"))
            founding_date = launched_dt.date().isoformat() if launched_dt else None
            industries = item.get("industries") or []
            industry = (
                str(item.get("industry") or (industries[0] if industries else "")).strip() or None
            )
            desc = (item.get("one_liner") or item.get("long_description") or "").strip() or None

            rec = {
                "name": name,
                "description": desc[:3500] if desc else None,
                "website": website,
                "industry": industry,
                "location": (item.get("all_locations") or "").strip() or None,
                "founding_date": founding_date,
                "source_name": "yc_oss_directory",
                "source_url": source_url,
                "collected_at": now,
                "source_metadata": {
                    "batch": item.get("batch"),
                    "status": item.get("status"),
                    "team_size": item.get("team_size"),
                    "tags": item.get("tags") or [],
                    "yc_industries": industries,
                },
            }
            if self.enrich_websites and website:
                rec = await self.enrich_from_official_website(rec)
            records.append(rec)
        return records, [], has_more

    async def enrich_from_official_website(self, record: dict[str, Any]) -> dict[str, Any]:
        """Optionally fetch official company website (respecting robots.txt) to enrich description."""
        website = record.get("website")
        if not website or not self.enrich_websites:
            return record
        res = await self.crawler.fetch(website, deduplicate=True, check_robots=True)
        if res.ok and "html" in res.content_type.lower():
            page = self.extractor.extract(res.content, res.url)
            if not record.get("description") and page.description:
                record["description"] = page.description
            record.setdefault("source_metadata", {})["website_title"] = page.title
        return record

    async def collect(self, limit: Optional[int] = None, page: int = 1) -> CollectionBatch:
        """Collect paginated startup records up to `limit`."""
        target = limit or self.settings.target_startups
        records, errors, has_more = await self.collect_yc_directory(limit=target, page=page)
        stats = CollectorStats(
            source_category=self.category,
            discovered=len(records),
            extracted=len(records),
            failed=len(errors),
            unavailable_sources=[e["source"] for e in errors],
            page=max(1, page),
            has_more=has_more,
            next_page=(max(1, page) + 1) if has_more else None,
        )
        return CollectionBatch(category=self.category, records=records, stats=stats, errors=errors)
