"""End-to-end FrontierAtlas data intelligence pipeline orchestrator."""

from __future__ import annotations

import argparse
import asyncio
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from src.collectors import (
    CollectionBatch,
    JobCollector,
    NewsCollector,
    ProductCollector,
    ResearchCollector,
    StartupCollector,
)
from src.config.settings import Settings, get_settings
from src.crawler.async_crawler import AsyncCrawler
from src.exporters import CSVExporter, GoogleSheetsExporter
from src.llm import LLMRouter
from src.resolver import CanonicalRegistry, EntityMappingLogger, EntityMatcher
from src.schemas.entity import EntityType
from src.storage import AtlasRepository, DatabaseManager
from src.utils.logging_config import configure_logging, get_logger
from src.validation import (
    CategoryQualityStats,
    DatasetValidator,
    FreshnessFilter,
    QualityReport,
    QualityReportGenerator,
    RecordDeduplicator,
    SourceVerifier,
    VerificationSummary,
)

logger = get_logger("pipeline.orchestrator")

ALL_CATEGORIES: tuple[str, ...] = (
    "startups",
    "products",
    "research_papers",
    "jobs",
    "news",
)

ALL_AUDIT_CATEGORIES: tuple[str, ...] = (
    *ALL_CATEGORIES,
    "entity_mapping_log",
)


@dataclass
class PipelineRunSummary:
    """Verifiable summary of an executed pipeline run."""

    database_counts: dict[str, int] = field(default_factory=dict)
    verification_counts: dict[str, Any] = field(default_factory=dict)
    collector_errors: list[dict[str, Any]] = field(default_factory=list)
    quality_report_path: Optional[Path] = None
    csv_export_dir: Optional[Path] = None
    google_sheets_url: Optional[str] = None
    google_sheets_error: Optional[str] = None


