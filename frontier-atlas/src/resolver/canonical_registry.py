"""Canonical entity registry with multi-index lookup and persistence support."""

from __future__ import annotations

from typing import Optional

from src.resolver.normalizer import compact_entity_key, is_specific_company_domain, normalize_entity_name
from src.schemas.base import make_stable_id
from src.schemas.entity import CanonicalEntity, EntityType
from src.storage.repository import AtlasRepository


class CanonicalRegistry:
    """Maintains canonical entities and fast indexes for exact, alias, compact, and domain lookup."""

    def __init__(self) -> None:
        self._entities: dict[str, CanonicalEntity] = {}
        self._by_norm_name: dict[tuple[EntityType, str], str] = {}
        self._by_compact: dict[tuple[EntityType, str], list[str]] = {}
        self._by_domain: dict[tuple[EntityType, str], list[str]] = {}

    def load_from_repository(self, repo: AtlasRepository) -> int:
        """Hydrate registry from persisted canonical_entities table."""
        import json

        rows = repo.fetch_dataset("canonical_entities")
        count = 0
        for row in rows:
            aliases = json.loads(row.get("aliases_json") or "[]")
            entity = CanonicalEntity(
                canonical_id=row["canonical_id"],
                canonical_name=row["canonical_name"],
                normalized_name=row["normalized_name"],
                entity_type=EntityType(row["entity_type"]),
                primary_domain=row.get("primary_domain"),
                aliases=aliases,
                created_at=row["created_at"],
            )
            self.register(entity)
            count += 1
        return count

    def register(self, entity: CanonicalEntity) -> CanonicalEntity:
        """Register or update a canonical entity and refresh lookup indexes."""
        self._entities[entity.canonical_id] = entity
        etype = entity.entity_type
        norm = entity.normalized_name or normalize_entity_name(entity.canonical_name)
        self._by_norm_name[(etype, norm)] = entity.canonical_id

        compact = compact_entity_key(norm)
        if compact:
            bucket = self._by_compact.setdefault((etype, compact), [])
            if entity.canonical_id not in bucket:
                bucket.append(entity.canonical_id)

        for alias in entity.aliases:
            alias_norm = normalize_entity_name(alias)
            if alias_norm:
                self._by_norm_name[(etype, alias_norm)] = entity.canonical_id
                alias_compact = compact_entity_key(alias_norm)
                c_bucket = self._by_compact.setdefault((etype, alias_compact), [])
                if entity.canonical_id not in c_bucket:
                    c_bucket.append(entity.canonical_id)

        if is_specific_company_domain(entity.primary_domain):
            assert entity.primary_domain is not None
            d_bucket = self._by_domain.setdefault((etype, entity.primary_domain.lower()), [])
            if entity.canonical_id not in d_bucket:
                d_bucket.append(entity.canonical_id)

        return entity

    def add_alias(self, canonical_id: str, alias: str) -> None:
        """Attach a verified alias to an existing canonical entity."""
        entity = self._entities.get(canonical_id)
        if not entity:
            return
        if alias not in entity.aliases:
            entity.aliases.append(alias)
        alias_norm = normalize_entity_name(alias)
        if alias_norm:
            self._by_norm_name[(entity.entity_type, alias_norm)] = canonical_id

    def create_and_register(
        self,
        *,
        raw_name: str,
        entity_type: EntityType,
        primary_domain: Optional[str] = None,
    ) -> CanonicalEntity:
        """Create a new CanonicalEntity with deterministic ID and register it."""
        norm = normalize_entity_name(raw_name) or raw_name.strip().lower()
        canonical_id = make_stable_id("ent", entity_type.value, norm)
        # Disambiguate if another entity already owns this exact ID with a conflicting domain
        if canonical_id in self._entities and primary_domain:
            existing = self._entities[canonical_id]
            if existing.primary_domain and existing.primary_domain != primary_domain:
                canonical_id = make_stable_id("ent", entity_type.value, norm, primary_domain)

        entity = CanonicalEntity(
            canonical_id=canonical_id,
            canonical_name=raw_name.strip(),
            normalized_name=norm,
            entity_type=entity_type,
            primary_domain=primary_domain if is_specific_company_domain(primary_domain) else None,
            aliases=[raw_name.strip()],
        )
        return self.register(entity)

    def get(self, canonical_id: str) -> Optional[CanonicalEntity]:
        return self._entities.get(canonical_id)

    def find_by_normalized_name(self, normalized_name: str, entity_type: EntityType) -> Optional[CanonicalEntity]:
        cid = self._by_norm_name.get((entity_type, normalized_name))
        return self._entities.get(cid) if cid else None

    def find_by_compact_key(self, compact_key: str, entity_type: EntityType) -> list[CanonicalEntity]:
        cids = self._by_compact.get((entity_type, compact_key), [])
        return [self._entities[cid] for cid in cids if cid in self._entities]

    def find_by_domain(self, domain: str, entity_type: EntityType) -> list[CanonicalEntity]:
        cids = self._by_domain.get((entity_type, domain.lower()), [])
        return [self._entities[cid] for cid in cids if cid in self._entities]

    def list_by_type(self, entity_type: EntityType) -> list[CanonicalEntity]:
        return [e for e in self._entities.values() if e.entity_type == entity_type]

    def all_entities(self) -> list[CanonicalEntity]:
        return list(self._entities.values())
