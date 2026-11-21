"""Structured logging configuration for FrontierAtlas."""

from __future__ import annotations

import json
import logging
import sys
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Optional


class StructuredFormatter(logging.Formatter):
    """Formats log records as readable structured lines or JSON."""

    def __init__(self, json_output: bool = False) -> None:
        super().__init__()
        self.json_output = json_output

    def format(self, record: logging.LogRecord) -> str:
        timestamp = datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat()
        base: dict[str, Any] = {
            "ts": timestamp,
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        # Include custom structured context if passed via extra={"ctx": {...}}
        ctx = getattr(record, "ctx", None)
        if isinstance(ctx, dict):
            base["ctx"] = ctx
        if record.exc_info:
            base["exc"] = self.formatException(record.exc_info)

        if self.json_output:
            return json.dumps(base, default=str)

        ctx_str = f" | {json.dumps(ctx, default=str)}" if isinstance(ctx, dict) and ctx else ""
        exc_str = f"\n{base['exc']}" if "exc" in base else ""
        return f"{timestamp} [{record.levelname}] {record.name}: {record.getMessage()}{ctx_str}{exc_str}"


def configure_logging(
    level: str = "INFO",
    log_file: Optional[Path] = None,
    json_console: bool = False,
) -> logging.Logger:
    """Configure root logger for FrontierAtlas with console and optional file output."""
    numeric_level = getattr(logging, level.upper(), logging.INFO)
    root_logger = logging.getLogger("frontier_atlas")
    root_logger.setLevel(numeric_level)
    root_logger.propagate = False

    # Avoid duplicate handlers across repeated calls
    if root_logger.handlers:
        root_logger.handlers.clear()

    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(numeric_level)
    console_handler.setFormatter(StructuredFormatter(json_output=json_console))
    root_logger.addHandler(console_handler)

    if log_file is not None:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        file_handler = RotatingFileHandler(
            log_file, maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8"
        )
        file_handler.setLevel(numeric_level)
        file_handler.setFormatter(StructuredFormatter(json_output=True))
        root_logger.addHandler(file_handler)

    return root_logger


def get_logger(name: str) -> logging.Logger:
    """Return a namespaced logger under frontier_atlas."""
    if name.startswith("frontier_atlas"):
        return logging.getLogger(name)
    return logging.getLogger(f"frontier_atlas.{name}")
