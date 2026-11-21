"""Shared Pydantic base models, verification enums, and field validators for FrontierAtlas."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime
from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict

from src.utils.date_utils import parse_utc_datetime, utc_now
from src.utils.url_utils import is_valid_http_url, normalize_url

UNKNOWN_PLACEHOLDERS = frozenset({"", "unknown", "n/a", "na", "none", "null", "tbd", "unspecified", "-"})


class VerificationStatus(str, Enum):
    """Explicit verification classification grounded in real source accessibility and evidence."""

    VERIFIED = "Verified"
    PARTIALLY_VERIFIED = "Partially Verified"
    UNVERIFIED = "Unverified"
    SOURCE_UNAVAILABLE = "Source Unavailable"
    REJECTED = "Rejected"


def normalize_unknown_text(value: Optional[str]) -> str:
    """Normalize empty or placeholder descriptive text to 'Unknown' without guessing."""
    if value is None:
        return "Unknown"
    cleaned = str(value).strip()
    if cleaned.lower() in UNKNOWN_PLACEHOLDERS:
        return "Unknown"
    return cleaned


def normalize_supported_fields(value: Any) -> list[str]:
    """Coerce supported_fields from JSON string or sequence into a deduplicated ordered list."""
    if value is None:
        return []
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return []
        if raw.startswith("["):
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, list):
                    value = parsed
                else:
                    return []
            except ValueError:
                value = [part.strip() for part in raw.split(";") if part.strip()]
        else:
            value = [part.strip() for part in raw.replace(",", ";").split(";") if part.strip()]
    if not isinstance(value, (list, tuple, set)):
        return []
    seen: set[str] = set()
    result: list[str] = []
    for item in value:
        label = str(item).strip()
        if label and label not in seen:
            seen.add(label)
            result.append(label)
    return result


def make_stable_id(prefix: str, *parts: Optional[str]) -> str:
    """Create a deterministic, collision-resistant ID from canonical key parts."""
    normalized_parts = [(part or "").strip().lower() for part in parts if part and part.strip()]
    payload = "|".join(normalized_parts)
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]
    return f"{prefix}_{digest}"


def validate_required_url(value: str, field_name: str = "url") -> str:
    """Validate and normalize a required HTTP/HTTPS URL."""
    if not is_valid_http_url(value):
        raise ValueError(f"Invalid HTTP/HTTPS URL for {field_name}: {value!r}")
    return normalize_url(value)


def validate_optional_url(value: Optional[str], field_name: str = "url") -> Optional[str]:
    """Validate and normalize an optional HTTP/HTTPS URL; return None if blank."""
    if value is None:
        return None
    stripped = value.strip()
    if not stripped or stripped.lower() in UNKNOWN_PLACEHOLDERS:
        return None
    if not is_valid_http_url(stripped):
        raise ValueError(f"Invalid HTTP/HTTPS URL for {field_name}: {value!r}")
    return normalize_url(stripped)


def validate_utc_dt(value: datetime | str | int | float, field_name: str = "timestamp") -> datetime:
    """Parse and normalize a datetime to timezone-aware UTC."""
    parsed = parse_utc_datetime(value)
    if parsed is None:
        raise ValueError(f"Invalid datetime value for {field_name}: {value!r}")
    return parsed


def validate_optional_utc_dt(
    value: Optional[datetime | str | int | float],
    field_name: str = "timestamp",
) -> Optional[datetime]:
    """Parse an optional UTC datetime, returning None if absent."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    return validate_utc_dt(value, field_name)


def default_collected_at() -> datetime:
    """Default UTC timestamp factory for collection time."""
    return utc_now()


class AtlasBaseModel(BaseModel):
    """Base Pydantic model with strict whitespace stripping and clean serialization."""

    model_config = ConfigDict(
        str_strip_whitespace=True,
        validate_assignment=True,
        populate_by_name=True,
        extra="ignore",
    )
