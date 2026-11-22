# FrontierAtlas

AI-powered data intelligence, structured extraction, conservative entity resolution, and Google Sheets synchronization pipeline running on **Node.js (Express + `node:sqlite`)** and **React + Vite**, alongside the companion Python 3.11+ package in `frontier-atlas/`.

FrontierAtlas collects, extracts, validates, deduplicates, resolves, verifies, persists, and exports six interconnected datasets:

1. **Startups** (`Startups` tab / `startups.csv`) — YC OSS directory & official sites (target: 1,000+ unique startups)
2. **Products** (`Products` tab / `products.csv`) — Hugging Face Spaces, GitHub repositories & Show HN (target: 1,000+ unique products)
3. **Research Papers** (`Research Papers` tab / `research_papers.csv`) — Hugging Face Daily Papers, arXiv, OpenAlex, Crossref + GitHub repository star & metric enrichment (target: 1,000+ unique papers)
4. **Jobs** (`Jobs` tab / `jobs.csv`) — Qualifying AI postings strictly within the last **24 hours UTC** across 9 job boards (WeWorkRemotely, Jobicy, Arbeitnow, Greenhouse boards, Ashby boards, Lever boards, Himalayas, Remotive, RemoteOK)
5. **News** (`News` tab / `news.csv`) — Qualifying AI articles strictly within the last **24 hours UTC** across 12+ RSS/Atom feeds & Hacker News Algolia
6. **Entity Mapping Log** (`Entity Mapping Log` tab / `entity_mapping_log.csv`) — Raw names, normalized names, canonical IDs, match methods, confidence scores, and merge decisions

---

## Architecture Overview

```
Live Public APIs, Feeds & Permitted Pages
                 │
                 ▼
   ┌─────────────────────────────┐
   │  PoliteHttpClient           │  robots.txt policy, per-domain rate limiter,
   │  & Concurrent Collectors    │  429 Retry-After backoff, 401/403/CAPTCHA guard
   └─────────────┬───────────────┘
                 │
                 ▼
   ┌─────────────────────────────┐
   │  LLMRouter (Multi-Tier)     │  Gemini -> Groq -> DeepSeek fallback chain,
   │  & Token-Aware Chunking     │  paragraph/overlap chunking + 413 sub-chunking
   └─────────────┬───────────────┘
                 │
                 ▼
   ┌─────────────────────────────┐
   │  UTC Freshness, Validation, │  Strict UTC timestamp parsing, SHA-256 IDs,
   │  Deduplication & Resolver   │  domain guards, live source verification
   └─────────────┬───────────────┘
                 │
                 ▼
   ┌─────────────────────────────┐
   │  SQLite (WAL) & CSV Writer  │  frontier-atlas/data/frontier_atlas.db
   │                             │  frontier-atlas/data/exports/*.csv
   └─────────────┬───────────────┘
                 │
                 ▼
   ┌─────────────────────────────┐
   │  GoogleSheetsService (v4)   │  RS256 Service Account JWT, 6 exact tabs,
   │  Full Export & Inc. Sync    │  stable-ID dedup, 500-row batching, Col A verify
   └─────────────────────────────┘
```

Key server modules in `src/server/`:
- `atlasDb.ts` — SQLite schema, transactional batch upserts, verification status aggregation, audit trail, failure logs, checkpoints, and `sheets_sync_state`.
- `httpClient.ts` — `RobotsPolicyManager`, `DomainRateLimiter`, and `PoliteHttpClient` with bounded retries, exponential backoff, `Retry-After` compliance, and non-bypass enforcement for HTTP `401`/`403`/`451` and CAPTCHA challenges.
- `llmRouter.ts` — `LLMRouter` orchestrating **Gemini** (`@google/genai`) -> **Groq** -> **DeepSeek**, token-aware overlap chunking, recursive half-size sub-chunking on `413` / context-limit errors, and evidence verification.
- `googleSheets.ts` — Google Sheets API v4 integration with Service Account JWT auth, quota retries (`429`/`5xx`), 6-tab creation & header formatting, paginated 500-row PUT batches, duplicate-free incremental sync via Column A stable IDs, read-back verification, and persistent connection status (`Connected`, `Not Connected`, `Sync Failed`).
- `atlasBackend.ts` — Collectors, UTC freshness enforcement, deterministic entity resolution (`EntityResolver`), `LiveSourceVerifier`, CSV export, and pipeline orchestration.

---

## Setup Instructions

### 1. Install Dependencies & Configure Environment

```bash
npm install
cp .env.example .env
```

Start the Express + Vite dashboard server on port `3000`:

```bash
npm run dev
```

Build for production:

```bash
npm run build
```

---

## Environment Variables

Set variables in `.env` (or `frontier-atlas/.env`; never commit credentials to git):

