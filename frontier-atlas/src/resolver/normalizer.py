"""Entity name normalization, legal suffix handling, and tokenization utilities."""

from __future__ import annotations

import re
import unicodedata

LEGAL_SUFFIXES: frozenset[str] = frozenset(
    {
        "inc",
        "incorporated",
        "corp",
        "corporation",
        "llc",
        "ltd",
        "limited",
        "plc",
        "gmbh",
        "ag",
        "sa",
        "sas",
        "sarl",
        "bv",
        "nv",
        "pty",
        "co",
        "company",
        "lp",
        "llp",
        "pbc",
    }
)

GENERIC_HOST_DOMAINS: frozenset[str] = frozenset(
    {
        "github.com",
        "gitlab.com",
        "bitbucket.org",
        "linkedin.com",
        "twitter.com",
        "x.com",
        "medium.com",
        "substack.com",
        "ycombinator.com",
        "news.ycombinator.com",
        "arxiv.org",
        "huggingface.co",
        "notion.site",
        "docs.google.com",
    }
)

PUNCTUATION_RE = re.compile(r"[^\w\s]+", re.UNICODE)
WHITESPACE_RE = re.compile(r"\s+")


def normalize_entity_name(raw_name: str, *, strip_legal_suffixes: bool = True) -> str:
    """Normalize an entity name (NFKC, lowercase, punctuation removal, legal suffix stripping)."""
    if not raw_name or not raw_name.strip():
        return ""
    text = unicodedata.normalize("NFKC", raw_name).lower().strip()
    # Replace punctuation/hyphens/underscores with spaces for clean tokenization
    text = text.replace("_", " ").replace("-", " ")
    text = PUNCTUATION_RE.sub(" ", text)
    tokens = [tok for tok in WHITESPACE_RE.sub(" ", text).strip().split(" ") if tok]

    if strip_legal_suffixes:
        while len(tokens) > 1 and tokens[-1] in LEGAL_SUFFIXES:
            tokens.pop()

    return " ".join(tokens)


def compact_entity_key(normalized_name: str) -> str:
    """Collapse internal spaces (e.g., 'open ai' -> 'openai') for spacing-variant checks."""
    return normalized_name.replace(" ", "")


def meaningful_tokens(normalized_name: str) -> list[str]:
    """Return non-empty tokens excluding very short noise tokens when longer tokens exist."""
    return [tok for tok in normalized_name.split(" ") if tok]


def is_specific_company_domain(domain: str | None) -> bool:
    """Return True if domain is likely dedicated to a single company/product rather than a shared host."""
    if not domain:
        return False
    lower = domain.lower().strip()
    if lower in GENERIC_HOST_DOMAINS:
        return False
    # Ignore subdomain-only shared platforms like foo.github.io or bar.substack.com
    for suffix in (".github.io", ".substack.com", ".medium.com", ".notion.site", ".blogspot.com"):
        if lower.endswith(suffix):
            return False
    return "." in lower
