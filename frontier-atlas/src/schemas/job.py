"""Pydantic schema for Job posting records."""

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


class JobRecord(AtlasBaseModel):
    """Validated record representing a recent job posting."""

    job_id: str = ""
    title: str = Field(..., min_length=1, max_length=256)
    company: str = Field(default="Unknown", min_length=1, max_length=256)
    location: str = Field(default="Unknown", max_length=256)
    employment_type: str = Field(default="Unknown", max_length=64)
    description: Optional[str] = Field(default=None, max_length=16000)
    posted_at: datetime
    application_url: str
    official_website: Optional[str] = None
    source_name: str = Field(..., min_length=1, max_length=128)
    source_url: str
    source_title: Optional[str] = Field(default=None, max_length=512)
    collected_at: datetime = Field(default_factory=default_collected_at)
    last_checked_at: Optional[datetime] = None
    supported_fields: list[str] = Field(default_factory=list)
    verification_status: VerificationStatus = VerificationStatus.UNVERIFIED
    rejection_reason: Optional[str] = Field(default=None, max_length=1000)
    canonical_company_id: Optional[str] = None
    source_metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("company", "location", "employment_type", mode="before")
    @classmethod
    def _normalize_unknown_fields(cls, v: Optional[str]) -> str:
        return normalize_unknown_text(v)

    @field_validator("posted_at", mode="before")
    @classmethod
    def _validate_posted_at(cls, v: Any) -> datetime:
        return validate_utc_dt(v, "posted_at")

    @field_validator("application_url")
    @classmethod
    def _validate_application_url(cls, v: str) -> str:
        return validate_required_url(v, "application_url")

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
    def _assign_stable_id(self) -> "JobRecord":
        if not self.job_id:
            object.__setattr__(
                self, "job_id", make_stable_id("job", self.application_url, self.title, self.company)
            )
        return self
