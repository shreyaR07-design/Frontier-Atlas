"""Tests for source verification, HQ-vs-branch guard, additive DB migration, duplicate org detection, audit, and CSV traceability."""

from __future__ import annotations

import csv
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest

from src.config.settings import Settings
from src.crawler.async_crawler import FetchResult
from src.exporters import CSVExporter
from src.llm.llm_router import LLMProvider, LLMRouter
from src.pipeline.orchestrator import PipelineOrchestrator
from src.schemas import (
    ProductRecord,
    StartupRecord,
    VerificationStatus,
)
from src.storage import AtlasRepository, DatabaseManager
from src.validation import RecordDeduplicator, SourceVerifier


@dataclass
class StaticFakeCrawler:
    responses: dict[str, FetchResult]

    async def fetch(self, url: str, **kwargs: Any) -> FetchResult:
        for key, res in self.responses.items():
            if key in url:
                return res
        return FetchResult(url=url, status=404, ok=False, error="http_404")


class FakeLLMProvider(LLMProvider):
    provider_name = "fake_gemini"

    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def is_configured(self) -> bool:
        return True

    async def generate_json(self, prompt: str, *, system_instruction: str = "") -> dict[str, Any]:
        return self._payload


@pytest.mark.asyncio
async def test_source_verifier_classifies_verified_partial_unverified_and_unavailable() -> None:
    html_verified = (
        "<html><head><title>Orbital Foundry | Autonomous Spacecraft</title></head>"
        "<body><h1>Orbital Foundry</h1>"
        "<p>Orbital Foundry builds autonomous orbital robotics in Aerospace, headquartered in Pasadena, CA.</p>"
        "</body></html>"
    )
    html_partial = (
        "<html><head><title>Boreal Labs</title></head>"
        "<body><h1>Boreal Labs</h1><p>Early stealth research group.</p></body></html>"
    )
    html_unverified = (
        "<html><head><title>Alpine Botany Journal</title></head>"
        "<body><p>Field notes on mountain wildflowers and lens optics.</p></body></html>"
    )

    crawler = StaticFakeCrawler(
        responses={
            "https://yc.example/orbital": FetchResult(
                url="https://yc.example/orbital",
                status=200,
                content=html_verified,
                content_type="text/html",
                ok=True,
            ),
            "https://orbitalfoundry.example": FetchResult(
                url="https://orbitalfoundry.example",
                status=200,
                content=html_verified,
                content_type="text/html",
                ok=True,
            ),
            "https://yc.example/boreal": FetchResult(
                url="https://yc.example/boreal",
                status=200,
                content=html_partial,
                content_type="text/html",
                ok=True,
            ),
            "https://yc.example/ghost": FetchResult(
                url="https://yc.example/ghost",
                status=200,
                content=html_unverified,
                content_type="text/html",
                ok=True,
            ),
        }
    )

    verifier = SourceVerifier(crawler)
    records = [
        StartupRecord(
            name="Orbital Foundry",
            description="Orbital Foundry builds autonomous orbital robotics",
            website="https://orbitalfoundry.example",
            industry="Aerospace",
            location="Pasadena, CA",
            source_name="yc",
            source_url="https://yc.example/orbital",
        ),
        StartupRecord(
            name="Boreal Labs",
            description="Claimed quantum compiler not mentioned on site",
            industry="Quantum",
            location="Toronto",
            source_name="yc",
            source_url="https://yc.example/boreal",
        ),
        StartupRecord(
            name="Ghost AI",
            description="Invented company description",
            source_name="yc",
            source_url="https://yc.example/ghost",
        ),
        StartupRecord(
            name="Offline Dynamics",
            source_name="yc",
            source_url="https://yc.example/offline",
        ),
    ]

    verified_batch, summary = await verifier.verify_batch("startups", records)
    assert verified_batch[0].verification_status == VerificationStatus.VERIFIED
    assert verified_batch[0].source_title == "Orbital Foundry | Autonomous Spacecraft"
    assert "name" in verified_batch[0].supported_fields
    assert "location" in verified_batch[0].supported_fields
    assert verified_batch[0].last_checked_at is not None

    assert verified_batch[1].verification_status == VerificationStatus.PARTIALLY_VERIFIED
    assert "name" in verified_batch[1].supported_fields
    assert verified_batch[1].location == "Unknown"

    assert verified_batch[2].verification_status == VerificationStatus.UNVERIFIED
    assert verified_batch[3].verification_status == VerificationStatus.SOURCE_UNAVAILABLE
    assert summary.verified == 1
    assert summary.partially_verified == 1
    assert summary.unverified == 1
    assert summary.source_unavailable == 1


