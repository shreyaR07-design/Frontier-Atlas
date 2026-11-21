"""CSV fallback exporter writing all six datasets cleanly."""

from __future__ import annotations

import csv
from dataclasses import dataclass, field
from pathlib import Path

from src.exporters.sheet_formatting import EXPORT_SPECS, prepare_table_rows
from src.storage.repository import AtlasRepository
from src.utils.logging_config import get_logger

logger = get_logger("exporters.csv")


@dataclass
class CSVExportSummary:
    """Summary of exported CSV files and row counts (excluding headers)."""

    output_dir: Path
    files_written: dict[str, Path] = field(default_factory=dict)
    row_counts: dict[str, int] = field(default_factory=dict)


class CSVExporter:
    """Exports all six FrontierAtlas datasets to UTF-8 CSV files."""

    def export_all(self, repo: AtlasRepository, output_dir: Path) -> CSVExportSummary:
        output_dir.mkdir(parents=True, exist_ok=True)
        summary = CSVExportSummary(output_dir=output_dir)

        for spec in EXPORT_SPECS:
            rows = prepare_table_rows(repo, spec, for_sheets=False)
            target_file = output_dir / spec.csv_filename
            with target_file.open("w", encoding="utf-8", newline="") as fh:
                writer = csv.writer(fh)
                writer.writerows(rows)
            data_count = max(0, len(rows) - 1)
            summary.files_written[spec.tab_name] = target_file
            summary.row_counts[spec.tab_name] = data_count
            logger.info(
                "Exported CSV dataset",
                extra={"ctx": {"tab": spec.tab_name, "rows": data_count, "path": str(target_file)}},
            )

        return summary
