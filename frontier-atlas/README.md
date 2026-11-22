# FrontierAtlas

AI-powered data intelligence, structured extraction, and conservative entity resolution pipeline built in Python 3.11+.

FrontierAtlas collects, extracts, validates, deduplicates, resolves, stores, and exports six interconnected intelligence datasets:

1. **Startups** (`startups`) — target scale: 1,000+ legitimate records
2. **Products** (`products`) — target scale: 1,000+ legitimate records
3. **Research Papers** (`research_papers`) — target scale: 1,000+ legitimate records with GitHub repository and star enrichment
4. **Jobs** (`jobs`) — eligible accessible postings published within the last 24 hours (UTC)
5. **News** (`news`) — eligible accessible articles published within the last 24 hours (UTC)
6. **Entity Mapping Log** (`entity_mapping_log`) — full audit trail of raw names, normalized forms, canonical IDs, match methods, confidence scores, and conservative merge decisions

---

## Features

- **Compliant Asynchronous Collection**: Built on `asyncio` and `aiohttp` with bounded concurrency (`asyncio.Semaphore`), per-domain rate limiting, request deduplication, exponential backoff retries, `robots.txt` policy checks, and optional Playwright rendering only for permitted JS pages.
- **Official Public APIs & Feeds**: Integrates OpenAlex, arXiv Atom API, Crossref, GitHub REST API (repositories + star enrichment), Remotive, Arbeitnow, public Greenhouse boards, Hacker News Algolia API, RSS/Atom feeds, and the YC OSS public directory.
- **Gemini LLM Extraction Engine**: Uses the official `google-genai` Python SDK (`GEMINI_API_KEY`, `GEMINI_MODEL`) with JSON-only structured output, token-aware chunking, controlled retries (`429`, `5xx`, malformed JSON), automatic sub-chunking on `413`, and source-evidence verification so LLM outputs are audited against original source text.
- **Provider Routing**: Gemini is the primary provider. Optional fallback providers (`groq`, `deepseek`) activate only when their API keys are configured; otherwise the router fails gracefully and logs errors without fabricating results.
- **Conservative Entity Resolution**: NFKC/lowercase/punctuation/legal-suffix normalization, alias registry, compact spacing checks, domain matching (excluding generic hosts like `github.com`), false-positive guards, and `EntityMappingLog` auditing (`exact_match`, `auto_merge`, `manual_review`, `new_entity`).
- **24-Hour UTC Freshness & Data Quality**: Strict UTC window filtering for Jobs and News, canonical URL/DOI/arXiv deduplication, Pydantic v2 validation, failure preservation (`failure_logs`), and JSON quality reporting (`data/quality_report.json`).
- **Storage & Exports**: Local SQLite (`WAL` mode, transactional batch upserts, unique constraints, incremental checkpoints) with PostgreSQL-compatible SQL schema (`psycopg`), six-tab Google Sheets batch exporter with quota retry, and deterministic CSV fallback export.

---

## Architecture

```
Public APIs / RSS / Permitted Web Pages
                 │
                 ▼
     ┌───────────────────────┐
     │  AsyncCrawler &       │  robots.txt check, rate limiting, retries
     │  5 Category Collectors│
     └───────────┬───────────┘
                 │
                 ▼
     ┌───────────────────────┐
     │  LLMRouter (Optional  │  google-genai (Gemini primary)
     │  Unstructured Pages)  │  + chunking + evidence verification
     └───────────┬───────────┘
                 │
                 ▼
     ┌───────────────────────┐
     │  Freshness (24h UTC)  │  Pydantic schemas, URL/DOI dedup,
     │  Validation & Dedup   │  failure_logs, quality_report.json
     └───────────┬───────────┘
                 │
                 ▼
     ┌───────────────────────┐
     │  Entity Resolution    │  Normalizer + CanonicalRegistry +
     │  & Mapping Logger     │  EntityMatcher -> EntityMappingLog
     └───────────┬───────────┘
                 │
                 ▼
     ┌───────────────────────┐
     │  AtlasRepository      │  SQLite (local) / PostgreSQL (scale)
     └─────┬───────────┬─────┘
           │           │
           ▼           ▼
     CSV Exporter   Google Sheets Exporter (6 exact tabs)
```

See `docs/architecture.pdf` for full diagrams, database DDL design, LLM orchestration flow, and scaling architecture.

---

## Project Structure

