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
    created_at TEXT NOT NULL,
    UNIQUE(entity_type, normalized_name)
  );`,
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
      conn.exec("COMMIT");
      this.initialized = true;
    } catch (err) {
      conn.exec("ROLLBACK");
      throw err;
    }
  }

  public fetchAll(sql: string, ...params: Array<string | number | null>): Array<Record<string, unknown>> {
    this.initializeSchema();
    const conn = this.getConnection();
    const rows = conn.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ ...row }));
  }

  public fetchDataset(tableName: string, limit?: number): Array<Record<string, unknown>> {
    if (!ALLOWED_DATASET_TABLES.has(tableName)) {
      throw new Error(`Unsupported dataset table: ${tableName}`);
    }
    if (limit !== undefined) {
      return this.fetchAll(`SELECT * FROM ${tableName} LIMIT ?;`, limit);
    }
    return this.fetchAll(`SELECT * FROM ${tableName};`);
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
        stmt.run(
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
          r.collected_at,
          r.last_checked_at,
          JSON.stringify(r.supported_fields),
          r.verification_status,
          r.rejection_reason,
          r.canonical_entity_id,
          JSON.stringify(r.source_metadata)
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
        stmt.run(
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
          r.collected_at,
          r.last_checked_at,
          JSON.stringify(r.supported_fields),
          r.verification_status,
          r.rejection_reason,
          r.canonical_entity_id,
          JSON.stringify(r.source_metadata)
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
    `);
    conn.exec("BEGIN");
    try {
      for (const r of records) {
        const pid = existingByUrl.get(r.source_url) ?? r.paper_id;
        stmt.run(
          pid,
          r.title,
          r.abstract,
          JSON.stringify(r.authors),
          r.publication_date,
          r.doi,
          r.arxiv_id,
          r.github_repository,
          r.github_stars,
          r.official_website,
          r.source_name,
          r.source_url,
          r.source_title,
          r.collected_at,
          r.last_checked_at,
          JSON.stringify(r.supported_fields),
          r.verification_status,
          r.rejection_reason,
          JSON.stringify(r.source_metadata)
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
    const stmt = conn.prepare(`
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
    `);
    conn.exec("BEGIN");
    try {
      for (const r of records) {
        stmt.run(
          r.job_id,
          r.title,
          r.company,
          r.location,
          r.employment_type,
          r.description,
          r.posted_at,
          r.application_url,
          r.official_website,
          r.source_name,
          r.source_url,
          r.source_title,
          r.collected_at,
          r.last_checked_at,
          JSON.stringify(r.supported_fields),
          r.verification_status,
          r.rejection_reason,
          r.canonical_company_id,
          JSON.stringify(r.source_metadata)
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
    const stmt = conn.prepare(`
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
    `);
    conn.exec("BEGIN");
    try {
      for (const r of records) {
        stmt.run(
          r.news_id,
          r.headline,
          r.summary,
          r.publisher,
          r.published_at,
          r.article_url,
          r.official_website,
          r.category,
          r.source_name,
          r.source_url,
          r.source_title,
          r.collected_at,
          r.last_checked_at,
          JSON.stringify(r.supported_fields),
          r.verification_status,
          r.rejection_reason,
          JSON.stringify(r.source_metadata)
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
          e.primary_domain,
          e.aliases_json,
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
        stmt.run(
          entry.mapping_id,
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
}
