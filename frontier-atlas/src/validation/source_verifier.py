"""Real-source verification, anomaly/placeholder/duplicate/outdated/mismatch detection, and audit trail."""

from __future__ import annotations

import asyncio
import json
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Optional

from bs4 import BeautifulSoup

from src.crawler.async_crawler import AsyncCrawler, FetchResult
from src.crawler.content_extractor import ContentExtractor
from src.schemas import (
    JobRecord,
    NewsRecord,
    ProductRecord,
    ResearchPaperRecord,
    StartupRecord,
    VerificationStatus,
)
from src.utils.date_utils import is_within_freshness_window, parse_utc_datetime, to_utc_iso, utc_now
from src.utils.logging_config import get_logger
from src.utils.url_utils import extract_domain, is_valid_http_url
from src.validation.deduplication import RecordDeduplicator

logger = get_logger("validation.source_verifier")

WS_RE = re.compile(r"\s+")
TOKEN_RE = re.compile(r"[a-z0-9]+")

FACILITY_CONTEXT_RE = re.compile(
    r"\b(?:factory|factories|manufacturing\s+plant|assembly\s+plant|production\s+facility|plant|"
    r"branch(?:\s+office)?|regional\s+office|satellite\s+office|field\s+office|"
    r"warehouse|distribution\s+center|fulfillment\s+center|retail\s+store|showroom)\b",
    re.IGNORECASE,
)

HQ_CONTEXT_RE = re.compile(
    r"\b(?:headquarter(?:s|ed)?|hq|corporate\s+headquarters|global\s+headquarters|"
    r"main\s+office|corporate\s+office|based\s+in|founded\s+in)\b",
    re.IGNORECASE,
)

PUBLIC_API_HOST_HINTS = (
    "api.github.com",
    "export.arxiv.org",
    "api.openalex.org",
    "api.crossref.org",
    "yc-oss.github.io",
    "hn.algolia.com",
    "boards-api.greenhouse.io",
    "remotive.com/api",
    "arbeitnow.com/api",
)

PLACEHOLDER_DOMAINS = frozenset(
    {
        "example.com",
        "example.org",
        "example.net",
        "localhost",
        "127.0.0.1",
        "0.0.0.0",
        "test.local",
        "dummy.com",
    }
)

PLACEHOLDER_TEXT_RE = re.compile(
    r"\b(?:lorem\s+ipsum|placeholder|dummy\s+(?:company|record|startup|product)|"
    r"mock\s+(?:record|company|data)|sample\s+(?:record|startup|data)|fabricated|"
    r"this\s+domain\s+is\s+(?:for\s+use\s+in\s+illustrative\s+examples|available\s+for\s+purchase))\b",
    re.IGNORECASE,
)

PARKED_DOMAIN_RE = re.compile(
    r"\b(?:namebright|coming\s+soon|domain\s+is\s+for\s+sale|buy\s+this\s+domain|"
    r"hugedomains|sedo\s+domain\s+parking|afternic|dan\.com|domain\s+parking|"
    r"this\s+domain\s+(?:name\s+)?may\s+be\s+for\s+sale|expired\s+domain)\b",
    re.IGNORECASE,
)

STOPWORDS = frozenset(
    {
        "the",
        "and",
        "for",
        "with",
        "that",
        "this",
        "from",
        "into",
        "are",
        "was",
        "were",
        "has",
        "have",
        "using",
        "via",
        "api",
        "inc",
        "llc",
        "ltd",
        "corp",
    }
)


def _norm_text(text: Optional[str]) -> str:
    return WS_RE.sub(" ", (text or "")).strip().lower()


def _meaningful_tokens(text: Optional[str]) -> list[str]:
    tokens = TOKEN_RE.findall(_norm_text(text))
    return [t for t in tokens if len(t) >= 2 and t not in STOPWORDS]


def text_supports_claim(claim: Optional[str], source_text: str, *, min_token_ratio: float = 0.65) -> bool:
    """Return True if a normalized claim or high token overlap is present in source_text."""
    if not claim or not source_text:
        return False
    norm_claim = _norm_text(claim)
    if not norm_claim or norm_claim == "unknown":
        return False
    norm_src = _norm_text(source_text)
    if norm_claim in norm_src:
        return True

    claim_tokens = _meaningful_tokens(norm_claim)
    if not claim_tokens:
        return False
    src_tokens = set(_meaningful_tokens(norm_src))
    if not src_tokens:
        return False
    matched = sum(1 for tok in claim_tokens if tok in src_tokens)
    return (matched / len(claim_tokens)) >= min_token_ratio


def extract_evidence_excerpt(claim: Optional[str], source_text: str, *, radius: int = 120) -> Optional[str]:
    """Return a concise real excerpt from source_text supporting claim, or None if not found."""
    if not claim or not source_text:
        return None
    clean_src = WS_RE.sub(" ", source_text).strip()
    norm_src = clean_src.lower()
    norm_claim = _norm_text(claim)
    if not norm_claim:
        return None
    idx = norm_src.find(norm_claim)
    if idx != -1:
        start = max(0, idx - radius)
        end = min(len(clean_src), idx + len(norm_claim) + radius)
        snippet = clean_src[start:end].strip()
        return ("..." if start > 0 else "") + snippet + ("..." if end < len(clean_src) else "")

    # Fallback: match first meaningful token if text_supports_claim passed
    if text_supports_claim(claim, source_text):
        tokens = _meaningful_tokens(claim)
        for tok in tokens:
            t_idx = norm_src.find(tok)
            if t_idx != -1:
                start = max(0, t_idx - radius)
                end = min(len(clean_src), t_idx + len(tok) + radius)
                snippet = clean_src[start:end].strip()
                return ("..." if start > 0 else "") + snippet + ("..." if end < len(clean_src) else "")
    return None


