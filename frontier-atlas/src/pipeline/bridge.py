"""JSON CLI bridge exposing existing FrontierAtlas backend state, audit trail, and actions."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any, Optional

from src.config.settings import get_settings
from src.exporters import CSVExporter, GoogleSheetsExporter
from src.pipeline.orchestrator import ALL_AUDIT_CATEGORIES, ALL_CATEGORIES, PipelineOrchestrator
from src.storage import AtlasRepository, DatabaseManager


def _get_repo() -> tuple[Any, DatabaseManager, AtlasRepository]:
    settings = get_settings()
    settings.ensure_directories()
    db = DatabaseManager.from_settings(settings)
    db.initialize_schema()
    repo = AtlasRepository(db)
    return settings, db, repo


def cmd_status() -> dict[str, Any]:
    settings, _, repo = _get_repo()
    counts = repo.count_records()
    verification_counts = repo.get_verification_counts()
    checkpoints = repo.db.fetch_all("SELECT * FROM collection_checkpoints ORDER BY last_collected_at DESC;")
    failures_count_rows = repo.db.fetch_all("SELECT COUNT(*) AS cnt FROM failure_logs;")
    failures_count = int(failures_count_rows[0]["cnt"]) if failures_count_rows else 0
    recent_audit = repo.fetch_audit_trail(limit=50)

    quality_report_path = settings.data_dir / "quality_report.json"
    quality_report = None
    if quality_report_path.exists():
        try:
            quality_report = json.loads(quality_report_path.read_text(encoding="utf-8"))
        except ValueError:
            quality_report = None

    sheets_creds_exists = bool(
        settings.google_sheets_credentials_path
        and Path(settings.google_sheets_credentials_path).exists()
    )

    exports_dir = settings.data_dir / "exports"
    csv_files = (
        sorted(p.name for p in exports_dir.glob("*.csv"))
        if exports_dir.exists()
        else []
    )

    return {
        "counts": counts,
        "verificationCounts": verification_counts,
        "auditTrail": recent_audit,
        "failureCount": failures_count,
        "targets": {
            "startups": settings.target_startups,
            "products": settings.target_products,
            "research_papers": settings.target_research_papers,
        },
        "freshnessWindowHours": settings.freshness_window_hours,
        "credentials": {
            "geminiConfigured": bool(settings.gemini_api_key),
            "geminiModel": settings.gemini_model,
            "groqConfigured": bool(settings.groq_api_key),
            "deepseekConfigured": bool(settings.deepseek_api_key),
            "githubTokenConfigured": bool(settings.github_token),
            "googleSheetsConfigured": sheets_creds_exists,
            "googleSheetsSpreadsheetId": bool(settings.google_sheets_spreadsheet_id),
        },
        "storage": {
            "backend": settings.database_backend,
            "sqlitePath": str(settings.sqlite_path) if settings.database_backend == "sqlite" else None,
        },
        "checkpoints": checkpoints,
        "qualityReport": quality_report,
        "csvExports": csv_files,
    }


def cmd_dataset(category: str, limit: int) -> dict[str, Any]:
    allowed = {
        "startups",
        "products",
        "research_papers",
        "jobs",
        "news",
        "entity_mapping_log",
        "failure_logs",
        "verification_audit_log",
    }
    if category not in allowed:
        raise ValueError(f"Unsupported dataset: {category!r}")
    _, _, repo = _get_repo()
    rows = repo.fetch_dataset(category, limit=limit)
    return {"category": category, "rows": rows, "count": len(rows)}


def cmd_audit_trail(
    category: Optional[str] = None,
    record_id: Optional[str] = None,
    limit: int = 100,
) -> dict[str, Any]:
    _, _, repo = _get_repo()
    rows = repo.fetch_audit_trail(category=category, record_id=record_id, limit=limit)
    return {"entries": rows, "count": len(rows)}


def cmd_run(categories: list[str], limit: int, page: int = 1) -> dict[str, Any]:
    settings = get_settings()
    selected = ALL_CATEGORIES if "all" in categories else tuple(c for c in categories if c in ALL_CATEGORIES)
    if not selected:
        raise ValueError(f"No valid categories in {categories!r}")

    orchestrator = PipelineOrchestrator(settings)
    summary, report = asyncio.run(
        orchestrator.run(
            categories=selected,
            limit_per_category=limit,
            page=page,
            export_csv=True,
            export_sheets=False,
        )
    )
    return {
        "databaseCounts": summary.database_counts,
        "verificationCounts": summary.verification_counts,
        "collectorErrors": summary.collector_errors,
        "qualityReport": report.to_dict(),
        "csvExportDir": str(summary.csv_export_dir) if summary.csv_export_dir else None,
    }


def cmd_audit(
    categories: list[str],
    live_check: bool = True,
    remove_duplicates: bool = True,
) -> dict[str, Any]:
    settings = get_settings()
    selected = ALL_AUDIT_CATEGORIES if "all" in categories else tuple(c for c in categories if c in ALL_AUDIT_CATEGORIES)
    if not selected:
        raise ValueError(f"No valid categories in {categories!r}")

    orchestrator = PipelineOrchestrator(settings)
    return asyncio.run(
        orchestrator.audit_existing(
            categories=selected,
            export_csv=True,
            live_check=live_check,
            remove_duplicates=remove_duplicates,
        )
    )


def cmd_export_sheets() -> dict[str, Any]:
    settings, _, repo = _get_repo()
    exporter = GoogleSheetsExporter.from_settings(settings)
    res = exporter.export_all(repo)
    return {
        "success": res.success,
        "spreadsheetId": res.spreadsheet_id,
        "spreadsheetUrl": res.spreadsheet_url,
        "tabRowCounts": res.tab_row_counts,
        "error": res.error,
    }


def cmd_export_csv() -> dict[str, Any]:
    settings, _, repo = _get_repo()
    summary = CSVExporter().export_all(repo, settings.data_dir / "exports")
    return {
        "outputDir": str(summary.output_dir),
        "rowCounts": summary.row_counts,
        "files": {k: str(v) for k, v in summary.files_written.items()},
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="FrontierAtlas JSON bridge")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("status")

    ds_p = sub.add_parser("dataset")
    ds_p.add_argument("--category", required=True)
    ds_p.add_argument("--limit", type=int, default=200)

    at_p = sub.add_parser("audit-trail")
    at_p.add_argument("--category", required=False, default=None)
    at_p.add_argument("--record-id", required=False, default=None)
    at_p.add_argument("--limit", type=int, default=100)

    run_p = sub.add_parser("run")
    run_p.add_argument("--categories", nargs="+", default=["all"])
    run_p.add_argument("--limit", type=int, default=20)
    run_p.add_argument("--page", type=int, default=1)

    audit_p = sub.add_parser("audit")
    audit_p.add_argument("--categories", nargs="+", default=["all"])
    audit_p.add_argument("--offline", action="store_true", default=False)
    audit_p.add_argument("--keep-duplicates", action="store_true", default=False)

    sub.add_parser("export-sheets")
    sub.add_parser("export-csv")

    args = parser.parse_args(argv)
    try:
        if args.command == "status":
            payload = cmd_status()
        elif args.command == "dataset":
            payload = cmd_dataset(args.category, args.limit)
        elif args.command == "audit-trail":
            payload = cmd_audit_trail(
                category=args.category,
                record_id=args.record_id,
                limit=args.limit,
            )
        elif args.command == "run":
            payload = cmd_run(args.categories, args.limit, page=args.page)
        elif args.command == "audit":
            payload = cmd_audit(
                args.categories,
                live_check=not args.offline,
                remove_duplicates=not args.keep_duplicates,
            )
        elif args.command == "export-sheets":
            payload = cmd_export_sheets()
        elif args.command == "export-csv":
            payload = cmd_export_csv()
        else:
            raise ValueError(f"Unknown command: {args.command}")
        print(json.dumps(payload, default=str))
        return 0
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
