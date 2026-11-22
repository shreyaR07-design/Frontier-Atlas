import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const VERIFIED_DATASET_TABLES = [
  "startups",
  "products",
  "research_papers",
  "jobs",
  "news",
] as const;

export const ALLOWED_DATASET_TABLES = new Set([
  "startups",
  "products",
  "research_papers",
  "jobs",
  "news",
  "entity_mapping_log",
  "canonical_entities",
  "failure_logs",
  "verification_audit_log",
  "sheets_sync_state",
]);

export const VERIFICATION_STATUSES = [
  "Verified",
  "Partially Verified",
  "Unverified",
  "Source Unavailable",
  "Rejected",
] as const;

export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

const SCHEMA_DDL_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS canonical_entities (
    canonical_id TEXT PRIMARY KEY,
    canonical_name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    primary_domain TEXT,
    aliases_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_canonical_type_norm ON canonical_entities(entity_type, normalized_name);`,
  `CREATE TABLE IF NOT EXISTS startups (
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
  );`,
  `CREATE INDEX IF NOT EXISTS idx_startups_website ON startups(website);`,
  `CREATE INDEX IF NOT EXISTS idx_startups_collected ON startups(collected_at);`,
  `CREATE TABLE IF NOT EXISTS products (
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
  );`,
  `CREATE INDEX IF NOT EXISTS idx_products_website ON products(website);`,
  `CREATE TABLE IF NOT EXISTS research_papers (
    paper_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    abstract TEXT,
    authors_json TEXT NOT NULL DEFAULT '[]',
    publication_date TEXT,
    published_at TEXT,
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
  );`,
  `CREATE INDEX IF NOT EXISTS idx_papers_doi ON research_papers(doi);`,
  `CREATE INDEX IF NOT EXISTS idx_papers_arxiv ON research_papers(arxiv_id);`,
  `CREATE TABLE IF NOT EXISTS jobs (
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
  );`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_posted_at ON jobs(posted_at);`,
  `CREATE TABLE IF NOT EXISTS news (
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
  );`,
  `CREATE INDEX IF NOT EXISTS idx_news_published_at ON news(published_at);`,
  `CREATE TABLE IF NOT EXISTS entity_mapping_log (
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
  );`,
  `CREATE INDEX IF NOT EXISTS idx_entity_mapping_canonical ON entity_mapping_log(canonical_id);`,
  `CREATE TABLE IF NOT EXISTS failure_logs (
    failure_id TEXT PRIMARY KEY,
    stage TEXT NOT NULL,
    category TEXT NOT NULL,
    source_url TEXT,
    reason TEXT NOT NULL,
    payload_json TEXT,
    created_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS collection_checkpoints (
    source_key TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    last_cursor TEXT,
    last_collected_at TEXT NOT NULL,
    records_count INTEGER NOT NULL DEFAULT 0
  );`,
  `CREATE TABLE IF NOT EXISTS verification_audit_log (
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
  );`,
  `CREATE INDEX IF NOT EXISTS idx_audit_category_record ON verification_audit_log(category, record_id);`,
  `CREATE INDEX IF NOT EXISTS idx_audit_checked_at ON verification_audit_log(checked_at);`,
  `CREATE TABLE IF NOT EXISTS sheets_sync_state (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'Not Connected',
    spreadsheet_id TEXT,
    spreadsheet_url TEXT,
    last_sync_mode TEXT,
    last_attempt_at TEXT,
    last_success_at TEXT,
    tab_row_counts_json TEXT NOT NULL DEFAULT '{}',
    tab_statuses_json TEXT NOT NULL DEFAULT '{}',
    rows_added INTEGER NOT NULL DEFAULT 0,
    rows_updated INTEGER NOT NULL DEFAULT 0,
    rows_unchanged INTEGER NOT NULL DEFAULT 0,
    rows_skipped INTEGER NOT NULL DEFAULT 0,
    rows_failed INTEGER NOT NULL DEFAULT 0,
    public_access_status TEXT NOT NULL DEFAULT 'unknown',
    public_viewer_verified INTEGER NOT NULL DEFAULT 0,
    public_access_error TEXT,
    last_error TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS pipeline_runs (
    run_id TEXT PRIMARY KEY,
    trigger_type TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'full',
    categories_json TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    status TEXT NOT NULL,
    historical_counts_json TEXT NOT NULL DEFAULT '{}',
    new_records_counts_json TEXT NOT NULL DEFAULT '{}',
    fresh_24h_counts_json TEXT NOT NULL DEFAULT '{}',
    errors_json TEXT NOT NULL DEFAULT '[]',
    source_outcomes_json TEXT NOT NULL DEFAULT '[]',
    summary TEXT
  );`,
  `CREATE INDEX IF NOT EXISTS idx_pipeline_runs_started ON pipeline_runs(started_at DESC);`,
  `CREATE TABLE IF NOT EXISTS scheduler_state (
    id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    utc_time TEXT NOT NULL DEFAULT '02:00',
    last_run_at TEXT,
    last_success_at TEXT,
    next_run_at TEXT,
    updated_at TEXT NOT NULL
  );`,
];

const TRACEABILITY_COLUMNS: Array<[string, string]> = [
  ["official_website", "TEXT"],
  ["source_title", "TEXT"],
  ["last_checked_at", "TEXT"],
  ["supported_fields_json", "TEXT NOT NULL DEFAULT '[]'"],
  ["verification_status", "TEXT NOT NULL DEFAULT 'Unverified'"],
  ["rejection_reason", "TEXT"],
];

export interface StartupInput {
  startup_id: string;
  name: string;
  description: string | null;
  website: string | null;
  official_website: string | null;
  industry: string;
  location: string;
  founding_date: string | null;
  source_name: string;
  source_url: string;
  source_title: string | null;
  collected_at: string;
  last_checked_at: string | null;
  supported_fields: string[];
  verification_status: VerificationStatus;
  rejection_reason: string | null;
  canonical_entity_id: string | null;
  source_metadata: Record<string, unknown>;
}

export interface ProductInput {
  product_id: string;
  name: string;
  description: string | null;
  website: string | null;
  official_website: string | null;
  category: string;
  company_name: string;
  source_name: string;
  source_url: string;
  source_title: string | null;
  collected_at: string;
  last_checked_at: string | null;
  supported_fields: string[];
  verification_status: VerificationStatus;
  rejection_reason: string | null;
  canonical_entity_id: string | null;
  source_metadata: Record<string, unknown>;
}

export interface ResearchPaperInput {
  paper_id: string;
  title: string;
  abstract: string | null;
  authors: string[];
  publication_date: string | null;
  published_at?: string | null;
  doi: string | null;
  arxiv_id: string | null;
  github_repository: string | null;
  github_stars: number | null;
  official_website: string | null;
  source_name: string;
  source_url: string;
  source_title: string | null;
  collected_at: string;
  last_checked_at: string | null;
  supported_fields: string[];
  verification_status: VerificationStatus;
  rejection_reason: string | null;
  source_metadata: Record<string, unknown>;
}

