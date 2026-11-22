"""Research paper collector using OpenAlex, arXiv, Crossref, and GitHub APIs."""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from typing import Any, Optional
from urllib.parse import quote_plus

from bs4 import BeautifulSoup

from src.collectors.base_collector import BaseCollector, CollectionBatch, CollectorStats
from src.utils.date_utils import utc_now
from src.utils.url_utils import extract_github_repo_slug


class ResearchCollector(BaseCollector):
    """Collects research papers from OpenAlex, arXiv, and Crossref with GitHub star enrichment."""

    category = "research_papers"

    def __init__(self, settings: Any, crawler: Any) -> None:
        super().__init__(settings, crawler)
        self._github_stars_cache: dict[str, Optional[int]] = {}
        self._github_rate_limited = False

    @staticmethod
    def reconstruct_openalex_abstract(inverted_index: Optional[dict[str, list[int]]]) -> Optional[str]:
        """Reconstruct plain-text abstract from OpenAlex inverted-index representation."""
        if not inverted_index or not isinstance(inverted_index, dict):
            return None
        positions: list[tuple[int, str]] = []
        for word, idxs in inverted_index.items():
            for idx in idxs:
                positions.append((idx, word))
        if not positions:
            return None
        positions.sort(key=lambda item: item[0])
        return " ".join(word for _, word in positions).strip() or None

    async def fetch_github_stars(self, github_repo_url: Optional[str]) -> Optional[int]:
        """Fetch stargazers_count from the official GitHub REST API when possible."""
        if not github_repo_url or self._github_rate_limited:
            return None
        slug = extract_github_repo_slug(github_repo_url)
        if not slug:
            return None
        if slug in self._github_stars_cache:
            return self._github_stars_cache[slug]

        api_url = f"https://api.github.com/repos/{slug}"
        headers = {"Accept": "application/vnd.github+json"}
        if self.settings.github_token:
            headers["Authorization"] = f"Bearer {self.settings.github_token}"

        res = await self.crawler.fetch(api_url, headers=headers, deduplicate=False, check_robots=False)
        if res.status in {403, 429}:
            self._github_rate_limited = True
            self.logger.warning(
                "GitHub API rate limit reached; continuing without remaining star counts",
                extra={"ctx": {"repo": slug, "status": res.status}},
            )
            return None
        if not res.ok:
            self._github_stars_cache[slug] = None
            return None

        try:
            payload = json.loads(res.content)
            stars = payload.get("stargazers_count")
            parsed_stars = int(stars) if isinstance(stars, int) and stars >= 0 else None
            self._github_stars_cache[slug] = parsed_stars
            return parsed_stars
        except (ValueError, TypeError):
            self._github_stars_cache[slug] = None
            return None

    async def collect_from_openalex(
        self,
        query: str = "artificial intelligence",
        limit: int = 100,
        *,
        start_page: int = 1,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """Collect paginated works from OpenAlex API."""
        records: list[dict[str, Any]] = []
        errors: list[dict[str, Any]] = []
        cursor = "*" if start_page <= 1 else None
        cur_page = max(1, start_page)
        per_page = min(100, max(10, limit))

        while len(records) < limit and (cursor is not None or start_page > 1):
            if start_page <= 1:
                url = (
                    f"https://api.openalex.org/works?search={quote_plus(query)}"
                    f"&per-page={per_page}&cursor={quote_plus(cursor or '*')}"
                    "&sort=publication_date:desc"
                )
            else:
                url = (
                    f"https://api.openalex.org/works?search={quote_plus(query)}"
                    f"&per-page={per_page}&page={cur_page}"
                    "&sort=publication_date:desc"
                )
            res = await self.crawler.fetch(url, deduplicate=False, check_robots=False)
            if not res.ok:
                errors.append({"source": "openalex", "url": url, "error": res.error})
                break
            try:
                data = json.loads(res.content)
            except ValueError as exc:
                errors.append({"source": "openalex", "url": url, "error": f"invalid_json: {exc}"})
                break

            results = data.get("results") or []
            if not results:
                break

            for work in results:
                if len(records) >= limit:
                    break
                title = (work.get("title") or "").strip()
                if not title:
                    continue
                abstract = self.reconstruct_openalex_abstract(work.get("abstract_inverted_index"))
                authors = [
                    (a.get("author") or {}).get("display_name", "").strip()
                    for a in (work.get("authorships") or [])
                    if (a.get("author") or {}).get("display_name")
                ]
                primary_loc = work.get("primary_location") or {}
                landing_url = primary_loc.get("landing_page_url") or work.get("id")
                if not landing_url:
                    continue
                doi = work.get("doi")
                arxiv_id = None
                ids = work.get("ids") or {}
                if isinstance(ids.get("openalex"), str) and "arxiv" in str(landing_url).lower():
                    arxiv_id = str(landing_url).rstrip("/").split("/")[-1]
                github_repo = self.find_first_github_repo(abstract, title, str(landing_url))
                stars = await self.fetch_github_stars(github_repo) if github_repo else None

                openalex_id_url = str(work.get("id") or "").strip() or None
                openalex_api_url = (
                    f"https://api.openalex.org/works/{openalex_id_url.rstrip('/').split('/')[-1]}"
                    if openalex_id_url and "openalex.org/" in openalex_id_url
                    else None
                )
                collected_ts = utc_now()
                records.append(
                    {
                        "title": title,
                        "abstract": abstract,
                        "authors": authors,
                        "publication_date": work.get("publication_date"),
                        "doi": doi,
                        "arxiv_id": arxiv_id,
                        "github_repository": github_repo,
                        "github_stars": stars,
                        "official_website": openalex_id_url,
                        "source_name": "openalex",
                        "source_url": landing_url,
                        "collected_at": collected_ts,
                        "source_metadata": {
                            "openalex_id": openalex_id_url,
                            "openalex_api_url": openalex_api_url,
                            "cited_by_count": work.get("cited_by_count"),
                            "type": work.get("type"),
                            "github_metrics": {
                                "stars": stars,
                                "metrics_updated_at": collected_ts.isoformat(),
                            }
                            if github_repo
                            else None,
                        },
                    }
                )
            if start_page <= 1:
                cursor = (data.get("meta") or {}).get("next_cursor")
            else:
                cur_page += 1
                if len(results) < per_page:
                    break
        return records, errors

    async def collect_from_arxiv(
        self,
        search_query: str = "cat:cs.AI OR cat:cs.LG OR cat:cs.CL",
        limit: int = 100,
        *,
        start_page: int = 1,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """Collect paginated preprints from the official arXiv Atom API."""
        records: list[dict[str, Any]] = []
        errors: list[dict[str, Any]] = []
        batch_size = min(100, max(10, limit))
        start = max(0, (max(1, start_page) - 1) * limit)
        ns = {"atom": "http://www.w3.org/2005/Atom", "arxiv": "http://arxiv.org/schemas/atom"}

        while len(records) < limit:
            url = (
                f"https://export.arxiv.org/api/query?search_query={quote_plus(search_query)}"
                f"&start={start}&max_results={min(batch_size, limit - len(records))}"
                "&sortBy=submittedDate&sortOrder=descending"
            )
            res = await self.crawler.fetch(url, deduplicate=False, check_robots=False)
            if not res.ok:
                errors.append({"source": "arxiv", "url": url, "error": res.error})
                break

            try:
                root = ET.fromstring(res.content)
            except ET.ParseError as exc:
                errors.append({"source": "arxiv", "url": url, "error": f"xml_parse_error: {exc}"})
                break

            entries = root.findall("atom:entry", ns)
            if not entries:
                break

            for entry in entries:
                title_el = entry.find("atom:title", ns)
                id_el = entry.find("atom:id", ns)
                if title_el is None or id_el is None or not (title_el.text and id_el.text):
                    continue
                title = " ".join(title_el.text.split())
                entry_url = id_el.text.strip()
                if entry_url.startswith("http://arxiv.org/"):
                    entry_url = "https://" + entry_url[len("http://"):]
                arxiv_id = entry_url.rstrip("/").split("/")[-1]
                summary_el = entry.find("atom:summary", ns)
                abstract = " ".join(summary_el.text.split()) if summary_el is not None and summary_el.text else None
                published_el = entry.find("atom:published", ns)
                pub_date = published_el.text[:10] if published_el is not None and published_el.text else None
                comment_el = entry.find("arxiv:comment", ns)
                comment_text = comment_el.text if comment_el is not None else None
                doi_el = entry.find("arxiv:doi", ns)
                doi = doi_el.text.strip() if doi_el is not None and doi_el.text else None

                authors = [
                    name_el.text.strip()
                    for author_el in entry.findall("atom:author", ns)
                    if (name_el := author_el.find("atom:name", ns)) is not None and name_el.text
                ]
                github_repo = self.find_first_github_repo(abstract, comment_text)
                stars = await self.fetch_github_stars(github_repo) if github_repo else None

                records.append(
                    {
                        "title": title,
                        "abstract": abstract,
                        "authors": authors,
                        "publication_date": pub_date,
                        "doi": doi,
                        "arxiv_id": arxiv_id,
                        "github_repository": github_repo,
                        "github_stars": stars,
                        "source_name": "arxiv",
                        "source_url": entry_url,
                        "collected_at": utc_now(),
                        "source_metadata": {"comment": comment_text},
                    }
                )
            start += len(entries)
            if len(entries) < batch_size:
                break
        return records, errors

    async def collect_from_crossref(
        self,
        query: str = "large language model",
        limit: int = 50,
        *,
        start_page: int = 1,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """Collect scholarly works from the official Crossref REST API."""
        records: list[dict[str, Any]] = []
        errors: list[dict[str, Any]] = []
        rows = min(50, max(5, limit))
        offset = max(0, (max(1, start_page) - 1) * rows)
        url = (
            f"https://api.crossref.org/works?query={quote_plus(query)}"
            f"&rows={rows}&offset={offset}&sort=published&order=desc"
        )

        res = await self.crawler.fetch(url, deduplicate=False, check_robots=False)
        if not res.ok:
            return records, [{"source": "crossref", "url": url, "error": res.error}]

        try:
            payload = json.loads(res.content)
        except ValueError as exc:
            return records, [{"source": "crossref", "url": url, "error": f"invalid_json: {exc}"}]

        items = (payload.get("message") or {}).get("items") or []
        for item in items[:limit]:
            titles = item.get("title") or []
            title = str(titles[0]).strip() if titles else ""
            item_url = item.get("URL")
            if not title or not item_url:
                continue

            raw_abstract = item.get("abstract")
            abstract = (
                BeautifulSoup(raw_abstract, "html.parser").get_text(" ", strip=True)
                if raw_abstract
                else None
            )
            authors = []
            for a in item.get("author") or []:
                full = f"{a.get('given', '')} {a.get('family', '')}".strip()
                if full:
                    authors.append(full)

            pub_parts = ((item.get("published") or {}).get("date-parts") or [[]])[0]
            pub_date = "-".join(f"{int(p):02d}" if idx > 0 else str(p) for idx, p in enumerate(pub_parts)) if pub_parts else None
            github_repo = self.find_first_github_repo(abstract)
            stars = await self.fetch_github_stars(github_repo) if github_repo else None

            records.append(
                {
                    "title": title,
                    "abstract": abstract,
                    "authors": authors,
                    "publication_date": pub_date,
                    "doi": item.get("DOI"),
                    "arxiv_id": None,
                    "github_repository": github_repo,
                    "github_stars": stars,
                    "source_name": "crossref",
                    "source_url": item_url,
                    "collected_at": utc_now(),
                    "source_metadata": {"publisher": item.get("publisher"), "type": item.get("type")},
                }
            )
        return records, errors

    async def collect(self, limit: Optional[int] = None, page: int = 1) -> CollectionBatch:
        """Collect paginated research papers across arXiv, OpenAlex, and Crossref."""
        target = limit or self.settings.target_research_papers
        safe_page = max(1, page)
        per_source = max(1, target // 3 + 1)

        arxiv_recs, arxiv_errs = await self.collect_from_arxiv(limit=per_source, start_page=safe_page)
        openalex_recs, openalex_errs = await self.collect_from_openalex(limit=per_source, start_page=safe_page)
        crossref_recs, crossref_errs = await self.collect_from_crossref(limit=min(50, per_source), start_page=safe_page)

        combined = (arxiv_recs + openalex_recs + crossref_recs)[:target]
        all_errors = arxiv_errs + openalex_errs + crossref_errs

        stats = CollectorStats(
            source_category=self.category,
            discovered=len(arxiv_recs) + len(openalex_recs) + len(crossref_recs),
            extracted=len(combined),
            failed=len(all_errors),
            unavailable_sources=[e["source"] for e in all_errors],
            page=safe_page,
            has_more=len(combined) >= target,
            next_page=(safe_page + 1) if len(combined) >= target else None,
        )
        return CollectionBatch(category=self.category, records=combined, stats=stats, errors=all_errors)