def assess_location_evidence(location: Optional[str], source_text: str) -> tuple[str, bool, bool]:
    """Verify a claimed location against source text while refusing to assume HQ from branch/factory text.

    Returns: (resolved_location, is_supported, hq_branch_guarded)
    """
    cleaned = (location or "").strip()
    if not cleaned or cleaned.lower() == "unknown":
        return "Unknown", False, False

    if not source_text:
        return "Unknown", False, False

    norm_src = _norm_text(source_text)
    primary_segment = _norm_text(cleaned.split(",")[0])
    candidates = [_norm_text(cleaned)]
    if primary_segment and primary_segment != candidates[0] and len(primary_segment) >= 3:
        candidates.append(primary_segment)

    matched_positions: list[tuple[int, int]] = []
    for cand in candidates:
        start = 0
        while True:
            idx = norm_src.find(cand, start)
            if idx == -1:
                break
            matched_positions.append((idx, idx + len(cand)))
            start = idx + len(cand)
        if matched_positions:
            break

    if not matched_positions:
        return "Unknown", False, False

    saw_facility_only = False
    for start_idx, end_idx in matched_positions:
        window = norm_src[max(0, start_idx - 90) : min(len(norm_src), end_idx + 90)]
        has_hq = bool(HQ_CONTEXT_RE.search(window))
        has_facility = bool(FACILITY_CONTEXT_RE.search(window))
        if has_hq:
            return cleaned, True, False
        if has_facility:
            saw_facility_only = True

    if saw_facility_only:
        return "Unknown", False, True

    return cleaned, True, False


@dataclass
class ExtractedSourceSnapshot:
    """Normalized representation of an accessible URL response."""

    url: str
    status: int
    accessible: bool
    title: Optional[str] = None
    text: str = ""
    json_payload: Any = None
    error: Optional[str] = None


@dataclass
class VerificationSummary:
    """Counts across VerificationStatus for a batch or repository."""

    verified: int = 0
    partially_verified: int = 0
    unverified: int = 0
    source_unavailable: int = 0
    rejected: int = 0

    def to_dict(self) -> dict[str, int]:
        return {
            VerificationStatus.VERIFIED.value: self.verified,
            VerificationStatus.PARTIALLY_VERIFIED.value: self.partially_verified,
            VerificationStatus.UNVERIFIED.value: self.unverified,
            VerificationStatus.SOURCE_UNAVAILABLE.value: self.source_unavailable,
            VerificationStatus.REJECTED.value: self.rejected,
        }


