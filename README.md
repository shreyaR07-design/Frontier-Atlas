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
   │  SQLite (WAL) & CSV Writer  │  frontier-atlas/data/frontier_atlas_recovered.db
   │                             │  frontier-atlas/data/exports/*.csv
   └─────────────┬───────────────┘
                 │
                 ▼
   ┌─────────────────────────────┐
   │  GoogleSheetsService (v4)   │  OAuth Bearer / Service Account JWT, 6 tabs,
   │  Full Export & Inc. Sync    │  stable-ID dedup, batched writes, Col A verify
   └─────────────────────────────┘
```

Key server modules in `src/server/` (mirrored by Python modules in `frontier-atlas/src/` — `crawler/`, `llm/`, `resolver/`, `collectors/`, `exporters/`, `pipeline/`, `storage/`):
- `atlasDb.ts` — SQLite WAL-mode schema, transactional batch upserts, unique record queries, verification status aggregation, audit trail, failure logs, checkpoints, scheduler config, and `sheets_sync_state`.
- `httpClient.ts` — `RobotsPolicyManager`, `DomainRateLimiter`, and `PoliteHttpClient` with bounded retries, exponential backoff, `Retry-After` compliance, bounded crawl-delay budgets, and non-bypass enforcement for HTTP `401`/`403`/`451` and CAPTCHA challenges.
- `llmRouter.ts` — `LLMRouter` orchestrating **1. Gemini Flash** (`@google/genai`) -> **2. Groq** -> **3. Llama 3** -> **4. DeepSeek**, token-aware overlap chunking, recursive half-size sub-chunking on `413` / context-limit errors, 429 exponential backoff, evidence verification, and explicit `heuristic_demo_fallback` (`Unverified`) when zero LLM API keys are configured.
- `googleSheets.ts` — Google Sheets API v4 integration with dual auth (Workspace OAuth Bearer token or Service Account JWT), quota retries (`429`/`5xx`), 6-tab creation & header formatting, payload-bounded `values:batchUpdate` batches, duplicate-free incremental sync via Column A stable IDs, Column A read-back verification, per-tab status tracking, and persistent connection status (`Connected`, `Not Connected`, `Sync Failed`).
- `atlasBackend.ts` — Concurrent collectors, UTC & relative timestamp normalization (`parseUtcDatetimeWithMeta`), deterministic entity resolution (`EntityResolver`), `LiveSourceVerifier`, CSV export, daily scheduler, and pipeline orchestration.

For the full 3-page system diagram and architectural write-up (data flow, 4-tier LLM fallback, entity resolution, error handling, and scaling to 500,000+ records), see `architecture.pdf` (and `frontier-atlas/docs/architecture.pdf`).

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

Build and type-check for production:

```bash
npm run build
npm run lint
```

---

## Environment Variables

Set variables in `.env` (or `frontier-atlas/.env`; never commit credentials to git):

| Variable | Description | Default |
|---|---|---|
| `GOOGLE_SHEETS_CREDENTIALS_PATH` | Path to Google Service Account JSON file (also checks `GOOGLE_APPLICATION_CREDENTIALS`) | *(empty)* |
| `GOOGLE_SHEETS_CREDENTIALS_JSON` | Inline JSON or base64-encoded Service Account JSON (alternative to file path) | *(empty)* |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | Existing Google Spreadsheet ID (leave blank to auto-create) | *(empty)* |
| `GOOGLE_SHEETS_SPREADSHEET_NAME` | Title used when creating a new spreadsheet (also checks `GOOGLE_SHEETS_SPREADSHEET_TITLE`) | `FrontierAtlas Intelligence` |
| `GEMINI_API_KEY` | Tier-1 primary LLM API key (`@google/genai`, injected via AI Studio Secrets) | *(empty)* |
| `GEMINI_MODEL` | Gemini Flash model ID | `gemini-4-hydrogen` |
| `GROQ_API_KEY` | Tier-2 LLM fallback key (OpenAI-compatible) | *(empty)* |
| `GROQ_MODEL` | Groq model ID | `llama-3.3-70b-versatile` |
| `LLAMA3_API_KEY` | Tier-3 Llama 3 fallback key (OpenAI-compatible) | *(empty)* |
| `LLAMA3_MODEL` | Llama 3 model ID | `meta-llama/Llama-3.3-70B-Instruct` |
| `LLAMA3_ENDPOINT_URL` | Llama 3 chat completions endpoint URL | `https://api.together.xyz/v1/chat/completions` |
| `DEEPSEEK_API_KEY` | Tier-4 LLM fallback key (OpenAI-compatible) | *(empty)* |
| `DEEPSEEK_MODEL` | DeepSeek model ID | `deepseek-chat` |
| `GITHUB_TOKEN` | GitHub PAT raising REST rate limit from 60 to 5,000 req/hr | *(empty)* |
| `DATABASE_URL` | SQLite path (`sqlite:///data/frontier_atlas_recovered.db`) | `sqlite:///data/frontier_atlas_recovered.db` |
| `FRESHNESS_WINDOW_HOURS` | Strict UTC lookback window for Jobs and News | `24` |
| `MAX_CONCURRENCY` | Max concurrent requests (1–12) | `8` |
| `RATE_LIMIT_PER_SECOND` | Per-domain request rate cap | `4` |
| `REQUEST_TIMEOUT_SECONDS` | HTTP timeout in seconds | `20` |
| `RESPECT_ROBOTS_TXT` | Enforce `robots.txt` rules (`true`/`false`) | `true` |
| `USER_AGENT` | Polite HTTP `User-Agent` header | `FrontierAtlasBot/1.0 (+https://github.com/frontier-atlas)` |

---

## Google Sheets Configuration & Public Sharing

FrontierAtlas supports **two** authentication paths for writing to Google Sheets, plus an **automatic 6-CSV + ZIP fallback**:

### Option A — Backend Service Account (Recommended for Reliable Evaluator Links)
Because unverified Google OAuth apps return `Error 403: access_denied` to external Google accounts not added as OAuth Test Users, a **Google Cloud Service Account** is the most reliable server-side method:
1. In Google Cloud Console, enable **both** the **Google Sheets API** (`sheets.googleapis.com`) and the **Google Drive API** (`drive.googleapis.com`).
2. Create a **Service Account** and generate a JSON private key.
3. Provide the credentials **strictly on the backend** via environment variables (never in frontend code):
   - File path: `GOOGLE_SHEETS_CREDENTIALS_PATH=./secrets/google-service-account.json` (or `GOOGLE_APPLICATION_CREDENTIALS`)
   - Or inline JSON / base64: `GOOGLE_SHEETS_CREDENTIALS_JSON='{...}'`
4. Either leave `GOOGLE_SHEETS_SPREADSHEET_ID` blank (FrontierAtlas will create a new workbook) **or** share an existing spreadsheet with the Service Account's `client_email` as **Editor** and set `GOOGLE_SHEETS_SPREADSHEET_ID=<spreadsheet_id>`.
5. After exporting and verifying all 6 tabs, FrontierAtlas calls the Google Drive v3 Permissions API (`POST /drive/v3/files/{id}/permissions`) to grant `"Anyone with the link — Viewer"` (`type: "anyone"`, `role: "reader"`) and verifies the permission via a read-back `GET`. If a Google Workspace domain policy blocks public link sharing (`403`/`400`), the UI honestly reports `Restricted / Policy Blocked` without claiming public access.

### Option B — Interactive "Sign in with Google" (Browser OAuth)
1. Click **Sign in with Google** in the Overview dashboard's Google Sheets Sync panel (powered by `firebase-applet-config.json` with Drive & Sheets OAuth scopes).
2. Note: Until Google OAuth App Verification is completed in Google Cloud Console, only approved Test Users can complete popup sign-in; other users see `Error 403: access_denied`.
3. Your in-session access token remains strictly in memory and is passed via `Authorization: Bearer <token>` to the backend.

### Sheet Synchronization Behavior & Automatic CSV/ZIP Fallback

- **Six Exact Tabs**: `Startups`, `Products`, `Research Papers`, `Jobs`, `News`, `Entity Mapping Log`.
- **Qualified + 24h vs Full SQLite Export Scope**:
  - `qualified_24h` *(default)*: Excludes `Rejected` rows across datasets and restricts `Jobs` and `News` to qualifying records within the last `FRESHNESS_WINDOW_HOURS` (24h UTC), while preserving `Startups` (1,150+), `Products` (1,140+), and `Research Papers` (1,580+) above the 1,000-record threshold.
  - `all`: Exports the entire SQLite archive for every table.
- **Payload & Rate-Limit Resilience**: Writes are chunked into byte- and row-bounded `values:batchUpdate` batches with automatic recursive batch/range splitting on HTTP `413` and exponential backoff + `Retry-After` handling on HTTP `429`/`5xx`.
- **Full Export (`POST /api/atlas/export/sheets`)**: Ensures all 6 tabs exist with frozen bold headers, clears old ranges cleanly, writes batches, verifies Row 1 headers + Column A unique IDs on all 6 tabs, and configures/verifies public Viewer access.
- **Incremental Sync (`POST /api/atlas/sync/sheets`)**: Reads existing Column A record IDs + cells from each tab, updates modified rows in place, appends unseen stable IDs (`startup_id`, `product_id`, `paper_id`, `job_id`, `news_id`, `mapping_id`), repairs sheet duplicates if found, and reports `inserted / updated / skipped / failed` counts.
- **Automatic Fallback Export**: Whenever Google Sheets authentication or API sync fails, FrontierAtlas automatically builds all 6 CSV datasets + `frontier-atlas-datasets.zip` directly from SQLite and returns ready download links, explicitly labeled as a fallback (never a false Sheets success).

---

## API Endpoints

- `GET /api/atlas/status` — Total & unique qualified record counts, 1,000-record target checks, 24h freshness counts, verification summary, live integration health, `sheetsStatus`, scheduler state, CSV export list, and active run status.
- `GET /api/atlas/integrations/health?refresh=true|false` — Live startup & on-demand health probes for SQLite, LLM fallback tiers (`gemini`, `groq`, `llama3`, `deepseek`), GitHub REST API, and Google Sheets.
- `POST /api/atlas/integrations/test` — Runs live verification probes across configured integrations (accepts optional `Authorization: Bearer <oauthToken>` and `spreadsheetId`).
- `GET /api/atlas/datasets/:category?limit=500&offset=0&window=all|24h` — Paginated rows (`limit` up to `10000`) and metadata (`totalCount`, `truncated`, `window`) for `startups`, `products`, `research_papers`, `jobs`, `news`, `entity_mapping_log`, `failure_logs`, and `verification_audit_log`.
- `POST /api/atlas/run` — Starts async pipeline collection (`{ categories, limit, page, includeAllFresh24h }`), persists to SQLite + CSV, generates `data/quality_report.json`, and runs incremental Google Sheets sync when authorized.
- `POST /api/atlas/refresh-24h` — Launches a focused UTC 24-hour freshness refresh across `jobs`, `news`, and `research_papers` without overwriting historical records.
- `GET /api/atlas/run-status` — Live active run logs, progress, and completion status.
- `GET /api/atlas/runs` — Historical `pipeline_runs` log and active run status.
- `GET /api/atlas/scheduler` & `PUT /api/atlas/scheduler` — Reads or updates persisted daily UTC auto-refresh schedule (`{ enabled, utcTime }`).
- `GET /api/atlas/audit-trail?category=&recordId=&limit=100` — Queries `verification_audit_log` provenance entries.
- `POST /api/atlas/audit` — Re-verifies persisted records against live sources (supports `{ categories, offline, keepDuplicates }`).
- `POST /api/atlas/export/sheets` — Full 6-tab Google Sheets export (`401` when unauthenticated).
- `POST /api/atlas/sync/sheets` — Duplicate-free incremental Google Sheets sync (`401` when unauthenticated).
- `POST /api/atlas/sheets/verify` — Verifies live connectivity against Google Sheets (`401` when unauthenticated).
- `POST /api/atlas/export/csv` & `GET /api/atlas/download/csv/:filename` — Deterministic 6-file CSV export and allowlisted download.

---

## Testing Instructions

Run the Node.js/TypeScript backend & integration verification suite (covers 4-tier LLM fallback, 429 backoff, 413 sub-chunking, heuristic demo mode, UTC/relative date freshness, deterministic entity resolution, robots/anti-bot compliance, SQLite persistence, and 6-tab Google Sheets batching + Column A verification):

```bash
npm run test:ts
npm run lint
npm run build
```

Run the companion Python test suite (requires Python 3.11+ with `frontier-atlas/requirements.txt` installed):

```bash
cd frontier-atlas
pip install -r requirements.txt
pytest -v
python -m src.pipeline.orchestrator --categories all --limit 25 --export-csv
```

---

## Known Limitations

- **Live Google Sheets Write**: Interactive browser Google Sign-In or a backend Service Account (`GOOGLE_SHEETS_CREDENTIALS_PATH` / `GOOGLE_SHEETS_CREDENTIALS_JSON`) is required to authorize real writes against `sheets.googleapis.com`; without credentials, Sheets status accurately reports `Not Connected`.
- **LLM API Keys**: Without `GEMINI_API_KEY`, `GROQ_API_KEY`, `LLAMA3_API_KEY`, or `DEEPSEEK_API_KEY`, unstructured text extraction runs in explicit `heuristic_demo_fallback` mode and marks extracted rows `Unverified` (never fabricating live LLM responses).
- **External Rate Limits & Anti-Bot Rules**: Unauthenticated GitHub REST API lookups are capped at 60 req/hr without `GITHUB_TOKEN`; crawled HTML homepages returning `401`/`403`/`429`/CAPTCHA or disallowing paths in `robots.txt` are skipped and logged in `failure_logs` without bypassing access controls, while public JSON/RSS API feeds remain accessible directly.
- **Python Environment in Node Container**: The Node.js runtime container ships Python 3.11 stdlib without `pip` packages (`pytest`, `pydantic`, `reportlab`, `playwright`); install `frontier-atlas/requirements.txt` in a Python virtualenv to execute `pytest` and Playwright-rendered crawls.

