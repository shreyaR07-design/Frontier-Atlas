"""Token-aware text chunking utilities for LLM extraction."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass


PARAGRAPH_SPLIT_RE = re.compile(r"\n\s*\n+")
SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")


@dataclass(frozen=True)
class TextChunk:
    """A single chunk of source text with byte/character provenance."""

    index: int
    total_chunks: int
    text: str
    estimated_tokens: int
    start_char: int
    end_char: int


def estimate_tokens(text: str) -> int:
    """Conservative token estimator (~3.8 characters per token for English/HTML text)."""
    if not text:
        return 0
    return max(1, math.ceil(len(text) / 3.8))


def chunk_text(
    text: str,
    *,
    max_tokens: int = 8000,
    overlap_tokens: int = 200,
) -> list[TextChunk]:
    """Split text into token-bounded chunks with configurable overlap."""
    cleaned = (text or "").strip()
    if not cleaned:
        return []

    max_chars = max(400, int(max_tokens * 3.8))
    overlap_chars = max(0, min(int(overlap_tokens * 3.8), max_chars // 3))

    if len(cleaned) <= max_chars:
        return [
            TextChunk(
                index=0,
                total_chunks=1,
                text=cleaned,
                estimated_tokens=estimate_tokens(cleaned),
                start_char=0,
                end_char=len(cleaned),
            )
        ]

    # Split into natural paragraphs/sentences first so boundaries stay coherent
    segments = [seg.strip() for seg in PARAGRAPH_SPLIT_RE.split(cleaned) if seg.strip()]
    if len(segments) == 1:
        segments = [seg.strip() for seg in SENTENCE_SPLIT_RE.split(cleaned) if seg.strip()]

    raw_chunks: list[tuple[int, int, str]] = []
    current_parts: list[str] = []
    current_len = 0
    cursor = 0
    chunk_start = 0

    for seg in segments:
        # If a single segment exceeds max_chars, hard-slice it cleanly
        if len(seg) > max_chars:
            if current_parts:
                joined = "\n\n".join(current_parts)
                raw_chunks.append((chunk_start, cursor, joined))
                current_parts = []
                current_len = 0
            pos = 0
            while pos < len(seg):
                end = min(len(seg), pos + max_chars)
                piece = seg[pos:end]
                raw_chunks.append((cursor + pos, cursor + end, piece))
                if end == len(seg):
                    break
                pos = max(pos + 1, end - overlap_chars)
            cursor += len(seg) + 2
            chunk_start = cursor
            continue

        added_len = len(seg) + (2 if current_parts else 0)
        if current_len + added_len > max_chars and current_parts:
            joined = "\n\n".join(current_parts)
            raw_chunks.append((chunk_start, chunk_start + len(joined), joined))

            # Build overlap tail from existing parts
            overlap_parts: list[str] = []
            overlap_len = 0
            for prev in reversed(current_parts):
                if overlap_len + len(prev) <= overlap_chars:
                    overlap_parts.insert(0, prev)
                    overlap_len += len(prev) + 2
                else:
                    break
            current_parts = overlap_parts + [seg]
            current_len = sum(len(p) for p in current_parts) + max(0, (len(current_parts) - 1) * 2)
            chunk_start = max(0, (chunk_start + len(joined)) - overlap_len)
        else:
            current_parts.append(seg)
            current_len += added_len
        cursor += len(seg) + 2

    if current_parts:
        joined = "\n\n".join(current_parts)
        raw_chunks.append((chunk_start, min(len(cleaned), chunk_start + len(joined)), joined))

    total = len(raw_chunks)
    return [
        TextChunk(
            index=idx,
            total_chunks=total,
            text=chunk_str,
            estimated_tokens=estimate_tokens(chunk_str),
            start_char=start,
            end_char=end,
        )
        for idx, (start, end, chunk_str) in enumerate(raw_chunks)
    ]