| Variable | Description | Default |
|---|---|---|
| `GOOGLE_SHEETS_CREDENTIALS_PATH` | Path to Google Service Account JSON file | *(empty)* |
| `GOOGLE_SHEETS_CREDENTIALS_JSON` | Inline JSON or base64-encoded Service Account JSON (alternative to file path) | *(empty)* |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | Existing Google Spreadsheet ID (leave blank to auto-create) | *(empty)* |
| `GOOGLE_SHEETS_SPREADSHEET_NAME` | Title used when creating a new spreadsheet | `FrontierAtlas Intelligence` |
| `GEMINI_API_KEY` | Primary LLM provider API key (`@google/genai`) | *(empty)* |
| `GEMINI_MODEL` | Gemini model ID | `gemini-2.5-flash` |
| `GROQ_API_KEY` | Tier-2 LLM fallback key (OpenAI-compatible) | *(empty)* |
| `GROQ_MODEL` | Groq model ID | `llama-3.3-70b-versatile` |
| `DEEPSEEK_API_KEY` | Tier-3 LLM fallback key (OpenAI-compatible) | *(empty)* |
| `DEEPSEEK_MODEL` | DeepSeek model ID | `deepseek-chat` |
| `GITHUB_TOKEN` | GitHub PAT raising REST rate limit from 60 to 5,000 req/hr | *(empty)* |
| `DATABASE_URL` | SQLite path (`sqlite:///data/frontier_atlas.db`) | `sqlite:///data/frontier_atlas.db` |
| `FRESHNESS_WINDOW_HOURS` | Strict UTC lookback window for Jobs and News | `24` |
| `MAX_CONCURRENCY` | Max concurrent requests (1–12) | `8` |
| `RATE_LIMIT_PER_SECOND` | Per-domain request rate cap | `4` |
| `REQUEST_TIMEOUT_SECONDS` | HTTP timeout in seconds | `20` |
| `RESPECT_ROBOTS_TXT` | Enforce `robots.txt` rules (`true`/`false`) | `true` |
| `USER_AGENT` | Polite HTTP `User-Agent` header | `FrontierAtlasBot/1.0 (+https://github.com/frontier-atlas)` |

---

## Google Sheets Configuration

FrontierAtlas supports **two** authentication methods for writing to Google Sheets:

### Option A — Interactive "Sign in with Google" (Browser OAuth)
1. Click **Sign in with Google** in the Overview dashboard's Google Sheets Sync panel (powered by `firebase-applet-config.json` with Drive & Sheets OAuth scopes).
2. Optionally paste an existing target Spreadsheet ID (or leave blank to auto-create `FrontierAtlas Intelligence` in your Google Drive).
3. Click **Export Google Sheets** (full export) or **Sync Google Sheets** (incremental sync) and confirm the target sheet details in the confirmation dialog. Your access token stays strictly in memory (never persisted to `localStorage`/`sessionStorage`).

### Option B — Backend Service Account (Automated / Headless)
1. In Google Cloud Console, enable the **Google Sheets API** (`sheets.googleapis.com`).
2. Create a **Service Account** and download a JSON private key.
3. Configure credentials strictly on the backend using **either**:
   - File path: `GOOGLE_SHEETS_CREDENTIALS_PATH=./secrets/google-service-account.json`
   - Inline env var: `GOOGLE_SHEETS_CREDENTIALS_JSON='{...}'` (raw JSON or base64)
4. Share your target Google Spreadsheet with the Service Account's `client_email` as **Editor** and set `GOOGLE_SHEETS_SPREADSHEET_ID=<spreadsheet_id>` (or leave `GOOGLE_SHEETS_SPREADSHEET_ID` blank so FrontierAtlas creates a new workbook via the Sheets API and persists its ID).

### Sheet Synchronization Behavior

- **Six Exact Tabs**: `Startups`, `Products`, `Research Papers`, `Jobs`, `News`, `Entity Mapping Log`.
- **Full Export (`POST /api/atlas/export/sheets` / "Export Google Sheets" button)**: Ensures all 6 tabs exist with styled frozen headers, clears data ranges cleanly, and writes database records in paginated 500-row batches, then verifies row counts by reading back Column A.
- **Incremental Sync (`POST /api/atlas/sync/sheets` / "Sync Google Sheets" button & auto-sync after runs)**: Reads existing Column A record IDs + row values from each tab, updates modified rows in place via `values:batchUpdate`, appends only unseen stable IDs (`startup_id`, `product_id`, `paper_id`, `job_id`, `news_id`, `mapping_id`), and repairs duplicate IDs if any existed on the sheet.
- **Connection Status (`Connected` / `Not Connected` / `Sync Failed`)**: Tracked in `sheets_sync_state` and displayed in the Overview dashboard along with last sync timestamp, sync delta (`+added / ~updated / =unchanged`), and per-tab exported row counts. Credentials remain strictly server-side and are never exposed to the browser.

---

## API Endpoints

- `GET /api/atlas/status` — Record counts, verification summary, credentials state, `sheetsStatus`, checkpoints, CSV export list, and active run status.
- `GET /api/atlas/datasets/:category?limit=500` — Paginated table rows (`startups`, `products`, `research_papers`, `jobs`, `news`, `entity_mapping_log`, `failure_logs`, `verification_audit_log`).
- `POST /api/atlas/run` — Starts async pipeline collection (`{ categories, limit, page }`), persists to SQLite + CSV, generates `data/quality_report.json`, and runs incremental Google Sheets sync when configured.
- `GET /api/atlas/run-status` — Live run logs and completion status.
- `POST /api/atlas/audit` — Re-verifies persisted records against live sources and removes duplicates.
- `POST /api/atlas/export/sheets` — Full 6-tab Google Sheets export.
- `POST /api/atlas/sync/sheets` — Duplicate-free incremental Google Sheets sync.
- `POST /api/atlas/sheets/verify` — Verifies live connectivity against Google Sheets.
- `POST /api/atlas/export/csv` & `GET /api/atlas/download/csv/:filename` — Deterministic 6-file CSV export and download.

---

## Companion Python CLI (`frontier-atlas/`)

The original Python 3.11+ package under `frontier-atlas/` also includes collectors, exporters, and pytest tests:

```bash
cd frontier-atlas
pytest -v
python -m src.pipeline.orchestrator --categories all --limit 25 --export-csv
```
