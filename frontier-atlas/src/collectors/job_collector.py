"""Job posting collector using accessible public job APIs."""

from __future__ import annotations

import json
from typing import Any, Optional

from bs4 import BeautifulSoup

from src.collectors.base_collector import BaseCollector, CollectionBatch, CollectorStats
from src.utils.date_utils import parse_utc_datetime, utc_now

DEFAULT_GREENHOUSE_BOARDS: tuple[str, ...] = (
    "anthropic",
    "huggingface",
    "scaleai",
    "weightsandbiases",
)


class JobCollector(BaseCollector):
    """Collects public job postings from Remotive, Arbeitnow, and Greenhouse board APIs."""

    category = "jobs"

    def __init__(
        self,
        settings: Any,
        crawler: Any,
        greenhouse_boards: tuple[str, ...] = DEFAULT_GREENHOUSE_BOARDS,
    ) -> None:
        super().__init__(settings, crawler)
        self.greenhouse_boards = greenhouse_boards

    @staticmethod
    def _clean_html(raw: Optional[str], max_len: int = 4000) -> Optional[str]:
        if not raw:
            return None
        text = BeautifulSoup(raw, "html.parser").get_text(" ", strip=True)
        return text[:max_len] if text else None

    async def collect_remotive(self, limit: int = 100) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """Collect remote tech jobs from Remotive public API."""
        url = f"https://remotive.com/api/remote-jobs?limit={min(200, limit)}"
        res = await self.crawler.fetch(url, deduplicate=False, check_robots=False)
        if not res.ok:
            return [], [{"source": "remotive", "url": url, "error": res.error}]

        try:
            payload = json.loads(res.content)
        except ValueError as exc:
            return [], [{"source": "remotive", "url": url, "error": f"invalid_json: {exc}"}]

        records: list[dict[str, Any]] = []
        now = utc_now()
        for job in payload.get("jobs") or []:
            title = (job.get("title") or "").strip()
            company = (job.get("company_name") or "").strip()
            app_url = (job.get("url") or "").strip()
            posted_at = parse_utc_datetime(job.get("publication_date"))
            if not title or not company or not app_url or posted_at is None:
                continue
            records.append(
                {
                    "title": title,
                    "company": company,
                    "location": (job.get("candidate_required_location") or "Remote").strip(),
                    "employment_type": job.get("job_type"),
                    "description": self._clean_html(job.get("description")),
                    "posted_at": posted_at,
                    "application_url": app_url,
                    "source_name": "remotive",
                    "source_url": app_url,
                    "collected_at": now,
                    "source_metadata": {"category": job.get("category"), "remotive_id": job.get("id"), "api_url": url},
                }
            )
        return records[:limit], []

    async def collect_arbeitnow(self, max_pages: int = 3, *, start_page: int = 1) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """Collect jobs from Arbeitnow public job board API."""
        records: list[dict[str, Any]] = []
        errors: list[dict[str, Any]] = []
        now = utc_now()
        safe_start = max(1, start_page)

        for page in range(safe_start, safe_start + max_pages):
            url = f"https://www.arbeitnow.com/api/job-board-api?page={page}"
            res = await self.crawler.fetch(url, deduplicate=False, check_robots=False)
            if not res.ok:
                errors.append({"source": "arbeitnow", "url": url, "error": res.error})
                break
            try:
                payload = json.loads(res.content)
            except ValueError as exc:
                errors.append({"source": "arbeitnow", "url": url, "error": f"invalid_json: {exc}"})
                break

            items = payload.get("data") or []
            if not items:
                break
            for job in items:
                title = (job.get("title") or "").strip()
                company = (job.get("company_name") or "").strip()
                app_url = (job.get("url") or "").strip()
                posted_at = parse_utc_datetime(job.get("created_at"))
                if not title or not company or not app_url or posted_at is None:
                    continue
                job_types = job.get("job_types") or []
                emp_type = str(job_types[0]) if job_types else ("Remote" if job.get("remote") else None)
                records.append(
                    {
                        "title": title,
                        "company": company,
                        "location": (job.get("location") or "").strip() or None,
                        "employment_type": emp_type,
                        "description": self._clean_html(job.get("description")),
                        "posted_at": posted_at,
                        "application_url": app_url,
                        "source_name": "arbeitnow",
                        "source_url": app_url,
                        "collected_at": now,
                        "source_metadata": {"tags": job.get("tags", []), "remote": job.get("remote"), "api_url": url},
                    }
                )
        return records, errors

    async def collect_greenhouse_boards(self) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """Collect jobs from permitted public Greenhouse job board JSON endpoints."""
        records: list[dict[str, Any]] = []
        errors: list[dict[str, Any]] = []
        now = utc_now()

        for board in self.greenhouse_boards:
            url = f"https://boards-api.greenhouse.io/v1/boards/{board}/jobs?content=true"
            res = await self.crawler.fetch(url, deduplicate=False, check_robots=False)
            if not res.ok:
                errors.append({"source": f"greenhouse:{board}", "url": url, "error": res.error})
                continue
            try:
                payload = json.loads(res.content)
            except ValueError as exc:
                errors.append({"source": f"greenhouse:{board}", "url": url, "error": f"invalid_json: {exc}"})
                continue

            for job in payload.get("jobs") or []:
                title = (job.get("title") or "").strip()
                app_url = (job.get("absolute_url") or "").strip()
                posted_at = parse_utc_datetime(job.get("updated_at") or job.get("first_published"))
                if not title or not app_url or posted_at is None:
                    continue
                loc = (job.get("location") or {}).get("name")
                records.append(
                    {
                        "title": title,
                        "company": board.replace("_", " ").title(),
                        "location": loc,
                        "employment_type": None,
                        "description": self._clean_html(job.get("content")),
                        "posted_at": posted_at,
                        "application_url": app_url,
                        "source_name": f"greenhouse:{board}",
                        "source_url": app_url,
                        "collected_at": now,
                        "source_metadata": {"greenhouse_id": job.get("id"), "api_url": url},
                    }
                )
        return records, errors

    async def collect(self, limit: Optional[int] = None, page: int = 1) -> CollectionBatch:
        """Collect paginated job postings from configured public job APIs sorted newest-first."""
        safe_page = max(1, page)
        rem_recs, rem_errs = await self.collect_remotive(limit=max(100, limit or 100))
        arb_recs, arb_errs = await self.collect_arbeitnow(max_pages=2, start_page=safe_page)
        gh_recs, gh_errs = await self.collect_greenhouse_boards()

        combined = rem_recs + arb_recs + gh_recs
        combined.sort(key=lambda r: r.get("posted_at") or utc_now(), reverse=True)
        discovered_count = len(combined)

        if limit is not None:
            offset = (safe_page - 1) * limit if not arb_recs else 0
            sliced = combined[offset : offset + limit] if offset < len(combined) else []
            has_more = (offset + limit) < len(combined) or bool(arb_recs)
            records = sliced
        else:
            records = combined
            has_more = False

        errors = rem_errs + arb_errs + gh_errs

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
