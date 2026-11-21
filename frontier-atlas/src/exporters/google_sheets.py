"""Google Sheets API exporter with batch writes, pagination, and quota-safe retries."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from src.config.settings import Settings
from src.exporters.sheet_formatting import EXPORT_SPECS, DatasetExportSpec, prepare_table_rows
from src.storage.repository import AtlasRepository
from src.utils.logging_config import get_logger

logger = get_logger("exporters.google_sheets")

GOOGLE_SHEETS_SCOPES = (
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.file",
)


@dataclass
class GoogleSheetsExportSummary:
    """Outcome of a Google Sheets export run (never claims success unless API calls succeeded)."""

    success: bool
    spreadsheet_id: Optional[str] = None
    spreadsheet_url: Optional[str] = None
    tab_row_counts: dict[str, int] = field(default_factory=dict)
    error: Optional[str] = None


class GoogleSheetsExporter:
    """Exports the six FrontierAtlas datasets to Google Sheets using a Service Account."""

    def __init__(
        self,
        *,
        credentials_path: Optional[str] = None,
        spreadsheet_id: Optional[str] = None,
        spreadsheet_name: str = "FrontierAtlas Intelligence",
        batch_size: int = 500,
        client_factory: Optional[Any] = None,
    ) -> None:
        self.credentials_path = credentials_path
        self.spreadsheet_id = spreadsheet_id
        self.spreadsheet_name = spreadsheet_name
        self.batch_size = max(50, batch_size)
        self._client_factory = client_factory

    @classmethod
    def from_settings(cls, settings: Settings) -> "GoogleSheetsExporter":
        return cls(
            credentials_path=settings.google_sheets_credentials_path,
            spreadsheet_id=settings.google_sheets_spreadsheet_id,
            spreadsheet_name=settings.google_sheets_spreadsheet_name,
        )

    def is_configured(self) -> bool:
        if self._client_factory is not None:
            return True
        if not self.credentials_path:
            return False
        return Path(self.credentials_path).exists()

    def _build_client(self) -> Any:
        if self._client_factory is not None:
            return self._client_factory()
        if not self.credentials_path or not Path(self.credentials_path).exists():
            raise FileNotFoundError(
                "Google Sheets credentials file not found. Set GOOGLE_SHEETS_CREDENTIALS_PATH "
                "to a valid Service Account JSON key file."
            )
        import gspread
        from google.oauth2.service_account import Credentials

        creds = Credentials.from_service_account_file(
            self.credentials_path, scopes=list(GOOGLE_SHEETS_SCOPES)
        )
        return gspread.authorize(creds)

    @staticmethod
    def _is_quota_error(exc: Exception) -> bool:
        resp = getattr(exc, "response", None)
        status = getattr(resp, "status_code", None)
        msg = str(exc).lower()
        return status in {429, 500, 502, 503} or "quota" in msg or "rate limit" in msg or "429" in msg

    def _call_with_quota_retry(self, fn: Any, *args: Any, max_attempts: int = 4, **kwargs: Any) -> Any:
        for attempt in range(1, max_attempts + 1):
            try:
                return fn(*args, **kwargs)
            except Exception as exc:
                if not self._is_quota_error(exc) or attempt == max_attempts:
                    raise
                delay = min(32.0, 2.0 ** attempt)
                logger.warning(
                    "Google Sheets API quota/transient error; retrying",
                    extra={"ctx": {"attempt": attempt, "delay": delay, "error": str(exc)}},
                )
                time.sleep(delay)

    def _get_or_create_worksheet(self, spreadsheet: Any, spec: DatasetExportSpec, rows_needed: int) -> Any:
        worksheets = {ws.title: ws for ws in self._call_with_quota_retry(spreadsheet.worksheets)}
        cols_needed = len(spec.columns)
        if spec.tab_name in worksheets:
            ws = worksheets[spec.tab_name]
            self._call_with_quota_retry(ws.clear)
            self._call_with_quota_retry(ws.resize, rows=max(2, rows_needed), cols=cols_needed)
            return ws
        return self._call_with_quota_retry(
            spreadsheet.add_worksheet,
            title=spec.tab_name,
            rows=max(2, rows_needed),
            cols=cols_needed,
        )

    def export_all(self, repo: AtlasRepository) -> GoogleSheetsExportSummary:
        """Export all six datasets into exact Google Sheet tabs using paginated batch writes."""
        if not self.is_configured():
            return GoogleSheetsExportSummary(
                success=False,
                error=(
                    "Google Sheets export skipped: GOOGLE_SHEETS_CREDENTIALS_PATH is not configured "
                    "or file does not exist."
                ),
            )

        try:
            client = self._build_client()
            if self.spreadsheet_id:
                spreadsheet = self._call_with_quota_retry(client.open_by_key, self.spreadsheet_id)
            else:
                spreadsheet = self._call_with_quota_retry(client.create, self.spreadsheet_name)

            tab_counts: dict[str, int] = {}
            for spec in EXPORT_SPECS:
                rows = prepare_table_rows(repo, spec, for_sheets=True)
                ws = self._get_or_create_worksheet(spreadsheet, spec, len(rows))

                # Batch write in paginated chunks to stay within API payload & quota limits
                for start_idx in range(0, len(rows), self.batch_size):
                    chunk = rows[start_idx : start_idx + self.batch_size]
                    start_row_num = start_idx + 1
                    cell_range = f"A{start_row_num}"
                    self._call_with_quota_retry(
                        ws.update,
                        range_name=cell_range,
                        values=chunk,
                        value_input_option="RAW",
                    )

                tab_counts[spec.tab_name] = max(0, len(rows) - 1)

            # Remove default 'Sheet1' if we created a brand-new workbook and Sheet1 is unused
            if not self.spreadsheet_id:
                try:
                    existing_titles = {ws.title: ws for ws in spreadsheet.worksheets()}
                    if "Sheet1" in existing_titles and len(existing_titles) > 1:
                        spreadsheet.del_worksheet(existing_titles["Sheet1"])
                except Exception:
                    pass

            return GoogleSheetsExportSummary(
                success=True,
                spreadsheet_id=getattr(spreadsheet, "id", self.spreadsheet_id),
                spreadsheet_url=getattr(spreadsheet, "url", None),
                tab_row_counts=tab_counts,
            )
        except Exception as exc:
            logger.error("Google Sheets export failed", extra={"ctx": {"error": str(exc)}})
            return GoogleSheetsExportSummary(success=False, error=str(exc))
