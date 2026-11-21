"""Generate docs/architecture.pdf with system diagrams and technical design."""

from __future__ import annotations

from pathlib import Path

from reportlab.graphics.shapes import Drawing, Line, Polygon, Rect, String
from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


def _arrow(drawing: Drawing, x1: float, y1: float, x2: float, y2: float) -> None:
    drawing.add(Line(x1, y1, x2, y2, strokeColor=colors.HexColor("#334155"), strokeWidth=1.4))
    # Simple downward or rightward arrowhead
    if abs(x2 - x1) < 1e-3 and y2 < y1:  # Down
        drawing.add(Polygon([x2 - 4, y2 + 6, x2 + 4, y2 + 6, x2, y2], fillColor=colors.HexColor("#334155"), strokeColor=colors.HexColor("#334155")))
    elif x2 > x1 and abs(y2 - y1) < 1e-3:  # Right
        drawing.add(Polygon([x2 - 6, y2 + 4, x2 - 6, y2 - 4, x2, y2], fillColor=colors.HexColor("#334155"), strokeColor=colors.HexColor("#334155")))


def _box(drawing: Drawing, x: float, y: float, w: float, h: float, title: str, subtitle: str, fill: str) -> None:
    drawing.add(
        Rect(
            x,
            y,
            w,
            h,
            rx=6,
            ry=6,
            fillColor=colors.HexColor(fill),
            strokeColor=colors.HexColor("#1e293b"),
            strokeWidth=1.1,
        )
    )
    drawing.add(
        String(
            x + w / 2,
            y + h - 18,
            title,
            textAnchor="middle",
            fontName="Helvetica-Bold",
            fontSize=9.5,
            fillColor=colors.HexColor("#0f172a"),
        )
    )
    drawing.add(
        String(
            x + w / 2,
            y + h - 32,
            subtitle,
            textAnchor="middle",
            fontName="Helvetica",
            fontSize=7.5,
            fillColor=colors.HexColor("#334155"),
        )
    )


def build_system_diagram() -> Drawing:
    d = Drawing(480, 295)
    _box(d, 90, 240, 300, 42, "1. Public Sources & Official APIs", "OpenAlex | arXiv | Crossref | GitHub | Remotive | RSS | YC OSS", "#e2e8f0")
    _arrow(d, 240, 240, 240, 222)

    _box(d, 50, 178, 380, 44, "2. AsyncCrawler & Category Collectors", "aiohttp Semaphore, per-domain rate limit, robots.txt, BeautifulSoup", "#dbeafe")
    _arrow(d, 160, 178, 160, 158)
    _arrow(d, 320, 178, 320, 158)

    _box(d, 30, 114, 200, 44, "3a. LLMRouter (Unstructured)", "Gemini Primary + Chunking + Evidence", "#ede9fe")
    _box(d, 250, 114, 200, 44, "3b. Validation & Freshness", "Pydantic v2, 24h UTC, Dedup, Quality", "#dcfce7")
    _arrow(d, 230, 136, 250, 136)
    _arrow(d, 350, 114, 350, 96)

    _box(d, 90, 52, 300, 44, "4. Conservative Entity Resolution & Registry", "Normalizer, CanonicalRegistry, EntityMatcher -> MappingLog", "#fef3c7")
    _arrow(d, 240, 52, 240, 36)

    _box(d, 30, 2, 200, 34, "5a. Storage (SQLite / Postgres)", "Upserts, Checkpoints, failure_logs", "#f1f5f9")
    _box(d, 250, 2, 200, 34, "5b. Exporters (Sheets & CSV)", "6 Tabs, Batch Writes, Quota Retry", "#fce7f3")
    _arrow(d, 230, 19, 250, 19)
    return d


