"""HTML content extraction using BeautifulSoup."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from src.utils.url_utils import canonical_github_repo_url, is_valid_http_url

WHITESPACE_RE = re.compile(r"\s+")
GITHUB_LINK_RE = re.compile(r"https?://(?:www\.)?github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", re.IGNORECASE)


@dataclass
class ExtractedPage:
    """Structured HTML content extracted from a fetched web page."""

    url: str
    title: Optional[str] = None
    description: Optional[str] = None
    canonical_url: Optional[str] = None
    text: str = ""
    github_links: list[str] = field(default_factory=list)
    outbound_links: list[str] = field(default_factory=list)


class ContentExtractor:
    """Parses raw HTML into clean text, metadata, and discovered links."""

    STRIP_TAGS = ("script", "style", "noscript", "svg", "iframe", "template")

    def extract(self, html: str, base_url: str, max_text_chars: int = 40000) -> ExtractedPage:
        """Extract clean text and metadata from an HTML document."""
        soup = BeautifulSoup(html or "", "lxml" if self._has_lxml() else "html.parser")

        title = None
        if soup.title and soup.title.string:
            title = WHITESPACE_RE.sub(" ", soup.title.string).strip() or None

        description = self._extract_meta(soup, ("description", "og:description", "twitter:description"))
        canonical_url = self._extract_canonical(soup, base_url)

        # Extract links before decomposing tags
        github_links: list[str] = []
        outbound_links: list[str] = []
        seen_gh: set[str] = set()
        seen_out: set[str] = set()

        for anchor in soup.find_all("a", href=True):
            href = urljoin(base_url, anchor["href"].strip())
            if not is_valid_http_url(href):
                continue
            gh_canon = canonical_github_repo_url(href)
            if gh_canon and gh_canon not in seen_gh:
                seen_gh.add(gh_canon)
                github_links.append(gh_canon)
            if href not in seen_out and len(outbound_links) < 100:
                seen_out.add(href)
                outbound_links.append(href)

        for tag in soup.find_all(list(self.STRIP_TAGS)):
            tag.decompose()

        raw_text = soup.get_text(separator=" ", strip=True)
        clean_text = WHITESPACE_RE.sub(" ", raw_text).strip()[:max_text_chars]

        # Also scan raw text for GitHub repository URLs
        for match in GITHUB_LINK_RE.findall(clean_text):
            gh_canon = canonical_github_repo_url(match)
            if gh_canon and gh_canon not in seen_gh:
                seen_gh.add(gh_canon)
                github_links.append(gh_canon)

        return ExtractedPage(
            url=base_url,
            title=title,
            description=description,
            canonical_url=canonical_url,
            text=clean_text,
            github_links=github_links,
            outbound_links=outbound_links,
        )

    @staticmethod
    def _has_lxml() -> bool:
        try:
            import lxml  # noqa: F401
            return True
        except ImportError:
            return False

    @staticmethod
    def _extract_meta(soup: BeautifulSoup, names: tuple[str, ...]) -> Optional[str]:
        for name in names:
            tag = soup.find("meta", attrs={"name": name}) or soup.find("meta", attrs={"property": name})
            if tag and tag.get("content"):
                cleaned = WHITESPACE_RE.sub(" ", str(tag["content"])).strip()
                if cleaned:
                    return cleaned
        return None

    @staticmethod
    def _extract_canonical(soup: BeautifulSoup, base_url: str) -> Optional[str]:
        link = soup.find("link", rel="canonical")
        if link and link.get("href"):
            candidate = urljoin(base_url, str(link["href"]).strip())
            if is_valid_http_url(candidate):
                return candidate
        return None