class PipelineOrchestrator:
    """Coordinates collection, validation, freshness, deduplication, source verification, resolution, storage, and export."""

    def __init__(
        self,
        settings: Settings,
        *,
        db: Optional[DatabaseManager] = None,
        crawler: Optional[AsyncCrawler] = None,
        llm_router: Optional[LLMRouter] = None,
    ) -> None:
        self.settings = settings
        self.settings.ensure_directories()
        self.db = db or DatabaseManager.from_settings(settings)
        self.db.initialize_schema()
        self.repo = AtlasRepository(self.db)
        self._external_crawler = crawler
        self.llm_router = llm_router or LLMRouter.from_settings(settings)

        self.validator = DatasetValidator()
        self.freshness = FreshnessFilter(window_hours=settings.freshness_window_hours)
        self.deduplicator = RecordDeduplicator()
        self.registry = CanonicalRegistry()
        self.registry.load_from_repository(self.repo)
        self.matcher = EntityMatcher.from_settings(self.registry, settings)
        self.mapping_logger = EntityMappingLogger()

    def _build_collectors(self, crawler: AsyncCrawler) -> dict[str, Any]:
        return {
            "startups": StartupCollector(self.settings, crawler),
            "products": ProductCollector(self.settings, crawler),
            "research_papers": ResearchCollector(self.settings, crawler),
            "jobs": JobCollector(self.settings, crawler),
            "news": NewsCollector(self.settings, crawler),
        }

    def _resolve_entities_for_records(self, category: str, records: list[Any]) -> None:
        """Resolve entities for startups, products, and jobs and log every decision."""
        if category == "startups":
            for rec in records:
                res = self.matcher.resolve(
                    raw_name=rec.name,
                    entity_type=EntityType.STARTUP,
                    website=rec.website,
                    source_url=rec.source_url,
                )
                rec.canonical_entity_id = res.canonical_id
                self.mapping_logger.record(res, source_url=rec.source_url, entity_type=EntityType.STARTUP)
        elif category == "products":
            for rec in records:
                prod_res = self.matcher.resolve(
                    raw_name=rec.name,
                    entity_type=EntityType.PRODUCT,
                    website=rec.website,
                    source_url=rec.source_url,
                )
                rec.canonical_entity_id = prod_res.canonical_id
                self.mapping_logger.record(
                    prod_res, source_url=rec.source_url, entity_type=EntityType.PRODUCT
                )
                if rec.company_name and rec.company_name != "Unknown":
                    comp_res = self.matcher.resolve(
                        raw_name=rec.company_name,
                        entity_type=EntityType.COMPANY,
                        website=None,
                        source_url=rec.source_url,
                    )
                    self.mapping_logger.record(
                        comp_res, source_url=rec.source_url, entity_type=EntityType.COMPANY
                    )
        elif category == "jobs":
            for rec in records:
                if rec.company and rec.company != "Unknown":
                    comp_res = self.matcher.resolve(
                        raw_name=rec.company,
                        entity_type=EntityType.COMPANY,
                        website=None,
                        source_url=rec.source_url,
                    )
                    rec.canonical_company_id = comp_res.canonical_id
                    self.mapping_logger.record(
                        comp_res, source_url=rec.source_url, entity_type=EntityType.COMPANY
                    )

    def _persist_category(self, category: str, records: list[Any]) -> int:
        if not records:
            return 0
        if category == "startups":
            return self.repo.upsert_startups(records)
        if category == "products":
            return self.repo.upsert_products(records)
        if category == "research_papers":
            return self.repo.upsert_research_papers(records)
        if category == "jobs":
            return self.repo.upsert_jobs(records)
        if category == "news":
            return self.repo.upsert_news(records)
        raise ValueError(f"Unsupported persistence category: {category!r}")

    def _target_for_category(self, category: str) -> Optional[int]:
        return {
            "startups": self.settings.target_startups,
            "products": self.settings.target_products,
            "research_papers": self.settings.target_research_papers,
        }.get(category)

    async def run(
        self,
        *,
        categories: tuple[str, ...] = ALL_CATEGORIES,
        limit_per_category: Optional[int] = None,
        page: int = 1,
        export_csv: bool = True,
        export_sheets: bool = False,
        verify_sources: bool = True,
    ) -> tuple[PipelineRunSummary, QualityReport]:
        """Run the complete pipeline for the selected categories."""
        selected = tuple(c for c in categories if c in ALL_CATEGORIES)
        if not selected:
            raise ValueError(f"No valid categories selected from {categories!r}")

        safe_page = max(1, page)
        category_quality: dict[str, CategoryQualityStats] = {}
        unavailable_sources: list[str] = []
        collected_errors: list[dict[str, Any]] = []

        async def _execute_with_crawler(crawler: AsyncCrawler) -> None:
            verifier = SourceVerifier(
                crawler,
                max_concurrency=min(4, max(1, self.settings.max_concurrency)),
                per_url_timeout_seconds=25.0,
                freshness_window_hours=self.settings.freshness_window_hours,
            )
            collectors = self._build_collectors(crawler)
            tasks = {
                cat: collectors[cat].collect(limit=limit_per_category, page=safe_page)
                for cat in selected
            }
            batches: dict[str, CollectionBatch] = {}
            results = await asyncio.gather(*tasks.values(), return_exceptions=True)

            for cat, outcome in zip(tasks.keys(), results):
                if isinstance(outcome, Exception):
                    logger.error(
                        "Collector crashed safely",
                        extra={"ctx": {"category": cat, "error": str(outcome)}},
                    )
                    self.repo.record_failure(
                        stage="collect",
                        category=cat,
                        reason=str(outcome),
                    )
                    batches[cat] = CollectionBatch(category=cat)
                    unavailable_sources.append(f"{cat}:collector_error")
                    collected_errors.append({"category": cat, "source": cat, "error": str(outcome)})
                else:
                    batches[cat] = outcome
                    unavailable_sources.extend(outcome.stats.unavailable_sources)
                    for err in outcome.errors:
                        collected_errors.append({"category": cat, **err})
                        self.repo.record_failure(
                            stage="collect",
                            category=cat,
                            source_url=err.get("url"),
                            reason=str(err.get("error") or "collection_error"),
                            payload=err,
                        )

            id_field_map = {
                "startups": ("startup_id", "name"),
                "products": ("product_id", "name"),
                "research_papers": ("paper_id", "title"),
                "jobs": ("job_id", "title"),
                "news": ("news_id", "headline"),
            }

            for cat in selected:
                batch = batches[cat]
                raw_records = list(batch.records)
                freshness_dict: Optional[dict[str, Any]] = None
                rejection_samples: list[str] = []
                rejected_count = 0

                if cat in {"jobs", "news"}:
                    fresh_out = self.freshness.filter_records(cat, raw_records)
                    freshness_dict = {
                        "window_hours": fresh_out.stats.window_hours,
                        "evaluated": fresh_out.stats.evaluated,
                        "accepted": fresh_out.stats.accepted,
                        "rejected_older": fresh_out.stats.rejected_older,
                        "rejected_missing_date": fresh_out.stats.rejected_missing_date,
                        "rejected_future_date": fresh_out.stats.rejected_future_date,
                    }
                    for rej in fresh_out.rejected:
                        rejected_count += 1
                        if len(rejection_samples) < 5:
                            rejection_samples.append(rej["reason"])
                        self.repo.record_failure(
                            stage="freshness",
                            category=cat,
                            source_url=rej["record"].get("source_url"),
                            reason=rej["reason"],
                            payload=rej["record"],
                        )
                    raw_records = fresh_out.accepted

                val_out = self.validator.validate_batch(cat, raw_records)
                for rej in val_out.rejected:
                    rejected_count += 1
                    if len(rejection_samples) < 5:
                        rejection_samples.append(rej["reason"][:180])
                    self.repo.record_failure(
                        stage="validation",
                        category=cat,
                        source_url=rej.get("source_url"),
                        reason=rej["reason"],
                        payload=rej.get("raw"),
                    )

                dedup_out = self.deduplicator.deduplicate(cat, val_out.validated)
                records_to_persist = dedup_out.unique_records
                ver_summary = VerificationSummary(unverified=len(records_to_persist))
                if records_to_persist:
                    records_to_persist, ver_summary = await verifier.verify_batch(
                        cat,
                        records_to_persist,
                        live_check=verify_sources,
                    )

                self._resolve_entities_for_records(cat, records_to_persist)
                self._persist_category(cat, records_to_persist)

                id_col, name_col = id_field_map[cat]
                audit_rows = []
                for rec in records_to_persist:
                    meta = getattr(rec, "source_metadata", {}) or {}
                    audit_rows.append(
                        {
                            "category": cat,
                            "record_id": getattr(rec, id_col),
                            "record_name": getattr(rec, name_col, ""),
                            "previous_status": None,
                            "new_status": rec.verification_status.value,
                            "issues": meta.get("audit_issues") or [],
                            "source_url": rec.source_url,
                            "source_title": rec.source_title,
                            "evidence_excerpt": meta.get("source_evidence_excerpt"),
                            "reason": verifier._build_audit_reason(rec, None),
                        }
                    )
                if audit_rows:
                    self.repo.record_audit_entries(audit_rows)

                next_cursor = f"page:{batch.stats.next_page}" if batch.stats.next_page else f"page:{safe_page}"
                self.repo.save_checkpoint(
                    source_key=f"pipeline:{cat}",
                    category=cat,
                    cursor=next_cursor,
                    count=len(records_to_persist),
                )

                persisted_counts = self.repo.count_records()
                persisted_total = persisted_counts.get(cat, 0)
                target_min = self._target_for_category(cat)
                target_met = (persisted_total >= target_min) if target_min is not None else None

                category_quality[cat] = CategoryQualityStats(
                    discovered=batch.stats.discovered,
                    extracted=batch.stats.extracted,
                    validated=len(val_out.validated),
                    rejected=rejected_count,
                    duplicates=dedup_out.duplicate_count,
                    persisted_total=persisted_total,
                    target_minimum=target_min,
                    target_met=target_met,
                    verification_breakdown=ver_summary.to_dict(),
                    missing_fields=val_out.missing_fields,
                    source_distribution=val_out.source_distribution,
                    freshness=freshness_dict,
                    sample_rejection_reasons=rejection_samples,
                )

        if self._external_crawler is not None:
            await _execute_with_crawler(self._external_crawler)
        else:
            async with AsyncCrawler.from_settings(self.settings) as managed_crawler:
                await _execute_with_crawler(managed_crawler)

        # Persist canonical entities & mapping logs
        self.repo.upsert_canonical_entities(self.registry.all_entities())
        self.mapping_logger.flush(self.repo)

        db_counts = self.repo.count_records()
        ver_counts = self.repo.get_verification_counts()
        report = QualityReportGenerator().build(
            category_stats=category_quality,
            entity_resolution_stats=self.mapping_logger.summary(),
            unavailable_sources=unavailable_sources,
        )
        report_path = report.write_json(self.settings.data_dir / "quality_report.json")

        summary = PipelineRunSummary(
            database_counts=db_counts,
            verification_counts=ver_counts,
            collector_errors=collected_errors,
            quality_report_path=report_path,
        )

        if export_csv:
            csv_dir = self.settings.data_dir / "exports"
            CSVExporter().export_all(self.repo, csv_dir)
            summary.csv_export_dir = csv_dir

        if export_sheets:
            gs_summary = GoogleSheetsExporter.from_settings(self.settings).export_all(self.repo)
            if gs_summary.success:
                summary.google_sheets_url = gs_summary.spreadsheet_url
            else:
                summary.google_sheets_error = gs_summary.error

        logger.info("Pipeline run completed", extra={"ctx": {"counts": db_counts}})
        return summary, report

    async def audit_existing(
        self,
        *,
        categories: tuple[str, ...] = ALL_AUDIT_CATEGORIES,
        export_csv: bool = True,
        live_check: bool = True,
        remove_duplicates: bool = False,
    ) -> dict[str, Any]:
        """Re-verify all existing database records across all datasets against original source URLs."""
        selected = tuple(c for c in categories if c in ALL_AUDIT_CATEGORIES)

        async def _run_audit(crawler: AsyncCrawler) -> dict[str, Any]:
            verifier = SourceVerifier(
                crawler,
                max_concurrency=min(4, max(1, self.settings.max_concurrency)),
                per_url_timeout_seconds=25.0,
                freshness_window_hours=self.settings.freshness_window_hours,
            )
            return await verifier.audit_repository(
                self.repo,
                categories=selected,
                live_check=live_check,
                remove_duplicates=remove_duplicates,
            )

        if self._external_crawler is not None:
            audit_result = await _run_audit(self._external_crawler)
        else:
            async with AsyncCrawler.from_settings(self.settings) as managed_crawler:
                audit_result = await _run_audit(managed_crawler)

        if export_csv:
            CSVExporter().export_all(self.repo, self.settings.data_dir / "exports")

        return {
            "auditedCategories": audit_result["auditedCategories"],
            "auditEntriesLogged": audit_result["auditEntriesLogged"],
            "duplicatesRemoved": audit_result.get("duplicatesRemoved", {}),
            "databaseCounts": self.repo.count_records(),
            "verificationCounts": self.repo.get_verification_counts(),
        }


