"""Database initialization, schema migrations, connection management, and DDL for SQLite and PostgreSQL."""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Sequence

from src.config.settings import Settings
from src.utils.logging_config import get_logger

logger = get_logger("storage.database")

SCHEMA_DDL_STATEMENTS: tuple[str, ...] = (
    """
    CREATE TABLE IF NOT EXISTS canonical_entities (
        canonical_id TEXT PRIMARY KEY,
        canonical_name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        primary_domain TEXT,
        aliases_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        UNIQUE(entity_type, normalized_name)
    );
    """,
    """
    CREATE TABLE IF NOT EXISTS startups (
        startup_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        website TEXT,
        official_website TEXT,
        industry TEXT NOT NULL DEFAULT 'Unknown',
        location TEXT NOT NULL DEFAULT 'Unknown',
        founding_date TEXT,
        source_name TEXT NOT NULL,
        source_url TEXT NOT NULL,
        source_title TEXT,
        collected_at TEXT NOT NULL,
        last_checked_at TEXT,
        supported_fields_json TEXT NOT NULL DEFAULT '[]',
        verification_status TEXT NOT NULL DEFAULT 'Unverified',
        rejection_reason TEXT,
        canonical_entity_id TEXT,
        source_metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(name, source_url)
    );
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_startups_website ON startups(website);
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_startups_collected ON startups(collected_at);
    """,
    """
    CREATE TABLE IF NOT EXISTS products (
        product_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        website TEXT,
        official_website TEXT,
        category TEXT NOT NULL DEFAULT 'Unknown',
        company_name TEXT NOT NULL DEFAULT 'Unknown',
        source_name TEXT NOT NULL,
        source_url TEXT NOT NULL,
        source_title TEXT,
        collected_at TEXT NOT NULL,
        last_checked_at TEXT,
        supported_fields_json TEXT NOT NULL DEFAULT '[]',
        verification_status TEXT NOT NULL DEFAULT 'Unverified',
        rejection_reason TEXT,
        canonical_entity_id TEXT,
        source_metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(name, source_url)
    );
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_products_website ON products(website);
    """,
    """
    CREATE TABLE IF NOT EXISTS research_papers (
        paper_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        abstract TEXT,
        authors_json TEXT NOT NULL DEFAULT '[]',
        publication_date TEXT,
        doi TEXT,
        arxiv_id TEXT,
        github_repository TEXT,
        github_stars INTEGER,
        official_website TEXT,
        source_name TEXT NOT NULL DEFAULT 'unknown',
        source_url TEXT NOT NULL UNIQUE,
        source_title TEXT,
        collected_at TEXT NOT NULL,
        last_checked_at TEXT,
        supported_fields_json TEXT NOT NULL DEFAULT '[]',
        verification_status TEXT NOT NULL DEFAULT 'Unverified',
        rejection_reason TEXT,
        source_metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_papers_doi ON research_papers(doi);
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_papers_arxiv ON research_papers(arxiv_id);
    """,
    """
    CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        company TEXT NOT NULL DEFAULT 'Unknown',
        location TEXT NOT NULL DEFAULT 'Unknown',
        employment_type TEXT NOT NULL DEFAULT 'Unknown',
        description TEXT,
        posted_at TEXT NOT NULL,
        application_url TEXT NOT NULL UNIQUE,
        official_website TEXT,
        source_name TEXT NOT NULL,
        source_url TEXT NOT NULL,
        source_title TEXT,
        collected_at TEXT NOT NULL,
        last_checked_at TEXT,
        supported_fields_json TEXT NOT NULL DEFAULT '[]',
        verification_status TEXT NOT NULL DEFAULT 'Unverified',
        rejection_reason TEXT,
        canonical_company_id TEXT,
        source_metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_jobs_posted_at ON jobs(posted_at);
    """,
    """
    CREATE TABLE IF NOT EXISTS news (
        news_id TEXT PRIMARY KEY,
        headline TEXT NOT NULL,
        summary TEXT,
        publisher TEXT NOT NULL DEFAULT 'Unknown',
        published_at TEXT NOT NULL,
        article_url TEXT NOT NULL UNIQUE,
        official_website TEXT,
        category TEXT NOT NULL DEFAULT 'Unknown',
        source_name TEXT,
        source_url TEXT NOT NULL,
        source_title TEXT,
        collected_at TEXT NOT NULL,
        last_checked_at TEXT,
        supported_fields_json TEXT NOT NULL DEFAULT '[]',
        verification_status TEXT NOT NULL DEFAULT 'Unverified',
        rejection_reason TEXT,
        source_metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_news_published_at ON news(published_at);
    """,
    """
    CREATE TABLE IF NOT EXISTS entity_mapping_log (
        mapping_id TEXT PRIMARY KEY,
        raw_name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        canonical_name TEXT NOT NULL,
        canonical_id TEXT NOT NULL,
        source_url TEXT NOT NULL,
        match_method TEXT NOT NULL,
        confidence REAL NOT NULL,
        decision TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        entity_type TEXT NOT NULL DEFAULT 'company',
        match_reason TEXT,
        UNIQUE(raw_name, canonical_id, source_url, match_method)
    );
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_entity_mapping_canonical ON entity_mapping_log(canonical_id);
    """,
    """
    CREATE TABLE IF NOT EXISTS failure_logs (
        failure_id TEXT PRIMARY KEY,
        stage TEXT NOT NULL,
        category TEXT NOT NULL,
        source_url TEXT,
        reason TEXT NOT NULL,
        payload_json TEXT,
        created_at TEXT NOT NULL
    );
    """,
    """
    CREATE TABLE IF NOT EXISTS collection_checkpoints (
        source_key TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        last_cursor TEXT,
        last_collected_at TEXT NOT NULL,
        records_count INTEGER NOT NULL DEFAULT 0
    );
    """,
    """
    CREATE TABLE IF NOT EXISTS verification_audit_log (
        audit_id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        record_id TEXT NOT NULL,
        record_name TEXT NOT NULL,
        previous_status TEXT,
        new_status TEXT NOT NULL,
        issues_json TEXT NOT NULL DEFAULT '[]',
        source_url TEXT,
        source_title TEXT,
        evidence_excerpt TEXT,
        reason TEXT NOT NULL,
        checked_at TEXT NOT NULL
    );
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_audit_category_record ON verification_audit_log(category, record_id);
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_audit_checked_at ON verification_audit_log(checked_at);
    """,
)