```
frontier-atlas/
├── src/
│   ├── config/          # Typed Settings loader (.env + environment variables)
│   ├── collectors/      # Independent async collectors for all 5 source categories
│   ├── crawler/         # AsyncCrawler, robots.txt policy, BeautifulSoup extractor
│   ├── llm/             # GeminiClient, LLMRouter, prompts, chunking, retry handler
│   ├── schemas/         # Pydantic v2 models for all 6 datasets
│   ├── resolver/        # Normalizer, CanonicalRegistry, EntityMatcher, MappingLogger
│   ├── validation/      # Validators, 24h FreshnessFilter, Deduplicator, QualityReport
│   ├── storage/         # DatabaseManager (SQLite/PostgreSQL) & AtlasRepository
│   ├── exporters/       # GoogleSheetsExporter & CSVExporter
│   ├── pipeline/        # PipelineOrchestrator CLI & PipelineScheduler
│   └── utils/           # Structured logging, URL normalization, UTC date helpers
├── tests/               # Unit tests (mocked APIs) + opt-in live integration tests
├── data/                # Local SQLite database, quality_report.json, CSV exports
├── docs/                # architecture.pdf and PDF generator script
├── .env.example
├── .gitignore
├── pyproject.toml
├── pytest.ini
├── requirements.txt
└── README.md
```

---

## Technology Stack

- **Language**: Python 3.11+
- **Async HTTP & Parsing**: `aiohttp`, `beautifulsoup4`, `lxml`, `playwright` (optional)
- **LLM SDK & HTTP**: `google-genai`, `httpx`, `tenacity`
- **Validation**: `pydantic` v2
- **Storage**: `sqlite3` (local), `psycopg` (PostgreSQL scaling)
- **Export**: `gspread`, `google-api-python-client`, `google-auth`, stdlib `csv`
- **Testing & Docs**: `pytest`, `pytest-asyncio`, `reportlab`

---

## Installation

```bash
cd frontier-atlas
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

If you plan to enable Playwright for permitted JavaScript-rendered pages (`PLAYWRIGHT_ENABLED=true`):

```bash
playwright install chromium
```

---

## Environment Variables

Configure values in `.env` (never commit `.env` or credential JSON files):

| Variable | Description | Default |
|---|---|---|
| `GEMINI_API_KEY` | Google Gemini API key | *(empty)* |
| `GEMINI_MODEL` | Active Gemini model name | `gemini-2.5-flash` |
| `GROQ_API_KEY` | Optional Groq tier-2 fallback API key | *(empty)* |
| `GROQ_MODEL` | Optional Groq model | `llama-3.3-70b-versatile` |
| `DEEPSEEK_API_KEY` | Optional DeepSeek tier-3 fallback API key | *(empty)* |
| `DEEPSEEK_MODEL` | Optional DeepSeek model | `deepseek-chat` |
| `DATABASE_URL` | SQLite or PostgreSQL DSN | `sqlite:///data/frontier_atlas.db` |
| `GITHUB_TOKEN` | Optional GitHub PAT for higher API rate limits | *(empty)* |
| `GOOGLE_SHEETS_CREDENTIALS_JSON` | Inline or base64 Google Service Account JSON (alternative to path) | *(empty)* |
| `GOOGLE_SHEETS_CREDENTIALS_PATH` | Path to Google Service Account JSON | *(empty)* |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | Existing Google Sheet ID (blank creates new) | *(empty)* |
| `GOOGLE_SHEETS_SPREADSHEET_NAME` | Workbook title when creating new sheet | `FrontierAtlas Intelligence` |
| `MAX_CONCURRENCY` | Max concurrent HTTP requests | `8` |
| `RATE_LIMIT_PER_SECOND` | Per-domain request cap | `4.0` |
| `FRESHNESS_WINDOW_HOURS` | UTC lookback window for Jobs and News | `24` |
| `ENABLE_LIVE_TESTS` | Enable live network tests (`true`/`false`) | `false` |

---

## API Setup

1. **Gemini / Groq / DeepSeek APIs**: Set `GEMINI_API_KEY` (primary), and optionally `GROQ_API_KEY` + `DEEPSEEK_API_KEY` for multi-tier fallback (`Gemini -> Groq -> DeepSeek`).
2. **GitHub API (Optional)**: Create a read-only personal access token (`public_repo` not required for public read) and set `GITHUB_TOKEN` to raise the unauthenticated 60 req/hr limit to 5,000 req/hr when enriching research paper star counts/metrics and product repos.
3. **Public Structured APIs & Feeds**: Collects from YC OSS, Hugging Face Spaces & Daily Papers, arXiv, OpenAlex, Crossref, WeWorkRemotely, Jobicy, Arbeitnow, Greenhouse/Ashby/Lever ATS boards, Himalayas, Remotive, RemoteOK, 12+ AI RSS/Atom feeds, and HN Algolia while honoring `robots.txt` and rate limits.

---

## Running Instructions

Run the web dashboard + Node.js backend from the repository root:

```bash
npm install
npm run dev
```

Or run the Python CLI inside `frontier-atlas/`:

```bash
python -m src.pipeline.orchestrator --categories all --limit 25 --export-csv
```

Run larger collection toward 1,000+ startups, products, and papers (plus Google Sheets export once configured):

```bash
python -m src.pipeline.orchestrator --categories startups products research_papers --limit 1000 --export-csv --export-sheets
```

Run only 24-hour fresh Jobs and News sweeps:

