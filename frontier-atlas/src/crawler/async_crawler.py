"""Asynchronous HTTP crawler with bounded concurrency, rate limiting, retries, and deduplication."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any, Optional
from urllib.parse import urlparse

import aiohttp
from tenacity import AsyncRetrying, retry_if_exception_type, stop_after_attempt, wait_exponential

from src.config.settings import Settings
from src.crawler.robots_policy import RobotsPolicyManager
from src.utils.logging_config import get_logger
from src.utils.url_utils import is_valid_http_url, normalize_url

logger = get_logger("crawler.async")


class TransientHTTPError(RuntimeError):
    """Raised on retryable HTTP status codes such as 429 or 5xx."""

    def __init__(self, status: int, url: str, message: str = "") -> None:
        self.status = status
        self.url = url
        super().__init__(f"HTTP {status} for {url}: {message}")


@dataclass
class FetchResult:
    """Outcome of fetching a single URL."""

    url: str
    status: int
    content: str = ""
    content_type: str = ""
    headers: dict[str, str] = field(default_factory=dict)
    ok: bool = False
    error: Optional[str] = None
    blocked_by_robots: bool = False
    skipped_duplicate: bool = False


class DomainRateLimiter:
    """Simple per-domain interval rate limiter."""

    def __init__(self, requests_per_second: float) -> None:
        self.min_interval = 1.0 / max(requests_per_second, 0.1)
        self._last_request: dict[str, float] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    async def wait(self, domain: str, override_delay: Optional[float] = None) -> None:
        lock = self._locks.setdefault(domain, asyncio.Lock())
        async with lock:
            interval = max(self.min_interval, override_delay or 0.0)
            now = time.monotonic()
            last = self._last_request.get(domain, 0.0)
            sleep_for = interval - (now - last)
            if sleep_for > 0:
                await asyncio.sleep(sleep_for)
            self._last_request[domain] = time.monotonic()


class AsyncCrawler:
    """Async HTTP/Playwright crawler with robots.txt compliance and request deduplication."""

    RETRYABLE_STATUSES = {429, 500, 502, 503, 504}
    ANTI_BOT_STATUSES = {401, 403, 451}

    def __init__(
        self,
        *,
        user_agent: str = "FrontierAtlasBot/1.0",
        max_concurrency: int = 8,
        timeout_seconds: int = 20,
        rate_limit_per_second: float = 2.0,
        respect_robots_txt: bool = True,
        playwright_enabled: bool = False,
        max_attempts: int = 3,
    ) -> None:
        self.user_agent = user_agent
        self.semaphore = asyncio.Semaphore(max(1, max_concurrency))
        self.timeout_seconds = timeout_seconds
        self.rate_limiter = DomainRateLimiter(rate_limit_per_second)
        self.robots = RobotsPolicyManager(
            user_agent=user_agent,
            respect_robots_txt=respect_robots_txt,
            timeout_seconds=min(10, timeout_seconds),
        )
        self.playwright_enabled = playwright_enabled
        self.max_attempts = max_attempts
        self._seen_urls: set[str] = set()
        self._session: Optional[aiohttp.ClientSession] = None

    @classmethod
    def from_settings(cls, settings: Settings) -> "AsyncCrawler":
        return cls(
            user_agent=settings.user_agent,
            max_concurrency=settings.max_concurrency,
            timeout_seconds=settings.request_timeout_seconds,
            rate_limit_per_second=settings.rate_limit_per_second,
            respect_robots_txt=settings.respect_robots_txt,
            playwright_enabled=settings.playwright_enabled,
        )

    async def __aenter__(self) -> "AsyncCrawler":
        timeout = aiohttp.ClientTimeout(total=self.timeout_seconds)
        connector = aiohttp.TCPConnector(limit=32, ttl_dns_cache=300)
        self._session = aiohttp.ClientSession(
            timeout=timeout,
            connector=connector,
            headers={"User-Agent": self.user_agent, "Accept": "application/json, text/html, application/xml;q=0.9, */*;q=0.8"},
        )
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        if self._session is not None:
            await self._session.close()
            self._session = None

    def reset_deduplication(self) -> None:
        """Clear seen URL cache for a fresh crawl batch."""
        self._seen_urls.clear()

    async def fetch(
        self,
        url: str,
        *,
        headers: Optional[dict[str, str]] = None,
        deduplicate: bool = True,
        check_robots: bool = True,
    ) -> FetchResult:
        """Fetch a single URL with bounded concurrency, rate limiting, and retries."""
        if not is_valid_http_url(url):
            return FetchResult(url=url, status=0, ok=False, error="invalid_url")

        canonical = normalize_url(url, strip_query_tracking=False)
        if deduplicate:
            if canonical in self._seen_urls:
                return FetchResult(url=canonical, status=0, ok=False, skipped_duplicate=True, error="duplicate_url")
            self._seen_urls.add(canonical)

        if self._session is None:
            raise RuntimeError("AsyncCrawler must be used as an async context manager")

        domain = (urlparse(canonical).hostname or "").lower()
        crawl_delay: Optional[float] = None
        if check_robots:
            decision = await self.robots.can_fetch(canonical, self._session)
            if not decision.allowed:
                logger.info("Skipping URL disallowed by robots.txt", extra={"ctx": {"url": canonical}})
                return FetchResult(
                    url=canonical,
                    status=0,
                    ok=False,
                    blocked_by_robots=True,
                    error=decision.reason,
                )
            crawl_delay = decision.crawl_delay

        async with self.semaphore:
            await self.rate_limiter.wait(domain, override_delay=crawl_delay)
            try:
                return await self._fetch_with_retry(canonical, headers=headers)
            except Exception as exc:
                logger.warning(
                    "HTTP fetch failed after retries",
                    extra={"ctx": {"url": canonical, "error": str(exc)}},
                )
                return FetchResult(url=canonical, status=0, ok=False, error=str(exc))

    async def _fetch_with_retry(self, url: str, headers: Optional[dict[str, str]] = None) -> FetchResult:
        assert self._session is not None
        async for attempt in AsyncRetrying(
            stop=stop_after_attempt(self.max_attempts),
            wait=wait_exponential(multiplier=1, min=1, max=16),
            retry=retry_if_exception_type((TransientHTTPError, aiohttp.ClientError, asyncio.TimeoutError)),
            reraise=True,
        ):
            with attempt:
                async with self._session.get(url, headers=headers) as resp:
                    body = await resp.text(errors="replace")
                    resp_headers = {k: v for k, v in resp.headers.items()}
                    content_type = resp_headers.get("Content-Type", "")

                    if resp.status in self.RETRYABLE_STATUSES:
                        raise TransientHTTPError(resp.status, url, "retryable upstream status")

                    if resp.status in self.ANTI_BOT_STATUSES:
                        # Do not bypass anti-bot protections or auth gates
                        return FetchResult(
                            url=str(resp.url),
                            status=resp.status,
                            content="",
                            content_type=content_type,
                            headers=resp_headers,
                            ok=False,
                            error=f"access_restricted_http_{resp.status}",
                        )

                    if resp.status >= 400:
                        return FetchResult(
                            url=str(resp.url),
                            status=resp.status,
                            content=body[:500],
                            content_type=content_type,
                            headers=resp_headers,
                            ok=False,
                            error=f"http_{resp.status}",
                        )

                    return FetchResult(
                        url=str(resp.url),
                        status=resp.status,
                        content=body,
                        content_type=content_type,
                        headers=resp_headers,
                        ok=True,
                    )
        return FetchResult(url=url, status=0, ok=False, error="retry_exhausted")

    async def fetch_with_playwright(self, url: str) -> FetchResult:
        """Render a permitted JavaScript page via Playwright when explicitly enabled."""
        if not self.playwright_enabled:
            return FetchResult(url=url, status=0, ok=False, error="playwright_disabled")
        if self._session is not None:
            decision = await self.robots.can_fetch(url, self._session)
            if not decision.allowed:
                return FetchResult(url=url, status=0, ok=False, blocked_by_robots=True, error=decision.reason)
        try:
            from playwright.async_api import async_playwright
        except ImportError as exc:  # pragma: no cover
            return FetchResult(url=url, status=0, ok=False, error=f"playwright_unavailable: {exc}")

        try:
            async with async_playwright() as p:
                browser = await p.chromium.launch(headless=True)
                try:
                    page = await browser.new_page(user_agent=self.user_agent)
                    response = await page.goto(url, wait_until="domcontentloaded", timeout=self.timeout_seconds * 1000)
                    status = response.status if response else 200
                    html = await page.content()
                    return FetchResult(
                        url=page.url,
                        status=status,
                        content=html,
                        content_type="text/html",
                        ok=200 <= status < 400,
                    )
                finally:
                    await browser.close()
        except Exception as exc:
            return FetchResult(url=url, status=0, ok=False, error=f"playwright_error: {exc}")