VERIFIED_DATASET_TABLES: tuple[str, ...] = (
    "startups",
    "products",
    "research_papers",
    "jobs",
    "news",
)

TRACEABILITY_COLUMNS: tuple[tuple[str, str], ...] = (
    ("official_website", "TEXT"),
    ("source_title", "TEXT"),
    ("last_checked_at", "TEXT"),
    ("supported_fields_json", "TEXT NOT NULL DEFAULT '[]'"),
    ("verification_status", "TEXT NOT NULL DEFAULT 'Unverified'"),
    ("rejection_reason", "TEXT"),
)


class DatabaseManager:
    """Manages connections, transactions, and schema lifecycle.

    Uses SQLite natively for local development and shares standard SQL DDL
    compatible with PostgreSQL via psycopg when scaling.
    """

    def __init__(self, database_url: str = "sqlite:///data/frontier_atlas.db", base_dir: Path | None = None) -> None:
        self.database_url = database_url
        self.base_dir = base_dir or Path(__file__).resolve().parents[2]
        self.backend = (
            "postgresql"
            if database_url.startswith(("postgresql://", "postgres://"))
            else "sqlite"
        )

    @classmethod
    def from_settings(cls, settings: Settings) -> "DatabaseManager":
        return cls(database_url=settings.database_url, base_dir=settings.base_dir)

    def _resolve_sqlite_target(self) -> str:
        raw = self.database_url.removeprefix("sqlite:///")
        if raw == ":memory:":
            return ":memory:"
        candidate = Path(raw)
        resolved = candidate if candidate.is_absolute() else (self.base_dir / candidate)
        resolved.parent.mkdir(parents=True, exist_ok=True)
        return str(resolved)

    def connect(self) -> Any:
        """Open a configured database connection."""
        if self.backend == "sqlite":
            target = self._resolve_sqlite_target()
            conn = sqlite3.connect(target, timeout=30.0)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys = ON;")
            if target != ":memory:":
                conn.execute("PRAGMA journal_mode = WAL;")
            conn.execute("PRAGMA busy_timeout = 5000;")
            return conn

        # PostgreSQL scaling path
        try:
            import psycopg
            from psycopg.rows import dict_row
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError(
                "PostgreSQL backend requested but 'psycopg' is not installed. "
                "Install psycopg[binary] from requirements.txt."
            ) from exc
        return psycopg.connect(self.database_url, row_factory=dict_row)

    @contextmanager
    def transaction(self) -> Iterator[Any]:
        """Yield a connection wrapped in an atomic commit/rollback transaction."""
        conn = self.connect()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _migrate_schema(self, cursor: Any) -> None:
        """Additively migrate existing tables to include traceability and verification columns without deleting rows."""
        for table in VERIFIED_DATASET_TABLES:
            if self.backend == "sqlite":
                cursor.execute(f"PRAGMA table_info({table});")
                existing_cols = {row["name"] if isinstance(row, sqlite3.Row) else row[1] for row in cursor.fetchall()}
                for col_name, col_def in TRACEABILITY_COLUMNS:
                    if col_name not in existing_cols:
                        cursor.execute(f"ALTER TABLE {table} ADD COLUMN {col_name} {col_def};")
            else:
                for col_name, col_def in TRACEABILITY_COLUMNS:
                    cursor.execute(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {col_name} {col_def};")

            cursor.execute(
                f"CREATE INDEX IF NOT EXISTS idx_{table}_verification ON {table}(verification_status);"
            )

    def initialize_schema(self) -> None:
        """Create all required tables, run non-destructive additive migrations, and create indexes."""
        with self.transaction() as conn:
            cursor = conn.cursor()
            for statement in SCHEMA_DDL_STATEMENTS:
                cursor.execute(statement)
            self._migrate_schema(cursor)
        logger.info("Initialized database schema", extra={"ctx": {"backend": self.backend}})

    def execute_many(self, sql: str, params_seq: Sequence[tuple[Any, ...]]) -> int:
        """Execute a parameterized batch statement inside a transaction."""
        if not params_seq:
            return 0
        adapted_sql = sql.replace("?", "%s") if self.backend == "postgresql" else sql
        with self.transaction() as conn:
            cursor = conn.cursor()
            cursor.executemany(adapted_sql, params_seq)
            return len(params_seq)

    def fetch_all(self, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        """Execute a read query and return rows as dictionaries."""
        adapted_sql = sql.replace("?", "%s") if self.backend == "postgresql" else sql
        conn = self.connect()
        try:
            cursor = conn.cursor()
            cursor.execute(adapted_sql, params)
            rows = cursor.fetchall()
            return [dict(row) for row in rows]
        finally:
            conn.close()