def build_llm_and_er_diagram() -> Drawing:
    d = Drawing(480, 175)
    # LLM Orchestration Flow
    _box(d, 10, 120, 105, 42, "Chunker", "Token-aware split", "#ede9fe")
    _arrow(d, 115, 141, 135, 141)
    _box(d, 135, 120, 115, 42, "GeminiClient", "google-genai JSON", "#ddd6fe")
    _arrow(d, 250, 141, 270, 141)
    _box(d, 270, 120, 100, 42, "Retry / 413", "Backoff / Fallback", "#fee2e2")
    _arrow(d, 370, 141, 390, 141)
    _box(d, 390, 120, 85, 42, "Evidence", "Source verify", "#dcfce7")

    # Entity Resolution Flow
    _box(d, 10, 30, 105, 46, "Normalizer", "Lower, punct, Inc.", "#fef3c7")
    _arrow(d, 115, 53, 135, 53)
    _box(d, 135, 30, 115, 46, "Exact / Domain", "Domain conflict guard", "#fde68a")
    _arrow(d, 250, 53, 270, 53)
    _box(d, 270, 30, 100, 46, "Fuzzy Guard", ">=0.92 Auto / 0.80 Rev", "#fed7aa")
    _arrow(d, 370, 53, 390, 53)
    _box(d, 390, 30, 85, 46, "MappingLog", "Audit + Confidence", "#dcfce7")
    return d


