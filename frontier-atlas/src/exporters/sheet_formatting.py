"""Shared dataset column definitions, formatting, and duplicate-free row preparation."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from src.storage.repository import AtlasRepository


@dataclass(frozen=True)
class DatasetExportSpec:
    """Export specification mapping a storage table to its display tab and ordered columns."""

    table_name: str
    tab_name: str
    csv_filename: str
    id_column: str
    columns: tuple[str, ...]


TRACEABILITY_EXPORT_COLUMNS: tuple[str, ...] = (
    "official_website",
    "source_title",
    "last_checked_at",
    "supported_fields",
    "verification_status",
    "verification_reason",
    "rejection_reason",
)

EXPORT_SPECS: tuple[DatasetExportSpec, ...] = (
    DatasetExportSpec(
        table_name="startups",
        tab_name="Startups",
        csv_filename="startups.csv",
        id_column="startup_id",
        columns=(
            "startup_id",
            "name",
            "description",
            "website",
            "industry",
            "location",
            "founding_date",
            "source_name",
            "source_url",
            "collected_at",
            "canonical_entity_id",
            *TRACEABILITY_EXPORT_COLUMNS,
            "source_metadata_json",
        ),
    ),
    DatasetExportSpec(
        table_name="products",
        tab_name="Products",
        csv_filename="products.csv",
        id_column="product_id",
        columns=(
            "product_id",
            "name",
            "description",
            "website",
            "category",
            "company_name",
            "source_name",
            "source_url",
            "collected_at",
            "canonical_entity_id",
            *TRACEABILITY_EXPORT_COLUMNS,
            "source_metadata_json",
        ),
    ),
    DatasetExportSpec(
        table_name="research_papers",
        tab_name="Research Papers",
        csv_filename="research_papers.csv",
        id_column="paper_id",
        columns=(
            "paper_id",
            "title",
            "abstract",
            "authors",
            "publication_date",
            "doi",
            "arxiv_id",
            "github_repository",
            "github_stars",
            "source_name",
            "source_url",
            "collected_at",
            *TRACEABILITY_EXPORT_COLUMNS,
            "source_metadata_json",
        ),
    ),
    DatasetExportSpec(
        table_name="jobs",
        tab_name="Jobs",
        csv_filename="jobs.csv",
        id_column="job_id",
        columns=(
            "job_id",
            "title",
            "company",
            "location",
            "employment_type",
            "description",
            "posted_at",
            "application_url",
            "canonical_company_id",
            "source_name",
            "source_url",
            "collected_at",
            *TRACEABILITY_EXPORT_COLUMNS,
            "source_metadata_json",
        ),
    ),
    DatasetExportSpec(
        table_name="news",
        tab_name="News",
        csv_filename="news.csv",
        id_column="news_id",
        columns=(
            "news_id",
            "headline",
            "summary",
            "publisher",
            "published_at",
            "article_url",
            "category",
            "source_name",
            "source_url",
            "collected_at",
            *TRACEABILITY_EXPORT_COLUMNS,
            "source_metadata_json",
        ),
    ),
    DatasetExportSpec(
        table_name="entity_mapping_log",
        tab_name="Entity Mapping Log",
        csv_filename="entity_mapping_log.csv",
        id_column="mapping_id",
        columns=(
            "mapping_id",
            "raw_name",
            "normalized_name",
            "canonical_name",
            "canonical_id",
            "entity_type",
            "source_url",
            "match_method",
            "confidence",
            "decision",
            "match_reason",
            "timestamp",
        ),
    ),
)


def _format_cell(col: str, row: dict[str, Any], *, for_sheets: bool = True) -> Any:
    if col == "authors":
        raw_authors = row.get("authors_json") if "authors_json" in row else row.get("authors")
        if isinstance(raw_authors, str):
            try:
                parsed = json.loads(raw_authors)
                if isinstance(parsed, list):
                    return "; ".join(str(a) for a in parsed)
            except ValueError:
                return raw_authors
        elif isinstance(raw_authors, list):
            return "; ".join(str(a) for a in raw_authors)
        return ""

    if col == "supported_fields":
        raw_sf = row.get("supported_fields_json") if "supported_fields_json" in row else row.get("supported_fields")
        if isinstance(raw_sf, str):
            try:
                parsed = json.loads(raw_sf)
                if isinstance(parsed, list):
                    return "; ".join(str(f) for f in parsed)
            except ValueError:
                return raw_sf
        elif isinstance(raw_sf, list):
            return "; ".join(str(f) for f in raw_sf)
        return ""

    if col == "official_website":
        val = row.get("official_website") or row.get("website")
        return "" if val is None else str(val)

    if col == "verification_reason":
        rej = row.get("rejection_reason")
        if rej:
            return str(rej)
        raw_meta = row.get("source_metadata_json")
        if isinstance(raw_meta, str) and raw_meta.strip():
            try:
                meta = json.loads(raw_meta)
                if isinstance(meta, dict):
                    reason = meta.get("verification_reason") or meta.get("source_error")
                    if reason:
                        return str(reason)
            except ValueError:
                pass
        return ""

    if col == "source_metadata_json":
        raw_meta = row.get("source_metadata_json") if "source_metadata_json" in row else row.get("source_metadata")
        if raw_meta is None:
            return "{}"
        serialized = raw_meta if isinstance(raw_meta, str) else json.dumps(raw_meta)
        return serialized[:45000] if for_sheets and len(serialized) > 45000 else serialized

    val = row.get(col)
    if val is None:
        return ""
    if col == "github_stars":
        return int(val) if for_sheets else str(int(val))
    if col == "confidence":
        return round(float(val), 4) if for_sheets else f"{float(val):.4f}"
    return str(val)


def prepare_table_rows(
    repo: AtlasRepository,
    spec: DatasetExportSpec,
    *,
    for_sheets: bool = True,
) -> list[list[Any]]:
    """Load, deduplicate by primary key, and format header + data rows for export."""
    raw_rows = repo.fetch_dataset(spec.table_name)
    seen_ids: set[str] = set()
    formatted_rows: list[list[Any]] = [list(spec.columns)]

    for row in raw_rows:
        row_id = str(row.get(spec.id_column) or "")
        if not row_id or row_id in seen_ids:
            continue
        seen_ids.add(row_id)
        formatted_rows.append(
            [_format_cell(col, row, for_sheets=for_sheets) for col in spec.columns]
        )
    return formatted_rows
