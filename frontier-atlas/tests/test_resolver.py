"""Phase 4 tests: Entity normalization, exact/fuzzy matching, false-positive prevention, and mapping log."""

from __future__ import annotations

from src.resolver import (
    CanonicalRegistry,
    EntityMappingLogger,
    EntityMatcher,
    normalize_entity_name,
)
from src.schemas.entity import EntityType, MatchDecision


def test_entity_normalization_handles_punctuation_whitespace_and_legal_suffixes() -> None:
    assert normalize_entity_name("OpenAI Inc.") == "openai"
    assert normalize_entity_name("  Open-AI,   LLC ") == "open ai"
    assert normalize_entity_name("Anthropic, PBC") == "anthropic"
    assert normalize_entity_name("Scale AI Corp.") == "scale ai"


def test_exact_and_spacing_variant_resolution_and_mapping_log() -> None:
    registry = CanonicalRegistry()
    matcher = EntityMatcher(registry)
    logger = EntityMappingLogger()

    r1 = matcher.resolve(
        raw_name="OpenAI",
        entity_type=EntityType.STARTUP,
        website="https://openai.com",
        source_url="https://openai.com/about",
    )
    assert r1.decision == MatchDecision.NEW_ENTITY
    logger.record(r1, source_url="https://openai.com/about", entity_type=EntityType.STARTUP)

    r2 = matcher.resolve(
        raw_name="OpenAI Inc.",
        entity_type=EntityType.STARTUP,
        website="https://www.openai.com/",
        source_url="https://dir.example/openai",
    )
    assert r2.decision == MatchDecision.AUTO_MERGE
    assert r2.canonical_id == r1.canonical_id
    logger.record(r2, source_url="https://dir.example/openai", entity_type=EntityType.STARTUP)

    r3 = matcher.resolve(
        raw_name="Open AI",
        entity_type=EntityType.STARTUP,
        website="https://openai.com",
        source_url="https://news.example/openai",
    )
    assert r3.decision == MatchDecision.AUTO_MERGE
    assert r3.canonical_id == r1.canonical_id
    logger.record(r3, source_url="https://news.example/openai", entity_type=EntityType.STARTUP)

    summary = logger.summary()
    assert summary["total_logged"] == 3
    assert summary["new_entity"] == 1
    assert summary["auto_merge"] == 2


def test_false_positive_prevention_for_similar_companies() -> None:
    registry = CanonicalRegistry()
    matcher = EntityMatcher(registry)

    r_openai = matcher.resolve(
        raw_name="OpenAI",
        entity_type=EntityType.STARTUP,
        website="https://openai.com",
    )
    r_openrouter = matcher.resolve(
        raw_name="OpenRouter",
        entity_type=EntityType.STARTUP,
        website="https://openrouter.ai",
    )
    assert r_openrouter.canonical_id != r_openai.canonical_id
    assert r_openrouter.decision in {MatchDecision.NEW_ENTITY, MatchDecision.MANUAL_REVIEW}

    r_alpha = matcher.resolve(
        raw_name="Alpha Labs",
        entity_type=EntityType.STARTUP,
        website="https://alphalabs.example",
    )
    r_beta = matcher.resolve(
        raw_name="Beta Labs",
        entity_type=EntityType.STARTUP,
        website="https://betalabs.example",
    )
    assert r_beta.canonical_id != r_alpha.canonical_id
    assert r_beta.decision == MatchDecision.NEW_ENTITY


def test_domain_conflict_prevents_blind_merge() -> None:
    registry = CanonicalRegistry()
    matcher = EntityMatcher(registry)

    first = matcher.resolve(
        raw_name="Acme",
        entity_type=EntityType.STARTUP,
        website="https://acme-robotics.com",
    )
    second = matcher.resolve(
        raw_name="Acme",
        entity_type=EntityType.STARTUP,
        website="https://acme-fintech.io",
    )
    assert second.canonical_id != first.canonical_id
    assert second.decision == MatchDecision.MANUAL_REVIEW
