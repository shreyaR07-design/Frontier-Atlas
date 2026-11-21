"""Repository layer providing idempotent upserts, verification queries, and checkpoints."""

from __future__ import annotations

import hashlib
import json
from typing import Any, Iterable, Optional

from src.schemas.base import VerificationStatus
from src.schemas.entity import CanonicalEntity, EntityMappingLog
from src.schemas.job import JobRecord
from src.schemas.news import NewsRecord
from src.schemas.product import ProductRecord
from src.schemas.research_paper import ResearchPaperRecord
from src.schemas.startup import StartupRecord
from src.storage.database import DatabaseManager, VERIFIED_DATASET_TABLES
from src.utils.date_utils import to_utc_iso, utc_now


class AtlasRepository:
    """Data access layer for FrontierAtlas datasets."""

    def __init__(self, db: DatabaseManager) -> None:
        self.db = db

    def upsert_startups(self, records: Iterable[StartupRecord]) -> int:
        rows = [
            (
                r.startup_id,
                r.name,
                r.description,
                r.website,
                r.official_website,
                r.industry,
                r.location,
                r.founding_date,
                r.source_name,
                r.source_url,
                r.source_title,
                to_utc_iso(r.collected_at),
                to_utc_iso(r.last_checked_at),
                json.dumps(r.supported_fields),
                r.verification_status.value,
                r.rejection_reason,
                r.canonical_entity_id,
                json.dumps(r.source_metadata),
            )
            for r in records
        ]
        sql = """
        INSERT INTO startups (
            startup_id, name, description, website, official_website, industry, location,
            founding_date, source_name, source_url, source_title, collected_at,
            last_checked_at, supported_fields_json, verification_status, rejection_reason,
            canonical_entity_id, source_metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(startup_id) DO UPDATE SET
            description = COALESCE(excluded.description, startups.description),
            website = COALESCE(excluded.website, startups.website),
            official_website = COALESCE(excluded.official_website, startups.official_website),
            industry = CASE
                WHEN excluded.industry != 'Unknown' THEN excluded.industry
                ELSE startups.industry
            END,
            location = CASE
                WHEN excluded.last_checked_at IS NOT NULL THEN excluded.location
                WHEN excluded.location != 'Unknown' THEN excluded.location
                ELSE startups.location
            END,
            founding_date = COALESCE(excluded.founding_date, startups.founding_date),
            source_title = COALESCE(excluded.source_title, startups.source_title),
            collected_at = excluded.collected_at,
            last_checked_at = COALESCE(excluded.last_checked_at, startups.last_checked_at),
            supported_fields_json = excluded.supported_fields_json,
            verification_status = excluded.verification_status,
            rejection_reason = excluded.rejection_reason,
            canonical_entity_id = COALESCE(excluded.canonical_entity_id, startups.canonical_entity_id),
            source_metadata_json = excluded.source_metadata_json;
        """
        return self.db.execute_many(sql, rows)

    def upsert_products(self, records: Iterable[ProductRecord]) -> int:
        rows = [
            (
                r.product_id,
                r.name,
                r.description,
                r.website,
                r.official_website,
                r.category,
                r.company_name,
                r.source_name,
                r.source_url,
                r.source_title,
                to_utc_iso(r.collected_at),
                to_utc_iso(r.last_checked_at),
                json.dumps(r.supported_fields),
                r.verification_status.value,
                r.rejection_reason,
                r.canonical_entity_id,
                json.dumps(r.source_metadata),
            )
            for r in records
        ]
        sql = """
        INSERT INTO products (
            product_id, name, description, website, official_website, category, company_name,
            source_name, source_url, source_title, collected_at, last_checked_at,
            supported_fields_json, verification_status, rejection_reason,
            canonical_entity_id, source_metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(product_id) DO UPDATE SET
            description = COALESCE(excluded.description, products.description),
            website = COALESCE(excluded.website, products.website),
            official_website = COALESCE(excluded.official_website, products.official_website),
            category = CASE
                WHEN excluded.category != 'Unknown' THEN excluded.category
                ELSE products.category
            END,
            company_name = CASE
                WHEN excluded.company_name != 'Unknown' THEN excluded.company_name
                ELSE products.company_name
            END,
            source_title = COALESCE(excluded.source_title, products.source_title),
            collected_at = excluded.collected_at,
            last_checked_at = COALESCE(excluded.last_checked_at, products.last_checked_at),
            supported_fields_json = excluded.supported_fields_json,
            verification_status = excluded.verification_status,
            rejection_reason = excluded.rejection_reason,
            canonical_entity_id = COALESCE(excluded.canonical_entity_id, products.canonical_entity_id),
            source_metadata_json = excluded.source_metadata_json;
        """
        return self.db.execute_many(sql, rows)

    def upsert_research_papers(self, records: Iterable[ResearchPaperRecord]) -> int:
        rec_list = list(records)
        if not rec_list:
            return 0
        existing_by_url: dict[str, str] = {}
        with self.db.connect() as conn:
            for row in conn.execute("SELECT paper_id, source_url FROM research_papers").fetchall():
                existing_by_url[str(row["source_url"])] = str(row["paper_id"])

        rows = []
        for r in rec_list:
            pid = r.paper_id
            if r.source_url in existing_by_url and existing_by_url[r.source_url] != pid:
                pid = existing_by_url[r.source_url]
            rows.append(
                (
                    pid,
                    r.title,
                    r.abstract,
                    json.dumps(r.authors),
                    r.publication_date,
                    r.doi,
                    r.arxiv_id,
                    r.github_repository,
                    r.github_stars,
                    r.official_website,
                    r.source_name,
                    r.source_url,
                    r.source_title,
                    to_utc_iso(r.collected_at),
                    to_utc_iso(r.last_checked_at),
                    json.dumps(r.supported_fields),
                    r.verification_status.value,
                    r.rejection_reason,
                    json.dumps(r.source_metadata),
                )
            )
        sql = """
        INSERT INTO research_papers (
            paper_id, title, abstract, authors_json, publication_date,
            doi, arxiv_id, github_repository, github_stars, official_website,
            source_name, source_url, source_title, collected_at, last_checked_at,
            supported_fields_json, verification_status, rejection_reason, source_metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(paper_id) DO UPDATE SET
            title = excluded.title,
            abstract = COALESCE(excluded.abstract, research_papers.abstract),
            authors_json = excluded.authors_json,
            publication_date = COALESCE(excluded.publication_date, research_papers.publication_date),
            doi = COALESCE(excluded.doi, research_papers.doi),
            arxiv_id = COALESCE(excluded.arxiv_id, research_papers.arxiv_id),
            github_repository = COALESCE(excluded.github_repository, research_papers.github_repository),
            github_stars = COALESCE(excluded.github_stars, research_papers.github_stars),
            official_website = COALESCE(excluded.official_website, research_papers.official_website),
            source_name = excluded.source_name,
            source_url = excluded.source_url,
            source_title = COALESCE(excluded.source_title, research_papers.source_title),
            collected_at = excluded.collected_at,
            last_checked_at = COALESCE(excluded.last_checked_at, research_papers.last_checked_at),
            supported_fields_json = excluded.supported_fields_json,
            verification_status = excluded.verification_status,
            rejection_reason = excluded.rejection_reason,
            source_metadata_json = excluded.source_metadata_json;
        """
        return self.db.execute_many(sql, rows)

    def upsert_jobs(self, records: Iterable[JobRecord]) -> int:
        rows = [
            (
                r.job_id,
                r.title,
                r.company,
                r.location,
                r.employment_type,
                r.description,
                to_utc_iso(r.posted_at),
                r.application_url,
                r.official_website,
                r.source_name,
                r.source_url,
                r.source_title,
                to_utc_iso(r.collected_at),
                to_utc_iso(r.last_checked_at),
                json.dumps(r.supported_fields),
                r.verification_status.value,
                r.rejection_reason,
                r.canonical_company_id,
                json.dumps(r.source_metadata),
            )
            for r in records
        ]
        sql = """
        INSERT INTO jobs (
            job_id, title, company, location, employment_type, description,
            posted_at, application_url, official_website, source_name, source_url,
            source_title, collected_at, last_checked_at, supported_fields_json,
            verification_status, rejection_reason, canonical_company_id, source_metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(application_url) DO UPDATE SET
            title = excluded.title,
            location = CASE
                WHEN excluded.last_checked_at IS NOT NULL THEN excluded.location
                WHEN excluded.location != 'Unknown' THEN excluded.location
                ELSE jobs.location
            END,
            employment_type = CASE
                WHEN excluded.employment_type != 'Unknown' THEN excluded.employment_type
                ELSE jobs.employment_type
            END,
            description = COALESCE(excluded.description, jobs.description),
            posted_at = excluded.posted_at,
            official_website = COALESCE(excluded.official_website, jobs.official_website),
            source_url = excluded.source_url,
            source_title = COALESCE(excluded.source_title, jobs.source_title),
            collected_at = excluded.collected_at,
            last_checked_at = COALESCE(excluded.last_checked_at, jobs.last_checked_at),
            supported_fields_json = excluded.supported_fields_json,
            verification_status = excluded.verification_status,
            rejection_reason = excluded.rejection_reason,
            canonical_company_id = COALESCE(excluded.canonical_company_id, jobs.canonical_company_id),
            source_metadata_json = excluded.source_metadata_json;
        """
        return self.db.execute_many(sql, rows)

    def upsert_news(self, records: Iterable[NewsRecord]) -> int:
        rows = [
            (
                r.news_id,
                r.headline,
                r.summary,
                r.publisher,
                to_utc_iso(r.published_at),
                r.article_url,
                r.official_website,
                r.category,
                r.source_name,
                r.source_url,
                r.source_title,
                to_utc_iso(r.collected_at),
                to_utc_iso(r.last_checked_at),
                json.dumps(r.supported_fields),
                r.verification_status.value,
                r.rejection_reason,
                json.dumps(r.source_metadata),
            )
            for r in records
        ]
        sql = """
        INSERT INTO news (
            news_id, headline, summary, publisher, published_at, article_url,
            official_website, category, source_name, source_url, source_title,
            collected_at, last_checked_at, supported_fields_json, verification_status,
            rejection_reason, source_metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(article_url) DO UPDATE SET
            headline = excluded.headline,
            summary = COALESCE(excluded.summary, news.summary),
            category = CASE
                WHEN excluded.category != 'Unknown' THEN excluded.category
                ELSE news.category
            END,
            published_at = excluded.published_at,
            official_website = COALESCE(excluded.official_website, news.official_website),
            source_url = excluded.source_url,
            source_title = COALESCE(excluded.source_title, news.source_title),
            collected_at = excluded.collected_at,
            last_checked_at = COALESCE(excluded.last_checked_at, news.last_checked_at),
            supported_fields_json = excluded.supported_fields_json,
            verification_status = excluded.verification_status,
            rejection_reason = excluded.rejection_reason,
            source_metadata_json = excluded.source_metadata_json;
        """
        return self.db.execute_many(sql, rows)

    def upsert_canonical_entities(self, entities: Iterable[CanonicalEntity]) -> int:
        rows = [
            (
                e.canonical_id,
                e.canonical_name,
                e.normalized_name,
                e.entity_type.value,
                e.primary_domain,
                json.dumps(e.aliases),
                to_utc_iso(e.created_at),
            )
            for e in entities
        ]
        sql = """
        INSERT INTO canonical_entities (
            canonical_id, canonical_name, normalized_name, entity_type,
            primary_domain, aliases_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(canonical_id) DO UPDATE SET
            primary_domain = COALESCE(excluded.primary_domain, canonical_entities.primary_domain),
            aliases_json = excluded.aliases_json;
        """
        return self.db.execute_many(sql, rows)

    def upsert_entity_mapping_logs(self, logs: Iterable[EntityMappingLog]) -> int:
        rows = [
            (
                entry.mapping_id,
                entry.raw_name,
                entry.normalized_name,
                entry.canonical_name,
                entry.canonical_id,
                entry.source_url,
                entry.match_method,
                entry.confidence,
                entry.decision.value,
                to_utc_iso(entry.timestamp),
                entry.entity_type.value,
                entry.match_reason,
            )
            for entry in logs
        ]
        sql = """
        INSERT INTO entity_mapping_log (
            mapping_id, raw_name, normalized_name, canonical_name, canonical_id,
            source_url, match_method, confidence, decision, timestamp,
            entity_type, match_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(mapping_id) DO UPDATE SET
            confidence = excluded.confidence,
            decision = excluded.decision,
            timestamp = excluded.timestamp,
            match_reason = excluded.match_reason;
        """
        return self.db.execute_many(sql, rows)

    def record_failure(
        self,
        *,
        stage: str,
        category: str,
        reason: str,
        source_url: Optional[str] = None,
        payload: Optional[dict[str, Any]] = None,
    ) -> None:
        """Persist failed record/collection diagnostics instead of silently discarding."""
        now_iso = to_utc_iso(utc_now()) or ""
        digest = hashlib.sha256(
            f"{stage}|{category}|{source_url or ''}|{reason}|{now_iso}".encode("utf-8")
        ).hexdigest()[:16]
        sql = """
        INSERT INTO failure_logs (
            failure_id, stage, category, source_url, reason, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(failure_id) DO NOTHING;
        """
        self.db.execute_many(
            sql,
            [
                (
                    f"fail_{digest}",
                    stage,
                    category,
                    source_url,
                    reason[:1000],
                    json.dumps(payload or {}, default=str),
                    now_iso,
                )
            ],
        )

    def record_audit_entries(self, entries: Iterable[dict[str, Any]]) -> int:
        """Persist verification audit trail entries documenting status changes and detected issues."""
        rows = []
        for item in entries:
            checked_at = item.get("checked_at") or to_utc_iso(utc_now()) or ""
            cat = str(item.get("category") or "")
            rec_id = str(item.get("record_id") or "")
            prev_st = item.get("previous_status")
            new_st = str(item.get("new_status") or VerificationStatus.UNVERIFIED.value)
            reason = str(item.get("reason") or "")[:1000]
            digest = hashlib.sha256(
                f"{cat}|{rec_id}|{prev_st}|{new_st}|{reason}|{checked_at}".encode("utf-8")
            ).hexdigest()[:16]
            rows.append(
                (
                    item.get("audit_id") or f"aud_{digest}",
                    cat,
                    rec_id,
                    str(item.get("record_name") or "")[:256],
                    prev_st,
                    new_st,
                    json.dumps(item.get("issues") or []),
                    item.get("source_url"),
                    item.get("source_title"),
                    (item.get("evidence_excerpt") or "")[:1000] or None,
                    reason,
                    checked_at,
                )
            )
        sql = """
        INSERT INTO verification_audit_log (
            audit_id, category, record_id, record_name, previous_status,
            new_status, issues_json, source_url, source_title,
            evidence_excerpt, reason, checked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(audit_id) DO NOTHING;
        """
        return self.db.execute_many(sql, rows)

    def fetch_audit_trail(
        self,
        *,
        category: Optional[str] = None,
        record_id: Optional[str] = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        """Query verification audit trail entries ordered newest first."""
        clauses: list[str] = []
        params: list[Any] = []
        if category:
            clauses.append("category = ?")
            params.append(category)
        if record_id:
            clauses.append("record_id = ?")
            params.append(record_id)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        params.append(limit)
        return self.db.fetch_all(
            f"SELECT * FROM verification_audit_log {where} ORDER BY checked_at DESC LIMIT ?;",
            tuple(params),
        )

    def save_checkpoint(self, source_key: str, category: str, cursor: Optional[str], count: int) -> None:
        """Record incremental collection checkpoint for a source."""
        sql = """
        INSERT INTO collection_checkpoints (
            source_key, category, last_cursor, last_collected_at, records_count
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(source_key) DO UPDATE SET
            last_cursor = excluded.last_cursor,
            last_collected_at = excluded.last_collected_at,
            records_count = excluded.records_count;
        """
        self.db.execute_many(
            sql,
            [(source_key, category, cursor, to_utc_iso(utc_now()), count)],
        )

    def get_checkpoint(self, source_key: str) -> Optional[dict[str, Any]]:
        rows = self.db.fetch_all(
            "SELECT * FROM collection_checkpoints WHERE source_key = ?;", (source_key,)
        )
        return rows[0] if rows else None

    def fetch_dataset(self, table_name: str, limit: Optional[int] = None) -> list[dict[str, Any]]:
        """Fetch rows from one of the allowed dataset tables."""
        allowed = {
            "startups",
            "products",
            "research_papers",
            "jobs",
            "news",
            "entity_mapping_log",
            "canonical_entities",
            "failure_logs",
            "verification_audit_log",
        }
        if table_name not in allowed:
            raise ValueError(f"Unsupported dataset table: {table_name!r}")
        if limit is not None:
            return self.db.fetch_all(f"SELECT * FROM {table_name} LIMIT ?;", (limit,))
        return self.db.fetch_all(f"SELECT * FROM {table_name};")

    def list_all(self, category: str) -> list[dict[str, Any]]:
        """Return all rows from a dataset table."""
        return self.fetch_dataset(category, limit=None)

    def delete_records(self, table_name: str, record_ids: Iterable[str]) -> int:
        """Delete specific duplicate or invalid rows by primary key after audit logging."""
        id_col_map = {
            "startups": "startup_id",
            "products": "product_id",
            "research_papers": "paper_id",
            "jobs": "job_id",
            "news": "news_id",
            "entity_mapping_log": "mapping_id",
        }
        if table_name not in id_col_map:
            raise ValueError(f"Unsupported delete table: {table_name!r}")
        ids = [str(rid) for rid in record_ids if rid]
        if not ids:
            return 0
        id_col = id_col_map[table_name]
        placeholders = ",".join("?" for _ in ids)
        with self.db.connect() as conn:
            cur = conn.execute(f"DELETE FROM {table_name} WHERE {id_col} IN ({placeholders});", tuple(ids))
            return int(cur.rowcount or 0)

    def count_records(self) -> dict[str, int]:
        """Return actual row counts stored in each dataset table."""
        counts: dict[str, int] = {}
        for table in (
            "startups",
            "products",
            "research_papers",
            "jobs",
            "news",
            "entity_mapping_log",
        ):
            rows = self.db.fetch_all(f"SELECT COUNT(*) AS cnt FROM {table};")
            counts[table] = int(rows[0]["cnt"]) if rows else 0
        return counts

    def get_verification_counts(self) -> dict[str, Any]:
        """Return verification status breakdown across persisted datasets plus rejected record counts."""
        statuses = [s.value for s in VerificationStatus]
        totals: dict[str, int] = {st: 0 for st in statuses}
        by_category: dict[str, dict[str, int]] = {}

        for table in VERIFIED_DATASET_TABLES:
            cat_counts: dict[str, int] = {st: 0 for st in statuses}
            rows = self.db.fetch_all(
                f"SELECT verification_status, COUNT(*) AS cnt FROM {table} GROUP BY verification_status;"
            )
            for row in rows:
                st_val = str(row.get("verification_status") or VerificationStatus.UNVERIFIED.value)
                cnt = int(row.get("cnt") or 0)
                if st_val not in cat_counts:
                    st_val = VerificationStatus.UNVERIFIED.value
                cat_counts[st_val] += cnt
                totals[st_val] += cnt

            rej_rows = self.db.fetch_all(
                "SELECT COUNT(*) AS cnt FROM failure_logs WHERE category = ?;",
                (table,),
            )
            rej_log_cnt = int(rej_rows[0]["cnt"]) if rej_rows else 0
            cat_counts[VerificationStatus.REJECTED.value] += rej_log_cnt
            totals[VerificationStatus.REJECTED.value] += rej_log_cnt
            by_category[table] = cat_counts

        return {
            "totals": totals,
            "byCategory": by_category,
        }