export interface SourceOutcomeRecord {
  category: string;
  source: string;
  url: string;
  status: "ok" | "empty" | "failed";
  discoveredCount: number;
  freshCount?: number;
  retried: boolean;
  attempts: number;
  httpStatus?: number | null;
  error: string | null;
}

export interface PipelineRunRecord {
  run_id: string;
  trigger_type: "manual" | "scheduled" | "daily_24h";
  mode: "full" | "daily_24h";
  categories: string[];
  started_at: string;
  completed_at: string | null;
  status: "running" | "completed" | "partial" | "failed";
  historical_counts: Record<string, number>;
  new_records_counts: Record<string, number>;
  fresh_24h_counts: Record<string, number>;
  errors: Array<Record<string, unknown>>;
  source_outcomes: SourceOutcomeRecord[];
  summary: string | null;
}

export interface SchedulerStateRecord {
  enabled: boolean;
  utc_time: string;
  last_run_at: string | null;
  last_success_at: string | null;
  next_run_at: string | null;
  updated_at: string;
}

export interface JobInput {
  job_id: string;
  title: string;
  company: string;
  location: string;
  employment_type: string;
  description: string | null;
  posted_at: string;
  application_url: string;
  official_website: string | null;
  source_name: string;
  source_url: string;
  source_title: string | null;
  collected_at: string;
  last_checked_at: string | null;
  supported_fields: string[];
  verification_status: VerificationStatus;
  rejection_reason: string | null;
  canonical_company_id: string | null;
  source_metadata: Record<string, unknown>;
}

export interface NewsInput {
  news_id: string;
  headline: string;
  summary: string | null;
  publisher: string;
  published_at: string;
  article_url: string;
  official_website: string | null;
  category: string;
  source_name: string | null;
  source_url: string;
  source_title: string | null;
  collected_at: string;
  last_checked_at: string | null;
  supported_fields: string[];
  verification_status: VerificationStatus;
  rejection_reason: string | null;
  source_metadata: Record<string, unknown>;
}

export interface CanonicalEntityRow {
  canonical_id: string;
  canonical_name: string;
  normalized_name: string;
  entity_type: string;
  primary_domain: string | null;
  aliases_json: string;
  created_at: string;
}

export interface EntityMappingLogInput {
  mapping_id: string;
  raw_name: string;
  normalized_name: string;
  canonical_name: string;
  canonical_id: string;
  source_url: string;
  match_method: string;
  confidence: number;
  decision: string;
  timestamp: string;
  entity_type: string;
  match_reason: string | null;
}

export interface AuditEntryInput {
  audit_id?: string;
  category: string;
  record_id: string;
  record_name: string;
  previous_status: string | null;
  new_status: string;
  issues: string[];
  source_url: string | null;
  source_title: string | null;
  evidence_excerpt: string | null;
  reason: string;
  checked_at?: string;
}

export interface TabExportStatus {
  tabName: string;
  status: "success" | "failed";
  expectedRows: number;
  writtenRows: number;
  verifiedRows: number;
  error: string | null;
  message: string;
}

export function sha256Prefix(input: string, len = 16): string {
  return crypto.createHash("sha256").update(input, "utf-8").digest("hex").slice(0, len);
}

export class AtlasDatabase {
  public readonly dbPath: string;
  private db: DatabaseSync | null = null;
  private initialized = false;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  private getConnection(): DatabaseSync {
    if (!this.db) {
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
      this.db = new DatabaseSync(this.dbPath);
      this.db.exec("PRAGMA foreign_keys = ON;");
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA busy_timeout = 5000;");
    }
    return this.db;
  }

