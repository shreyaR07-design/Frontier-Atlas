"""Configuration management for FrontierAtlas."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - fallback when python-dotenv is absent
    def load_dotenv(dotenv_path: Optional[Path] = None, override: bool = False) -> bool:
        if dotenv_path is None or not Path(dotenv_path).exists():
            return False
        for raw_line in Path(dotenv_path).read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if override or key not in os.environ:
                os.environ[key] = val
        return True


def _parse_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _parse_int(value: str | None, default: int) -> int:
    if value is None or not value.strip():
        return default
    return int(value.strip())


def _parse_float(value: str | None, default: float) -> float:
    if value is None or not value.strip():
        return default
    return float(value.strip())


@dataclass(frozen=True)
class Settings:
    """Immutable application settings loaded from environment variables."""

    # Paths
    base_dir: Path = field(default_factory=lambda: Path(__file__).resolve().parents[2])
    data_dir: Path = field(init=False)
    docs_dir: Path = field(init=False)
    logs_dir: Path = field(init=False)

    # LLM settings
    gemini_api_key: Optional[str] = None
    gemini_model: str = "gemini-4-hydrogen"
    groq_api_key: Optional[str] = None
    groq_model: str = "llama-3.3-70b-versatile"
    deepseek_api_key: Optional[str] = None
    deepseek_model: str = "deepseek-chat"
    llm_max_input_tokens: int = 12000
    llm_chunk_overlap_tokens: int = 300

    # Storage
    database_url: str = "sqlite:///data/frontier_atlas.db"

    # External APIs
    github_token: Optional[str] = None

    # Google Sheets
    google_sheets_credentials_path: Optional[str] = None
    google_sheets_spreadsheet_id: Optional[str] = None
    google_sheets_spreadsheet_name: str = "FrontierAtlas Intelligence"

    # Crawler & Rate Limiting
    user_agent: str = "FrontierAtlasBot/1.0 (+https://github.com/frontier-atlas)"
    max_concurrency: int = 8
    request_timeout_seconds: int = 20
    rate_limit_per_second: float = 2.0
    respect_robots_txt: bool = True
    playwright_enabled: bool = False

    # Quality, Freshness & Targets
    freshness_window_hours: int = 24
    target_startups: int = 1000
    target_products: int = 1000
    target_research_papers: int = 1000

    # Entity Resolution Thresholds (conservative)
    exact_match_threshold: float = 1.0
    fuzzy_auto_merge_threshold: float = 0.92
    fuzzy_review_threshold: float = 0.80

    # Logging & Testing
    log_level: str = "INFO"
    enable_live_tests: bool = False

    def __post_init__(self) -> None:
        object.__setattr__(self, "data_dir", self.base_dir / "data")
        object.__setattr__(self, "docs_dir", self.base_dir / "docs")
        object.__setattr__(self, "logs_dir", self.base_dir / "logs")

    @property
    def sqlite_path(self) -> Path:
        """Resolve local SQLite file path when using a sqlite:/// URL."""
        if not self.database_url.startswith("sqlite:///"):
            raise ValueError(f"Not a SQLite URL: {self.database_url}")
        raw_path = self.database_url.removeprefix("sqlite:///")
        if raw_path == ":memory:":
            return Path(":memory:")
        candidate = Path(raw_path)
        return candidate if candidate.is_absolute() else (self.base_dir / candidate)

    @property
    def database_backend(self) -> str:
        """Return 'sqlite' or 'postgresql' based on database_url."""
        if self.database_url.startswith("postgresql://") or self.database_url.startswith("postgres://"):
            return "postgresql"
        return "sqlite"

    def ensure_directories(self) -> None:
        """Ensure runtime directories exist."""
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.docs_dir.mkdir(parents=True, exist_ok=True)
        self.logs_dir.mkdir(parents=True, exist_ok=True)

    @classmethod
    def from_env(cls, env_file: Optional[Path] = None) -> "Settings":
        """Load settings from environment variables and optional .env file."""
        base_dir = Path(__file__).resolve().parents[2]
        target_env = env_file or (base_dir / ".env")
        load_dotenv(target_env, override=False)

        return cls(
            base_dir=base_dir,
            gemini_api_key=os.getenv("GEMINI_API_KEY") or None,
            gemini_model=os.getenv("GEMINI_MODEL", "gemini-4-hydrogen"),
            groq_api_key=os.getenv("GROQ_API_KEY") or None,
            groq_model=os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile"),
            deepseek_api_key=os.getenv("DEEPSEEK_API_KEY") or None,
            deepseek_model=os.getenv("DEEPSEEK_MODEL", "deepseek-chat"),
            llm_max_input_tokens=_parse_int(os.getenv("LLM_MAX_INPUT_TOKENS"), 12000),
            llm_chunk_overlap_tokens=_parse_int(os.getenv("LLM_CHUNK_OVERLAP_TOKENS"), 300),
            database_url=os.getenv("DATABASE_URL", "sqlite:///data/frontier_atlas.db"),
            github_token=os.getenv("GITHUB_TOKEN") or None,
            google_sheets_credentials_path=os.getenv("GOOGLE_SHEETS_CREDENTIALS_PATH") or None,
            google_sheets_spreadsheet_id=os.getenv("GOOGLE_SHEETS_SPREADSHEET_ID") or None,
            google_sheets_spreadsheet_name=os.getenv(
                "GOOGLE_SHEETS_SPREADSHEET_NAME", "FrontierAtlas Intelligence"
            ),
            user_agent=os.getenv(
                "USER_AGENT", "FrontierAtlasBot/1.0 (+https://github.com/frontier-atlas)"
            ),
            max_concurrency=_parse_int(os.getenv("MAX_CONCURRENCY"), 8),
            request_timeout_seconds=_parse_int(os.getenv("REQUEST_TIMEOUT_SECONDS"), 20),
            rate_limit_per_second=_parse_float(os.getenv("RATE_LIMIT_PER_SECOND"), 2.0),
            respect_robots_txt=_parse_bool(os.getenv("RESPECT_ROBOTS_TXT"), True),
            playwright_enabled=_parse_bool(os.getenv("PLAYWRIGHT_ENABLED"), False),
            freshness_window_hours=_parse_int(os.getenv("FRESHNESS_WINDOW_HOURS"), 24),
            log_level=os.getenv("LOG_LEVEL", "INFO").upper(),
            enable_live_tests=_parse_bool(os.getenv("ENABLE_LIVE_TESTS"), False),
        )


def get_settings() -> Settings:
    """Return a freshly loaded Settings instance."""
    return Settings.from_env()
