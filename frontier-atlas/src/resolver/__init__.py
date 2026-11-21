"""Entity resolution package for FrontierAtlas."""

from src.resolver.canonical_registry import CanonicalRegistry
from src.resolver.entity_matcher import EntityMatcher, MatchResult
from src.resolver.mapping_logger import EntityMappingLogger
from src.resolver.normalizer import (
    compact_entity_key,
    is_specific_company_domain,
    normalize_entity_name,
)

__all__ = [
    "CanonicalRegistry",
    "EntityMappingLogger",
    "EntityMatcher",
    "MatchResult",
    "compact_entity_key",
    "is_specific_company_domain",
    "normalize_entity_name",
]
