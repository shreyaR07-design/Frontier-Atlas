"""Pydantic schema for Research Paper records."""

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
    validate_optional_url,
    validate_optional_utc_dt,
    validate_required_url,
    validate_utc_dt,
)
from src.utils.url_utils import canonical_github_repo_url


class ResearchPaperRecord(AtlasBaseModel):
    """Validated record representing an academic research paper."""

    paper_id: str = ""
    title: str = Field(..., min_length=1, max_length=1000)
    abstract: Optional[str] = Field(default=None, max_length=16000)
    authors: list[str] = Field(default_factory=list)
    publication_date: Optional[str] = Field(default=None, max_length=64)
    doi: Optional[str] = Field(default=None, max_length=256)
    arxiv_id: Optional[str] = Field(default=None, max_length=64)
    github_repository: Optional[str] = None
    github_stars: Optional[int] = Field(default=None, ge=0)
    official_website: Optional[str] = None
    source_name: str = Field(default="unknown", min_length=1, max_length=128)
    source_url: str
    source_title: Optional[str] = Field(default=None, max_length=512)
    collected_at: datetime = Field(default_factory=default_collected_at)
    last_checked_at: Optional[datetime] = None
    supported_fields: list[str] = Field(default_factory=list)
    verification_status: VerificationStatus = VerificationStatus.UNVERIFIED
    rejection_reason: Optional[str] = Field(default=None, max_length=1000)
    source_metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("authors", mode="before")
    @classmethod
    def _clean_authors(cls, v: Any) -> list[str]:
        if v is None:
            return []
        if isinstance(v, str):
            return [part.strip() for part in v.split(",") if part.strip()]
        return [str(item).strip() for item in v if str(item).strip()]

    @field_validator("doi")
    @classmethod
    def _clean_doi(cls, v: Optional[str]) -> Optional[str]:
        if not v:
            return None
        cleaned = v.strip()
        for prefix in ("https://doi.org/", "http://doi.org/", "doi:"):
            if cleaned.lower().startswith(prefix):
                cleaned = cleaned[len(prefix) :]
        return cleaned.strip() or None

    @field_validator("github_repository")
    @classmethod
    def _validate_github_repo(cls, v: Optional[str]) -> Optional[str]:
        if not v or not v.strip():
            return None
        canonical = canonical_github_repo_url(v)
        if canonical is None:
            raise ValueError(f"Invalid GitHub repository URL: {v!r}")
        return canonical

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
    def _assign_stable_id(self) -> "ResearchPaperRecord":
        if not self.paper_id:
            identity = self.doi or self.arxiv_id or self.source_url
            object.__setattr__(self, "paper_id", make_stable_id("pap", identity, self.title))
        return self
