export type DatasetCategory =
  | "startups"
  | "products"
  | "research_papers"
  | "jobs"
  | "news"
  | "entity_mapping_log";

export type SectionId = "overview" | DatasetCategory;

export type VerificationStatus =
  | "Verified"
  | "Partially Verified"
  | "Unverified"
  | "Source Unavailable"
  | "Rejected";

export interface VerificationTotals {
  Verified: number;
  "Partially Verified": number;
  Unverified: number;
  "Source Unavailable": number;
  Rejected: number;
}

export interface VerificationCountsPayload {
  totals: VerificationTotals;
  byCategory: Record<string, VerificationTotals>;
}

export interface CategoryQualityStats {
  discovered: number;
  extracted: number;
  validated: number;
  rejected: number;
  duplicates: number;
  persisted_total: number;
  unique_qualified_total?: number;
  target_minimum: number | null;
  target_met: boolean | null;
  verification_breakdown?: Record<string, number>;
  missing_fields: Record<string, number>;
  source_distribution: Record<string, number>;
  freshness: {
    window_hours: number;
    evaluated: number;
    accepted: number;
    rejected_older: number;
    rejected_missing_date: number;
    rejected_future_date: number;
  } | null;
  sample_rejection_reasons: string[];
}

export interface QualityReport {
  generated_at_utc: string;
  categories: Record<string, CategoryQualityStats>;
  entity_resolution: Record<string, number>;
  verification_summary?: Record<string, number>;
  unavailable_sources: string[];
}

export interface CheckpointRow {
  source_key: string;
  category: string;
  last_cursor: string | null;
  last_collected_at: string;
  records_count: number;
}

export interface RunJobState {
  id: string;
  status: "idle" | "running" | "completed" | "partial" | "failed";
  triggerType?: "manual" | "scheduled" | "daily_24h";
  mode?: "full" | "daily_24h";
  categories: string[];
  limit: number;
  page?: number;
  startedAt: string | null;
  finishedAt: string | null;
  logs?: string[];
  error?: string | null;
}

