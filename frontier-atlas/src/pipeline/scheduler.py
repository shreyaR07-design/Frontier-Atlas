"""Async interval scheduler for recurring FrontierAtlas pipeline sweeps."""

from __future__ import annotations

import asyncio
from typing import Optional

from src.config.settings import Settings, get_settings
from src.pipeline.orchestrator import ALL_CATEGORIES, PipelineOrchestrator
from src.utils.logging_config import get_logger

logger = get_logger("pipeline.scheduler")


class PipelineScheduler:
    """Runs periodic pipeline cycles with configurable intervals and max iterations."""

    def __init__(
        self,
        settings: Optional[Settings] = None,
        *,
        interval_seconds: int = 3600,
        categories: tuple[str, ...] = ALL_CATEGORIES,
        limit_per_category: int = 100,
    ) -> None:
        self.settings = settings or get_settings()
        self.interval_seconds = max(10, interval_seconds)
        self.categories = categories
        self.limit_per_category = limit_per_category
        self._stop_event = asyncio.Event()

    def stop(self) -> None:
        self._stop_event.set()

    async def run_loop(self, max_runs: Optional[int] = None) -> int:
        """Execute scheduled collection cycles until stopped or `max_runs` reached."""
        runs_completed = 0
        while not self._stop_event.is_set():
            if max_runs is not None and runs_completed >= max_runs:
                break
            orchestrator = PipelineOrchestrator(self.settings)
            try:
                await orchestrator.run(
                    categories=self.categories,
                    limit_per_category=self.limit_per_category,
                    export_csv=True,
                    export_sheets=bool(self.settings.google_sheets_credentials_path),
                )
            except Exception as exc:  # pragma: no cover
                logger.error("Scheduled pipeline run failed", extra={"ctx": {"error": str(exc)}})
            runs_completed += 1
            if max_runs is not None and runs_completed >= max_runs:
                break
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=self.interval_seconds)
            except asyncio.TimeoutError:
                continue
        return runs_completed
