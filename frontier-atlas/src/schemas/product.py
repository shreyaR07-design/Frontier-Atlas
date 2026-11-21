"""Pydantic schema for Product records."""

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


class ProductRecord(AtlasBaseModel):
    """Validated record representing a software or technology product."""

    product_id: str = ""
    name: str = Field(..., min_length=1, max_length=256)
    description: Optional[str] = Field(default=None, max_length=4000)
    website: Optional[str] = None
    official_website: Optional[str] = None
    category: str = Field(default="Unknown", max_length=128)
    company_name: str = Field(default="Unknown", max_length=256)
    source_name: str = Field(..., min_length=1, max_length=128)
    source_url: str
    source_title: Optional[str] = Field(default=None, max_length=512)
    collected_at: datetime = Field(default_factory=default_collected_at)
    last_checked_at: Optional[datetime] = None
    supported_fields: list[str] = Field(default_factory=list)
    verification_status: VerificationStatus = VerificationStatus.UNVERIFIED
    rejection_reason: Optional[str] = Field(default=None, max_length=1000)
    canonical_entity_id: Optional[str] = None
    source_metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("category", "company_name", mode="before")
    @classmethod
    def _normalize_unknown_fields(cls, v: Optional[str]) -> str:
        return normalize_unknown_text(v)

    @field_validator("website", "official_website")
    @classmethod
    def _validate_website(cls, v: Optional[str]) -> Optional[str]:
        return validate_optional_url(v, "website")

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
    def _sync_websites_and_id(self) -> "ProductRecord":
        if not self.official_website and self.website:
            object.__setattr__(self, "official_website", self.website)
        elif not self.website and self.official_website:
            object.__setattr__(self, "website", self.official_website)
        if not self.product_id:
            key = self.website or self.source_url
            company_key = None if self.company_name == "Unknown" else self.company_name
            object.__setattr__(
                self, "product_id", make_stable_id("prd", self.name, company_key, key)
            )
        return self
