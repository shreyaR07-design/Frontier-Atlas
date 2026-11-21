"""Pydantic schemas for Entity Resolution and Entity Mapping Log."""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Optional

from pydantic import Field, field_validator, model_validator

from src.schemas.base import (
    AtlasBaseModel,
    default_collected_at,
    make_stable_id,
    validate_required_url,
    validate_utc_dt,
)


class MatchDecision(str, Enum):
    """Conservative entity resolution outcome."""

    EXACT_MATCH = "exact_match"
    AUTO_MERGE = "auto_merge"
    MANUAL_REVIEW = "manual_review"
    NEW_ENTITY = "new_entity"
    REJECTED = "rejected"


class EntityType(str, Enum):
    """Supported canonical entity categories."""

    STARTUP = "startup"
    PRODUCT = "product"
    COMPANY = "company"
    ORGANIZATION = "organization"


class CanonicalEntity(AtlasBaseModel):
    """Canonical entity entry maintained in the registry."""

    canonical_id: str = ""
    canonical_name: str = Field(..., min_length=1, max_length=256)
    normalized_name: str = Field(..., min_length=1, max_length=256)
    entity_type: EntityType = EntityType.COMPANY
    primary_domain: Optional[str] = Field(default=None, max_length=256)
    aliases: list[str] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=default_collected_at)

    @model_validator(mode="after")
    def _assign_id(self) -> "CanonicalEntity":
        if not self.canonical_id:
            self.canonical_id = make_stable_id("ent", self.entity_type.value, self.normalized_name)
        return self


class EntityMappingLog(AtlasBaseModel):
    """Audit log entry recording every entity resolution decision."""

    mapping_id: str = ""
    raw_name: str = Field(..., min_length=1, max_length=256)
    normalized_name: str = Field(..., min_length=1, max_length=256)
    canonical_name: str = Field(..., min_length=1, max_length=256)
    canonical_id: str = Field(..., min_length=1, max_length=64)
    source_url: str
    match_method: str = Field(..., min_length=1, max_length=64)
    confidence: float = Field(..., ge=0.0, le=1.0)
    decision: MatchDecision
    timestamp: datetime = Field(default_factory=default_collected_at)
    entity_type: EntityType = EntityType.COMPANY
    match_reason: Optional[str] = Field(default=None, max_length=512)

    @field_validator("source_url")
    @classmethod
    def _validate_source_url(cls, v: str) -> str:
        return validate_required_url(v, "source_url")

    @field_validator("timestamp", mode="before")
    @classmethod
    def _validate_timestamp(cls, v: Any) -> datetime:
        return validate_utc_dt(v, "timestamp")

    @model_validator(mode="after")
    def _assign_stable_id(self) -> "EntityMappingLog":
        if not self.mapping_id:
            self.mapping_id = make_stable_id(
                "map",
                self.raw_name.strip().lower(),
                self.canonical_id,
                self.source_url,
                self.entity_type.value,
            )
        return self
