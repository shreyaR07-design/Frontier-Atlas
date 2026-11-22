"""Generate docs/architecture.pdf with system diagrams and technical design."""

from __future__ import annotations

from pathlib import Path

try:
    from reportlab.graphics.shapes import Drawing, Line, Polygon, Rect, String
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import LETTER
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import inch
    from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
    _HAS_REPORTLAB = True
except ImportError:
    _HAS_REPORTLAB = False


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
            "<b>Collection Layer (PoliteHttpClient & Async Collectors):</b> Independent async collectors query official APIs "
            "(OpenAlex, arXiv, Crossref, HF Spaces/Daily Papers, GitHub, Arbeitnow, Jobicy, Greenhouse, Lever, Himalayas, "
            "HN Algolia, YC OSS) and permitted RSS/HTML pages. Bounded concurrency, per-domain rate limits, robots.txt "
            "compliance, URL deduplication, and exponential backoff run without bypassing auth or anti-bot walls.",
            body,
        ),
        Spacer(1, 4),
        Paragraph(
            "<b>4-Tier LLM Extraction Layer:</b> Unstructured text uses token-aware overlap chunking and invokes "
            "<b>1. Gemini Flash -> 2. Groq -> 3. Llama 3 -> 4. DeepSeek</b>. HTTP 429 triggers exponential backoff + jitter "
            "before tier failover; HTTP 413 triggers recursive half-size sub-chunking. When zero keys are configured, an "
            "explicit heuristic demo fallback extracts grounded fields marked Unverified.",
            body,
        ),
        Spacer(1, 4),
        Paragraph(
            "<b>Validation & 24h UTC Freshness Layer:</b> Normalizes ISO-8601, RFC-2822, epoch, and explicit relative dates "
            "('2 hours ago'), tagging exact vs relative timestamps and rejecting older/missing/ambiguous dates. Deduplicator "
            "eliminates cross-source duplicates by canonical URL, DOI, arXiv ID, and SHA-256 deterministic IDs.",
            body,
        ),
        PageBreak(),
        Paragraph("3. LLM Orchestration & Entity Resolution Workflows", h1),
        build_llm_and_er_diagram(),
        Spacer(1, 8),
        Paragraph(
            "<b>LLM Orchestration Flow:</b> Text splits on paragraph/sentence boundaries. GeminiClient (@google/genai) and "
            "OpenAI-compatible tiers (Groq, Llama 3, DeepSeek) enforce JSON output. HTTP 429/5xx triggers exponential backoff; "
            "HTTP 413 halves chunk tokens recursively (up to 3 levels). Evidence quotes are checked against source text.",
            body,
        ),
        Spacer(1, 4),
        Paragraph(
            "<b>Deterministic Entity Resolution Workflow:</b> Raw names undergo NFKC normalization, lowercasing, punctuation "
            "cleanup, and legal-suffix removal (Inc., Corp., LLC, PBC). Matcher evaluates exact normalized forms, compact "
            "spacing variants ('Open AI' -> 'OpenAI'), dedicated domain conflict guards, and conservative fuzzy thresholds "
            "(>=0.92 auto-merge, 0.80-0.92 manual review), logging every decision with confidence and reason.",
            body,
        ),
        Paragraph("4. Database Design & 6-Tab Google Sheets Sync", h1),
    ]

    db_table = Table(
        [
            ["Table / Sheet Tab", "Primary Key", "Unique / Dedup Constraint", "Key Indexes"],
            ["startups / Startups", "startup_id", "UNIQUE(name, source_url)", "website, collected_at"],
            ["products / Products", "product_id", "UNIQUE(name, source_url)", "website"],
            ["research_papers / Research Papers", "paper_id", "UNIQUE(source_url)", "doi, arxiv_id, github"],
            ["jobs / Jobs", "job_id", "UNIQUE(application_url)", "posted_at"],
            ["news / News", "news_id", "UNIQUE(article_url)", "published_at"],
            ["entity_mapping_log / Entity Mapping Log", "mapping_id", "UNIQUE(raw, canonical_id, url)", "canonical_id"],
            ["canonical_entities", "canonical_id", "UNIQUE(entity_type, normalized_name)", "primary_domain"],
            ["failure_logs / sheets_sync_state", "failure_id / id", "PRIMARY KEY", "stage, category"],
        ],
        colWidths=[1.55 * inch, 1.0 * inch, 2.05 * inch, 1.5 * inch],
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
            "<b>Horizontal & Queue-Based Scaling:</b> Partition source collectors across stateless workers reading from "
            "durable queues (Redis Streams / PubSub). Separate I/O-bound crawling from rate-limited LLM extraction workers. "
            "Switch DATABASE_URL to PostgreSQL with connection pooling, batch upserts (500-2,000 rows), pg_trgm blocking "
            "indexes for entity resolution, and collection_checkpoints for incremental delta ingestion.",
            body,
        )
    )
    story.append(Spacer(1, 4))
    story.append(
        Paragraph(
            "<b>Cost & Token Optimization:</b> Prefer structured APIs (OpenAlex, arXiv, HF, RSS) before invoking LLMs; "
            "strip HTML boilerplate; deduplicate canonical URLs prior to chunking; route basic extraction to Gemini Flash "
            "before Groq, Llama 3, and DeepSeek.",
            body,
        )
    )
    story.append(Spacer(1, 4))
    story.append(
        Paragraph(
            "<b>Error Handling & Dead-Letter Recovery:</b> HTTP 401/403/429/CAPTCHA blocks, malformed JSON, freshness "
            "rejections, and validation errors never crash the pipeline. Failures persist in failure_logs; Google Sheets "
            "quota errors trigger exponential backoff + per-tab verification; CSV exports provide deterministic local backup.",
            body,
        )
    )

    doc.build(story)
    return output_path


