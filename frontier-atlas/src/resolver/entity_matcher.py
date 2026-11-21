"""Conservative multi-signal entity matching engine."""

from __future__ import annotations

from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Optional

from src.config.settings import Settings
from src.resolver.canonical_registry import CanonicalRegistry
from src.resolver.normalizer import (
    compact_entity_key,
    is_specific_company_domain,
    meaningful_tokens,
    normalize_entity_name,
)
from src.schemas.entity import CanonicalEntity, EntityType, MatchDecision
from src.utils.url_utils import extract_domain


@dataclass
class MatchResult:
    """Detailed outcome of resolving a raw entity mention against the registry."""

    raw_name: str
    normalized_name: str
    canonical_name: str
    canonical_id: str
    match_method: str
    confidence: float
    decision: MatchDecision
    match_reason: str
    entity: CanonicalEntity


class EntityMatcher:
    """Resolves entity mentions conservatively using exact, domain, compact, and fuzzy checks."""

    def __init__(
        self,
        registry: CanonicalRegistry,
        *,
        auto_merge_threshold: float = 0.92,
        review_threshold: float = 0.80,
    ) -> None:
        self.registry = registry
        self.auto_merge_threshold = auto_merge_threshold
        self.review_threshold = review_threshold

    @classmethod
    def from_settings(cls, registry: CanonicalRegistry, settings: Settings) -> "EntityMatcher":
        return cls(
            registry=registry,
            auto_merge_threshold=settings.fuzzy_auto_merge_threshold,
            review_threshold=settings.fuzzy_review_threshold,
        )

    @staticmethod
    def compute_name_similarity(norm_a: str, norm_b: str) -> float:
        """Compute conservative similarity score combining sequence ratio and token overlap."""
        if not norm_a or not norm_b:
            return 0.0
        if norm_a == norm_b:
            return 1.0

        seq_ratio = SequenceMatcher(None, norm_a, norm_b).ratio()
        tokens_a = set(meaningful_tokens(norm_a))
        tokens_b = set(meaningful_tokens(norm_b))
        if not tokens_a or not tokens_b:
            return seq_ratio

        jaccard = len(tokens_a & tokens_b) / len(tokens_a | tokens_b)

        # Guard against merging single-word prefixes/competitors like 'openai' vs 'openrouter'
        if len(tokens_a) == 1 and len(tokens_b) == 1 and compact_entity_key(norm_a) != compact_entity_key(norm_b):
            # Penalize different single-word names so 'OpenAI' and 'OpenBI' aren't auto-merged
            return min(seq_ratio, 0.84)

        # Guard against multi-word names that differ in their primary distinguishing word (e.g., 'alpha labs' vs 'beta labs')
        if len(tokens_a) >= 2 and len(tokens_b) >= 2 and jaccard < 0.55:
            return min(seq_ratio, 0.78)

        return round(0.65 * seq_ratio + 0.35 * jaccard, 4)

    def _domains_conflict(self, domain_a: Optional[str], domain_b: Optional[str]) -> bool:
        if not is_specific_company_domain(domain_a) or not is_specific_company_domain(domain_b):
            return False
        assert domain_a is not None and domain_b is not None
        return domain_a.lower() != domain_b.lower()

    def resolve(
        self,
        *,
        raw_name: str,
        entity_type: EntityType,
        website: Optional[str] = None,
        source_url: Optional[str] = None,
    ) -> MatchResult:
        """Resolve a raw entity name into a canonical decision without unsafe merges."""
        clean_raw = (raw_name or "").strip()
        normalized = normalize_entity_name(clean_raw) or clean_raw.lower()
        domain = extract_domain(website) or (extract_domain(source_url) if website is None else None)
        if not is_specific_company_domain(domain):
            domain = None

        # 1. Exact normalized / alias match
        exact = self.registry.find_by_normalized_name(normalized, entity_type)
        if exact is not None:
            if self._domains_conflict(domain, exact.primary_domain):
                new_ent = self.registry.create_and_register(
                    raw_name=clean_raw,
                    entity_type=entity_type,
                    primary_domain=domain,
                )
                return MatchResult(
                    raw_name=clean_raw,
                    normalized_name=normalized,
                    canonical_name=new_ent.canonical_name,
                    canonical_id=new_ent.canonical_id,
                    match_method="domain_conflict_guard",
                    confidence=0.65,
                    decision=MatchDecision.MANUAL_REVIEW,
                    match_reason=(
                        f"Normalized name '{normalized}' matched '{exact.canonical_name}' "
                        f"but domains differ ({domain} vs {exact.primary_domain}); kept separate for review."
                    ),
                    entity=new_ent,
                )

            decision = (
                MatchDecision.EXACT_MATCH
                if clean_raw.lower() == exact.canonical_name.lower()
                else MatchDecision.AUTO_MERGE
            )
            method = "exact_normalized" if decision == MatchDecision.EXACT_MATCH else "legal_suffix_or_alias_match"
            self.registry.add_alias(exact.canonical_id, clean_raw)
            return MatchResult(
                raw_name=clean_raw,
                normalized_name=normalized,
                canonical_name=exact.canonical_name,
                canonical_id=exact.canonical_id,
                match_method=method,
                confidence=1.0 if decision == MatchDecision.EXACT_MATCH else 0.98,
                decision=decision,
                match_reason=f"Matched canonical entity '{exact.canonical_name}' via normalized form '{normalized}'.",
                entity=exact,
            )

        # 2. Compact spacing-variant match (e.g., 'Open AI' <-> 'OpenAI')
        compact = compact_entity_key(normalized)
        for candidate in self.registry.find_by_compact_key(compact, entity_type):
            if self._domains_conflict(domain, candidate.primary_domain):
                continue
            same_domain = bool(domain and candidate.primary_domain and domain == candidate.primary_domain)
            if same_domain or len(compact) >= 5:
                self.registry.add_alias(candidate.canonical_id, clean_raw)
                return MatchResult(
                    raw_name=clean_raw,
                    normalized_name=normalized,
                    canonical_name=candidate.canonical_name,
                    canonical_id=candidate.canonical_id,
                    match_method="compact_spacing_match",
                    confidence=0.96 if same_domain else 0.93,
                    decision=MatchDecision.AUTO_MERGE,
                    match_reason=(
                        f"Compact key '{compact}' matched '{candidate.canonical_name}'"
                        + (" with identical domain." if same_domain else " with spacing normalization.")
                    ),
                    entity=candidate,
                )

        # 3. Domain-based matching when website domain is specific
        if domain:
            domain_matches = self.registry.find_by_domain(domain, entity_type)
            for candidate in domain_matches:
                sim = self.compute_name_similarity(normalized, candidate.normalized_name)
                if sim >= 0.70:
                    self.registry.add_alias(candidate.canonical_id, clean_raw)
                    return MatchResult(
                        raw_name=clean_raw,
                        normalized_name=normalized,
                        canonical_name=candidate.canonical_name,
                        canonical_id=candidate.canonical_id,
                        match_method="domain_and_name",
                        confidence=round(max(0.93, sim), 4),
                        decision=MatchDecision.AUTO_MERGE,
                        match_reason=f"Shared domain '{domain}' and compatible name similarity ({sim:.2f}).",
                        entity=candidate,
                    )
                # Same domain, different name -> flag for manual review instead of blind merge
                new_ent = self.registry.create_and_register(
                    raw_name=clean_raw,
                    entity_type=entity_type,
                    primary_domain=domain,
                )
                return MatchResult(
                    raw_name=clean_raw,
                    normalized_name=normalized,
                    canonical_name=new_ent.canonical_name,
                    canonical_id=new_ent.canonical_id,
                    match_method="domain_only_uncertain",
                    confidence=0.82,
                    decision=MatchDecision.MANUAL_REVIEW,
                    match_reason=(
                        f"Shared domain '{domain}' with '{candidate.canonical_name}' "
                        f"but low name similarity ({sim:.2f}); held for manual review."
                    ),
                    entity=new_ent,
                )

        # 4. Conservative fuzzy match across existing entities of same type
        best_candidate: Optional[CanonicalEntity] = None
        best_score = 0.0
        for candidate in self.registry.list_by_type(entity_type):
            if self._domains_conflict(domain, candidate.primary_domain):
                continue
            score = self.compute_name_similarity(normalized, candidate.normalized_name)
            if score > best_score:
                best_score = score
                best_candidate = candidate

        if best_candidate is not None and best_score >= self.auto_merge_threshold:
            self.registry.add_alias(best_candidate.canonical_id, clean_raw)
            return MatchResult(
                raw_name=clean_raw,
                normalized_name=normalized,
                canonical_name=best_candidate.canonical_name,
                canonical_id=best_candidate.canonical_id,
                match_method="fuzzy_high_confidence",
                confidence=round(best_score, 4),
                decision=MatchDecision.AUTO_MERGE,
                match_reason=f"High fuzzy similarity ({best_score:.3f} >= {self.auto_merge_threshold}) with no domain conflict.",
                entity=best_candidate,
            )

        if best_candidate is not None and best_score >= self.review_threshold:
            new_ent = self.registry.create_and_register(
                raw_name=clean_raw,
                entity_type=entity_type,
                primary_domain=domain,
            )
            return MatchResult(
                raw_name=clean_raw,
                normalized_name=normalized,
                canonical_name=new_ent.canonical_name,
                canonical_id=new_ent.canonical_id,
                match_method="fuzzy_uncertain",
                confidence=round(best_score, 4),
                decision=MatchDecision.MANUAL_REVIEW,
                match_reason=(
                    f"Uncertain similarity ({best_score:.3f}) to '{best_candidate.canonical_name}'; "
                    "not auto-merged to prevent false positives."
                ),
                entity=new_ent,
            )

        # 5. Register as a genuinely new canonical entity
        new_entity = self.registry.create_and_register(
            raw_name=clean_raw,
            entity_type=entity_type,
            primary_domain=domain,
        )
        return MatchResult(
            raw_name=clean_raw,
            normalized_name=normalized,
            canonical_name=new_entity.canonical_name,
            canonical_id=new_entity.canonical_id,
            match_method="new_canonical",
            confidence=1.0,
            decision=MatchDecision.NEW_ENTITY,
            match_reason="No sufficiently similar canonical entity found; registered new canonical entity.",
            entity=new_entity,
        )
