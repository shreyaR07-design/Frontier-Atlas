"""robots.txt policy enforcement with per-domain async caching."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlparse
from urllib.robotparser import RobotFileParser

import aiohttp

from src.utils.logging_config import get_logger

logger = get_logger("crawler.robots")


@dataclass
class RobotsDecision:
    """Result of checking robots.txt for a target URL."""

    allowed: bool
    crawl_delay: Optional[float] = None
    reason: str = "allowed"


class RobotsPolicyManager:
    """Fetches, caches, and evaluates robots.txt rules per origin."""

    def __init__(self, user_agent: str, respect_robots_txt: bool = True, timeout_seconds: int = 10) -> None:
        self.user_agent = user_agent
        self.respect_robots_txt = respect_robots_txt
        self.timeout_seconds = timeout_seconds
        self._parsers: dict[str, Optional[RobotFileParser]] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    def _origin(self, url: str) -> str:
        parsed = urlparse(url)
        return f"{parsed.scheme.lower()}://{parsed.netloc.lower()}"

    async def _load_parser(self, origin: str, session: aiohttp.ClientSession) -> Optional[RobotFileParser]:
        robots_url = f"{origin}/robots.txt"
        parser = RobotFileParser()
        parser.set_url(robots_url)
        try:
            timeout = aiohttp.ClientTimeout(total=self.timeout_seconds)
            async with session.get(
                robots_url,
                headers={"User-Agent": self.user_agent},
                timeout=timeout,
            ) as resp:
                if resp.status == 200:
                    text = await resp.text(errors="replace")
                    parser.parse(text.splitlines())
                    return parser
                if resp.status in {401, 403}:
                    # Restricted robots.txt -> disallow crawling conservatively
                    parser.parse(["User-agent: *", "Disallow: /"])
                    return parser
                # 404 or no robots.txt -> allowed
                return None
        except Exception as exc:
            logger.debug(
                "Could not fetch robots.txt; treating as unreachable",
                extra={"ctx": {"robots_url": robots_url, "error": str(exc)}},
            )
            return None

    async def can_fetch(self, url: str, session: aiohttp.ClientSession) -> RobotsDecision:
        """Check whether the crawler is allowed to fetch `url`."""
        if not self.respect_robots_txt:
            return RobotsDecision(allowed=True, reason="robots_check_disabled")

        origin = self._origin(url)
        lock = self._locks.setdefault(origin, asyncio.Lock())
        async with lock:
            if origin not in self._parsers:
                self._parsers[origin] = await self._load_parser(origin, session)

        parser = self._parsers[origin]
        if parser is None:
            return RobotsDecision(allowed=True, reason="no_robots_txt")

        allowed = parser.can_fetch(self.user_agent, url)
        delay_val = parser.crawl_delay(self.user_agent)
        crawl_delay = float(delay_val) if delay_val is not None else None
        return RobotsDecision(
            allowed=allowed,
            crawl_delay=crawl_delay,
            reason="robots_allowed" if allowed else "disallowed_by_robots_txt",
        )