def generate_pdf(output_path: Path) -> Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(
        str(output_path),
        pagesize=LETTER,
        leftMargin=0.7 * inch,
        rightMargin=0.7 * inch,
        topMargin=0.65 * inch,
        bottomMargin=0.65 * inch,
        title="FrontierAtlas Architecture Specification",
        author="FrontierAtlas Engineering",
    )
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "AtlasTitle",
        parent=styles["Title"],
        fontSize=20,
        textColor=colors.HexColor("#0f172a"),
        spaceAfter=6,
    )
    h1 = ParagraphStyle(
        "AtlasH1",
        parent=styles["Heading1"],
        fontSize=13,
        textColor=colors.HexColor("#1e3a8a"),
        spaceBefore=12,
        spaceAfter=5,
    )
    body = ParagraphStyle(
        "AtlasBody",
        parent=styles["BodyText"],
        fontSize=9.5,
        leading=13.5,
        textColor=colors.HexColor("#1e293b"),
    )

    story = [
        Paragraph("FrontierAtlas — System Architecture & Engineering Blueprint", title_style),
        Paragraph(
            "AI-Powered Data Intelligence, Structured Extraction, Verification & Entity Resolution Pipeline",
            body,
        ),
        Spacer(1, 10),
        Paragraph("1. System Architecture Diagram", h1),
        build_system_diagram(),
        Spacer(1, 8),
        Paragraph("2. End-to-End Data Flow & Component Responsibilities", h1),
        Paragraph(
            "<b>Collection Layer (src/crawler, src/collectors):</b> Independent async collectors query official APIs "
            "(OpenAlex, arXiv, Crossref, GitHub, Remotive, Arbeitnow, Greenhouse, HN Algolia) and permitted RSS/HTML "
            "pages. AsyncCrawler enforces bounded concurrency, per-domain rate limits, robots.txt compliance, URL "
            "deduplication, and exponential backoff without bypassing authentication or anti-bot walls.",
            body,
        ),
        Spacer(1, 4),
        Paragraph(
            "<b>Extraction Layer (src/llm):</b> When unstructured web text requires schema extraction, LLMRouter splits "
            "content with token-aware chunking, invokes Google Gemini via the official google-genai Python SDK, routes "
            "to optional configured fallbacks (Groq/DeepSeek) on failure, verifies extracted quotes against original source "
            "text, and enforces Pydantic v2 validation.",
            body,
        ),
        Spacer(1, 4),
        Paragraph(
            "<b>Validation & Freshness Layer (src/validation):</b> FreshnessFilter rejects Jobs and News lacking a valid "
            "UTC publication timestamp within the trailing 24 hours. RecordDeduplicator removes cross-source duplicates "
            "by canonical URL, DOI, arXiv ID, and deterministic record IDs. QualityReportGenerator audits discovered, "
            "extracted, validated, rejected, duplicate, and missing-field counts.",
            body,
        ),
        PageBreak(),
        Paragraph("3. LLM Orchestration & Entity Resolution Workflows", h1),
        build_llm_and_er_diagram(),
        Spacer(1, 8),
        Paragraph(
            "<b>LLM Orchestration Flow:</b> Text is segmented on paragraph/sentence boundaries (chunking.py). GeminiClient "
            "requests JSON-only output. HTTP 429/5xx and malformed JSON trigger exponential backoff retries; HTTP 413 "
            "automatically halves chunk size and re-runs sub-chunks. Missing keys or unconfigured fallbacks fail safely "
            "and persist diagnostics into failure_logs.",
            body,
        ),
        Spacer(1, 4),
        Paragraph(
            "<b>Conservative Entity Resolution Workflow:</b> Raw names undergo NFKC Unicode normalization, lowercasing, "
            "punctuation cleanup, and trailing legal-suffix removal (Inc., Corp., LLC, PBC). EntityMatcher evaluates "
            "exact normalized matches, compact spacing variants ('Open AI' vs 'OpenAI'), dedicated website domains "
            "(excluding shared hosts like github.com), and conservative fuzzy similarity (>=0.92 auto-merge, 0.80-0.92 "
            "manual review). Conflicting domains or differing root tokens block unsafe merges. Every decision is recorded "
            "in EntityMappingLog.",
            body,
        ),
        Paragraph("4. Database Design (SQLite Local & PostgreSQL Scaling)", h1),
    ]

    db_table = Table(
        [
            ["Table", "Primary Key", "Unique / Dedup Constraint", "Key Indexes"],
            ["startups", "startup_id", "UNIQUE(name, source_url)", "website, collected_at"],
            ["products", "product_id", "UNIQUE(name, source_url)", "website"],
            ["research_papers", "paper_id", "UNIQUE(source_url)", "doi, arxiv_id"],
            ["jobs", "job_id", "UNIQUE(application_url)", "posted_at"],
            ["news", "news_id", "UNIQUE(article_url)", "published_at"],
            ["entity_mapping_log", "mapping_id", "UNIQUE(raw, canonical_id, url, method)", "canonical_id"],
            ["canonical_entities", "canonical_id", "UNIQUE(entity_type, normalized_name)", "primary_domain"],
            ["failure_logs", "failure_id", "PRIMARY KEY", "stage, category"],
        ],
        colWidths=[1.35 * inch, 1.05 * inch, 2.15 * inch, 1.55 * inch],
    )
    db_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1e293b")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), 8),
                ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#cbd5e1")),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f8fafc")]),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ]
        )
    )
    story.append(db_table)
    story.append(Spacer(1, 10))
    story.append(Paragraph("5. Scaling Architecture (500,000+ Records) & Error Handling", h1))
    story.append(
        Paragraph(
            "<b>Horizontal & Queue-Based Scaling:</b> Partition source collectors across stateless worker containers reading "
            "from a durable queue (Redis Streams / PubSub). Separate I/O-bound crawling from rate-limited LLM extraction "
            "workers. Switch DATABASE_URL to PostgreSQL with connection pooling, batch upserts (500-2,000 rows), "
            "pg_trgm blocking indexes for entity resolution, and collection_checkpoints for incremental delta ingestion.",
            body,
        )
    )
    story.append(Spacer(1, 4))
    story.append(
        Paragraph(
            "<b>Cost & Token Optimization:</b> Prefer structured APIs (OpenAlex, arXiv, Remotive, RSS) before invoking "
            "LLMs; strip HTML boilerplate via ContentExtractor; deduplicate canonical URLs prior to chunking; use "
            "gemini-4-hydrogen for high-throughput structured extraction.",
            body,
        )
    )
    story.append(Spacer(1, 4))
    story.append(
        Paragraph(
            "<b>Error Handling & Dead-Letter Recovery:</b> Collector failures, HTTP 401/403/429 blocks, malformed LLM "
            "JSON, freshness rejections, and Pydantic validation errors never crash the pipeline. Every failure is logged "
            "with structured context and persisted into failure_logs for replay and auditing, while Google Sheets quota "
            "errors trigger exponential backoff and CSV exports serve as an automatic local fallback.",
            body,
        )
    )

    doc.build(story)
    return output_path


if __name__ == "__main__":
    out = generate_pdf(Path(__file__).resolve().parent / "architecture.pdf")
    print(f"Generated {out}")
