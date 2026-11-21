"""Base collector contract and shared collection telemetry."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Optional

from src.config.settings import Settings
from src.crawler.async_crawler import AsyncCrawler
from src.utils.logging_config import get_logger
from src.utils.url_utils import canonical_github_repo_url
import re

GITHUB_URL_PATTERN = re.compile(
    r"https?://(?:www\.)?github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+",
    re.IGNORECASE,
)


@dataclass
class CollectorStats:
    """Counters summarizing a single collector run."""

    source_category: str
    discovered: int = 0
    extracted: int = 0
    failed: int = 0
    unavailable_sources: list[str] = field(default_factory=list)
    page: int = 1
    has_more: bool = False
    next_page: Optional[int] = None


@dataclass
class CollectionBatch:
    """Output returned by a collector containing raw/pre-normalized dicts and stats."""

    category: str
    records: list[dict[str, Any]] = field(default_factory=list)
    stats: CollectorStats = field(default_factory=lambda: CollectorStats(source_category="unknown"))
    errors: list[dict[str, Any]] = field(default_factory=list)


class BaseCollector(ABC):
    """Abstract base class for category-specific FrontierAtlas collectors."""

    category: str = "base"

    def __init__(self, settings: Settings, crawler: AsyncCrawler) -> None:
        self.settings = settings
        self.crawler = crawler
        self.logger = get_logger(f"collectors.{self.category}")

    @abstractmethod
    async def collect(self, limit: Optional[int] = None, page: int = 1) -> CollectionBatch:
        """Collect records from configured public APIs and permitted web pages."""

    @staticmethod
    def find_first_github_repo(*texts: Optional[str]) -> Optional[str]:
        """Search candidate text snippets for the first valid GitHub repository URL."""
        for text in texts:
            if not text:
                continue
            for match in GITHUB_URL_PATTERN.findall(text):
                canonical = canonical_github_repo_url(match)
                if canonical:
                    return canonical
        return None
