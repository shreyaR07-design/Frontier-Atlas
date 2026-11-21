"""Entity mapping log builder and persistence coordinator."""

from __future__ import annotations

from collections import Counter
from typing import Optional

from src.resolver.entity_matcher import MatchResult
from src.schemas.entity import EntityMappingLog, EntityType
from src.storage.repository import AtlasRepository
from src.utils.date_utils import utc_now


class EntityMappingLogger:
    """Records EntityMappingLog entries and summarizes entity resolution decisions."""

    def __init__(self) -> None:
        self._entries: list[EntityMappingLog] = []

    def record(
        self,
        match: MatchResult,
        *,
        source_url: str,
        entity_type: EntityType,
    ) -> EntityMappingLog:
        entry = EntityMappingLog(
            raw_name=match.raw_name,
            normalized_name=match.normalized_name,
            canonical_name=match.canonical_name,
            canonical_id=match.canonical_id,
            source_url=source_url,
            match_method=match.match_method,
            confidence=match.confidence,
            decision=match.decision,
            entity_type=entity_type,
            match_reason=match.match_reason,
            timestamp=utc_now(),
        )
        self._entries.append(entry)
        return entry

    @property
    def entries(self) -> list[EntityMappingLog]:
        return list(self._entries)

    def summary(self) -> dict[str, int]:
        counts = Counter(entry.decision.value for entry in self._entries)
        return {
            "total_logged": len(self._entries),
            "exact_match": counts.get("exact_match", 0),
            "auto_merge": counts.get("auto_merge", 0),
            "manual_review": counts.get("manual_review", 0),
            "new_entity": counts.get("new_entity", 0),
            "rejected": counts.get("rejected", 0),
        }

    def flush(self, repo: Optional[AtlasRepository]) -> int:
        if repo is None or not self._entries:
            return 0
        return repo.upsert_entity_mapping_logs(self._entries)