```bash
python -m src.pipeline.orchestrator --categories jobs news --limit 200 --export-csv
```

Outputs generated locally:
- SQLite database: `data/frontier_atlas.db`
- Quality audit report: `data/quality_report.json`
- CSV exports: `data/exports/{startups,products,research_papers,jobs,news,entity_mapping_log}.csv`

---

## Testing Instructions

All standard unit and mocked end-to-end tests run offline without consuming paid LLM quota:

```bash
pytest -v
```

To run the opt-in live public API integration test (`@pytest.mark.live`):

```bash
ENABLE_LIVE_TESTS=true pytest -m live -v
```

---

## Google Sheets Setup

1. Create a Google Cloud Project and enable the **Google Sheets API** (and optionally **Google Drive API**).
2. Create a **Service Account** and download its JSON key file (store outside git, e.g., `./secrets/google-sa.json`).
3. Set `GOOGLE_SHEETS_CREDENTIALS_PATH=./secrets/google-sa.json` (or `GOOGLE_SHEETS_CREDENTIALS_JSON`) in `.env`.
4. Optional: Create a Google Spreadsheet manually, share it as **Editor** with the Service Account's `client_email`, and set `GOOGLE_SHEETS_SPREADSHEET_ID`. If left blank, FrontierAtlas creates a new workbook automatically.
5. Use **Export Google Sheets** (full export) or **Sync Google Sheets** (incremental sync via Column A stable-ID deduplication) in the dashboard, or `--export-sheets` in Python CLI.

Exported tabs match exact names:
`Startups`, `Products`, `Research Papers`, `Jobs`, `News`, `Entity Mapping Log`.

If credentials are missing or invalid, the exporter explicitly sets status to `Not Connected` or `Sync Failed` and surfaces the exact error without fabricating success; CSV export always remains available as a reliable fallback.

---

## Known Limitations

- **GitHub Unauthenticated Quota**: Without `GITHUB_TOKEN`, GitHub REST API limits requests to 60/hour; `ResearchCollector` detects HTTP `403`/`429` and leaves remaining `github_stars` as `null` rather than fabricating counts.
- **Anti-Bot / Auth-Gated Sites**: `AsyncCrawler` strictly respects `robots.txt` and never bypasses CAPTCHAs, logins, or `401`/`403` protections.
- **Optional LLM Fallback**: `groq` and `deepseek` fallbacks activate only if `GROQ_API_KEY` or `DEEPSEEK_API_KEY` is provided in the environment; unit tests verify routing behavior with mocked providers.
- **Target Volumes Require Explicit Runs**: The codebase ships without fabricated records; reaching 1,000+ rows in `startups`, `products`, and `research_papers` requires executing live collection runs against external networks.

---

## Scaling Strategy (500,000+ Records)

1. **Async Workers & Bounded Concurrency**: Partition collection into stateless async worker pools with per-domain semaphores and adaptive token-bucket rate limiters.
2. **Queue-Based Processing**: Decouple URL discovery, raw fetching, LLM extraction, and entity resolution via durable message queues (e.g., Redis Streams, Pub/Sub, or SQS) so slow LLM calls do not stall crawlers.
3. **Batch Database Writes**: Migrate `DATABASE_URL` to managed PostgreSQL (`psycopg` connection pools) and flush records in batched `INSERT ... ON CONFLICT DO UPDATE` transactions (500–2,000 rows/batch).
4. **Incremental Updates & Checkpointing**: Use `collection_checkpoints` cursors, `If-Modified-Since` / `ETag` headers, and date-bounded queries so hourly runs ingest deltas rather than re-crawling historical archives.
5. **Database Indexing**: Index `website`, `doi`, `arxiv_id`, `posted_at`, `published_at`, and `canonical_id`, adding trigram (`pg_trgm`) or vector indexes in PostgreSQL for sub-10ms entity candidate blocking.
6. **Idempotent Operations**: Deterministic SHA-256 primary keys (`make_stable_id`) and `UNIQUE` constraints make worker retries safe across crashes.
7. **Caching**: Cache `robots.txt` rules, domain-to-canonical-entity lookups, and GitHub star counts in Redis with TTLs.
8. **Retry & Dead-Letter Handling**: Route exhausted retries, `413` anomalies, and schema validation failures to `failure_logs` / DLQ topics for inspection and replay.
9. **Monitoring**: Export structured JSON logs (`StructuredFormatter`), track queue lag, 429 rates, LLM parse failure ratios, and per-run `QualityReport` drift metrics.
10. **Horizontal Scaling**: Run collectors and resolution workers as horizontally auto-scaled containers keyed by source partition.
11. **Cost & Token Optimization**: Prefer official structured APIs/JSON/RSS first; invoke Gemini (`gemini-4-hydrogen`) only for unstructured HTML pages, truncate boilerplate via `ContentExtractor`, and deduplicate URLs before calling the LLM.
