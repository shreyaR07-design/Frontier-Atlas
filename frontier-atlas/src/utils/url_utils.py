"""URL validation, canonical normalization, and domain extraction utilities."""

from __future__ import annotations

import re
from typing import Optional
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

TRACKING_QUERY_PARAMS = frozenset(
    {
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_term",
        "utm_content",
        "utm_id",
        "fbclid",
        "gclid",
        "mc_cid",
        "mc_eid",
        "ref",
        "ref_src",
        "source",
        "trk",
        "gh_jid",
    }
)

GITHUB_REPO_RE = re.compile(
    r"^https?://(?:www\.)?github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?/?(?:[#?].*)?$",
    re.IGNORECASE,
)


def is_valid_http_url(url: Optional[str]) -> bool:
    """Return True if url is a syntactically valid HTTP/HTTPS URL with a host."""
    if not url or not isinstance(url, str):
        return False
    candidate = url.strip()
    if not candidate:
        return False
    try:
        parsed = urlparse(candidate)
    except ValueError:
        return False
    return parsed.scheme.lower() in {"http", "https"} and bool(parsed.netloc)


def normalize_url(url: str, *, strip_query_tracking: bool = True) -> str:
    """Normalize a URL into a canonical form for deduplication and traceability."""
    if not url or not isinstance(url, str):
        raise ValueError("URL must be a non-empty string")
    raw = url.strip()
    parsed = urlparse(raw)
    if not parsed.scheme or not parsed.netloc:
        raise ValueError(f"Invalid URL without scheme or host: {url!r}")

    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"}:
        raise ValueError(f"Unsupported URL scheme {scheme!r} in {url!r}")

    hostname = (parsed.hostname or "").lower()
    if not hostname:
        raise ValueError(f"URL missing hostname: {url!r}")

    # Strip default ports
    port = parsed.port
    if (scheme == "http" and port == 80) or (scheme == "https" and port == 443):
        port = None
    netloc = f"{hostname}:{port}" if port else hostname

    # Collapse duplicate slashes and normalize trailing slash for non-root paths
    path = re.sub(r"/{2,}", "/", parsed.path or "/")
    if path != "/" and path.endswith("/"):
        path = path.rstrip("/")

    query_pairs = parse_qsl(parsed.query, keep_blank_values=False)
    if strip_query_tracking:
        query_pairs = [
            (k, v)
            for k, v in query_pairs
            if k.lower() not in TRACKING_QUERY_PARAMS and not k.lower().startswith("utm_")
        ]
    query_pairs.sort(key=lambda item: (item[0], item[1]))
    query = urlencode(query_pairs)

    # Drop fragments (#section) as non-canonical for resource identity
    return urlunparse((scheme, netloc, path, "", query, ""))


def extract_domain(url: Optional[str]) -> Optional[str]:
    """Extract normalized lowercase domain without leading 'www.'."""
    if not url or not is_valid_http_url(url):
        return None
    hostname = (urlparse(url.strip()).hostname or "").lower()
    if hostname.startswith("www."):
        hostname = hostname[4:]
    return hostname or None


def extract_github_repo_slug(url: Optional[str]) -> Optional[str]:
    """Extract 'owner/repo' from a GitHub repository URL, or return None."""
    if not url:
        return None
    match = GITHUB_REPO_RE.match(url.strip())
    if not match:
        return None
    owner, repo = match.group(1), match.group(2)
    # Ignore non-repository GitHub top-level paths
    if owner.lower() in {"topics", "orgs", "users", "search", "explore", "marketplace", "features"}:
        return None
    return f"{owner}/{repo}"


def canonical_github_repo_url(url: Optional[str]) -> Optional[str]:
    """Return canonical https://github.com/owner/repo URL if valid, else None."""
    slug = extract_github_repo_slug(url)
    return f"https://github.com/{slug}" if slug else None