@pytest.mark.asyncio
async def test_hq_guard_rejects_factory_location_as_headquarters() -> None:
    html = (
        "<html><head><title>Helios Batteries</title></head>"
        "<body><h1>Helios Batteries</h1>"
        "<p>Helios Batteries manufactures grid storage systems and operates a battery factory in Reno, Nevada.</p>"
        "</body></html>"
    )
    crawler = StaticFakeCrawler(
        responses={
            "https://helios.example": FetchResult(
                url="https://helios.example",
                status=200,
                content=html,
                content_type="text/html",
                ok=True,
            )
        }
    )
    verifier = SourceVerifier(crawler)
    startup = StartupRecord(
        name="Helios Batteries",
        description="Manufactures grid storage systems",
        location="Reno, Nevada",
        source_name="official_site",
        source_url="https://helios.example",
    )

    verified = await verifier.verify_record("startups", startup)
    # Factory mention must NOT be assumed as company HQ
    assert verified.location == "Unknown"
    assert "location" not in verified.supported_fields
    assert verified.source_metadata.get("hq_guard_triggered") is True
    assert verified.verification_status == VerificationStatus.PARTIALLY_VERIFIED


@pytest.mark.asyncio
async def test_llm_extracted_records_never_marked_verified_without_source_check() -> None:
    provider = FakeLLMProvider(
        {
            "records": [
                {
                    "name": "Quasar AI",
                    "description": "Builds enterprise search.",
                    "industry": None,
                    "location": None,
                    "evidence": {"name": "Quasar AI", "description": "Builds enterprise search."},
                }
            ]
        }
    )
    router = LLMRouter(providers=[provider])
    res = await router.extract_structured(
        category="startups",
        source_url="https://quasar.example/about",
        source_name="llm_html",
        source_text="Quasar AI — Builds enterprise search.",
    )
    assert len(res.validated_records) == 1
    rec = res.validated_records[0]
    assert rec["verification_status"] == VerificationStatus.UNVERIFIED
    assert rec["supported_fields"] == []
    assert rec["industry"] == "Unknown"
    assert rec["location"] == "Unknown"


def test_duplicate_organization_and_domain_detection() -> None:
    ts = datetime(2026, 11, 21, 10, 0, 0, tzinfo=timezone.utc)
    s1 = StartupRecord(
        name="Acme Robotics Inc.",
        website="https://acmerobotics.example",
        source_name="yc",
        source_url="https://yc.example/acme",
        collected_at=ts,
    )
    s2 = StartupRecord(
        name="Acme Robotics",
        website="https://www.acmerobotics.example/",
        source_name="crunchbase_mirror",
        source_url="https://mirror.example/acme-robotics",
        collected_at=ts,
    )
    dedup = RecordDeduplicator().deduplicate("startups", [s1, s2])
    assert len(dedup.unique_records) == 1
    assert dedup.duplicate_count == 1
    assert dedup.duplicates[0]["duplicate_type"] == "organization"