def _escape_pdf_text(text: str) -> str:
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _generate_stdlib_three_page_pdf(output_path: Path) -> Path:
    """Fallback pure-stdlib PDF 1.4 generator (strictly 3 pages) when reportlab is unavailable."""
    pages: list[list[tuple[int, str, bool]]] = [
        [
            (18, "FrontierAtlas - System Architecture & Engineering Blueprint", True),
            (10, "AI-Powered Data Intelligence, Structured Extraction, Verification & Entity Resolution", False),
            (13, "1. High-Level Architecture & Data Flow (500k+ Scale Design)", True),
            (10, "[1] Public APIs & Feeds: OpenAlex | arXiv | Crossref | HF Spaces/Papers | GitHub | Job Boards | RSS", False),
            (10, "        |", False),
            (10, "        v", False),
            (10, "[2] PoliteHttpClient & Async Collectors: Bounded concurrency, per-domain rate limit, robots.txt,", False),
            (10, "    HTTP 429 Retry-After backoff, 401/403/CAPTCHA non-bypass logging, checkpointed pagination.", False),
            (10, "        |", False),
            (10, "        +---> [3a] 4-Tier LLMRouter: 1. Gemini Flash -> 2. Groq -> 3. Llama 3 -> 4. DeepSeek", False),
            (10, "        |          Token-aware overlap chunking, recursive 413 half-split, heuristic demo fallback", False),
            (10, "        +---> [3b] Freshness & Deduplication: 24h UTC window, relative date parsing, SHA-256 IDs", False),
            (10, "        |", False),
            (10, "        v", False),
            (10, "[4] Deterministic Entity Resolution: NFKC normalize, legal suffix strip, domain conflict guards,", False),
            (10, "    'OpenAI'/'OpenAI Inc.'/'Open AI' -> canonical ID + confidence + Entity Mapping Log.", False),
            (10, "        |", False),
            (10, "        v", False),
            (10, "[5] Storage & Sync: SQLite WAL (or PostgreSQL pool) + 6 CSV files + 6-Tab Google Sheets API v4.", False),
        ],
        [
            (13, "2. Multi-Tier LLM Fallback Chain & Context-Limit Recovery", True),
            (10, "- Tier 1: Google Gemini Flash (@google/genai) | Tier 2: Groq | Tier 3: Llama 3 | Tier 4: DeepSeek.", False),
            (10, "- Rate Limits (HTTP 429 / 5xx): Exponential backoff + random jitter before tier failover.", False),
            (10, "- Context / Payload Limits (HTTP 413): Recursive half-size sub-chunking (down to 600 tokens).", False),
            (10, "- Unconfigured Keys: Explicit heuristic_demo_fallback extracts grounded fields marked Unverified.", False),
            (13, "3. Freshness, Research Enrichment & Anti-Bot Resilience", True),
            (10, "- Jobs & News: Parses ISO-8601, RFC-2822, epoch, and explicit relative dates ('2 hours ago').", False),
            (10, "- Precision Tracking: Distinguishes verified_exact vs relative_estimated; rejects undated/old items.", False),
            (10, "- Research Enrichment: Extracts GitHub repos + live star counts and tracks metrics_updated_at.", False),
            (10, "- Anti-Bot Compliance: Enforces robots.txt, crawl-delay budgets, and logs 401/403/CAPTCHA safely.", False),
            (13, "4. Database Tables & Exact 6-Tab Google Sheets Schema", True),
            (10, "- Startups (startup_id), Products (product_id), Research Papers (paper_id, github_stars),", False),
            (10, "  Jobs (job_id, posted_at), News (news_id, published_at), Entity Mapping Log (mapping_id).", False),
            (10, "- Full Export & Incremental Sync: Payload-bounded values:batchUpdate + Column A ID read-back verify.", False),
        ],
        [
            (13, "5. Scaling Architecture to 500,000+ Records", True),
            (10, "- Stateless Collector Workers: Partition source cursors (OpenAlex, YC, GitHub, RSS) over Redis", False),
            (10, "  Streams / PubSub queues so I/O-bound crawls scale horizontally without blocking.", False),
            (10, "- PostgreSQL Production Backend: Swap DATABASE_URL to PostgreSQL with connection pooling,", False),
            (10, "  500-2,000 row transactional upserts, and pg_trgm trigram blocking for fast entity matching.", False),
            (10, "- Checkpointing & Recovery: collection_checkpoints persists page/cursor progress per category.", False),
            (10, "- Cost & Token Optimization: Structured APIs precede LLM calls; boilerplate HTML stripping and", False),
            (10, "  canonical URL deduplication eliminate redundant chunk inference.", False),
            (10, "- Dead-Letter & Partial Failure Resilience: failure_logs captures 401/403/429/schema/freshness", False),
            (10, "  errors; Sheets sync gates 'Connected' strictly on 6/6 per-tab write + Column A verification.", False),
        ],
    ]

    objects: list[bytes] = []
    # Obj 1: Catalog, Obj 2: Pages, Obj 3: F1 Regular, Obj 4: F2 Bold
    page_obj_nums = [5, 7, 9]
    kids = " ".join(f"{n} 0 R" for n in page_obj_nums)
    objects.append(b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n")
    objects.append(f"2 0 obj\n<< /Type /Pages /Kids [{kids}] /Count {len(page_obj_nums)} >>\nendobj\n".encode("ascii"))
    objects.append(b"3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n")
    objects.append(b"4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n")

    for idx, lines in enumerate(pages):
        page_num = 5 + idx * 2
        content_num = page_num + 1
        stream_cmds: list[str] = ["BT"]
        y = 740
        for size, text, bold in lines:
            font = "/F2" if bold else "/F1"
            if bold and y < 730:
                y -= 10
            stream_cmds.append(f"{font} {size} Tf")
            stream_cmds.append(f"1 0 0 1 48 {y} Tm")
            stream_cmds.append(f"({_escape_pdf_text(text)}) Tj")
            y -= size + 7
        stream_cmds.append(f"/F1 9 Tf 1 0 0 1 48 36 Tm (Page {idx + 1} of {len(pages)}) Tj")
        stream_cmds.append("ET")
        stream_bytes = "\n".join(stream_cmds).encode("latin-1", errors="replace")
        objects.append(
            (
                f"{page_num} 0 obj\n"
                f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
                f"/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents {content_num} 0 R >>\n"
                f"endobj\n"
            ).encode("ascii")
        )
        objects.append(
            f"{content_num} 0 obj\n<< /Length {len(stream_bytes)} >>\nstream\n".encode("ascii")
            + stream_bytes
            + b"\nendstream\nendobj\n"
        )

    out = bytearray(b"%PDF-1.4\n")
    offsets: list[int] = [0]
    for obj in objects:
        offsets.append(len(out))
        out.extend(obj)
    xref_pos = len(out)
    out.extend(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode("ascii"))
    for off in offsets[1:]:
        out.extend(f"{off:010d} 00000 n \n".encode("ascii"))
    out.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n".encode("ascii")
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(bytes(out))
    return output_path


if __name__ == "__main__":
    out_file = Path(__file__).resolve().parent / "architecture.pdf"
    try:
        out = generate_pdf(out_file)
    except Exception:
        out = _generate_stdlib_three_page_pdf(out_file)
    print(f"Generated {out}")