def _parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the FrontierAtlas data intelligence pipeline.")
    parser.add_argument(
        "--categories",
        nargs="+",
        default=["all"],
        help="Categories to run: all, startups, products, research_papers, jobs, news",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=50,
        help="Maximum records per category to collect in this run (default: 50)",
    )
    parser.add_argument(
        "--page",
        type=int,
        default=1,
        help="1-indexed page number for paginated source collection (default: 1)",
    )
    parser.add_argument(
        "--export-csv",
        action="store_true",
        default=True,
        help="Export all six datasets to CSV under data/exports/",
    )
    parser.add_argument(
        "--export-sheets",
        action="store_true",
        default=False,
        help="Export all six datasets to Google Sheets (requires configured credentials)",
    )
    return parser.parse_args(argv)


async def async_main(argv: Optional[list[str]] = None) -> int:
    args = _parse_args(argv)
    settings = get_settings()
    settings.ensure_directories()
    configure_logging(settings.log_level, log_file=settings.logs_dir / "frontier_atlas.log")

    cats = ALL_CATEGORIES if "all" in args.categories else tuple(args.categories)
    orchestrator = PipelineOrchestrator(settings)
    summary, _ = await orchestrator.run(
        categories=cats,
        limit_per_category=args.limit,
        page=args.page,
        export_csv=args.export_csv,
        export_sheets=args.export_sheets,
    )
    print("Database counts:", summary.database_counts)
    print("Verification summary:", summary.verification_counts.get("totals"))
    print("Quality report:", summary.quality_report_path)
    if summary.csv_export_dir:
        print("CSV exports:", summary.csv_export_dir)
    if summary.google_sheets_url:
        print("Google Sheets:", summary.google_sheets_url)
    elif summary.google_sheets_error:
        print("Google Sheets status:", summary.google_sheets_error)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(asyncio.run(async_main()))
