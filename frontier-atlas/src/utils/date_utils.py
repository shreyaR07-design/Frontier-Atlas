"""UTC date parsing, validation, and freshness window helpers."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Optional, Union


def utc_now() -> datetime:
    """Return current timezone-aware UTC datetime."""
    return datetime.now(timezone.utc)


def ensure_utc(dt: datetime) -> datetime:
    """Ensure a datetime is timezone-aware in UTC. Naive datetimes are assumed UTC."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def parse_utc_datetime(value: Union[str, int, float, datetime, None]) -> Optional[datetime]:
    """Safely parse ISO-8601, RFC-2822 (RSS), or epoch timestamps into UTC datetime."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return ensure_utc(value)
    if isinstance(value, (int, float)):
        # Handle millisecond epochs heuristically if > 1e12
        ts = value / 1000.0 if value > 1e12 else float(value)
        try:
            return datetime.fromtimestamp(ts, tz=timezone.utc)
        except (OSError, OverflowError, ValueError):
            return None

    if not isinstance(value, str):
        return None
    raw = value.strip()
    if not raw:
        return None

    # ISO-8601 (handles 'Z' suffix cleanly in Python 3.11+)
    try:
        iso_candidate = raw.replace("Z", "+00:00") if raw.endswith("Z") else raw
        parsed = datetime.fromisoformat(iso_candidate)
        return ensure_utc(parsed)
    except ValueError:
        pass

    # RFC 2822 / HTTP / RSS pubDate
    try:
        parsed_rfc = parsedate_to_datetime(raw)
        if parsed_rfc is not None:
            return ensure_utc(parsed_rfc)
    except (TypeError, ValueError, IndexError):
        pass

    # Common fallback formats
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y/%m/%d", "%Y-%m-%d"):
        try:
            return datetime.strptime(raw, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def to_utc_iso(dt: Optional[datetime]) -> Optional[str]:
    """Serialize a datetime to UTC ISO-8601 string."""
    if dt is None:
        return None
    return ensure_utc(dt).isoformat()


def is_within_freshness_window(
    published_at: Optional[datetime],
    *,
    reference_time: Optional[datetime] = None,
    window_hours: int = 24,
    max_future_skew_minutes: int = 5,
) -> tuple[bool, str]:
    """Check whether published_at falls inside [reference - window_hours, reference + skew]."""
    if published_at is None:
        return False, "missing_published_at"

    ref = ensure_utc(reference_time or utc_now())
    pub = ensure_utc(published_at)

    if pub > ref + timedelta(minutes=max_future_skew_minutes):
        return False, "future_publication_date"

    cutoff = ref - timedelta(hours=window_hours)
    if pub < cutoff:
        return False, f"older_than_{window_hours}h"

    return True, "fresh"