export interface SourceOutcomeItem {
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

export interface PipelineRunRow {
  run_id: string;
  trigger_type: "manual" | "scheduled" | "daily_24h";
  mode: "full" | "daily_24h";
  categories: string[];
  started_at: string;
  completed_at: string | null;
  status: "running" | "completed" | "partial" | "failed";
  historical_counts: Record<string, number>;
  new_records_counts?: Record<string, number>;
  fresh_24h_counts: Record<string, number>;
  errors: Array<Record<string, unknown>>;
  source_outcomes: SourceOutcomeItem[];
  summary: string | null;
}

export interface SchedulerState {
  enabled: boolean;
  utc_time: string;
  last_run_at: string | null;
  last_success_at: string | null;
  next_run_at: string | null;
  updated_at: string;
}

export interface StartupVerificationReport {
  company_name_match: {
    matched: boolean;
    claimed: string;
    evidence: string | null;
    source_url: string;
  };
  official_website_validity: {
    valid_url: boolean;
    accessible: boolean | null;
    http_status: number | null;
    url: string | null;
    page_title: string | null;
    error: string | null;
  };
  description_match: {
    matched: boolean;
    claimed: string | null;
    evidence: string | null;
  };
  industry_evidence: {
    matched: boolean;
    claimed: string;
    evidence: string | null;
  };
  location_evidence: {
    matched: boolean;
    claimed: string;
    evidence: string | null;
    hq_guard_triggered: boolean;
  };
  source_accessibility: {
    accessible: boolean;
    http_status: number | null;
    source_url: string;
    source_title: string | null;
    error: string | null;
  };
  verification_timestamp: string | null;
  exact_reason: string;
}

export interface AuditTrailEntry {
  audit_id: string;
  category: string;
  record_id: string;
  record_name: string;
  previous_status: string | null;
  new_status: string;
  issues_json: string;
  source_url: string | null;
  source_title: string | null;
  evidence_excerpt: string | null;
  reason: string;
  checked_at: string;
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

export interface SheetsStatusPayload {
  status: "Connected" | "Not Connected" | "Sync Failed";
  configured: boolean;
  authRequired?: boolean;
  credentialSource: "oauth" | "path" | "json_env" | null;
  verifiedAccountEmail?: string | null;
  grantedScopes?: string[];
  tokenExpiresInSeconds?: number | null;
  spreadsheetId: string | null;
  spreadsheetUrl: string | null;
  lastSyncAt: string | null;
  lastAttemptAt: string | null;
  lastMode: string | null;
  tabRowCounts: Record<string, number>;
  tabStatuses?: Record<string, TabExportStatus>;
  rowsAdded: number;
  rowsUpdated: number;
  rowsUnchanged: number;
  lastError: string | null;
}

export type IntegrationConnectionStatus = "Configured" | "Not Configured" | "Connection Failed";

export interface IntegrationHealthItem {
  id: "sqlite" | "gemini" | "groq" | "llama3" | "deepseek" | "github" | "google_sheets";
  label: string;
  envKey: string;
  status: IntegrationConnectionStatus;
  detail: string;
  error: string | null;
  latencyMs: number | null;
  checkedAt: string | null;
  tested: boolean;
}

export interface IntegrationHealthSummary {
  checkedAt: string | null;
  items: IntegrationHealthItem[];
  byId: Record<string, IntegrationHealthItem>;
}

export interface AtlasStatusResponse {
  counts: Record<DatasetCategory, number>;
  uniqueQualifiedCounts?: {
    startups: number;
    products: number;
    research_papers: number;
  };
  latestRunNewCounts?: Record<string, number>;
  freshCounts24h?: {
    jobs: number;
    news: number;
    research_papers: number;
  };
  verificationCounts?: VerificationCountsPayload;
  auditTrail?: AuditTrailEntry[];
  failureCount: number;
  pipelineRuns?: PipelineRunRow[];
  scheduler?: SchedulerState;
  lastSuccessfulRunAt?: string | null;
  lastCollectionAt?: string | null;
  latestRunStatus?: "completed" | "partial" | "failed" | null;
  lastSourceOutcomes?: SourceOutcomeItem[];
  targets: {
    startups: number;
    products: number;
    research_papers: number;
  };
  targetChecks?: {
    startups: { uniqueCount: number; target: number; met: boolean };
    products: { uniqueCount: number; target: number; met: boolean };
    research_papers: { uniqueCount: number; target: number; met: boolean };
  };
  freshnessWindowHours: number;
  credentials: {
    geminiConfigured: boolean;
    geminiModel: string;
    groqConfigured: boolean;
    llama3Configured?: boolean;
    deepseekConfigured: boolean;
    llmChain?: string[];
    llmDemoFallbackActive?: boolean;
    githubTokenConfigured: boolean;
    googleSheetsConfigured: boolean;
    googleSheetsSpreadsheetId: boolean;
  };
  integrationHealth?: IntegrationHealthSummary;
  sheetsStatus?: SheetsStatusPayload;
  storage: {
    backend: string;
    sqlitePath: string | null;
    integrityCheck?: string;
  };
  checkpoints: CheckpointRow[];
  qualityReport: QualityReport | null;
  csvExports: string[];
  activeRun: RunJobState;
}

export interface TraceabilityFields {
  official_website?: string | null;
  source_title?: string | null;
  last_checked_at?: string | null;
  supported_fields_json?: string;
  verification_status?: VerificationStatus | string;
  rejection_reason?: string | null;
}

export interface StartupRow extends TraceabilityFields {
  startup_id: string;
  name: string;
  description: string | null;
  website: string | null;
  industry: string;
  location: string;
  founding_date: string | null;
  source_name: string;
  source_url: string;
  collected_at: string;
  canonical_entity_id: string | null;
  source_metadata_json?: string;
}

export interface ProductRow extends TraceabilityFields {
  product_id: string;
  name: string;
  description: string | null;
  website: string | null;
  category: string;
  company_name: string;
  source_name: string;
  source_url: string;
  collected_at: string;
  canonical_entity_id: string | null;
  source_metadata_json?: string;
}

export interface ResearchPaperRow extends TraceabilityFields {
  paper_id: string;
  title: string;
  abstract: string | null;
  authors_json: string;
  publication_date: string | null;
  published_at?: string | null;
  doi: string | null;
  arxiv_id: string | null;
  github_repository: string | null;
  github_stars: number | null;
  source_name: string;
  source_url: string;
  collected_at: string;
  source_metadata_json?: string;
}

export interface JobRow extends TraceabilityFields {
  job_id: string;
  title: string;
  company: string;
  location: string;
  employment_type: string;
  description: string | null;
  posted_at: string;
  application_url: string;
  source_name: string;
  source_url: string;
  collected_at: string;
  canonical_company_id: string | null;
  source_metadata_json?: string;
}

export interface NewsRow extends TraceabilityFields {
  news_id: string;
  headline: string;
  summary: string | null;
  publisher: string;
  published_at: string;
  article_url: string;
  category: string;
  source_name: string | null;
  source_url: string;
  collected_at: string;
  source_metadata_json?: string;
}

export interface EntityMappingRow {
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

export interface FailureLogRow {
  failure_id: string;
  stage: string;
  category: string;
  source_url: string | null;
  reason: string;
  payload_json: string | null;
  created_at: string;
}

export type AnyDatasetRow =
  | StartupRow
  | ProductRow
  | ResearchPaperRow
  | JobRow
  | NewsRow
  | EntityMappingRow;
