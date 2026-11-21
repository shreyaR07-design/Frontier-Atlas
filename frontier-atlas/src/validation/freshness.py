"""24-hour UTC freshness filtering for Jobs and News datasets."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional

from src.utils.date_utils import is_within_freshness_window, parse_utc_datetime, utc_now


@dataclass
class FreshnessStats:
    """Statistics produced by FreshnessFilter."""

    category: str
    window_hours: int
    reference_time_utc: str
    evaluated: int = 0
    accepted: int = 0
    rejected_older: int = 0
    rejected_missing_date: int = 0
    rejected_future_date: int = 0


@dataclass
class FreshnessOutcome:
    """Result of applying freshness filtering to a batch of records."""

    accepted: list[dict[str, Any]] = field(default_factory=list)
    rejected: list[dict[str, Any]] = field(default_factory=list)
    stats: FreshnessStats = field(
        default_factory=lambda: FreshnessStats(
            category="unknown", window_hours=24, reference_time_utc=""
        )
    )


class FreshnessFilter:
    """Enforces strict UTC publication-time window filtering for Jobs and News."""

    def __init__(self, window_hours: int = 24, max_future_skew_minutes: int = 5) -> None:
        self.window_hours = window_hours
        self.max_future_skew_minutes = max_future_skew_minutes

    def filter_records(
        self,
        category: str,
        records: list[dict[str, Any]],
        *,
        reference_time: Optional[datetime] = None,
    ) -> FreshnessOutcome:
        """Filter records so only entries published within the last `window_hours` remain."""
        if category not in {"jobs", "news"}:
            raise ValueError(f"FreshnessFilter applies only to 'jobs' or 'news', got {category!r}")

        date_field = "posted_at" if category == "jobs" else "published_at"
        ref = reference_time or utc_now()
        stats = FreshnessStats(
            category=category,
            window_hours=self.window_hours,
            reference_time_utc=ref.isoformat(),
            evaluated=len(records),
        )
        outcome = FreshnessOutcome(stats=stats)

        for rec in records:
            pub_dt = parse_utc_datetime(rec.get(date_field))
            is_fresh, reason = is_within_freshness_window(
                pub_dt,
                reference_time=ref,
                window_hours=self.window_hours,
                max_future_skew_minutes=self.max_future_skew_minutes,
            )
            if is_fresh:
                outcome.accepted.append(rec)
                stats.accepted += 1
            else:
                if reason == "missing_published_at":
                    stats.rejected_missing_date += 1
                elif reason == "future_publication_date":
                    stats.rejected_future_date += 1
                else:
                    stats.rejected_older += 1
                outcome.rejected.append({"record": rec, "reason": reason})

        return outcome