@pytest.mark.asyncio
async def test_additive_sqlite_migration_preserves_and_audits_existing_records(tmp_path: Path) -> None:
    db_path = tmp_path / "data" / "legacy.db"
    db_path.parent.mkdir(parents=True, exist_ok=True)

    # Simulate a pre-migration database without verification/traceability columns
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        CREATE TABLE startups (
            startup_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            website TEXT,
            industry TEXT,
            location TEXT,
            founding_date TEXT,
            source_name TEXT NOT NULL,
            source_url TEXT NOT NULL,
            collected_at TEXT NOT NULL,
            canonical_entity_id TEXT,
            source_metadata_json TEXT NOT NULL DEFAULT '{}',
            UNIQUE(name, source_url)
        );
        """
    )
    conn.execute(
        """
        INSERT INTO startups (
            startup_id, name, description, website, industry, location,
            founding_date, source_name, source_url, collected_at, canonical_entity_id, source_metadata_json
        ) VALUES (
            'stp_legacy_1', 'Northstar Robotics', 'Autonomous warehouse picking.', 'https://northstar.example',
            'Robotics', 'Pittsburgh, PA', NULL, 'yc', 'https://yc.example/northstar',
            '2026-11-21T08:00:00+00:00', NULL, '{}'
        );
        """
    )
    conn.commit()
    conn.close()

    html = (
        "<html><head><title>Northstar Robotics — YC</title></head>"
        "<body><h1>Northstar Robotics</h1>"
        "<p>Autonomous warehouse picking robotics company in Robotics, headquartered in Pittsburgh, PA.</p>"
        "</body></html>"
    )
    crawler = StaticFakeCrawler(
        responses={
            "https://yc.example/northstar": FetchResult(
                url="https://yc.example/northstar", status=200, content=html, content_type="text/html", ok=True
            ),
            "https://northstar.example": FetchResult(
                url="https://northstar.example", status=200, content=html, content_type="text/html", ok=True
            ),
        }
    )

    settings = Settings(base_dir=tmp_path, database_url=f"sqlite:///{db_path}")
    orchestrator = PipelineOrchestrator(settings, crawler=crawler)  # type: ignore[arg-type]

    # Existing record must still exist (never deleted) and now audit cleanly
    audit_res = await orchestrator.audit_existing(categories=("startups",), export_csv=True)
    assert audit_res["databaseCounts"]["startups"] == 1
    assert audit_res["verificationCounts"]["totals"]["Verified"] == 1

    rows = orchestrator.repo.fetch_dataset("startups")
    assert rows[0]["startup_id"] == "stp_legacy_1"
    assert rows[0]["verification_status"] == "Verified"
    assert rows[0]["source_title"] == "Northstar Robotics — YC"

    # CSV export must preserve verification_status, source_url, and source_title
    csv_path = tmp_path / "data" / "exports" / "startups.csv"
    assert csv_path.exists()
    with csv_path.open("r", encoding="utf-8") as fh:
        csv_rows = list(csv.reader(fh))
    header = csv_rows[0]
    assert "verification_status" in header
    assert "source_title" in header
    assert "supported_fields" in header
    assert "last_checked_at" in header
    assert csv_rows[1][header.index("verification_status")] == "Verified"
    assert csv_rows[1][header.index("source_title")] == "Northstar Robotics — YC"


@pytest.mark.asyncio
async def test_audit_detects_placeholder_outdated_duplicate_incomplete_and_logs_audit_trail(tmp_path: Path) -> None:
    db_path = tmp_path / "data" / "audit_cases.db"
    db_path.parent.mkdir(parents=True, exist_ok=True)

    settings = Settings(base_dir=tmp_path, database_url=f"sqlite:///{db_path}")
    db = DatabaseManager.from_settings(settings)
    db.initialize_schema()
    repo = AtlasRepository(db)

    now = datetime.now(timezone.utc)
    # 1) Valid complete startup + 2) duplicate of it + 3) placeholder example.com + 4) incomplete startup
    repo.upsert_startups(
        [
            StartupRecord(
                startup_id="stp_real_1",
                name="Cobalt Robotics",
                description="Autonomous indoor security robots.",
                website="https://cobalt.robotics",
                industry="Robotics",
                location="San Mateo, CA",
                source_name="yc",
                source_url="https://yc.ycombinator.com/cobalt",
                collected_at=now,
                verification_status=VerificationStatus.VERIFIED,
            ),
            StartupRecord(
                startup_id="stp_dup_1",
                name="Cobalt Robotics Inc.",
                description="Autonomous indoor security robots.",
                website="https://cobalt.robotics/",
                industry="Robotics",
                location="San Mateo, CA",
                source_name="other_dir",
                source_url="https://dir.other/cobalt",
                collected_at=now,
                verification_status=VerificationStatus.VERIFIED,
            ),
            StartupRecord(
                startup_id="stp_placeholder_1",
                name="Acme Placeholder",
                description="Lorem ipsum sample company.",
                website="https://example.com",
                source_name="yc",
                source_url="https://example.com/acme",
                collected_at=now,
                verification_status=VerificationStatus.VERIFIED,
            ),
        ]
    )

    real_html = (
        "<html><head><title>Cobalt Robotics</title></head>"
        "<body><h1>Cobalt Robotics</h1>"
        "<p>Cobalt Robotics builds autonomous indoor security robots in Robotics, headquartered in San Mateo, CA.</p>"
        "</body></html>"
    )
    placeholder_html = (
        "<html><head><title>Example Domain</title></head>"
        "<body><p>This domain is for use in illustrative examples.</p></body></html>"
    )
    crawler = StaticFakeCrawler(
        responses={
            "https://yc.ycombinator.com/cobalt": FetchResult(
                url="https://yc.ycombinator.com/cobalt", status=200, content=real_html, content_type="text/html", ok=True
            ),
            "https://cobalt.robotics": FetchResult(
                url="https://cobalt.robotics", status=200, content=real_html, content_type="text/html", ok=True
            ),
            "https://dir.other/cobalt": FetchResult(
                url="https://dir.other/cobalt", status=200, content=real_html, content_type="text/html", ok=True
            ),
            "https://example.com": FetchResult(
                url="https://example.com", status=200, content=placeholder_html, content_type="text/html", ok=True
            ),
        }
    )

    orchestrator = PipelineOrchestrator(settings, crawler=crawler)  # type: ignore[arg-type]
    audit_res = await orchestrator.audit_existing(categories=("startups",), export_csv=False, live_check=True)
    assert audit_res["auditEntriesLogged"] >= 2

    rows = {r["startup_id"]: r for r in repo.fetch_dataset("startups")}
    # All 3 rows preserved (never deleted)
    assert len(rows) == 3
    assert rows["stp_real_1"]["verification_status"] == "Verified"
    assert rows["stp_dup_1"]["verification_status"] == "Rejected"
    assert "Duplicate" in (rows["stp_dup_1"]["rejection_reason"] or "")
    assert rows["stp_placeholder_1"]["verification_status"] == "Rejected"
    assert "Placeholder" in (rows["stp_placeholder_1"]["rejection_reason"] or "")

    # Evidence excerpt must be captured for Verified record and absent for placeholder
    assert "Cobalt Robotics" in (rows["stp_real_1"]["source_metadata_json"] or "")
    trail = repo.fetch_audit_trail(category="startups", record_id="stp_dup_1")
    assert len(trail) >= 1
    assert trail[0]["previous_status"] == "Verified"
    assert trail[0]["new_status"] == "Rejected"

    # Offline mode must never invent evidence or mark a record Verified
    offline_verifier = SourceVerifier(crawler)
    offline_rec = await offline_verifier.verify_record(
        "startups",
        StartupRecord(
            name="Cobalt Robotics",
            description="Autonomous indoor security robots.",
            website="https://cobalt.robotics",
            industry="Robotics",
            location="San Mateo, CA",
            source_name="yc",
            source_url="https://yc.ycombinator.com/cobalt",
            verification_status=VerificationStatus.VERIFIED,
        ),
        live_check=False,
    )
    assert offline_rec.verification_status == VerificationStatus.UNVERIFIED
    assert offline_rec.source_metadata.get("source_evidence_excerpt") is None
    assert offline_rec.source_metadata.get("verification_mode") == "offline_unverified"


@pytest.mark.asyncio
async def test_startup_verification_report_and_strict_website_validity() -> None:
    yc_html_live = (
        "<html><head><title>Aether Robotics | YC</title></head>"
        "<body><h1>Aether Robotics</h1>"
        "<p>Aether Robotics builds industrial welding autonomy in Robotics, based in Austin, TX. "
        "Website: https://aether-live.example</p></body></html>"
    )
    site_html_live = (
        "<html><head><title>Aether Robotics — Welding Autonomy</title></head>"
        "<body><p>Aether Robotics industrial welding autonomy headquartered in Austin, TX.</p></body></html>"
    )
    yc_html_dead_site = (
        "<html><head><title>LegacyCo | YC</title></head>"
        "<body><h1>LegacyCo</h1>"
        "<p>LegacyCo offered retail coupons in Consumer, based in New York, NY. "
        "Link: https://dead-startup.example</p></body></html>"
    )

    crawler = StaticFakeCrawler(
        responses={
            "https://yc.example/aether": FetchResult(
                url="https://yc.example/aether", status=200, content=yc_html_live, content_type="text/html", ok=True
            ),
            "https://aether-live.example": FetchResult(
                url="https://aether-live.example", status=200, content=site_html_live, content_type="text/html", ok=True
            ),
            "https://yc.example/legacyco": FetchResult(
                url="https://yc.example/legacyco", status=200, content=yc_html_dead_site, content_type="text/html", ok=True
            ),
            "https://dead-startup.example": FetchResult(
                url="https://dead-startup.example", status=404, content="", ok=False, error="http_404"
            ),
        }
    )
    verifier = SourceVerifier(crawler)

    verified_rec = await verifier.verify_record(
        "startups",
        StartupRecord(
            name="Aether Robotics",
            description="industrial welding autonomy",
            website="https://aether-live.example",
            industry="Robotics",
            location="Austin, TX",
            source_name="yc_oss_directory",
            source_url="https://yc.example/aether",
        ),
    )
    assert verified_rec.verification_status == VerificationStatus.VERIFIED
    report = verified_rec.source_metadata.get("startup_verification_report")
    assert isinstance(report, dict)
    assert report["company_name_match"]["matched"] is True
    assert report["official_website_validity"]["accessible"] is True
    assert report["official_website_validity"]["http_status"] == 200
    assert report["official_website_validity"]["page_title"] == "Aether Robotics — Welding Autonomy"
    assert report["description_match"]["matched"] is True
    assert report["industry_evidence"]["matched"] is True
    assert report["location_evidence"]["matched"] is True
    assert report["source_accessibility"]["accessible"] is True
    assert report["verification_timestamp"] is not None
    assert "corroborated" in report["exact_reason"].lower()

    # Official site returns HTTP 404 -> website MUST NOT be marked supported even though YC page mentions it
    partial_rec = await verifier.verify_record(
        "startups",
        StartupRecord(
            name="LegacyCo",
            description="offered retail coupons",
            website="https://dead-startup.example",
            industry="Consumer",
            location="New York, NY",
            source_name="yc_oss_directory",
            source_url="https://yc.example/legacyco",
        ),
    )
    assert partial_rec.verification_status == VerificationStatus.PARTIALLY_VERIFIED
    assert "website" not in partial_rec.supported_fields
    p_report = partial_rec.source_metadata["startup_verification_report"]
    assert p_report["official_website_validity"]["accessible"] is False
    assert p_report["official_website_validity"]["http_status"] == 404
    assert "unreachable" in p_report["exact_reason"].lower()

    # Primary source unavailable -> report still populated honestly
    unavail_rec = await verifier.verify_record(
        "startups",
        StartupRecord(
            name="MissingSourceCo",
            website="https://dead-startup.example",
            source_name="yc_oss_directory",
            source_url="https://yc.example/not-found",
        ),
    )
    assert unavail_rec.verification_status == VerificationStatus.SOURCE_UNAVAILABLE
    u_report = unavail_rec.source_metadata["startup_verification_report"]
    assert u_report["source_accessibility"]["accessible"] is False
    assert u_report["company_name_match"]["matched"] is False


@pytest.mark.asyncio
async def test_parked_domain_and_pdf_binary_handling() -> None:
    yc_html = (
        "<html><head><title>WireOver | YC</title></head>"
        "<body><h1>WireOver</h1>"
        "<p>WireOver builds secure messaging software in B2B, based in San Francisco, CA.</p>"
        "</body></html>"
    )
    parked_html = (
        "<html><head><title>NameBright - Coming Soon</title></head>"
        "<body><p>wireover.com is coming soon. This domain is for sale.</p></body></html>"
    )
    crawler = StaticFakeCrawler(
        responses={
            "https://yc.example/wireover": FetchResult(
                url="https://yc.example/wireover",
                status=200,
                content=yc_html,
                content_type="text/html",
                ok=True,
            ),
            "http://wireover.com/": FetchResult(
                url="http://wireover.com/",
                status=200,
                content=parked_html,
                content_type="text/html",
                ok=True,
            ),
            "https://doi.org/10.9999/paper.pdf": FetchResult(
                url="https://publisher.example/paper.pdf",
                status=200,
                content="%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>",
                content_type="application/pdf",
                ok=True,
            ),
        }
    )
    verifier = SourceVerifier(crawler)

    # Parked domain must strip website support and prevent Verified status
    parked_startup = await verifier.verify_record(
        "startups",
        StartupRecord(
            name="WireOver",
            description="WireOver builds secure messaging software",
            website="http://wireover.com/",
            industry="B2B",
            location="San Francisco, CA",
            source_name="yc_oss_directory",
            source_url="https://yc.example/wireover",
        ),
    )
    assert "website" not in parked_startup.supported_fields
    assert parked_startup.verification_status == VerificationStatus.PARTIALLY_VERIFIED
    assert "parked_or_forsale_website" in (parked_startup.source_metadata.get("audit_issues") or [])
    report = parked_startup.source_metadata["startup_verification_report"]
    assert report["official_website_validity"]["error"] == "parked_or_forsale_domain"

    # Raw PDF binary must be detected cleanly rather than parsed as HTML
    snap = verifier._parse_fetch_result(
        "https://doi.org/10.9999/paper.pdf",
        crawler.responses["https://doi.org/10.9999/paper.pdf"],
    )
    assert snap.title == "PDF Document"
    assert snap.text == ""
    assert snap.error == "pdf_binary_not_text"


@pytest.mark.asyncio
async def test_audit_all_six_datasets_and_remove_duplicates_including_entity_mapping_log(tmp_path: Path) -> None:
    from src.schemas import EntityMappingLog, EntityType, MatchDecision

    db_path = tmp_path / "data" / "audit_all.db"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    settings = Settings(base_dir=tmp_path, database_url=f"sqlite:///{db_path}")
    db = DatabaseManager.from_settings(settings)
    db.initialize_schema()
    repo = AtlasRepository(db)

    now = datetime.now(timezone.utc)
    # 1. Deterministic EntityMappingLog hashing across different match_method values
    m_first = EntityMappingLog(
        raw_name="Orbital Foundry",
        normalized_name="orbital foundry",
        canonical_name="Orbital Foundry",
        canonical_id="ent_001",
        source_url="https://yc.example/orbital",
        match_method="new_canonical",
        confidence=1.0,
        decision=MatchDecision.NEW_ENTITY,
        entity_type=EntityType.STARTUP,
        timestamp=now,
    )
    m_second = EntityMappingLog(
        raw_name="Orbital Foundry",
        normalized_name="orbital foundry",
        canonical_name="Orbital Foundry",
        canonical_id="ent_001",
        source_url="https://yc.example/orbital",
        match_method="exact_normalized_name",
        confidence=1.0,
        decision=MatchDecision.EXACT_MATCH,
        entity_type=EntityType.STARTUP,
        timestamp=now,
    )
    assert m_first.mapping_id == m_second.mapping_id

    # Simulate legacy duplicate rows already in entity_mapping_log + duplicate startups
    m_legacy_dup = m_second.model_copy(update={"mapping_id": "map_legacy_dup_1"})
    repo.upsert_entity_mapping_logs([m_first, m_legacy_dup])

    repo.upsert_startups(
        [
            StartupRecord(
                startup_id="stp_keep_1",
                name="Orbital Foundry",
                description="Autonomous spacecraft.",
                website="https://orbital.example",
                industry="Aerospace",
                location="Pasadena, CA",
                source_name="yc",
                source_url="https://yc.example/orbital",
                collected_at=now,
            ),
            StartupRecord(
                startup_id="stp_remove_dup",
                name="Orbital Foundry Inc.",
                description="Autonomous spacecraft.",
                website="https://orbital.example/",
                industry="Aerospace",
                location="Pasadena, CA",
                source_name="mirror",
                source_url="https://mirror.example/orbital",
                collected_at=now,
            ),
        ]
    )

    html = (
        "<html><head><title>Orbital Foundry</title></head>"
        "<body><h1>Orbital Foundry</h1>"
        "<p>Orbital Foundry builds autonomous spacecraft in Aerospace, headquartered in Pasadena, CA.</p>"
        "</body></html>"
    )
    crawler = StaticFakeCrawler(
        responses={
            "https://yc.example/orbital": FetchResult(
                url="https://yc.example/orbital", status=200, content=html, content_type="text/html", ok=True
            ),
            "https://orbital.example": FetchResult(
                url="https://orbital.example", status=200, content=html, content_type="text/html", ok=True
            ),
            "https://mirror.example/orbital": FetchResult(
                url="https://mirror.example/orbital", status=200, content=html, content_type="text/html", ok=True
            ),
        }
    )

    orchestrator = PipelineOrchestrator(settings, crawler=crawler)  # type: ignore[arg-type]
    audit_res = await orchestrator.audit_existing(export_csv=False, live_check=True, remove_duplicates=True)

    assert "entity_mapping_log" in audit_res["auditedCategories"]
    assert audit_res["duplicatesRemoved"]["startups"] == 1
    assert audit_res["duplicatesRemoved"]["entity_mapping_log"] == 1
    assert len(repo.list_all("startups")) == 1
    assert len(repo.list_all("entity_mapping_log")) == 1
    assert repo.list_all("startups")[0]["startup_id"] == "stp_keep_1"