  public initializeSchema(): void {
    if (this.initialized) return;
    const conn = this.getConnection();
    conn.exec("BEGIN");
    try {
      for (const stmt of SCHEMA_DDL_STATEMENTS) {
        conn.exec(stmt);
      }
      for (const table of VERIFIED_DATASET_TABLES) {
        const infoRows = conn.prepare(`PRAGMA table_info(${table});`).all() as Array<{ name: string }>;
        const existingCols = new Set(infoRows.map((r) => String(r.name)));
        for (const [colName, colDef] of TRACEABILITY_COLUMNS) {
          if (!existingCols.has(colName)) {
            conn.exec(`ALTER TABLE ${table} ADD COLUMN ${colName} ${colDef};`);
          }
        }
        conn.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_verification ON ${table}(verification_status);`);
      }
      // Migrate legacy canonical_entities table if it still has strict UNIQUE(entity_type, normalized_name)
      const ceMaster = conn
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'canonical_entities';")
        .get() as { sql?: string } | undefined;
      if (ceMaster?.sql && /UNIQUE\s*\(\s*entity_type\s*,\s*normalized_name\s*\)/i.test(ceMaster.sql)) {
        conn.exec(`
          CREATE TABLE canonical_entities_migrated (
            canonical_id TEXT PRIMARY KEY,
            canonical_name TEXT NOT NULL,
            normalized_name TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            primary_domain TEXT,
            aliases_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL
          );
          INSERT OR IGNORE INTO canonical_entities_migrated
            SELECT canonical_id, canonical_name, normalized_name, entity_type, primary_domain, aliases_json, created_at
            FROM canonical_entities;
          DROP TABLE canonical_entities;
          ALTER TABLE canonical_entities_migrated RENAME TO canonical_entities;
          CREATE INDEX IF NOT EXISTS idx_canonical_type_norm ON canonical_entities(entity_type, normalized_name);
        `);
      }

      const sheetsInfoRows = conn.prepare("PRAGMA table_info(sheets_sync_state);").all() as Array<{ name: string }>;
      const sheetsCols = new Set(sheetsInfoRows.map((r) => String(r.name)));
      if (!sheetsCols.has("tab_statuses_json")) {
        conn.exec("ALTER TABLE sheets_sync_state ADD COLUMN tab_statuses_json TEXT NOT NULL DEFAULT '{}';");
      }
      if (!sheetsCols.has("rows_skipped")) {
        conn.exec("ALTER TABLE sheets_sync_state ADD COLUMN rows_skipped INTEGER NOT NULL DEFAULT 0;");
      }
      if (!sheetsCols.has("rows_failed")) {
        conn.exec("ALTER TABLE sheets_sync_state ADD COLUMN rows_failed INTEGER NOT NULL DEFAULT 0;");
      }
      if (!sheetsCols.has("public_access_status")) {
        conn.exec("ALTER TABLE sheets_sync_state ADD COLUMN public_access_status TEXT NOT NULL DEFAULT 'unknown';");
      }
      if (!sheetsCols.has("public_viewer_verified")) {
        conn.exec("ALTER TABLE sheets_sync_state ADD COLUMN public_viewer_verified INTEGER NOT NULL DEFAULT 0;");
      }
      if (!sheetsCols.has("public_access_error")) {
        conn.exec("ALTER TABLE sheets_sync_state ADD COLUMN public_access_error TEXT;");
      }

      const paperInfoRows = conn.prepare("PRAGMA table_info(research_papers);").all() as Array<{ name: string }>;
      const paperCols = new Set(paperInfoRows.map((r) => String(r.name)));
      if (!paperCols.has("published_at")) {
        conn.exec("ALTER TABLE research_papers ADD COLUMN published_at TEXT;");
      }
      conn.exec("CREATE INDEX IF NOT EXISTS idx_papers_published_at ON research_papers(published_at);");

      const runInfoRows = conn.prepare("PRAGMA table_info(pipeline_runs);").all() as Array<{ name: string }>;
      const runCols = new Set(runInfoRows.map((r) => String(r.name)));
      if (!runCols.has("new_records_counts_json")) {
        conn.exec("ALTER TABLE pipeline_runs ADD COLUMN new_records_counts_json TEXT NOT NULL DEFAULT '{}';");
      }

      conn.exec("COMMIT");
      this.initialized = true;
    } catch (err) {
      conn.exec("ROLLBACK");
      throw err;
    }
  }

  public checkpointWal(mode: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE" = "PASSIVE"): void {
    if (!this.db) return;
    try {
      this.db.exec(`PRAGMA wal_checkpoint(${mode});`);
    } catch {
      // Ignore busy WAL checkpoint error if concurrent reader holds lock
    }
  }

  public close(): void {
    if (!this.db) return;
    try {
      this.checkpointWal("TRUNCATE");
      this.db.close();
    } finally {
      this.db = null;
      this.initialized = false;
    }
  }

  public checkHealth(): {
    ok: boolean;
    integrityCheck: string;
    tableCounts: Record<string, number>;
    journalMode: string;
    error: string | null;
  } {
    try {
      this.initializeSchema();
      const conn = this.getConnection();
      const icRows = conn.prepare("PRAGMA integrity_check;").all() as Array<Record<string, unknown>>;
      const icMessages = icRows
        .map((r) => String(Object.values(r)[0] ?? "").trim())
        .filter(Boolean);
      const icText = icMessages.join("; ") || "unknown";
      const icOk = icMessages.length === 1 && icMessages[0].toLowerCase() === "ok";
      const jmRow = conn.prepare("PRAGMA journal_mode;").get() as { journal_mode?: string } | undefined;
      if (!icOk) {
        return {
          ok: false,
          integrityCheck: icText,
          tableCounts: {},
          journalMode: String(jmRow?.journal_mode ?? "unknown"),
          error: `SQLite PRAGMA integrity_check failed: ${icText}`,
        };
      }
      const tableCounts = this.countRecords();
      return {
        ok: true,
        integrityCheck: "ok",
        tableCounts,
        journalMode: String(jmRow?.journal_mode ?? "unknown"),
        error: null,
      };
    } catch (err) {
      return {
        ok: false,
        integrityCheck: "error",
        tableCounts: {},
        journalMode: "unknown",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  public fetchAll(sql: string, ...params: Array<string | number | null>): Array<Record<string, unknown>> {
    this.initializeSchema();
    const conn = this.getConnection();
    const rows = conn.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ ...row }));
  }

  private parseRowTimestampMs(row: Record<string, unknown>, tableName: string): number | null {
    let raw: unknown = null;
    if (tableName === "jobs") {
      raw = row.posted_at;
    } else if (tableName === "news") {
      raw = row.published_at;
    } else if (tableName === "research_papers") {
      raw = row.published_at;
    }
    if (typeof raw !== "string" || !raw.trim()) return null;
    const s = raw.trim();
    const normalized = /^\d{4}-\d{2}-\d{2}$/.test(s)
      ? `${s}T00:00:00.000Z`
      : /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(s)
      ? `${s.replace(" ", "T")}Z`
      : s;
    const ms = Date.parse(normalized);
    return Number.isFinite(ms) ? ms : null;
  }

  public fetchDataset(tableName: string, limit?: number): Array<Record<string, unknown>> {
    if (!ALLOWED_DATASET_TABLES.has(tableName)) {
      throw new Error(`Unsupported dataset table: ${tableName}`);
    }
    if (limit !== undefined) {
      return this.fetchAll(`SELECT * FROM ${tableName} ORDER BY rowid ASC LIMIT ?;`, limit);
    }
    return this.fetchAll(`SELECT * FROM ${tableName} ORDER BY rowid ASC;`);
  }

  public fetchCanonicalNameMap(): Map<string, string> {
    this.initializeSchema();
    const map = new Map<string, string>();
    const ceRows = this.fetchAll(
      "SELECT canonical_id, canonical_name FROM canonical_entities WHERE canonical_id IS NOT NULL AND canonical_name IS NOT NULL;"
    );
    for (const r of ceRows) {
      const id = String(r.canonical_id ?? "").trim();
      const name = String(r.canonical_name ?? "").trim();
      if (id && name && !map.has(id)) {
        map.set(id, name);
      }
    }
    const logRows = this.fetchAll(
      "SELECT canonical_id, canonical_name FROM entity_mapping_log WHERE canonical_id IS NOT NULL AND canonical_name IS NOT NULL;"
    );
    for (const r of logRows) {
      const id = String(r.canonical_id ?? "").trim();
      const name = String(r.canonical_name ?? "").trim();
      if (id && name && !map.has(id)) {
        map.set(id, name);
      }
    }
    return map;
  }

  public fetchDatasetWindow(
    tableName: string,
    opts?: { limit?: number; offset?: number; windowHours?: number | null; refNow?: Date }
  ): Array<Record<string, unknown>> {
    if (!ALLOWED_DATASET_TABLES.has(tableName)) {
      throw new Error(`Unsupported dataset table: ${tableName}`);
    }
    const offset = Math.max(0, opts?.offset ?? 0);
    const windowHours = opts?.windowHours ?? null;
    if (
      !windowHours ||
      (tableName !== "jobs" && tableName !== "news" && tableName !== "research_papers")
    ) {
      if (offset === 0) {
        return this.fetchDataset(tableName, opts?.limit);
      }
      const limitSql = opts?.limit !== undefined ? `LIMIT ? OFFSET ?` : `LIMIT -1 OFFSET ?`;
      const params = opts?.limit !== undefined ? [opts.limit, offset] : [offset];
      return this.fetchAll(`SELECT * FROM ${tableName} ORDER BY rowid ASC ${limitSql};`, ...params);
    }
    const refMs = (opts?.refNow ?? new Date()).getTime();
    const minMs = refMs - windowHours * 3600_000;
    const maxMs = refMs + 5 * 60_000;
    const orderSql =
      tableName === "jobs"
        ? "ORDER BY posted_at DESC, rowid DESC"
        : tableName === "news"
        ? "ORDER BY published_at DESC, rowid DESC"
        : "ORDER BY COALESCE(published_at, publication_date) DESC, rowid DESC";
    const allRows = this.fetchAll(`SELECT * FROM ${tableName} ${orderSql};`);
    const filtered: Array<Record<string, unknown>> = [];
    let skipped = 0;
    for (const row of allRows) {
      const ts = this.parseRowTimestampMs(row, tableName);
      if (ts !== null && ts >= minMs && ts <= maxMs) {
        if (skipped < offset) {
          skipped++;
          continue;
        }
        filtered.push(row);
        if (opts?.limit !== undefined && filtered.length >= opts.limit) break;
      }
    }
    return filtered;
  }

  public countDatasetWindow(
    tableName: string,
    opts?: { windowHours?: number | null; refNow?: Date }
  ): number {
    if (!ALLOWED_DATASET_TABLES.has(tableName)) {
      throw new Error(`Unsupported dataset table: ${tableName}`);
    }
    this.initializeSchema();
    const windowHours = opts?.windowHours ?? null;
    if (
      !windowHours ||
      (tableName !== "jobs" && tableName !== "news" && tableName !== "research_papers")
    ) {
      const rows = this.fetchAll(`SELECT COUNT(*) AS cnt FROM ${tableName};`);
      return Number(rows[0]?.cnt ?? 0);
    }
    const refMs = (opts?.refNow ?? new Date()).getTime();
    const minMs = refMs - windowHours * 3600_000;
    const maxMs = refMs + 5 * 60_000;
    const col = tableName === "jobs" ? "posted_at" : "published_at";
    const rows = this.fetchAll(`SELECT ${col} FROM ${tableName};`);
    let cnt = 0;
    for (const r of rows) {
      const ts = this.parseRowTimestampMs(r, tableName);
      if (ts !== null && ts >= minMs && ts <= maxMs) cnt++;
    }
    return cnt;
  }

  public countFresh24h(
    windowHours = 24,
    refNow: Date = new Date()
  ): { jobs: number; news: number; research_papers: number } {
    this.initializeSchema();
    const refMs = refNow.getTime();
    const minMs = refMs - windowHours * 3600_000;
    const maxMs = refMs + 5 * 60_000;

    const countTable = (table: "jobs" | "news" | "research_papers", cols: string): number => {
      const rows = this.fetchAll(`SELECT ${cols} FROM ${table};`);
      let cnt = 0;
      for (const r of rows) {
        const ts = this.parseRowTimestampMs(r, table);
        if (ts !== null && ts >= minMs && ts <= maxMs) cnt++;
      }
      return cnt;
    };

    return {
      jobs: countTable("jobs", "posted_at"),
      news: countTable("news", "published_at"),
      research_papers: countTable("research_papers", "published_at"),
    };
  }

  public countUniqueQualifiedRecords(): {
    startups: number;
    products: number;
    research_papers: number;
  } {
    this.initializeSchema();
    const startupsRows = this.fetchAll(
      `SELECT COUNT(DISTINCT COALESCE(NULLIF(TRIM(canonical_entity_id), ''), LOWER(TRIM(name)) || '|' || LOWER(TRIM(COALESCE(NULLIF(website, ''), source_url))))) AS cnt
       FROM startups
       WHERE verification_status != 'Rejected' AND TRIM(name) != '';`
    );
    const productsRows = this.fetchAll(
      `SELECT COUNT(DISTINCT COALESCE(NULLIF(TRIM(canonical_entity_id), ''), LOWER(TRIM(name)) || '|' || LOWER(TRIM(COALESCE(NULLIF(website, ''), source_url))))) AS cnt
       FROM products
       WHERE verification_status != 'Rejected' AND TRIM(name) != '';`
    );
    const papersRows = this.fetchAll(
      `SELECT COUNT(DISTINCT COALESCE(NULLIF(LOWER(TRIM(doi)), ''), NULLIF(LOWER(TRIM(arxiv_id)), ''), LOWER(TRIM(source_url)), LOWER(TRIM(title)))) AS cnt
       FROM research_papers
       WHERE verification_status != 'Rejected' AND TRIM(title) != '';`
    );
    return {
      startups: Number(startupsRows[0]?.cnt ?? 0),
      products: Number(productsRows[0]?.cnt ?? 0),
      research_papers: Number(papersRows[0]?.cnt ?? 0),
    };
  }

  public countRecords(): Record<string, number> {
    this.initializeSchema();
    const tables = [
      "startups",
      "products",
      "research_papers",
      "jobs",
      "news",
      "entity_mapping_log",
    ];
    const counts: Record<string, number> = {};
    for (const t of tables) {
      const rows = this.fetchAll(`SELECT COUNT(*) AS cnt FROM ${t};`);
      counts[t] = Number(rows[0]?.cnt ?? 0);
    }
    return counts;
  }

  public getFailureCount(): number {
    const rows = this.fetchAll("SELECT COUNT(*) AS cnt FROM failure_logs;");
    return Number(rows[0]?.cnt ?? 0);
  }

  public getVerificationCounts(): {
    totals: Record<VerificationStatus, number>;
    byCategory: Record<string, Record<VerificationStatus, number>>;
  } {
    this.initializeSchema();
    const emptyCounts = (): Record<VerificationStatus, number> => ({
      Verified: 0,
      "Partially Verified": 0,
      Unverified: 0,
      "Source Unavailable": 0,
      Rejected: 0,
    });

    const totals = emptyCounts();
    const byCategory: Record<string, Record<VerificationStatus, number>> = {};

    for (const table of VERIFIED_DATASET_TABLES) {
      const catCounts = emptyCounts();
      const rows = this.fetchAll(
        `SELECT verification_status, COUNT(*) AS cnt FROM ${table} GROUP BY verification_status;`
      );
      for (const row of rows) {
        const rawStatus = String(row.verification_status ?? "Unverified");
        const st: VerificationStatus = (VERIFICATION_STATUSES as readonly string[]).includes(rawStatus)
          ? (rawStatus as VerificationStatus)
          : "Unverified";
        const cnt = Number(row.cnt ?? 0);
        catCounts[st] += cnt;
        totals[st] += cnt;
      }

      const rejRows = this.fetchAll(
        "SELECT COUNT(*) AS cnt FROM failure_logs WHERE category = ?;",
        table
      );
      const rejCnt = Number(rejRows[0]?.cnt ?? 0);
      catCounts.Rejected += rejCnt;
      totals.Rejected += rejCnt;
      byCategory[table] = catCounts;
    }

    return { totals, byCategory };
  }

  public fetchCheckpoints(): Array<Record<string, unknown>> {
    return this.fetchAll("SELECT * FROM collection_checkpoints ORDER BY last_collected_at DESC;");
  }

  public fetchAuditTrail(opts: {
    category?: string | null;
    recordId?: string | null;
    limit?: number;
  }): Array<Record<string, unknown>> {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (opts.category) {
      clauses.push("category = ?");
      params.push(opts.category);
    }
    if (opts.recordId) {
      clauses.push("record_id = ?");
      params.push(opts.recordId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = opts.limit ?? 100;
    params.push(limit);
    return this.fetchAll(
      `SELECT * FROM verification_audit_log ${where} ORDER BY checked_at DESC LIMIT ?;`,
      ...params
    );
  }

  public upsertStartups(records: StartupInput[]): number {
    if (records.length === 0) return 0;
    this.initializeSchema();
    const conn = this.getConnection();
    const existingRows = conn.prepare("SELECT startup_id, name, source_url FROM startups;").all() as Array<{
      startup_id: string;
      name: string;
      source_url: string;
    }>;
    const existingByKey = new Map<string, string>();
    for (const row of existingRows) {
      existingByKey.set(`${row.name}\u0000${row.source_url}`, String(row.startup_id));
    }

    const stmt = conn.prepare(`
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
    `);
    conn.exec("BEGIN");
    try {
      for (const r of records) {
        const key = `${r.name}\u0000${r.source_url}`;
        const sid = existingByKey.get(key) ?? r.startup_id;
        existingByKey.set(key, sid);
        stmt.run(
          sid,
          r.name,
          r.description ?? null,
          r.website ?? null,
          r.official_website ?? null,
          r.industry || "Unknown",
          r.location || "Unknown",
          r.founding_date ?? null,
          r.source_name,
          r.source_url,
          r.source_title ?? null,
          r.collected_at,
          r.last_checked_at ?? null,
          JSON.stringify(r.supported_fields ?? []),
          r.verification_status ?? "Unverified",
          r.rejection_reason ?? null,
          r.canonical_entity_id ?? null,
          JSON.stringify(r.source_metadata ?? {})
        );
      }
      conn.exec("COMMIT");
      return records.length;
    } catch (err) {
      conn.exec("ROLLBACK");
      throw err;
    }
  }

  public upsertProducts(records: ProductInput[]): number {
    if (records.length === 0) return 0;
    this.initializeSchema();
    const conn = this.getConnection();
    const existingRows = conn.prepare("SELECT product_id, name, source_url FROM products;").all() as Array<{
      product_id: string;
      name: string;
      source_url: string;
    }>;
    const existingByKey = new Map<string, string>();
    for (const row of existingRows) {
      existingByKey.set(`${row.name}\u0000${row.source_url}`, String(row.product_id));
    }

    const stmt = conn.prepare(`
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
    `);
    conn.exec("BEGIN");
    try {
      for (const r of records) {
        const key = `${r.name}\u0000${r.source_url}`;
        const pid = existingByKey.get(key) ?? r.product_id;
        existingByKey.set(key, pid);
        stmt.run(
          pid,
          r.name,
          r.description ?? null,
          r.website ?? null,
          r.official_website ?? null,
          r.category || "Unknown",
          r.company_name || "Unknown",
          r.source_name,
          r.source_url,
          r.source_title ?? null,
          r.collected_at,
          r.last_checked_at ?? null,
          JSON.stringify(r.supported_fields ?? []),
          r.verification_status ?? "Unverified",
          r.rejection_reason ?? null,
          r.canonical_entity_id ?? null,
          JSON.stringify(r.source_metadata ?? {})
        );
      }
      conn.exec("COMMIT");
      return records.length;
    } catch (err) {
      conn.exec("ROLLBACK");
      throw err;
    }
  }

  public upsertResearchPapers(records: ResearchPaperInput[]): number {
    if (records.length === 0) return 0;
    this.initializeSchema();
    const conn = this.getConnection();
    const existingRows = conn.prepare("SELECT paper_id, source_url FROM research_papers").all() as Array<{
      paper_id: string;
      source_url: string;
    }>;
    const existingByUrl = new Map<string, string>();
    for (const row of existingRows) {
      existingByUrl.set(String(row.source_url), String(row.paper_id));
    }

    const stmt = conn.prepare(`
      INSERT INTO research_papers (
        paper_id, title, abstract, authors_json, publication_date, published_at,
        doi, arxiv_id, github_repository, github_stars, official_website,
        source_name, source_url, source_title, collected_at, last_checked_at,
        supported_fields_json, verification_status, rejection_reason, source_metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(paper_id) DO UPDATE SET
        title = excluded.title,
        abstract = COALESCE(excluded.abstract, research_papers.abstract),
        authors_json = excluded.authors_json,
        publication_date = COALESCE(excluded.publication_date, research_papers.publication_date),
        published_at = COALESCE(excluded.published_at, research_papers.published_at),
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
    `);
    conn.exec("BEGIN");
    try {
      for (const r of records) {
        const pid = existingByUrl.get(r.source_url) ?? r.paper_id;
        existingByUrl.set(r.source_url, pid);
        stmt.run(
          pid,
          r.title,
          r.abstract ?? null,
          JSON.stringify(r.authors ?? []),
          r.publication_date ?? null,
          r.published_at ?? null,
          r.doi ?? null,
          r.arxiv_id ?? null,
          r.github_repository ?? null,
          r.github_stars ?? null,
          r.official_website ?? null,
          r.source_name,
          r.source_url,
          r.source_title ?? null,
          r.collected_at,
          r.last_checked_at ?? null,
          JSON.stringify(r.supported_fields ?? []),
          r.verification_status ?? "Unverified",
          r.rejection_reason ?? null,
          JSON.stringify(r.source_metadata ?? {})
        );
      }
      conn.exec("COMMIT");
      return records.length;
    } catch (err) {
      conn.exec("ROLLBACK");
      throw err;
    }
  }

  public upsertJobs(records: JobInput[]): number {
    if (records.length === 0) return 0;
    this.initializeSchema();
    const conn = this.getConnection();
    const existingRows = conn.prepare("SELECT job_id, application_url FROM jobs;").all() as Array<{
      job_id: string;
      application_url: string;
    }>;
    const existingByUrl = new Map<string, string>();
    for (const row of existingRows) {
      existingByUrl.set(String(row.application_url), String(row.job_id));
    }

    const stmt = conn.prepare(`
      INSERT INTO jobs (
        job_id, title, company, location, employment_type, description,
        posted_at, application_url, official_website, source_name, source_url,
        source_title, collected_at, last_checked_at, supported_fields_json,
        verification_status, rejection_reason, canonical_company_id, source_metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
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
    `);
    conn.exec("BEGIN");
    try {
      for (const r of records) {
        const jid = existingByUrl.get(r.application_url) ?? r.job_id;
        existingByUrl.set(r.application_url, jid);
        stmt.run(
          jid,
          r.title,
          r.company || "Unknown",
          r.location || "Unknown",
          r.employment_type || "Unknown",
          r.description ?? null,
          r.posted_at,
          r.application_url,
          r.official_website ?? null,
          r.source_name,
          r.source_url,
          r.source_title ?? null,
          r.collected_at,
          r.last_checked_at ?? null,
          JSON.stringify(r.supported_fields ?? []),
          r.verification_status ?? "Unverified",
          r.rejection_reason ?? null,
          r.canonical_company_id ?? null,
          JSON.stringify(r.source_metadata ?? {})
        );
      }
      conn.exec("COMMIT");
      return records.length;
    } catch (err) {
      conn.exec("ROLLBACK");
      throw err;
    }
  }

  public upsertNews(records: NewsInput[]): number {
    if (records.length === 0) return 0;
    this.initializeSchema();
    const conn = this.getConnection();
    const existingRows = conn.prepare("SELECT news_id, article_url FROM news;").all() as Array<{
      news_id: string;
      article_url: string;
    }>;
    const existingByUrl = new Map<string, string>();
    for (const row of existingRows) {
      existingByUrl.set(String(row.article_url), String(row.news_id));
    }

    const stmt = conn.prepare(`
      INSERT INTO news (
        news_id, headline, summary, publisher, published_at, article_url,
        official_website, category, source_name, source_url, source_title,
        collected_at, last_checked_at, supported_fields_json, verification_status,
        rejection_reason, source_metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(news_id) DO UPDATE SET
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
    `);
    conn.exec("BEGIN");
    try {
      for (const r of records) {
        const nid = existingByUrl.get(r.article_url) ?? r.news_id;
        existingByUrl.set(r.article_url, nid);
        stmt.run(
          nid,
          r.headline,
          r.summary ?? null,
          r.publisher || "Unknown",
          r.published_at,
          r.article_url,
          r.official_website ?? null,
          r.category || "ai_news",
          r.source_name ?? null,
          r.source_url,
          r.source_title ?? null,
          r.collected_at,
          r.last_checked_at ?? null,
          JSON.stringify(r.supported_fields ?? []),
          r.verification_status ?? "Unverified",
          r.rejection_reason ?? null,
          JSON.stringify(r.source_metadata ?? {})
        );
      }
      conn.exec("COMMIT");
      return records.length;
    } catch (err) {
      conn.exec("ROLLBACK");
      throw err;
    }
  }

  public upsertCanonicalEntities(entities: CanonicalEntityRow[]): number {
    if (entities.length === 0) return 0;
    this.initializeSchema();
    const conn = this.getConnection();
    const stmt = conn.prepare(`
      INSERT INTO canonical_entities (
        canonical_id, canonical_name, normalized_name, entity_type,
        primary_domain, aliases_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(canonical_id) DO UPDATE SET
        primary_domain = COALESCE(excluded.primary_domain, canonical_entities.primary_domain),
        aliases_json = excluded.aliases_json;
    `);
    conn.exec("BEGIN");
    try {
      for (const e of entities) {
        stmt.run(
          e.canonical_id,
          e.canonical_name,
          e.normalized_name,
          e.entity_type,
          e.primary_domain ?? null,
          e.aliases_json ?? "[]",
          e.created_at
        );
      }
      conn.exec("COMMIT");
      return entities.length;
    } catch (err) {
      conn.exec("ROLLBACK");
      throw err;
    }
  }

  public upsertEntityMappingLogs(logs: EntityMappingLogInput[]): number {
    if (logs.length === 0) return 0;
    this.initializeSchema();
    const conn = this.getConnection();
    const existingRows = conn
      .prepare("SELECT mapping_id, raw_name, canonical_id, source_url, match_method FROM entity_mapping_log;")
      .all() as Array<{
      mapping_id: string;
      raw_name: string;
      canonical_id: string;
      source_url: string;
      match_method: string;
    }>;
    const existingByComposite = new Map<string, string>();
    for (const row of existingRows) {
      existingByComposite.set(
        `${row.raw_name}\u0000${row.canonical_id}\u0000${row.source_url}\u0000${row.match_method}`,
        String(row.mapping_id)
      );
    }

    const stmt = conn.prepare(`
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
    `);
    conn.exec("BEGIN");
    try {
      for (const entry of logs) {
        const compKey = `${entry.raw_name}\u0000${entry.canonical_id}\u0000${entry.source_url}\u0000${entry.match_method}`;
        const mid = existingByComposite.get(compKey) ?? entry.mapping_id;
        existingByComposite.set(compKey, mid);
        stmt.run(
          mid,
          entry.raw_name,
          entry.normalized_name,
          entry.canonical_name,
          entry.canonical_id,
          entry.source_url,
          entry.match_method,
          entry.confidence,
          entry.decision,
          entry.timestamp,
          entry.entity_type,
          entry.match_reason
        );
      }
      conn.exec("COMMIT");
      return logs.length;
    } catch (err) {
      conn.exec("ROLLBACK");
      throw err;
    }
  }

  public recordFailure(opts: {
    stage: string;
    category: string;
    reason: string;
    sourceUrl?: string | null;
    payload?: unknown;
  }): void {
    this.initializeSchema();
    const conn = this.getConnection();
    const nowIso = new Date().toISOString();
    const digest = sha256Prefix(
      `${opts.stage}|${opts.category}|${opts.sourceUrl ?? ""}|${opts.reason}|${nowIso}`
    );
    conn
      .prepare(
        `INSERT INTO failure_logs (
          failure_id, stage, category, source_url, reason, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(failure_id) DO NOTHING;`
      )
      .run(
        `fail_${digest}`,
        opts.stage,
        opts.category,
        opts.sourceUrl ?? null,
        opts.reason.slice(0, 1000),
        JSON.stringify(opts.payload ?? {}),
        nowIso
      );
  }

  public recordAuditEntries(entries: AuditEntryInput[]): number {
    if (entries.length === 0) return 0;
    this.initializeSchema();
    const conn = this.getConnection();
    const stmt = conn.prepare(`
      INSERT INTO verification_audit_log (
        audit_id, category, record_id, record_name, previous_status,
        new_status, issues_json, source_url, source_title,
        evidence_excerpt, reason, checked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(audit_id) DO NOTHING;
    `);
    conn.exec("BEGIN");
    try {
      const fallbackNow = new Date().toISOString();
      for (const item of entries) {
        const checkedAt = item.checked_at || fallbackNow;
        const reason = (item.reason || "").slice(0, 1000);
        const digest = sha256Prefix(
          `${item.category}|${item.record_id}|${item.previous_status ?? "None"}|${item.new_status}|${reason}|${checkedAt}`
        );
        stmt.run(
          item.audit_id || `aud_${digest}`,
          item.category,
          item.record_id,
          (item.record_name || "").slice(0, 256),
          item.previous_status ?? null,
          item.new_status,
          JSON.stringify(item.issues ?? []),
          item.source_url ?? null,
          item.source_title ?? null,
          item.evidence_excerpt ? item.evidence_excerpt.slice(0, 1000) : null,
          reason,
          checkedAt
        );
      }
      conn.exec("COMMIT");
      return entries.length;
    } catch (err) {
      conn.exec("ROLLBACK");
      throw err;
    }
  }

  public saveCheckpoint(sourceKey: string, category: string, cursor: string | null, count: number): void {
    this.initializeSchema();
    const conn = this.getConnection();
    conn
      .prepare(
        `INSERT INTO collection_checkpoints (
          source_key, category, last_cursor, last_collected_at, records_count
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(source_key) DO UPDATE SET
          last_cursor = excluded.last_cursor,
          last_collected_at = excluded.last_collected_at,
          records_count = excluded.records_count;`
      )
      .run(sourceKey, category, cursor, new Date().toISOString(), count);
  }

  public deleteRecords(tableName: string, recordIds: string[]): number {
    const idColMap: Record<string, string> = {
      startups: "startup_id",
      products: "product_id",
      research_papers: "paper_id",
      jobs: "job_id",
      news: "news_id",
      entity_mapping_log: "mapping_id",
    };
    const idCol = idColMap[tableName];
    if (!idCol) {
      throw new Error(`Unsupported delete table: ${tableName}`);
    }
    const ids = recordIds.filter(Boolean);
    if (ids.length === 0) return 0;
    this.initializeSchema();
    const conn = this.getConnection();
    const placeholders = ids.map(() => "?").join(",");
    const res = conn
      .prepare(`DELETE FROM ${tableName} WHERE ${idCol} IN (${placeholders});`)
      .run(...ids);
    return Number(res.changes ?? 0);
  }

  public getSheetsSyncState(): {
    status: "Connected" | "Not Connected" | "Sync Failed";
    spreadsheetId: string | null;
    spreadsheetUrl: string | null;
    lastSyncMode: string | null;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    tabRowCounts: Record<string, number>;
    tabStatuses: Record<string, TabExportStatus>;
    rowsAdded: number;
    rowsUpdated: number;
    rowsUnchanged: number;
    rowsSkipped: number;
    rowsFailed: number;
    publicAccessStatus: "public_viewer" | "policy_blocked" | "not_configured" | "unknown";
    publicViewerVerified: boolean;
    publicAccessError: string | null;
    lastError: string | null;
  } | null {
    this.initializeSchema();
    const conn = this.getConnection();
    const row = conn
      .prepare("SELECT * FROM sheets_sync_state WHERE id = 'default';")
      .get() as Record<string, unknown> | undefined;
    if (!row) return null;
    let tabRowCounts: Record<string, number> = {};
    try {
      const parsed = JSON.parse(String(row.tab_row_counts_json ?? "{}"));
      if (parsed && typeof parsed === "object") {
        tabRowCounts = parsed as Record<string, number>;
      }
    } catch {
      tabRowCounts = {};
    }
    let tabStatuses: Record<string, TabExportStatus> = {};
    try {
      const parsed = JSON.parse(String(row.tab_statuses_json ?? "{}"));
      if (parsed && typeof parsed === "object") {
        tabStatuses = parsed as Record<string, TabExportStatus>;
      }
    } catch {
      tabStatuses = {};
    }
    const rawStatus = String(row.status ?? "Not Connected");
    const status =
      rawStatus === "Connected" || rawStatus === "Sync Failed" ? rawStatus : "Not Connected";
    const rawPubStatus = String(row.public_access_status ?? "unknown");
    const publicAccessStatus =
      rawPubStatus === "public_viewer" ||
      rawPubStatus === "policy_blocked" ||
      rawPubStatus === "not_configured"
        ? rawPubStatus
        : "unknown";
    return {
      status,
      spreadsheetId: (row.spreadsheet_id as string | null) ?? null,
      spreadsheetUrl: (row.spreadsheet_url as string | null) ?? null,
      lastSyncMode: (row.last_sync_mode as string | null) ?? null,
      lastAttemptAt: (row.last_attempt_at as string | null) ?? null,
      lastSuccessAt: (row.last_success_at as string | null) ?? null,
      tabRowCounts,
      tabStatuses,
      rowsAdded: Number(row.rows_added ?? 0),
      rowsUpdated: Number(row.rows_updated ?? 0),
      rowsUnchanged: Number(row.rows_unchanged ?? 0),
      rowsSkipped: Number(row.rows_skipped ?? 0),
      rowsFailed: Number(row.rows_failed ?? 0),
      publicAccessStatus,
      publicViewerVerified: Number(row.public_viewer_verified ?? 0) === 1,
      publicAccessError: (row.public_access_error as string | null) ?? null,
      lastError: (row.last_error as string | null) ?? null,
    };
  }

  public saveSheetsSyncState(state: {
    status: "Connected" | "Not Connected" | "Sync Failed";
    spreadsheetId: string | null;
    spreadsheetUrl: string | null;
    clearSpreadsheetTarget?: boolean;
    lastSyncMode: string | null;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    tabRowCounts: Record<string, number>;
    tabStatuses?: Record<string, TabExportStatus>;
    rowsAdded: number;
    rowsUpdated: number;
    rowsUnchanged: number;
    rowsSkipped?: number;
    rowsFailed?: number;
    publicAccessStatus?: "public_viewer" | "policy_blocked" | "not_configured" | "unknown";
    publicViewerVerified?: boolean;
    publicAccessError?: string | null;
    lastError: string | null;
  }): void {
    this.initializeSchema();
    const conn = this.getConnection();
    const spreadsheetIdSql = state.clearSpreadsheetTarget
      ? "excluded.spreadsheet_id"
      : "COALESCE(excluded.spreadsheet_id, sheets_sync_state.spreadsheet_id)";
    const spreadsheetUrlSql = state.clearSpreadsheetTarget
      ? "excluded.spreadsheet_url"
      : "COALESCE(excluded.spreadsheet_url, sheets_sync_state.spreadsheet_url)";
    conn
      .prepare(
        `INSERT INTO sheets_sync_state (
          id, status, spreadsheet_id, spreadsheet_url, last_sync_mode,
          last_attempt_at, last_success_at, tab_row_counts_json, tab_statuses_json,
          rows_added, rows_updated, rows_unchanged, rows_skipped, rows_failed,
          public_access_status, public_viewer_verified, public_access_error, last_error
        ) VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          spreadsheet_id = ${spreadsheetIdSql},
          spreadsheet_url = ${spreadsheetUrlSql},
          last_sync_mode = excluded.last_sync_mode,
          last_attempt_at = excluded.last_attempt_at,
          last_success_at = COALESCE(excluded.last_success_at, sheets_sync_state.last_success_at),
          tab_row_counts_json = CASE
            WHEN excluded.status = 'Connected' THEN excluded.tab_row_counts_json
            ELSE sheets_sync_state.tab_row_counts_json
          END,
          tab_statuses_json = excluded.tab_statuses_json,
          rows_added = excluded.rows_added,
          rows_updated = excluded.rows_updated,
          rows_unchanged = excluded.rows_unchanged,
          rows_skipped = excluded.rows_skipped,
          rows_failed = excluded.rows_failed,
          public_access_status = excluded.public_access_status,
          public_viewer_verified = excluded.public_viewer_verified,
          public_access_error = excluded.public_access_error,
          last_error = excluded.last_error;`
      )
      .run(
        state.status,
        state.spreadsheetId,
        state.spreadsheetUrl,
        state.lastSyncMode,
        state.lastAttemptAt,
        state.lastSuccessAt,
        JSON.stringify(state.tabRowCounts ?? {}),
        JSON.stringify(state.tabStatuses ?? {}),
        state.rowsAdded,
        state.rowsUpdated,
        state.rowsUnchanged,
        state.rowsSkipped ?? 0,
        state.rowsFailed ?? 0,
        state.publicAccessStatus ?? "unknown",
        state.publicViewerVerified ? 1 : 0,
        state.publicAccessError ?? null,
        state.lastError
      );
  }

  public createPipelineRun(run: {
    runId: string;
    triggerType: "manual" | "scheduled" | "daily_24h";
    mode: "full" | "daily_24h";
    categories: string[];
    startedAt: string;
    historicalCounts: Record<string, number>;
    newRecordsCounts?: Record<string, number>;
    fresh24hCounts: Record<string, number>;
  }): void {
    this.initializeSchema();
    const conn = this.getConnection();
    conn
      .prepare(
        `INSERT INTO pipeline_runs (
          run_id, trigger_type, mode, categories_json, started_at, completed_at,
          status, historical_counts_json, new_records_counts_json, fresh_24h_counts_json, errors_json, source_outcomes_json, summary
        ) VALUES (?, ?, ?, ?, ?, NULL, 'running', ?, ?, ?, '[]', '[]', NULL);`
      )
      .run(
        run.runId,
        run.triggerType,
        run.mode,
        JSON.stringify(run.categories),
        run.startedAt,
        JSON.stringify(run.historicalCounts),
        JSON.stringify(run.newRecordsCounts ?? {}),
        JSON.stringify(run.fresh24hCounts)
      );
  }

  public completePipelineRun(update: {
    runId: string;
    completedAt: string;
    status: "completed" | "partial" | "failed";
    historicalCounts: Record<string, number>;
    newRecordsCounts?: Record<string, number>;
    fresh24hCounts: Record<string, number>;
    errors: Array<Record<string, unknown>>;
    sourceOutcomes: SourceOutcomeRecord[];
    summary: string;
  }): void {
    this.initializeSchema();
    const conn = this.getConnection();
    conn
      .prepare(
        `UPDATE pipeline_runs SET
          completed_at = ?,
          status = ?,
          historical_counts_json = ?,
          new_records_counts_json = ?,
          fresh_24h_counts_json = ?,
          errors_json = ?,
          source_outcomes_json = ?,
          summary = ?
        WHERE run_id = ?;`
      )
      .run(
        update.completedAt,
        update.status,
        JSON.stringify(update.historicalCounts),
        JSON.stringify(update.newRecordsCounts ?? {}),
        JSON.stringify(update.fresh24hCounts),
        JSON.stringify(update.errors),
        JSON.stringify(update.sourceOutcomes),
        update.summary,
        update.runId
      );
  }

  public markInterruptedRunsFailed(reason = "Interrupted by server restart"): number {
    this.initializeSchema();
    const conn = this.getConnection();
    const nowIso = new Date().toISOString();
    const res = conn
      .prepare(
        `UPDATE pipeline_runs SET
          completed_at = COALESCE(completed_at, ?),
          status = 'failed',
          summary = COALESCE(summary, ?)
        WHERE status = 'running';`
      )
      .run(nowIso, reason);
    return Number(res.changes ?? 0);
  }

  public fetchPipelineRuns(limit = 20): PipelineRunRecord[] {
    this.initializeSchema();
    const rows = this.fetchAll(
      "SELECT * FROM pipeline_runs ORDER BY started_at DESC LIMIT ?;",
      Math.max(1, limit)
    );
    const parseJson = <T>(raw: unknown, fallback: T): T => {
      if (typeof raw !== "string" || !raw.trim()) return fallback;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return fallback;
      }
    };
    return rows.map((r) => ({
      run_id: String(r.run_id),
      trigger_type: (String(r.trigger_type) as PipelineRunRecord["trigger_type"]) || "manual",
      mode: (String(r.mode) as PipelineRunRecord["mode"]) || "full",
      categories: parseJson<string[]>(r.categories_json, []),
      started_at: String(r.started_at),
      completed_at: (r.completed_at as string | null) ?? null,
      status: (String(r.status) as PipelineRunRecord["status"]) || "completed",
      historical_counts: parseJson<Record<string, number>>(r.historical_counts_json, {}),
      new_records_counts: parseJson<Record<string, number>>(r.new_records_counts_json, {}),
      fresh_24h_counts: parseJson<Record<string, number>>(r.fresh_24h_counts_json, {}),
      errors: parseJson<Array<Record<string, unknown>>>(r.errors_json, []),
      source_outcomes: parseJson<SourceOutcomeRecord[]>(r.source_outcomes_json, []),
      summary: (r.summary as string | null) ?? null,
    }));
  }

  public getLastSuccessfulRun(includePartial = false): PipelineRunRecord | null {
    this.initializeSchema();
    const runs = this.fetchPipelineRuns(25);
    return (
      runs.find((r) =>
        includePartial ? r.status === "completed" || r.status === "partial" : r.status === "completed"
      ) ?? null
    );
  }

  public getSchedulerState(): SchedulerStateRecord | null {
    this.initializeSchema();
    const rows = this.fetchAll("SELECT * FROM scheduler_state WHERE id = 'default';");
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      enabled: Number(r.enabled ?? 1) === 1,
      utc_time: String(r.utc_time ?? "02:00"),
      last_run_at: (r.last_run_at as string | null) ?? null,
      last_success_at: (r.last_success_at as string | null) ?? null,
      next_run_at: (r.next_run_at as string | null) ?? null,
      updated_at: String(r.updated_at ?? new Date().toISOString()),
    };
  }

  public saveSchedulerState(state: SchedulerStateRecord): void {
    this.initializeSchema();
    const conn = this.getConnection();
    conn
      .prepare(
        `INSERT INTO scheduler_state (
          id, enabled, utc_time, last_run_at, last_success_at, next_run_at, updated_at
        ) VALUES ('default', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          enabled = excluded.enabled,
          utc_time = excluded.utc_time,
          last_run_at = excluded.last_run_at,
          last_success_at = excluded.last_success_at,
          next_run_at = excluded.next_run_at,
          updated_at = excluded.updated_at;`
      )
      .run(
        state.enabled ? 1 : 0,
        state.utc_time,
        state.last_run_at,
        state.last_success_at,
        state.next_run_at,
        state.updated_at
      );
  }
}
