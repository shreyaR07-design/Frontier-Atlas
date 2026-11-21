"""Product collector using public Show HN, GitHub repositories, and product pages."""

from __future__ import annotations

import json
from typing import Any, Optional
from urllib.parse import quote_plus

from src.collectors.base_collector import BaseCollector, CollectionBatch, CollectorStats
from src.utils.date_utils import utc_now
from src.utils.url_utils import is_valid_http_url


class ProductCollector(BaseCollector):
    """Collects software/AI product records from GitHub Search API and Show HN."""

    category = "products"

    async def collect_github_products(
        self,
        queries: tuple[str, ...] = ("topic:ai stars:>100", "topic:developer-tools stars:>200"),
        limit: int = 500,
        *,
        start_page: int = 1,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """Collect public developer/AI products from GitHub repository search API."""
        records: list[dict[str, Any]] = []
        errors: list[dict[str, Any]] = []
        headers = {"Accept": "application/vnd.github+json"}
        if self.settings.github_token:
            headers["Authorization"] = f"Bearer {self.settings.github_token}"

        now = utc_now()
        seen_repo_urls: set[str] = set()
        safe_start = max(1, start_page)
        for query in queries:
            page = safe_start
            while len(records) < limit and page < safe_start + 10:
                per_page = min(100, limit - len(records))
                url = (
                    f"https://api.github.com/search/repositories?q={quote_plus(query)}"
                    f"&sort=stars&order=desc&per_page={per_page}&page={page}"
                )
                res = await self.crawler.fetch(url, headers=headers, deduplicate=False, check_robots=False)
                if not res.ok:
                    errors.append({"source": "github_search", "url": url, "error": res.error})
                    break
                try:
                    payload = json.loads(res.content)
                except ValueError as exc:
                    errors.append({"source": "github_search", "url": url, "error": f"invalid_json: {exc}"})
                    break

                items = payload.get("items") or []
                if not items:
                    break

                for repo in items:
                    name = (repo.get("name") or "").strip()
                    html_url = (repo.get("html_url") or "").strip()
                    if not name or not html_url or html_url in seen_repo_urls:
                        continue
                    seen_repo_urls.add(html_url)
                    homepage = (repo.get("homepage") or "").strip() or None
                    if homepage and not is_valid_http_url(homepage):
                        homepage = None
                    topics = repo.get("topics") or []
                    category = str(topics[0]) if topics else (repo.get("language") or None)
                    owner = (repo.get("owner") or {}).get("login")
                    records.append(
                        {
                            "name": name,
                            "description": (repo.get("description") or "").strip() or None,
                            "website": homepage or html_url,
                            "category": category,
                            "company_name": owner,
                            "source_name": "github_repositories",
                            "source_url": html_url,
                            "collected_at": now,
                            "source_metadata": {
                                "stars": repo.get("stargazers_count"),
                                "language": repo.get("language"),
                                "full_name": repo.get("full_name"),
                            },
                        }
                    )
                if len(items) < per_page:
                    break
                page += 1
        return records[:limit], errors

    async def collect_show_hn(self, limit: int = 200, *, start_page: int = 1) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """Collect launched products from Hacker News Show HN via Algolia API."""
        records: list[dict[str, Any]] = []
        errors: list[dict[str, Any]] = []
        now = utc_now()
        safe_start = max(0, start_page - 1)
        page = safe_start

        while len(records) < limit and page < safe_start + 10:
            per_page = min(100, limit - len(records))
            url = f"https://hn.algolia.com/api/v1/search_by_date?tags=show_hn&hitsPerPage={per_page}&page={page}"
            res = await self.crawler.fetch(url, deduplicate=False, check_robots=False)
            if not res.ok:
                errors.append({"source": "show_hn", "url": url, "error": res.error})
                break
            try:
                payload = json.loads(res.content)
            except ValueError as exc:
                errors.append({"source": "show_hn", "url": url, "error": f"invalid_json: {exc}"})
                break

            hits = payload.get("hits") or []
            if not hits:
                break

            for hit in hits:
                raw_title = (hit.get("title") or "").strip()
                product_url = (hit.get("url") or "").strip()
                if not raw_title or not product_url or not is_valid_http_url(product_url):
                    continue
                name = raw_title.removeprefix("Show HN:").removeprefix("Show HN -").strip() or raw_title
                hn_item_url = f"https://news.ycombinator.com/item?id={hit.get('objectID')}"
                records.append(
                    {
                        "name": name[:200],
                        "description": (hit.get("story_text") or "").strip()[:2000] or None,
                        "website": product_url,
                        "category": "Show HN Launch",
                        "company_name": hit.get("author"),
                        "source_name": "show_hn",
                        "source_url": hn_item_url,
                        "collected_at": now,
                        "source_metadata": {"points": hit.get("points"), "created_at": hit.get("created_at")},
                    }
                )
            if len(hits) < per_page:
                break
            page += 1
        return records[:limit], errors

    async def collect(self, limit: Optional[int] = None, page: int = 1) -> CollectionBatch:
        """Collect paginated product records from GitHub repositories and Show HN."""
        target = limit or self.settings.target_products
        safe_page = max(1, page)
        gh_target = max(1, round(target * 0.7))
        hn_target = max(0, target - gh_target)

        gh_recs, gh_errs = await self.collect_github_products(limit=gh_target, start_page=safe_page)
        hn_recs: list[dict[str, Any]] = []
        hn_errs: list[dict[str, Any]] = []
        if hn_target > 0:
            hn_recs, hn_errs = await self.collect_show_hn(limit=hn_target, start_page=safe_page)

        combined = (gh_recs + hn_recs)[:target]
        errors = gh_errs + hn_errs

        stats = CollectorStats(
            source_category=self.category,
            discovered=len(gh_recs) + len(hn_recs),
            extracted=len(combined),
            failed=len(errors),
            unavailable_sources=[e["source"] for e in errors],
            page=safe_page,
            has_more=len(combined) >= target,
            next_page=(safe_page + 1) if len(combined) >= target else None,
        )
        return CollectionBatch(category=self.category, records=combined, stats=stats, errors=errors)
