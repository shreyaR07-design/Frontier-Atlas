"""Phase 6 tests: CSV export, Google Sheets batch preparation, exact tab names, and error handling."""

from __future__ import annotations

import csv
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from src.exporters import CSVExporter, EXPORT_SPECS, GoogleSheetsExporter, prepare_table_rows
from src.schemas import (
    EntityMappingLog,
    EntityType,
    JobRecord,
    MatchDecision,
    NewsRecord,
    ProductRecord,
    ResearchPaperRecord,
    StartupRecord,
)
from src.storage.database import DatabaseManager
from src.storage.repository import AtlasRepository


class FakeWorksheet:
    def __init__(self, title: str) -> None:
        self.title = title
        self.updates: list[tuple[str, list[list[Any]]]] = []
        self.cleared = False

    def clear(self) -> None:
        self.cleared = True

    def resize(self, rows: int, cols: int) -> None:
        self.rows = rows
        self.cols = cols

    def update(self, range_name: str, values: list[list[Any]], value_input_option: str = "RAW") -> None:
        self.updates.append((range_name, values))


class FakeSpreadsheet:
    def __init__(self) -> None:
        self.id = "fake-sheet-123"
        self.url = "https://docs.google.com/spreadsheets/d/fake-sheet-123"
        self._sheets: dict[str, FakeWorksheet] = {"Sheet1": FakeWorksheet("Sheet1")}

    def worksheets(self) -> list[FakeWorksheet]:
        return list(self._sheets.values())

    def add_worksheet(self, title: str, rows: int, cols: int) -> FakeWorksheet:
        ws = FakeWorksheet(title)
        self._sheets[title] = ws
        return ws

    def del_worksheet(self, ws: FakeWorksheet) -> None:
        self._sheets.pop(ws.title, None)


class FakeGSpreadClient:
    def __init__(self, spreadsheet: FakeSpreadsheet) -> None:
        self.spreadsheet = spreadsheet

    def create(self, name: str) -> FakeSpreadsheet:
        return self.spreadsheet

    def open_by_key(self, key: str) -> FakeSpreadsheet:
        return self.spreadsheet


def _seed_sample_repo(tmp_path: Path) -> AtlasRepository:
    db = DatabaseManager(database_url=f"sqlite:///{tmp_path / 'export.db'}", base_dir=tmp_path)
    db.initialize_schema()
    repo = AtlasRepository(db)
    ts = datetime(2026, 11, 21, 10, 0, 0, tzinfo=timezone.utc)

    repo.upsert_startups(
        [
            StartupRecord(
                name="Acme Robotics",
                website="https://acmerobotics.example",
                source_name="yc",
                source_url="https://yc.example/acme",
                collected_at=ts,
            )
        ]
    )
    repo.upsert_products(
        [
            ProductRecord(
                name="Acme Arm",
                company_name="Acme Robotics",
                source_name="official",
                source_url="https://acmerobotics.example/arm",
                collected_at=ts,
            )
        ]
    )
    repo.upsert_research_papers(
        [
            ResearchPaperRecord(
                title="Robotic Grasping Benchmark",
                authors=["Grace Hopper", "Alan Kay"],
                github_repository="https://github.com/acme/grasp-bench",
                github_stars=125,
                source_name="arxiv",
                source_url="https://arxiv.org/abs/2611.00010",
                collected_at=ts,
            )
        ]
    )
    repo.upsert_jobs(
        [
            JobRecord(
                title="Robotics Engineer",
                company="Acme Robotics",
                posted_at=ts,
                application_url="https://acmerobotics.example/jobs/1",
                source_name="greenhouse",
                source_url="https://boards.example/acme",
                collected_at=ts,
            )
        ]
    )
    repo.upsert_news(
        [
            NewsRecord(
                headline="Acme Robotics Launches Arm v2",
                publisher="Robotics Wire",
                published_at=ts,
                article_url="https://wire.example/acme-v2",
                source_url="https://wire.example/rss",
                collected_at=ts,
            )
        ]
    )
    repo.upsert_entity_mapping_logs(
        [
            EntityMappingLog(
                raw_name="Acme Robotics Inc.",
                normalized_name="acme robotics",
                canonical_name="Acme Robotics",
                canonical_id="ent_0001",
                source_url="https://yc.example/acme",
                match_method="legal_suffix_or_alias_match",
                confidence=0.98,
                decision=MatchDecision.AUTO_MERGE,
                entity_type=EntityType.STARTUP,
                timestamp=ts,
            )
        ]
    )
    return repo


def test_csv_and_google_sheets_exporters(tmp_path: Path) -> None:
    repo = _seed_sample_repo(tmp_path)

    # Verify exact six tab names
    assert [s.tab_name for s in EXPORT_SPECS] == [
        "Startups",
        "Products",
        "Research Papers",
        "Jobs",
        "News",
        "Entity Mapping Log",
    ]

    # Verify CSV export
    csv_summary = CSVExporter().export_all(repo, tmp_path / "exports")
    assert len(csv_summary.files_written) == 6
    assert all(count == 1 for count in csv_summary.row_counts.values())
    with (tmp_path / "exports" / "research_papers.csv").open("r", encoding="utf-8") as fh:
        rows = list(csv.reader(fh))
    assert rows[0][3] == "authors"
    assert rows[1][3] == "Grace Hopper; Alan Kay"
    assert rows[1][8] == "125"
    assert "source_name" in rows[0]
    assert "verification_reason" in rows[0]

    with (tmp_path / "exports" / "news.csv").open("r", encoding="utf-8") as fh:
        news_rows = list(csv.reader(fh))
    assert "source_name" in news_rows[0]
    assert "verification_reason" in news_rows[0]

    with (tmp_path / "exports" / "entity_mapping_log.csv").open("r", encoding="utf-8") as fh:
        em_rows = list(csv.reader(fh))
    assert "entity_type" in em_rows[0]
    assert "match_reason" in em_rows[0]

    # Verify Google Sheets batch preparation & mocked API write
    fake_book = FakeSpreadsheet()
    gs_exporter = GoogleSheetsExporter(
        batch_size=50,
        client_factory=lambda: FakeGSpreadClient(fake_book),
    )
    gs_summary = gs_exporter.export_all(repo)
    assert gs_summary.success is True
    assert set(gs_summary.tab_row_counts.keys()) == {s.tab_name for s in EXPORT_SPECS}
    assert all(cnt == 1 for cnt in gs_summary.tab_row_counts.values())
    assert "Sheet1" not in fake_book._sheets

    # Verify unconfigured exporter does NOT falsely claim success
    unconfigured = GoogleSheetsExporter(credentials_path=None)
    fail_summary = unconfigured.export_all(repo)
    assert fail_summary.success is False
    assert fail_summary.error is not None
    assert prepare_table_rows(repo, EXPORT_SPECS[0])[0][0] == "startup_id"