class SourceVerifier:
    """Verifies collected or persisted records directly against their original source URLs."""

    def __init__(
        self,
        crawler: Any,
        *,
        extractor: Optional[ContentExtractor] = None,
        max_concurrency: int = 4,
        per_url_timeout_seconds: float = 25.0,
        freshness_window_hours: int = 24,
        strict_placeholder_tlds: Optional[bool] = None,
    ) -> None:
        self.crawler = crawler
        self.extractor = extractor or ContentExtractor()
        self.semaphore = asyncio.Semaphore(max(1, max_concurrency))
        self.per_url_timeout_seconds = per_url_timeout_seconds
        self.freshness_window_hours = freshness_window_hours
        self.strict_placeholder_tlds = (
            isinstance(crawler, AsyncCrawler)
            if strict_placeholder_tlds is None
            else strict_placeholder_tlds
        )
        self._snapshot_cache: dict[str, ExtractedSourceSnapshot] = {}

    @staticmethod
    def _should_check_robots(url: str) -> bool:
        lower = url.lower()
        return not any(hint in lower for hint in PUBLIC_API_HOST_HINTS)

    def _is_placeholder_url(self, url: Optional[str]) -> bool:
        if not url:
            return False
        dom = extract_domain(url)
        if not dom:
            return False
        if dom in PLACEHOLDER_DOMAINS:
            return True
        if self.strict_placeholder_tlds and dom.endswith((".example", ".test", ".invalid", ".localhost")):
            return True
        return False

    def _detect_placeholder_signals(self, category: str, record: Any, combined_text: str = "") -> list[str]:
        reasons: list[str] = []
        urls_to_check = [
            getattr(record, "source_url", None),
            getattr(record, "website", None),
            getattr(record, "official_website", None),
            getattr(record, "application_url", None),
            getattr(record, "article_url", None),
        ]
        for u in urls_to_check:
            if self._is_placeholder_url(u):
                reasons.append(f"placeholder_domain:{extract_domain(u)}")
                break

        fields_text = " ".join(
            str(v)
            for v in (
                getattr(record, "name", None),
                getattr(record, "title", None),
                getattr(record, "headline", None),
                getattr(record, "description", None),
                getattr(record, "summary", None),
                getattr(record, "abstract", None),
                combined_text[:2000] if combined_text else "",
            )
            if v
        )
        m = PLACEHOLDER_TEXT_RE.search(fields_text)
        if m:
            reasons.append(f"placeholder_text:{m.group(0).lower()}")
        return reasons

    @staticmethod
    def _detect_incomplete_fields(category: str, record: Any) -> list[str]:
        missing: list[str] = []
        if category == "startups":
            if not getattr(record, "description", None):
                missing.append("description")
            if not (getattr(record, "website", None) or getattr(record, "official_website", None)):
                missing.append("website")
            if getattr(record, "industry", "Unknown") == "Unknown":
                missing.append("industry")
            if getattr(record, "location", "Unknown") == "Unknown":
                missing.append("location")
        elif category == "products":
            if not getattr(record, "description", None):
                missing.append("description")
            if not (getattr(record, "website", None) or getattr(record, "official_website", None)):
                missing.append("website")
            if getattr(record, "company_name", "Unknown") == "Unknown":
                missing.append("company_name")
            if getattr(record, "category", "Unknown") == "Unknown":
                missing.append("category")
        elif category == "research_papers":
            if not getattr(record, "abstract", None):
                missing.append("abstract")
            if not getattr(record, "authors", None):
                missing.append("authors")
            if not getattr(record, "publication_date", None):
                missing.append("publication_date")
        elif category == "jobs":
            if getattr(record, "company", "Unknown") == "Unknown":
                missing.append("company")
            if getattr(record, "location", "Unknown") == "Unknown":
                missing.append("location")
            if getattr(record, "employment_type", "Unknown") == "Unknown":
                missing.append("employment_type")
            if not getattr(record, "description", None):
                missing.append("description")
        elif category == "news":
            if not getattr(record, "summary", None):
                missing.append("summary")
            if getattr(record, "publisher", "Unknown") == "Unknown":
                missing.append("publisher")
        return missing

    async def _fetch_snapshot(self, url: str) -> ExtractedSourceSnapshot:
        if not is_valid_http_url(url):
            return ExtractedSourceSnapshot(url=url, status=0, accessible=False, error="invalid_url")

        cached = self._snapshot_cache.get(url)
        if cached is not None:
            return cached

        async with self.semaphore:
            cached = self._snapshot_cache.get(url)
            if cached is not None:
                return cached
            try:
                res: FetchResult = await asyncio.wait_for(
                    self.crawler.fetch(
                        url,
                        deduplicate=False,
                        check_robots=self._should_check_robots(url),
                    ),
                    timeout=self.per_url_timeout_seconds,
                )
            except asyncio.TimeoutError:
                snap = ExtractedSourceSnapshot(
                    url=url,
                    status=0,
                    accessible=False,
                    error="verification_timeout",
                )
                self._snapshot_cache[url] = snap
                return snap
            except Exception as exc:
                snap = ExtractedSourceSnapshot(
                    url=url,
                    status=0,
                    accessible=False,
                    error=f"verification_error:{exc}",
                )
                self._snapshot_cache[url] = snap
                return snap

            snapshot = self._parse_fetch_result(url, res)
            self._snapshot_cache[url] = snapshot
            return snapshot

    def _parse_fetch_result(self, requested_url: str, res: FetchResult) -> ExtractedSourceSnapshot:
        if not res.ok:
            return ExtractedSourceSnapshot(
                url=res.url or requested_url,
                status=res.status,
                accessible=False,
                error=res.error or f"http_{res.status}",
            )

        body = res.content or ""
        ctype = (res.content_type or "").lower()
        stripped = body.lstrip()

        if "application/pdf" in ctype or stripped.startswith("%PDF-"):
            return ExtractedSourceSnapshot(
                url=res.url or requested_url,
                status=res.status,
                accessible=True,
                title="PDF Document",
                text="",
                error="pdf_binary_not_text",
            )

        if "json" in ctype or stripped.startswith("{") or stripped.startswith("["):
            try:
                payload = json.loads(body)
                return ExtractedSourceSnapshot(
                    url=res.url or requested_url,
                    status=res.status,
                    accessible=True,
                    title=self._extract_json_feed_title(payload),
                    text=self._flatten_json_text(payload),
                    json_payload=payload,
                )
            except ValueError:
                pass

        if "xml" in ctype or stripped.startswith("<?xml") or stripped.startswith("<feed") or stripped.startswith("<rss"):
            xml_title, xml_text = self._extract_xml_summary(body)
            return ExtractedSourceSnapshot(
                url=res.url or requested_url,
                status=res.status,
                accessible=True,
                title=xml_title,
                text=xml_text,
            )

        page = self.extractor.extract(body, res.url or requested_url)
        title = page.title
        if not title and body:
            soup = BeautifulSoup(body, "html.parser")
            og = soup.find("meta", attrs={"property": "og:title"})
            if og and og.get("content"):
                title = WS_RE.sub(" ", str(og["content"])).strip() or None
            elif soup.find("h1"):
                title = WS_RE.sub(" ", soup.find("h1").get_text(" ", strip=True)).strip() or None

        combined_html_text = " ".join(part for part in (title, page.description, page.text) if part)
        return ExtractedSourceSnapshot(
            url=res.url or requested_url,
            status=res.status,
            accessible=True,
            title=title,
            text=combined_html_text,
        )

    @staticmethod
    def _extract_json_feed_title(payload: Any) -> Optional[str]:
        if isinstance(payload, dict):
            for key in ("full_name", "title", "name", "headline"):
                val = payload.get(key)
                if isinstance(val, str) and val.strip():
                    return val.strip()[:250]
        return None

    @staticmethod
    def _flatten_json_text(payload: Any, max_chars: int = 120000) -> str:
        parts: list[str] = []
        total = 0

        def walk(node: Any) -> None:
            nonlocal total
            if total >= max_chars:
                return
            if isinstance(node, dict):
                for val in node.values():
                    walk(val)
            elif isinstance(node, list):
                for item in node:
                    walk(item)
            elif isinstance(node, (str, int, float)):
                s = str(node).strip()
                if s:
                    parts.append(s)
                    total += len(s) + 1

        walk(payload)
        return " ".join(parts)[:max_chars]

    @staticmethod
    def _extract_xml_summary(xml_body: str) -> tuple[Optional[str], str]:
        try:
            root = ET.fromstring(xml_body)
        except ET.ParseError:
            soup = BeautifulSoup(xml_body, "html.parser")
            t = soup.find("title")
            return (t.get_text(" ", strip=True) if t else None), soup.get_text(" ", strip=True)

        title = None
        channel = root.find("channel")
        if channel is not None:
            t_el = channel.find("title")
            if t_el is not None and t_el.text:
                title = WS_RE.sub(" ", t_el.text).strip() or None
        if not title:
            for tag in ("{http://www.w3.org/2005/Atom}title", "title"):
                t_el = root.find(tag)
                if t_el is not None and t_el.text:
                    title = WS_RE.sub(" ", t_el.text).strip() or None
                    break

        text_chunks = [el.text.strip() for el in root.iter() if el.text and el.text.strip()]
        return title, " ".join(text_chunks)[:120000]

    @staticmethod
    def _match_json_item_text(payload: Any, primary_value: str, fallback_url: Optional[str] = None) -> Optional[str]:
        items: list[dict[str, Any]] = []
        if isinstance(payload, list):
            items = [x for x in payload if isinstance(x, dict)]
        elif isinstance(payload, dict):
            for key in ("items", "results", "jobs", "data", "hits"):
                val = payload.get(key)
                if isinstance(val, list):
                    items = [x for x in val if isinstance(x, dict)]
                    break
            if not items:
                return None

        target_norm = _norm_text(primary_value)
        for item in items:
            item_json = json.dumps(item, ensure_ascii=False).lower()
            if fallback_url and fallback_url.lower() in item_json:
                return " ".join(str(v) for v in item.values() if v is not None)
            for key in ("name", "title", "headline", "full_name"):
                v = item.get(key)
                if isinstance(v, str) and _norm_text(v) == target_norm:
                    return " ".join(str(val) for val in item.values() if val is not None)
        return None

    async def verify_record(
        self,
        category: str,
        record: Any,
        *,
        checked_at: Optional[datetime] = None,
        duplicate_of: Optional[str] = None,
        live_check: bool = True,
    ) -> Any:
        """Verify a single record's accuracy, URL accessibility, freshness, completeness, and evidence."""
        now = checked_at or utc_now()
        source_url = record.source_url
        meta = dict(getattr(record, "source_metadata", {}) or {})
        meta["verification_mode"] = "live_http_check" if live_check else "offline_unverified"
        issues: list[str] = []

        # 1. Inspect core timestamps (outdated check for Jobs/News & future collected_at)
        collected_dt = parse_utc_datetime(getattr(record, "collected_at", None))
        if collected_dt and collected_dt > now + timedelta(minutes=10):
            issues.append("future_collected_at")

        if category in {"jobs", "news"}:
            pub_field = "posted_at" if category == "jobs" else "published_at"
            pub_dt = parse_utc_datetime(getattr(record, pub_field, None))
            is_fresh, fresh_reason = is_within_freshness_window(
                pub_dt,
                reference_time=now,
                window_hours=self.freshness_window_hours,
            )
            if not is_fresh:
                issues.append(f"outdated:{fresh_reason}")

        # 2. Check duplicate detection signal passed from repository audit
        if duplicate_of:
            issues.append("duplicate_record")
            meta["duplicate_of"] = duplicate_of

        # 3. Check completeness
        incomplete_fields = self._detect_incomplete_fields(category, record)
        if incomplete_fields:
            issues.append("incomplete_fields")
            meta["incomplete_fields"] = incomplete_fields

        # 4. Placeholder check prior to or regardless of HTTP
        placeholder_reasons = self._detect_placeholder_signals(category, record)
        if placeholder_reasons:
            issues.extend(placeholder_reasons)

        updates: dict[str, Any] = {"last_checked_at": now}
        if category in {"startups", "products"}:
            site = getattr(record, "official_website", None) or getattr(record, "website", None)
            if site:
                updates["official_website"] = site

        if not live_check:
            # Never invent verification if live verification cannot run
            status = (
                VerificationStatus.REJECTED
                if (placeholder_reasons or any(i.startswith("outdated:") for i in issues))
                else VerificationStatus.UNVERIFIED
            )
            rej_reason = "; ".join(placeholder_reasons + [i for i in issues if i.startswith("outdated:")]) or None
            exact_reason = rej_reason or "Live HTTP verification was not performed (offline audit mode); evidence cannot be fabricated."
            meta["audit_issues"] = sorted(set(issues))
            meta["source_evidence_excerpt"] = None
            meta["verification_reason"] = exact_reason
            if category == "startups":
                site_url = getattr(record, "official_website", None) or getattr(record, "website", None)
                meta["startup_verification_report"] = {
                    "company_name_match": {"matched": False, "claimed": getattr(record, "name", ""), "evidence": None, "source_url": source_url},
                    "official_website_validity": {"valid_url": is_valid_http_url(site_url) if site_url else False, "accessible": None, "http_status": None, "url": site_url, "page_title": None, "error": "offline_not_checked"},
                    "description_match": {"matched": False, "claimed": getattr(record, "description", None), "evidence": None},
                    "industry_evidence": {"matched": False, "claimed": getattr(record, "industry", "Unknown"), "evidence": None},
                    "location_evidence": {"matched": False, "claimed": getattr(record, "location", "Unknown"), "evidence": None, "hq_guard_triggered": False},
                    "source_accessibility": {"accessible": False, "http_status": None, "source_url": source_url, "source_title": getattr(record, "source_title", None), "error": "offline_not_checked"},
                    "verification_timestamp": to_utc_iso(now),
                    "exact_reason": exact_reason,
                }
            updates.update(
                {
                    "supported_fields": [],
                    "verification_status": status,
                    "rejection_reason": rej_reason,
                    "source_metadata": meta,
                }
            )
            return record.model_copy(update=updates)

        # 5. Live HTTP verification against source_url and secondary target URL
        fetch_source_url = (
            "https://" + source_url[len("http://"):]
            if source_url.startswith("http://arxiv.org/")
            else source_url
        )
        primary_snap = await self._fetch_snapshot(fetch_source_url)

        secondary_url: Optional[str] = None
        if category in {"startups", "products"}:
            secondary_url = getattr(record, "official_website", None) or getattr(record, "website", None)
        elif category == "jobs":
            secondary_url = getattr(record, "application_url", None)
        elif category == "news":
            secondary_url = getattr(record, "article_url", None)
        elif category == "research_papers":
            secondary_url = meta.get("openalex_api_url") or getattr(record, "official_website", None)
            if isinstance(secondary_url, str) and "openalex.org/W" in secondary_url and "api.openalex.org" not in secondary_url:
                secondary_url = f"https://api.openalex.org/works/{secondary_url.rstrip('/').split('/')[-1]}"
            if not secondary_url and getattr(record, "arxiv_id", None):
                secondary_url = f"https://export.arxiv.org/api/query?id_list={getattr(record, 'arxiv_id')}"
            if not secondary_url and getattr(record, "doi", None):
                secondary_url = f"https://api.crossref.org/works/{getattr(record, 'doi')}"

        if secondary_url == source_url or secondary_url == fetch_source_url:
            secondary_url = None

        secondary_snap: Optional[ExtractedSourceSnapshot] = None
        if secondary_url and is_valid_http_url(secondary_url):
            secondary_snap = await self._fetch_snapshot(secondary_url)

        meta["source_http_status"] = primary_snap.status
        if primary_snap.error:
            meta["source_error"] = primary_snap.error
        if secondary_snap is not None:
            meta["secondary_url_checked"] = secondary_snap.url
            meta["secondary_http_status"] = secondary_snap.status
            meta["secondary_accessible"] = secondary_snap.accessible

        if not primary_snap.accessible:
            issues.append(f"source_unavailable:{primary_snap.error or 'unreachable'}")
            status = (
                VerificationStatus.REJECTED
                if (placeholder_reasons or any(i.startswith("outdated:") for i in issues))
                else VerificationStatus.SOURCE_UNAVAILABLE
            )
            rej_reason = (
                "; ".join(placeholder_reasons + [i for i in issues if i.startswith("outdated:")])
                if status == VerificationStatus.REJECTED
                else None
            )
            exact_reason = rej_reason or f"Primary source URL could not be accessed ({primary_snap.error or 'unreachable'})."
            meta["audit_issues"] = sorted(set(issues))
            meta["source_evidence_excerpt"] = None
            meta["verification_reason"] = exact_reason
            if category == "startups":
                site_url = getattr(record, "official_website", None) or getattr(record, "website", None)
                meta["startup_verification_report"] = {
                    "company_name_match": {"matched": False, "claimed": getattr(record, "name", ""), "evidence": None, "source_url": source_url},
                    "official_website_validity": {
                        "valid_url": is_valid_http_url(site_url) if site_url else False,
                        "accessible": secondary_snap.accessible if secondary_snap else None,
                        "http_status": secondary_snap.status if secondary_snap else None,
                        "url": site_url,
                        "page_title": secondary_snap.title if secondary_snap else None,
                        "error": secondary_snap.error if secondary_snap else None,
                    },
                    "description_match": {"matched": False, "claimed": getattr(record, "description", None), "evidence": None},
                    "industry_evidence": {"matched": False, "claimed": getattr(record, "industry", "Unknown"), "evidence": None},
                    "location_evidence": {"matched": False, "claimed": getattr(record, "location", "Unknown"), "evidence": None, "hq_guard_triggered": False},
                    "source_accessibility": {
                        "accessible": False,
                        "http_status": primary_snap.status,
                        "source_url": source_url,
                        "source_title": primary_snap.title,
                        "error": primary_snap.error or "unreachable",
                    },
                    "verification_timestamp": to_utc_iso(now),
                    "exact_reason": exact_reason,
                }
            updates.update(
                {
                    "source_title": secondary_snap.title if (secondary_snap and secondary_snap.accessible) else None,
                    "supported_fields": [],
                    "verification_status": status,
                    "rejection_reason": rej_reason,
                    "source_metadata": meta,
                }
            )
            return record.model_copy(update=updates)

        # Build combined accessible evidence text
        primary_claim = (
            getattr(record, "name", None)
            or getattr(record, "title", None)
            or getattr(record, "headline", None)
            or ""
        )
        primary_evidence_text = primary_snap.text
        if primary_snap.json_payload is not None:
            matched_item = self._match_json_item_text(
                primary_snap.json_payload,
                primary_claim,
                fallback_url=secondary_url,
            )
            primary_evidence_text = matched_item if matched_item is not None else ""

        combined_parts = [primary_evidence_text]
        if secondary_snap and secondary_snap.accessible and secondary_snap.text:
            combined_parts.append(secondary_snap.text)
        combined_text = " ".join(part for part in combined_parts if part)

        # Detect placeholder text in the fetched page content too (e.g. parked domain)
        body_placeholders = self._detect_placeholder_signals(category, record, combined_text=combined_text)
        for reason in body_placeholders:
            if reason not in issues:
                issues.append(reason)
        if body_placeholders:
            placeholder_reasons = sorted(set(placeholder_reasons + body_placeholders))

        resolved_title = (
            (secondary_snap.title if (secondary_snap and secondary_snap.accessible and secondary_snap.title) else None)
            or primary_snap.title
            or (primary_claim if text_supports_claim(primary_claim, primary_evidence_text) else None)
        )
        updates["source_title"] = resolved_title[:512] if resolved_title else None

        supported_fields: list[str] = []
        unsupported_claims: list[str] = []

        if category == "startups":
            original_location = record.location
            primary_ok = text_supports_claim(record.name, combined_text, min_token_ratio=0.8)
            if primary_ok:
                supported_fields.append("name")
            else:
                unsupported_claims.append("name")

            desc_ok = False
            if record.description:
                if text_supports_claim(record.description, combined_text, min_token_ratio=0.55):
                    supported_fields.append("description")
                    desc_ok = True
                else:
                    unsupported_claims.append("description")

            website_ok = False
            site_parked = False
            if record.website:
                dom = extract_domain(record.website)
                if secondary_snap is not None:
                    if secondary_snap.accessible:
                        sec_blob = f"{secondary_snap.title or ''} {secondary_snap.text[:1200]}"
                        if PARKED_DOMAIN_RE.search(sec_blob):
                            site_parked = True
                            issues.append("parked_or_forsale_website")
                            meta["parked_website_detected"] = True
                            website_ok = False
                        else:
                            website_ok = True
                    else:
                        website_ok = False
                else:
                    website_ok = bool(primary_snap.accessible and dom and dom in combined_text.lower())
                if website_ok:
                    supported_fields.append("website")
                else:
                    unsupported_claims.append("website")

            industry_ok = False
            if record.industry and record.industry != "Unknown":
                if text_supports_claim(record.industry, combined_text, min_token_ratio=0.7):
                    supported_fields.append("industry")
                    industry_ok = True
                else:
                    unsupported_claims.append("industry")

            loc_ok = False
            hq_guarded = False
            if record.location and record.location != "Unknown":
                loc_val, loc_ok, hq_guarded = assess_location_evidence(record.location, combined_text)
                if loc_ok:
                    supported_fields.append("location")
                    updates["location"] = loc_val
                else:
                    updates["location"] = "Unknown"
                    unsupported_claims.append("location")
                    if hq_guarded:
                        meta["hq_guard_triggered"] = True
                        issues.append("hq_branch_guard_triggered")

            if record.founding_date:
                if record.founding_date[:4] in combined_text:
                    supported_fields.append("founding_date")
                else:
                    unsupported_claims.append("founding_date")

        elif category == "products":
            primary_ok = text_supports_claim(record.name, combined_text, min_token_ratio=0.8)
            if primary_ok:
                supported_fields.append("name")
            else:
                unsupported_claims.append("name")

            if record.company_name and record.company_name != "Unknown":
                if text_supports_claim(record.company_name, combined_text, min_token_ratio=0.75):
                    supported_fields.append("company_name")
                else:
                    unsupported_claims.append("company_name")

            if record.description:
                if text_supports_claim(record.description, combined_text, min_token_ratio=0.55):
                    supported_fields.append("description")
                else:
                    unsupported_claims.append("description")

            if record.category and record.category != "Unknown":
                if text_supports_claim(record.category, combined_text, min_token_ratio=0.7) or record.category == "Show HN Launch":
                    supported_fields.append("category")
                else:
                    unsupported_claims.append("category")

            if record.website:
                dom = extract_domain(record.website)
                if secondary_snap is not None:
                    sec_blob = f"{secondary_snap.title or ''} {secondary_snap.text[:1200]}"
                    if secondary_snap.accessible and PARKED_DOMAIN_RE.search(sec_blob):
                        issues.append("parked_or_forsale_website")
                        unsupported_claims.append("website")
                    elif secondary_snap.accessible:
                        supported_fields.append("website")
                    else:
                        unsupported_claims.append("website")
                elif dom and dom in combined_text.lower():
                    supported_fields.append("website")
                else:
                    unsupported_claims.append("website")

        elif category == "research_papers":
            primary_ok = text_supports_claim(record.title, combined_text, min_token_ratio=0.75)
            if primary_ok:
                supported_fields.append("title")
            else:
                unsupported_claims.append("title")

            if record.abstract:
                if text_supports_claim(record.abstract[:300], combined_text, min_token_ratio=0.55):
                    supported_fields.append("abstract")
                else:
                    unsupported_claims.append("abstract")

            if record.authors:
                first_author_last = record.authors[0].split()[-1] if record.authors[0].split() else record.authors[0]
                if text_supports_claim(first_author_last, combined_text, min_token_ratio=0.8):
                    supported_fields.append("authors")
                else:
                    unsupported_claims.append("authors")

            if record.doi:
                if record.doi.lower() in combined_text.lower():
                    supported_fields.append("doi")
                else:
                    unsupported_claims.append("doi")

            if record.arxiv_id:
                base_id = record.arxiv_id.split("v")[0].lower()
                if base_id in combined_text.lower() or base_id in source_url.lower():
                    supported_fields.append("arxiv_id")
                else:
                    unsupported_claims.append("arxiv_id")

            if record.github_repository:
                if record.github_repository.lower() in combined_text.lower():
                    supported_fields.append("github_repository")
                else:
                    unsupported_claims.append("github_repository")

        elif category == "jobs":
            primary_ok = text_supports_claim(record.title, combined_text, min_token_ratio=0.75)
            if primary_ok:
                supported_fields.append("title")
            else:
                unsupported_claims.append("title")

            if record.company and record.company != "Unknown":
                if text_supports_claim(record.company, combined_text, min_token_ratio=0.75) or record.source_name.startswith("greenhouse:"):
                    supported_fields.append("company")
                else:
                    unsupported_claims.append("company")

            if record.description:
                if text_supports_claim(record.description[:300], combined_text, min_token_ratio=0.55):
                    supported_fields.append("description")
                else:
                    unsupported_claims.append("description")

            if record.location and record.location != "Unknown":
                loc_val, loc_ok, hq_guarded = assess_location_evidence(record.location, combined_text)
                if loc_ok or (record.location.lower() == "remote" and "remote" in combined_text.lower()):
                    supported_fields.append("location")
                    if loc_ok:
                        updates["location"] = loc_val
                else:
                    updates["location"] = "Unknown"
                    unsupported_claims.append("location")
                    if hq_guarded:
                        meta["hq_guard_triggered"] = True
                        issues.append("hq_branch_guard_triggered")

            if record.employment_type and record.employment_type != "Unknown":
                if text_supports_claim(record.employment_type, combined_text, min_token_ratio=0.7):
                    supported_fields.append("employment_type")
                else:
                    unsupported_claims.append("employment_type")

        elif category == "news":
            primary_ok = text_supports_claim(record.headline, combined_text, min_token_ratio=0.75)
            if primary_ok:
                supported_fields.append("headline")
            else:
                unsupported_claims.append("headline")

            if record.publisher and record.publisher != "Unknown":
                if (
                    text_supports_claim(record.publisher, combined_text, min_token_ratio=0.7)
                    or record.publisher == "Hacker News"
                ):
                    supported_fields.append("publisher")
                else:
                    unsupported_claims.append("publisher")

            if record.summary:
                if text_supports_claim(record.summary[:300], combined_text, min_token_ratio=0.55):
                    supported_fields.append("summary")
                else:
                    unsupported_claims.append("summary")

            if record.article_url:
                if (secondary_snap and secondary_snap.accessible) or (record.article_url.lower() in combined_text.lower()):
                    supported_fields.append("article_url")
                else:
                    unsupported_claims.append("article_url")
        else:
            primary_ok = False

        if not primary_ok:
            issues.append("mismatched_source_content")

        evidence_excerpt = extract_evidence_excerpt(primary_claim, combined_text) if primary_ok else None
        meta["source_evidence_excerpt"] = evidence_excerpt
        meta["unsupported_fields"] = unsupported_claims
        meta["audit_issues"] = sorted(set(issues))

        outdated_issues = [i for i in issues if i.startswith("outdated:") or i == "future_collected_at"]
        rejection_reason: Optional[str] = None

        if placeholder_reasons:
            status = VerificationStatus.REJECTED
            rejection_reason = f"Placeholder or fabricated signal detected: {', '.join(placeholder_reasons)}"
        elif duplicate_of:
            status = VerificationStatus.REJECTED
            rejection_reason = f"Duplicate of existing record {duplicate_of}"
        elif outdated_issues:
            status = VerificationStatus.REJECTED
            rejection_reason = f"Outdated or invalid timestamp: {', '.join(outdated_issues)}"
        elif not primary_ok or not supported_fields:
            status = VerificationStatus.UNVERIFIED
            rejection_reason = (
                "Accessible source did not corroborate primary record name/title"
                if primary_snap.accessible
                else None
            )
        elif len(supported_fields) >= 2 and not unsupported_claims and not incomplete_fields:
            status = VerificationStatus.VERIFIED
        else:
            status = VerificationStatus.PARTIALLY_VERIFIED

        # Compute detailed, human-readable verification reason for all outcomes
        if status == VerificationStatus.VERIFIED:
            verification_reason = (
                f"All required fields ({', '.join(supported_fields)}) were corroborated by accessible live source content."
            )
        elif status == VerificationStatus.PARTIALLY_VERIFIED:
            gap_parts: list[str] = []
            if unsupported_claims:
                gap_parts.append(f"uncorroborated fields: {', '.join(unsupported_claims)}")
            if incomplete_fields:
                gap_parts.append(f"missing/unknown fields: {', '.join(incomplete_fields)}")
            if secondary_snap is not None and not secondary_snap.accessible:
                gap_parts.append(
                    f"official website unreachable ({secondary_snap.error or f'http_{secondary_snap.status}'})"
                )
            verification_reason = (
                f"Supported fields: {', '.join(supported_fields)}; "
                + ("; ".join(gap_parts) if gap_parts else "insufficient evidence across all required fields")
            )
        else:
            verification_reason = rejection_reason or "Source did not sufficiently corroborate record claims."

        meta["verification_reason"] = verification_reason

        if category == "startups":
            site_url = getattr(record, "official_website", None) or getattr(record, "website", None)
            meta["startup_verification_report"] = {
                "company_name_match": {
                    "matched": primary_ok,
                    "claimed": record.name,
                    "evidence": extract_evidence_excerpt(record.name, combined_text, radius=90) if primary_ok else None,
                    "source_url": source_url,
                },
                "official_website_validity": {
                    "valid_url": is_valid_http_url(site_url) if site_url else False,
                    "accessible": (
                        secondary_snap.accessible
                        if secondary_snap is not None
                        else (primary_snap.accessible if site_url == source_url else website_ok)
                    ),
                    "http_status": (
                        secondary_snap.status
                        if secondary_snap is not None
                        else (primary_snap.status if site_url == source_url else None)
                    ),
                    "url": site_url,
                    "page_title": secondary_snap.title if secondary_snap is not None else None,
                    "error": (
                        "parked_or_forsale_domain"
                        if site_parked
                        else (
                            secondary_snap.error
                            if secondary_snap is not None
                            else (None if site_url else "missing_website")
                        )
                    ),
                },
                "description_match": {
                    "matched": desc_ok,
                    "claimed": record.description,
                    "evidence": (
                        extract_evidence_excerpt(record.description[:80], combined_text, radius=100)
                        if (desc_ok and record.description)
                        else None
                    ),
                },
                "industry_evidence": {
                    "matched": industry_ok,
                    "claimed": record.industry,
                    "evidence": (
                        extract_evidence_excerpt(record.industry, combined_text, radius=80)
                        if industry_ok
                        else None
                    ),
                },
                "location_evidence": {
                    "matched": loc_ok,
                    "claimed": original_location,
                    "evidence": (
                        extract_evidence_excerpt(original_location.split(",")[0], combined_text, radius=80)
                        if loc_ok
                        else None
                    ),
                    "hq_guard_triggered": hq_guarded,
                },
                "source_accessibility": {
                    "accessible": primary_snap.accessible,
                    "http_status": primary_snap.status,
                    "source_url": source_url,
                    "source_title": updates.get("source_title"),
                    "error": primary_snap.error,
                },
                "verification_timestamp": to_utc_iso(now),
                "exact_reason": verification_reason,
            }

        updates.update(
            {
                "supported_fields": supported_fields,
                "verification_status": status,
                "rejection_reason": rejection_reason,
                "source_metadata": meta,
            }
        )
        return record.model_copy(update=updates)

    async def verify_batch(
        self,
        category: str,
        records: list[Any],
        *,
        live_check: bool = True,
        duplicate_map: Optional[dict[str, str]] = None,
    ) -> tuple[list[Any], VerificationSummary]:
        """Verify all records in a batch with bounded concurrency."""
        if not records:
            return [], VerificationSummary()

        checked_at = utc_now()
        id_attr = {
            "startups": "startup_id",
            "products": "product_id",
            "research_papers": "paper_id",
            "jobs": "job_id",
            "news": "news_id",
        }.get(category, "")

        verified_records = await asyncio.gather(
            *(
                self.verify_record(
                    category,
                    rec,
                    checked_at=checked_at,
                    duplicate_of=(duplicate_map or {}).get(getattr(rec, id_attr, "")),
                    live_check=live_check,
                )
                for rec in records
            )
        )
        summary = VerificationSummary()
        for rec in verified_records:
            st = rec.verification_status
            if st == VerificationStatus.VERIFIED:
                summary.verified += 1
            elif st == VerificationStatus.PARTIALLY_VERIFIED:
                summary.partially_verified += 1
            elif st == VerificationStatus.SOURCE_UNAVAILABLE:
                summary.source_unavailable += 1
            elif st == VerificationStatus.REJECTED:
                summary.rejected += 1
            else:
                summary.unverified += 1
        return list(verified_records), summary

    @staticmethod
    def _build_audit_reason(rec: Any, previous_status: Optional[str]) -> str:
        meta = getattr(rec, "source_metadata", {}) or {}
        issues = meta.get("audit_issues") or []
        supported = getattr(rec, "supported_fields", []) or []
        rej = getattr(rec, "rejection_reason", None)
        parts: list[str] = []
        if previous_status and previous_status != rec.verification_status.value:
            parts.append(f"Status changed from '{previous_status}' to '{rec.verification_status.value}'")
        else:
            parts.append(f"Verified status assessed as '{rec.verification_status.value}'")
        if supported:
            parts.append(f"supported fields: {', '.join(supported)}")
        if issues:
            parts.append(f"detected issues: {', '.join(issues)}")
        if rej:
            parts.append(f"reason: {rej}")
        return "; ".join(parts)

    async def _audit_entity_mapping_log(
        self,
        repo: Any,
        *,
        live_check: bool = True,
        remove_duplicates: bool = False,
    ) -> tuple[dict[str, int], list[dict[str, Any]], int]:
        """Audit the entity_mapping_log table for duplicates, placeholder names, canonical integrity, and source URLs."""
        raw_rows = repo.list_all("entity_mapping_log")
        if not raw_rows:
            return VerificationSummary().to_dict(), [], 0

        canonical_rows = repo.fetch_dataset("canonical_entities")
        canonical_ids = {str(r.get("canonical_id") or "") for r in canonical_rows}
        seen_keys: dict[tuple[str, str, str, str], str] = {}
        dup_ids: list[str] = []
        audit_entries: list[dict[str, Any]] = []
        summary = VerificationSummary()
        now_iso = to_utc_iso(utc_now())

        for row in raw_rows:
            map_id = str(row.get("mapping_id") or "")
            raw_name = str(row.get("raw_name") or "").strip()
            canonical_id = str(row.get("canonical_id") or "").strip()
            src_url = str(row.get("source_url") or "").strip()
            entity_type = str(row.get("entity_type") or "company").strip().lower()
            dedup_key = (raw_name.lower(), canonical_id, src_url, entity_type)

            issues: list[str] = []
            if dedup_key in seen_keys:
                issues.append(f"duplicate_mapping_of:{seen_keys[dedup_key]}")
                dup_ids.append(map_id)
            else:
                seen_keys[dedup_key] = map_id

            if not raw_name or PLACEHOLDER_TEXT_RE.search(raw_name) or self._is_placeholder_url(src_url):
                issues.append("placeholder_entity_or_url")
            if canonical_ids and canonical_id not in canonical_ids:
                issues.append("missing_canonical_entity")

            source_ok = True
            source_title: Optional[str] = None
            if not is_valid_http_url(src_url):
                issues.append("invalid_source_url")
                source_ok = False
            elif live_check and dedup_key[0] and not dup_ids[-1:] == [map_id]:
                snap = await self._fetch_snapshot(src_url)
                source_ok = snap.accessible
                source_title = snap.title
                if not snap.accessible:
                    issues.append(f"source_unavailable:{snap.error or 'unreachable'}")

            if any(i.startswith("duplicate_mapping_of:") or i == "placeholder_entity_or_url" for i in issues):
                status = VerificationStatus.REJECTED.value
                summary.rejected += 1
            elif not source_ok:
                status = VerificationStatus.SOURCE_UNAVAILABLE.value
                summary.source_unavailable += 1
            elif not live_check:
                status = VerificationStatus.UNVERIFIED.value
                summary.unverified += 1
            elif issues:
                status = VerificationStatus.PARTIALLY_VERIFIED.value
                summary.partially_verified += 1
            else:
                status = VerificationStatus.VERIFIED.value
                summary.verified += 1

            if issues or status != VerificationStatus.VERIFIED.value:
                audit_entries.append(
                    {
                        "category": "entity_mapping_log",
                        "record_id": map_id,
                        "record_name": raw_name,
                        "previous_status": None,
                        "new_status": status,
                        "issues": issues,
                        "source_url": src_url,
                        "source_title": source_title,
                        "evidence_excerpt": None,
                        "reason": (
                            f"Entity mapping audited as '{status}'"
                            + (f"; issues: {', '.join(issues)}" if issues else "; offline check")
                        ),
                        "checked_at": now_iso,
                    }
                )

        removed = 0
        if remove_duplicates and dup_ids:
            removed = repo.delete_records("entity_mapping_log", dup_ids)
        return summary.to_dict(), audit_entries, removed

    async def audit_repository(
        self,
        repo: Any,
        *,
        categories: tuple[str, ...] = (
            "startups",
            "products",
            "research_papers",
            "jobs",
            "news",
            "entity_mapping_log",
        ),
        live_check: bool = True,
        remove_duplicates: bool = False,
    ) -> dict[str, Any]:
        """Re-verify all existing database rows across all datasets and record an audit trail."""
        from src.validation.validators import SCHEMA_BY_CATEGORY

        id_field_map = {
            "startups": ("startup_id", "name"),
            "products": ("product_id", "name"),
            "research_papers": ("paper_id", "title"),
            "jobs": ("job_id", "title"),
            "news": ("news_id", "headline"),
        }

        per_category_summary: dict[str, dict[str, int]] = {}
        audit_entries: list[dict[str, Any]] = []
        duplicates_removed: dict[str, int] = {}

        for category in categories:
            if category == "entity_mapping_log":
                em_summary, em_audits, em_removed = await self._audit_entity_mapping_log(
                    repo, live_check=live_check, remove_duplicates=remove_duplicates
                )
                per_category_summary["entity_mapping_log"] = em_summary
                audit_entries.extend(em_audits)
                duplicates_removed["entity_mapping_log"] = em_removed
                continue

            schema_cls = SCHEMA_BY_CATEGORY[category]
            id_col, name_col = id_field_map[category]
            raw_rows = repo.list_all(category)
            if not raw_rows:
                per_category_summary[category] = VerificationSummary().to_dict()
                duplicates_removed[category] = 0
                continue

            models: list[Any] = []
            prev_status_by_id: dict[str, Optional[str]] = {}
            for row in raw_rows:
                parsed_row = dict(row)
                prev_status = parsed_row.get("verification_status")
                if "authors_json" in parsed_row:
                    try:
                        parsed_row["authors"] = json.loads(parsed_row.pop("authors_json") or "[]")
                    except ValueError:
                        parsed_row["authors"] = []
                if "supported_fields_json" in parsed_row:
                    parsed_row["supported_fields"] = parsed_row.pop("supported_fields_json")
                if "source_metadata_json" in parsed_row:
                    try:
                        parsed_row["source_metadata"] = json.loads(parsed_row.pop("source_metadata_json") or "{}")
                    except ValueError:
                        parsed_row["source_metadata"] = {}
                try:
                    model = schema_cls(**parsed_row)
                    models.append(model)
                    prev_status_by_id[getattr(model, id_col)] = prev_status
                except Exception as exc:
                    rec_id = str(row.get(id_col) or "unknown")
                    rec_name = str(row.get(name_col) or "Unknown")
                    audit_entries.append(
                        {
                            "category": category,
                            "record_id": rec_id,
                            "record_name": rec_name,
                            "previous_status": prev_status,
                            "new_status": VerificationStatus.REJECTED.value,
                            "issues": ["schema_validation_error"],
                            "source_url": row.get("source_url"),
                            "source_title": row.get("source_title"),
                            "evidence_excerpt": None,
                            "reason": f"Malformed persisted row: {exc}",
                            "checked_at": to_utc_iso(utc_now()),
                        }
                    )

            dedup = RecordDeduplicator()
            seen_keys: dict[str, str] = {}
            duplicate_map: dict[str, str] = {}
            for model in models:
                rec_id = getattr(model, id_col)
                keys = dedup._dedup_keys(category, model)
                matched_id = next((seen_keys[k] for k in keys if k in seen_keys and seen_keys[k] != rec_id), None)
                if matched_id:
                    duplicate_map[rec_id] = matched_id
                for k in keys:
                    seen_keys.setdefault(k, rec_id)

            verified_models, summary = await self.verify_batch(
                category,
                models,
                live_check=live_check,
                duplicate_map=duplicate_map,
            )

            existing_audits = {
                a["record_id"] for a in repo.fetch_audit_trail(category=category, limit=5000)
            }

            dup_ids_to_delete: list[str] = []
            non_dup_models: list[Any] = []
            for rec in verified_models:
                rec_id = getattr(rec, id_col)
                prev_st = prev_status_by_id.get(rec_id)
                new_st = rec.verification_status.value
                meta = rec.source_metadata or {}
                is_dup = rec_id in duplicate_map
                if prev_st != new_st or rec_id not in existing_audits or meta.get("audit_issues"):
                    audit_entries.append(
                        {
                            "category": category,
                            "record_id": rec_id,
                            "record_name": getattr(rec, name_col, ""),
                            "previous_status": prev_st,
                            "new_status": new_st,
                            "issues": meta.get("audit_issues") or [],
                            "source_url": rec.source_url,
                            "source_title": rec.source_title,
                            "evidence_excerpt": meta.get("source_evidence_excerpt"),
                            "reason": self._build_audit_reason(rec, prev_st),
                            "checked_at": to_utc_iso(rec.last_checked_at) or to_utc_iso(utc_now()),
                        }
                    )
                if remove_duplicates and is_dup:
                    dup_ids_to_delete.append(rec_id)
                else:
                    non_dup_models.append(rec)

            if non_dup_models:
                upsert_method = getattr(repo, f"upsert_{category}")
                upsert_method(non_dup_models)
            removed_cnt = 0
            if remove_duplicates and dup_ids_to_delete:
                removed_cnt = repo.delete_records(category, dup_ids_to_delete)
            duplicates_removed[category] = removed_cnt
            per_category_summary[category] = summary.to_dict()

        if audit_entries:
            repo.record_audit_entries(audit_entries)

        return {
            "auditedCategories": per_category_summary,
            "auditEntriesLogged": len(audit_entries),
            "duplicatesRemoved": duplicates_removed,
        }
