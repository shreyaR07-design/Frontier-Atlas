"""Pydantic schema for News article records."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import Field, field_validator, model_validator

from src.schemas.base import (
    AtlasBaseModel,
    VerificationStatus,
    default_collected_at,
    make_stable_id,
    normalize_supported_fields,
    normalize_unknown_text,
    validate_optional_url,
    validate_optional_utc_dt,
    validate_required_url,
    validate_utc_dt,
)


class NewsRecord(AtlasBaseModel):
    """Validated record representing a recent news article."""

    news_id: str = ""
    headline: str = Field(..., min_length=1, max_length=512)
    summary: Optional[str] = Field(default=None, max_length=4000)
    publisher: str = Field(default="Unknown", min_length=1, max_length=256)
    published_at: datetime
    article_url: str
    official_website: Optional[str] = None
    category: str = Field(default="Unknown", max_length=128)
    source_name: Optional[str] = Field(default=None, max_length=128)
    source_url: str
    source_title: Optional[str] = Field(default=None, max_length=512)
    collected_at: datetime = Field(default_factory=default_collected_at)
    last_checked_at: Optional[datetime] = None
    supported_fields: list[str] = Field(default_factory=list)
    verification_status: VerificationStatus = VerificationStatus.UNVERIFIED
    rejection_reason: Optional[str] = Field(default=None, max_length=1000)
    source_metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("publisher", "category", mode="before")
    @classmethod
    def _normalize_unknown_fields(cls, v: Optional[str]) -> str:
        return normalize_unknown_text(v)

    @field_validator("published_at", mode="before")
    @classmethod
    def _validate_published_at(cls, v: Any) -> datetime:
        return validate_utc_dt(v, "published_at")

    @field_validator("article_url")
    @classmethod
    def _validate_article_url(cls, v: str) -> str:
        return validate_required_url(v, "article_url")

    @field_validator("official_website")
    @classmethod
    def _validate_official_website(cls, v: Optional[str]) -> Optional[str]:
        return validate_optional_url(v, "official_website")

    @field_validator("source_url")
    @classmethod
    def _validate_source_url(cls, v: str) -> str:
        return validate_required_url(v, "source_url")

    @field_validator("collected_at", mode="before")
    @classmethod
    def _validate_collected_at(cls, v: Any) -> datetime:
        return validate_utc_dt(v, "collected_at")

    @field_validator("last_checked_at", mode="before")
    @classmethod
    def _validate_last_checked_at(cls, v: Any) -> Optional[datetime]:
        return validate_optional_utc_dt(v, "last_checked_at")

    @field_validator("supported_fields", mode="before")
    @classmethod
    def _clean_supported_fields(cls, v: Any) -> list[str]:
        return normalize_supported_fields(v)

    @model_validator(mode="after")
    def _assign_stable_id(self) -> "NewsRecord":
        if not self.news_id:
            object.__setattr__(self, "news_id", make_stable_id("nws", self.article_url))
        return self
