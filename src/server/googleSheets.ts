/**
 * Google Sheets API v4 integration with Google Workspace OAuth & Service Account auth,
 * paginated batch writes, quota retry/backoff, 6-tab formatting & creation,
 * duplicate-free incremental sync via stable record IDs, and read-back verification.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AtlasDatabase, TabExportStatus } from "./atlasDb.ts";
import { type IntegrationConnectionStatus, redactSecrets } from "./llmRouter.ts";
export type { TabExportStatus } from "./atlasDb.ts";

export interface ExportSpec {
  tableName: string;
  tabName: string;
  csvFilename: string;
  idColumn: string;
  columns: string[];
}

export const TRACEABILITY_EXPORT_COLUMNS = [
  "official_website",
  "source_title",
  "last_checked_at",
  "supported_fields",
  "verification_status",
  "verification_reason",
  "rejection_reason",
];

export const EXPORT_SPECS: ExportSpec[] = [
  {
    tableName: "startups",
    tabName: "Startups",
    csvFilename: "startups.csv",
    idColumn: "startup_id",
    columns: [
      "startup_id",
      "name",
      "description",
      "website",
      "industry",
      "location",
      "founding_date",
      "source_name",
      "source_url",
      "collected_at",
      "canonical_entity_id",
      "canonical_entity_name",
      ...TRACEABILITY_EXPORT_COLUMNS,
      "source_metadata_json",
    ],
  },
  {
    tableName: "products",
    tabName: "Products",
    csvFilename: "products.csv",
    idColumn: "product_id",
    columns: [
      "product_id",
      "name",
      "description",
      "website",
      "category",
      "company_name",
      "source_name",
      "source_url",
      "collected_at",
      "canonical_entity_id",
      "canonical_entity_name",
      ...TRACEABILITY_EXPORT_COLUMNS,
      "source_metadata_json",
    ],
  },
  {
    tableName: "research_papers",
    tabName: "Research Papers",
    csvFilename: "research_papers.csv",
    idColumn: "paper_id",
    columns: [
      "paper_id",
      "title",
      "abstract",
      "authors",
      "publication_date",
      "published_at",
      "doi",
      "arxiv_id",
      "github_repository",
      "github_stars",
      "source_name",
      "source_url",
      "collected_at",
      ...TRACEABILITY_EXPORT_COLUMNS,
      "source_metadata_json",
    ],
  },
  {
    tableName: "jobs",
    tabName: "Jobs",
    csvFilename: "jobs.csv",
    idColumn: "job_id",
    columns: [
      "job_id",
      "title",
      "company",
      "location",
      "employment_type",
      "description",
      "posted_at",
      "application_url",
      "canonical_company_id",
      "canonical_company_name",
      "source_name",
      "source_url",
      "collected_at",
      ...TRACEABILITY_EXPORT_COLUMNS,
      "source_metadata_json",
    ],
  },
  {
    tableName: "news",
    tabName: "News",
    csvFilename: "news.csv",
    idColumn: "news_id",
    columns: [
      "news_id",
      "headline",
      "summary",
      "publisher",
      "published_at",
      "article_url",
      "category",
      "source_name",
      "source_url",
      "collected_at",
      ...TRACEABILITY_EXPORT_COLUMNS,
      "source_metadata_json",
    ],
  },
  {
    tableName: "entity_mapping_log",
    tabName: "Entity Mapping Log",
    csvFilename: "entity_mapping_log.csv",
    idColumn: "mapping_id",
    columns: [
      "mapping_id",
      "raw_name",
      "normalized_name",
      "canonical_name",
      "canonical_id",
      "entity_type",
      "source_url",
      "match_method",
      "confidence",
      "decision",
      "match_reason",
      "timestamp",
    ],
  },
];

const SHEETS_MAX_CELL_LEN = 45_000;

export function formatExportCell(
  col: string,
  row: Record<string, unknown>,
  forSheets: boolean
): string | number {
  if (col === "authors") {
    const raw = row.authors_json ?? row.authors;
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.map(String).join("; ");
      } catch {
        return raw;
      }
    } else if (Array.isArray(raw)) {
      return raw.map(String).join("; ");
    }
    return "";
  }
  if (col === "supported_fields") {
    const raw = row.supported_fields_json ?? row.supported_fields;
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.map(String).join("; ");
      } catch {
        return raw;
      }
    } else if (Array.isArray(raw)) {
      return raw.map(String).join("; ");
    }
    return "";
  }
  if (col === "official_website") {
    const v = row.official_website ?? row.website;
    return v === null || v === undefined ? "" : String(v);
  }
  if (col === "verification_reason") {
    if (row.rejection_reason) return String(row.rejection_reason);
    if (typeof row.source_metadata_json === "string" && row.source_metadata_json.trim()) {
      try {
        const meta = JSON.parse(row.source_metadata_json) as Record<string, unknown>;
        const reason = meta.verification_reason || meta.source_error;
        if (reason) return String(reason);
      } catch {
        // Ignore parse error
      }
    }
    return "";
  }
  if (col === "source_metadata_json") {
    const raw = row.source_metadata_json ?? row.source_metadata;
    if (raw === null || raw === undefined) return "{}";
    const serialized = typeof raw === "string" ? raw : JSON.stringify(raw);
    return forSheets && serialized.length > SHEETS_MAX_CELL_LEN
      ? serialized.slice(0, SHEETS_MAX_CELL_LEN)
      : serialized;
  }
  const val = row[col];
  if (val === null || val === undefined) return "";
  if (col === "github_stars") {
    const n = Number(val);
    if (!Number.isFinite(n)) return "";
    return forSheets ? Math.trunc(n) : String(Math.trunc(n));
  }
  if (col === "confidence") {
    const n = Number(val);
    if (!Number.isFinite(n)) return "";
    return forSheets ? Number(n.toFixed(4)) : n.toFixed(4);
  }
  const str = String(val);
  return forSheets && str.length > SHEETS_MAX_CELL_LEN ? str.slice(0, SHEETS_MAX_CELL_LEN) : str;
}

function columnLetter(colCount: number): string {
  let n = colCount;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out || "A";
}

export function canonicalSpreadsheetUrl(spreadsheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
}

export const SERVICE_ACCOUNT_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive",
];

interface ServiceAccountCreds {
  client_email: string;
  private_key: string;
  token_uri: string;
  source: "path" | "json_env" | "saved_config";
}

export class GoogleApiHttpError extends Error {
  public readonly httpStatus: number;
  constructor(httpStatus: number, message: string) {
    super(message);
    this.name = "GoogleApiHttpError";
    this.httpStatus = httpStatus;
  }
}

export type ExportScope = "qualified_24h" | "all";
export type PublicAccessStatus = "public_viewer" | "policy_blocked" | "not_configured" | "unknown";

export interface ExportStepStatus {
  step: number;
  key:
    | "auth"
    | "connection"
    | "spreadsheet"
    | "write_tabs"
    | "verify_tabs"
    | "public_access"
    | "share_url";
  label: string;
  status: "completed" | "failed" | "blocked" | "skipped";
  detail: string;
}

export interface SheetsFallbackExportSummary {
  ready: boolean;
  reason: string;
  zipFilename: string;
  zipUrl: string;
  zipByteSize: number;
  rowCounts: Record<string, number>;
  totalRows: number;
  datasets: Array<{
    tabName: string;
    filename: string;
    rowCount: number;
    downloadUrl: string;
  }>;
}

export interface GoogleSheetsConfig {
  atlasDir: string;
  rootDir: string;
  credentialsPath: string | null;
  credentialsJson: string | null;
  savedCredentialsPath?: string | null;
  spreadsheetId: string | null;
  spreadsheetName: string;
  freshnessWindowHours?: number;
  apiBaseUrl?: string; // Overrideable for local integration tests
  driveApiBaseUrl?: string; // Overrideable for local integration tests
  publicCheckBaseUrl?: string; // Overrideable base URL for anonymous read-access verification
  oauthTokenUrl?: string;
  tokenInfoUrl?: string;
}

export interface SheetsSyncResult {
  success: boolean;
  mode: "full" | "incremental";
  exportScope: ExportScope;
  status: "Connected" | "Not Connected" | "Sync Failed";
  authRequired?: boolean;
  spreadsheetId: string | null;
  spreadsheetUrl: string | null;
  tabRowCounts: Record<string, number>;
  verifiedTabRowCounts: Record<string, number>;
  tabStatuses: Record<string, TabExportStatus>;
  rowsAdded: number;
  rowsUpdated: number;
  rowsUnchanged: number;
  rowsSkipped: number;
  rowsFailed: number;
  skippedBreakdown: {
    rejected: number;
    stale24h: number;
    duplicateOrInvalid: number;
    unchanged: number;
  };
  publicAccessStatus: PublicAccessStatus;
  publicViewerVerified: boolean;
  publicAccessError: string | null;
  steps: ExportStepStatus[];
  fallbackExport?: SheetsFallbackExportSummary | null;
  syncedAt: string | null;
  error: string | null;
}

export interface SheetsConnectionStatus {
  status: "Connected" | "Not Connected" | "Sync Failed";
  configured: boolean;
  authRequired?: boolean;
  credentialSource: "oauth" | "path" | "json_env" | "saved_config" | null;
  verifiedAccountEmail?: string | null;
  grantedScopes?: string[];
  tokenExpiresInSeconds?: number | null;
  spreadsheetId: string | null;
  spreadsheetUrl: string | null;
  lastSyncAt: string | null;
  lastAttemptAt: string | null;
  lastMode: string | null;
  tabRowCounts: Record<string, number>;
  tabStatuses: Record<string, TabExportStatus>;
  rowsAdded: number;
  rowsUpdated: number;
  rowsUnchanged: number;
  rowsSkipped: number;
  rowsFailed: number;
  publicAccessStatus: PublicAccessStatus;
  publicViewerVerified: boolean;
  publicAccessError: string | null;
  lastError: string | null;
}

export class GoogleSheetsService {
  private cachedToken: { token: string; expiresAtMs: number } | null = null;
  private liveSessionVerified = false;
  private liveCredentialSource: "oauth" | "path" | "json_env" | "saved_config" | null = null;
  private verifiedAccountEmail: string | null = null;
  private grantedScopes: string[] = [];
  private tokenExpiresInSeconds: number | null = null;
  private readonly apiBase: string;
  private readonly driveApiBase: string;
  private readonly publicCheckBase: string | null;
  private readonly tokenInfoUrl: string | null;
  private readonly config: GoogleSheetsConfig;
  private readonly db: AtlasDatabase;

  constructor(config: GoogleSheetsConfig, db: AtlasDatabase) {
    this.config = config;
    this.db = db;
    this.apiBase = (config.apiBaseUrl || "https://sheets.googleapis.com/v4").replace(/\/+$/, "");
    this.driveApiBase = (config.driveApiBaseUrl || "https://www.googleapis.com/drive/v3").replace(/\/+$/, "");
    this.publicCheckBase = config.publicCheckBaseUrl
      ? config.publicCheckBaseUrl.replace(/\/+$/, "")
      : config.apiBaseUrl
      ? null
      : "https://docs.google.com/spreadsheets/d";
    this.tokenInfoUrl = config.tokenInfoUrl
      ? config.tokenInfoUrl.replace(/\/+$/, "")
      : config.apiBaseUrl
      ? null
      : "https://oauth2.googleapis.com/tokeninfo";
  }

  private resolveCredentialsPath(): string | null {
    const raw = this.config.credentialsPath?.trim();
    if (!raw) return null;
    if (path.isAbsolute(raw)) {
      return fs.existsSync(raw) ? raw : null;
    }
    const fromRoot = path.resolve(this.config.rootDir, raw);
    if (fs.existsSync(fromRoot)) return fromRoot;
    const fromAtlas = path.resolve(this.config.atlasDir, raw);
    if (fs.existsSync(fromAtlas)) return fromAtlas;
    return null;
  }

  private resolveSavedCredentialsPath(): string | null {
    const raw = this.config.savedCredentialsPath?.trim();
    if (!raw) return null;
    const resolved = path.isAbsolute(raw) ? raw : path.resolve(this.config.atlasDir, raw);
    return fs.existsSync(resolved) ? resolved : null;
  }

  public getCredentialSource(): "path" | "json_env" | "saved_config" | null {
    if (this.config.credentialsJson && this.config.credentialsJson.trim()) {
      return "json_env";
    }
    if (this.resolveCredentialsPath()) {
      return "path";
    }
    if (this.resolveSavedCredentialsPath()) {
      return "saved_config";
    }
    return null;
  }

  public isConfigured(): boolean {
    return this.getCredentialSource() !== null;
  }

  public clearCachedAuth(): void {
    this.cachedToken = null;
    this.liveSessionVerified = false;
    this.liveCredentialSource = null;
    this.verifiedAccountEmail = null;
    this.grantedScopes = [];
    this.tokenExpiresInSeconds = null;
  }

  private loadServiceAccountCredentials(): ServiceAccountCreds {
    let rawJsonText: string | null = null;
    let source: "path" | "json_env" | "saved_config" = "path";

    if (this.config.credentialsJson && this.config.credentialsJson.trim()) {
      const trimmed = this.config.credentialsJson.trim();
      if (trimmed.startsWith("{")) {
        rawJsonText = trimmed;
      } else {
        rawJsonText = Buffer.from(trimmed, "base64").toString("utf-8");
      }
      source = "json_env";
    } else {
      const resolvedPath = this.resolveCredentialsPath();
      if (resolvedPath) {
        rawJsonText = fs.readFileSync(resolvedPath, "utf-8");
        source = "path";
      } else {
        const savedPath = this.resolveSavedCredentialsPath();
        if (!savedPath) {
          throw new Error(
            "Google Service Account credentials are not configured. Paste a Service Account JSON key in the Google Sheets Setup panel or set GOOGLE_SHEETS_CREDENTIALS_JSON in the server environment."
          );
        }
        rawJsonText = fs.readFileSync(savedPath, "utf-8");
        source = "saved_config";
      }
    }

    let parsed: { client_email?: string; private_key?: string; token_uri?: string };
    try {
      parsed = JSON.parse(rawJsonText);
    } catch (err) {
      throw new Error(`Invalid Service Account JSON credentials: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!parsed.client_email || !parsed.private_key) {
      throw new Error("Service Account JSON is missing required client_email or private_key.");
    }

    return {
      client_email: parsed.client_email,
      private_key: parsed.private_key.replace(/\\n/g, "\n"),
      token_uri: this.config.oauthTokenUrl || parsed.token_uri || "https://oauth2.googleapis.com/token",
      source,
    };
  }

  private async getAccessToken(creds: ServiceAccountCreds): Promise<string> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAtMs - 60_000) {
      return this.cachedToken.token;
    }

    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const claim = Buffer.from(
      JSON.stringify({
        iss: creds.client_email,
        scope: SERVICE_ACCOUNT_SCOPES.join(" "),
        aud: creds.token_uri,
        exp: now + 3600,
        iat: now,
      })
    ).toString("base64url");

    const signer = crypto.createSign("RSA-SHA256");
    signer.update(`${header}.${claim}`);
    const sig = signer.sign(creds.private_key).toString("base64url");
    const assertion = `${header}.${claim}.${sig}`;

    const tokenResp = await this.fetchWithQuotaRetry(creds.token_uri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    });
    const tokenJson = (await tokenResp.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!tokenResp.ok || !tokenJson.access_token) {
      throw new Error(
        tokenJson.error_description || tokenJson.error || `Google OAuth token exchange failed (HTTP ${tokenResp.status})`
      );
    }

    const ttlMs = (Number(tokenJson.expires_in) || 3500) * 1000;
    this.cachedToken = {
      token: tokenJson.access_token,
      expiresAtMs: Date.now() + ttlMs,
    };
    return tokenJson.access_token;
  }

  private async fetchWithQuotaRetry(
    url: string,
    init: RequestInit,
    maxAttempts = 5
  ): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const resp = await fetch(url, init);
        if (resp.status === 429 || resp.status >= 500) {
          const retryAfterRaw = resp.headers.get("retry-after");
          const retryAfterMs =
            retryAfterRaw && /^\d+$/.test(retryAfterRaw.trim()) ? Math.min(65_000, Number(retryAfterRaw) * 1000) : null;
          const jitter = Math.floor(Math.random() * 400);
          const backoffMs = retryAfterMs ?? Math.min(20_000, 1500 * Math.pow(2, attempt - 1) + jitter);
          if (attempt < maxAttempts) {
            await new Promise((r) => setTimeout(r, backoffMs));
            continue;
          }
        }
        return resp;
      } catch (err) {
        lastError = err;
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, Math.min(12_000, 1000 * Math.pow(2, attempt - 1))));
          continue;
        }
        throw err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Google Sheets request failed");
  }

  private async apiJson<T>(
    baseUrl: string,
    accessToken: string,
    pathSuffix: string,
    opts: { method?: string; body?: unknown } = {}
  ): Promise<T> {
    const resp = await this.fetchWithQuotaRetry(`${baseUrl}${pathSuffix}`, {
      method: opts.method ?? "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await resp.text();
    let parsed: unknown = {};
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
    }
    if (!resp.ok) {
      const apiMsg = redactSecrets((parsed as { error?: { message?: string } })?.error?.message || "");
      if (resp.status === 401) {
        this.cachedToken = null;
        this.liveSessionVerified = false;
        this.liveCredentialSource = null;
        throw new GoogleApiHttpError(
          401,
          `Google Service Account authentication rejected or expired (HTTP 401${apiMsg ? `: ${apiMsg}` : ""}). Verify your Service Account JSON credentials.`
        );
      }
      if (resp.status === 403) {
        throw new GoogleApiHttpError(
          403,
          `Google Workspace permission denied (HTTP 403${apiMsg ? `: ${apiMsg}` : ""}). Ensure both Google Sheets API and Google Drive API are enabled on the Cloud project and that the Service Account has access.`
        );
      }
      if (resp.status === 404) {
        throw new GoogleApiHttpError(
          404,
          `Google Spreadsheet not found (HTTP 404${apiMsg ? `: ${apiMsg}` : ""}). Verify Target Spreadsheet ID (or clear it to create a new spreadsheet in Google Drive).`
        );
      }
      const errMsg = apiMsg || `Google Workspace API HTTP ${resp.status}`;
      throw new GoogleApiHttpError(resp.status, errMsg);
    }
    return parsed as T;
  }

  private async sheetsJson<T>(
    accessToken: string,
    pathSuffix: string,
    opts: { method?: string; body?: unknown } = {}
  ): Promise<T> {
    return this.apiJson<T>(this.apiBase, accessToken, pathSuffix, opts);
  }

  private async driveJson<T>(
    accessToken: string,
    pathSuffix: string,
    opts: { method?: string; body?: unknown } = {}
  ): Promise<T> {
    return this.apiJson<T>(this.driveApiBase, accessToken, pathSuffix, opts);
  }

  private resolveTargetSpreadsheetId(overrideId?: string | null, createNew = false): string | null {
    const cleanOverride = overrideId?.trim();
    if (cleanOverride) {
      if (!/^[a-zA-Z0-9-_]{10,120}$/.test(cleanOverride)) {
        throw new Error("Invalid Google Spreadsheet ID format.");
      }
      return cleanOverride;
    }
    if (createNew) {
      return null;
    }
    if (this.config.spreadsheetId?.trim()) {
      return this.config.spreadsheetId.trim();
    }
    return this.db.getSheetsSyncState()?.spreadsheetId ?? null;
  }

  private sanitizeOAuthToken(raw?: string | null): string | null {
    const clean = raw?.trim() ?? "";
    if (!clean || clean === "null" || clean === "undefined" || clean.length < 10 || /\s/.test(clean)) {
      return null;
    }
    return clean;
  }

  private async verifyOAuthTokenScopes(accessToken: string): Promise<{
    email: string | null;
    scopes: string[];
    expiresInSeconds: number | null;
  }> {
    if (!this.tokenInfoUrl) {
      return { email: null, scopes: [], expiresInSeconds: null };
    }
    const resp = await this.fetchWithQuotaRetry(this.tokenInfoUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ access_token: accessToken }).toString(),
    });
    const info = (await resp.json().catch(() => ({}))) as {
      scope?: string;
      email?: string;
      expires_in?: string | number;
      error?: string;
      error_description?: string;
    };
    if (!resp.ok) {
      this.liveSessionVerified = false;
      this.liveCredentialSource = null;
      const errDesc = redactSecrets(info.error_description || info.error || "Invalid or expired OAuth token");
      throw new GoogleApiHttpError(
        401,
        `Google OAuth token expired or invalid (HTTP 401: ${errDesc}). Provide valid Service Account credentials.`
      );
    }
    const scopes = String(info.scope ?? "")
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const hasSheetsScope = scopes.includes("https://www.googleapis.com/auth/spreadsheets");
    const hasDriveScope =
      scopes.includes("https://www.googleapis.com/auth/drive.file") ||
      scopes.includes("https://www.googleapis.com/auth/drive");
    if (!hasSheetsScope || !hasDriveScope) {
      throw new GoogleApiHttpError(
        403,
        "Google Workspace authorization is missing required permissions (Google Sheets & Google Drive). Ensure both scopes are granted."
      );
    }
    const expSec = Number(info.expires_in);
    return {
      email: typeof info.email === "string" && info.email ? info.email : null,
      scopes,
      expiresInSeconds: Number.isFinite(expSec) && expSec > 0 ? Math.floor(expSec) : null,
    };
  }

  private async resolveAuthToken(oauthAccessToken?: string | null): Promise<{
    accessToken: string;
    credentialSource: "oauth" | "path" | "json_env" | "saved_config";
    email: string | null;
    scopes: string[];
    expiresInSeconds: number | null;
  }> {
    const clean = this.sanitizeOAuthToken(oauthAccessToken);
    if (clean) {
      const meta = await this.verifyOAuthTokenScopes(clean);
      return {
        accessToken: clean,
        credentialSource: "oauth",
        email: meta.email,
        scopes: meta.scopes,
        expiresInSeconds: meta.expiresInSeconds,
      };
    }
    if (oauthAccessToken !== undefined && oauthAccessToken !== null && oauthAccessToken.trim() !== "") {
      throw new GoogleApiHttpError(
        401,
        "Google access token is malformed (HTTP 401)."
      );
    }
    const creds = this.loadServiceAccountCredentials();
    const accessToken = await this.getAccessToken(creds);
    return {
      accessToken,
      credentialSource: creds.source,
      email: creds.client_email,
      scopes: [...SERVICE_ACCOUNT_SCOPES],
      expiresInSeconds: null,
    };
  }

  private async ensureSpreadsheetAndTabs(
    accessToken: string,
    overrideSpreadsheetId?: string | null,
    createNew = false
  ): Promise<{
    spreadsheetId: string;
    spreadsheetUrl: string;
    sheetPropsByTitle: Map<string, { sheetId: number; rowCount: number; columnCount: number }>;
  }> {
    const savedDbId = this.db.getSheetsSyncState()?.spreadsheetId ?? null;
    const hasExplicitOverride =
      Boolean(overrideSpreadsheetId?.trim()) && overrideSpreadsheetId!.trim() !== savedDbId;
    let spreadsheetId = this.resolveTargetSpreadsheetId(overrideSpreadsheetId, createNew);
    let spreadsheetUrl: string = "";
    let sheetsList: Array<{ properties: { sheetId: number; title: string; gridProperties?: { rowCount?: number; columnCount?: number } } }> = [];

    if (spreadsheetId) {
      try {
        const meta = await this.sheetsJson<{
          spreadsheetId: string;
          spreadsheetUrl?: string;
          sheets?: typeof sheetsList;
        }>(accessToken, `/spreadsheets/${spreadsheetId}?fields=spreadsheetId,spreadsheetUrl,sheets.properties`);
        spreadsheetId = meta.spreadsheetId || spreadsheetId;
        spreadsheetUrl = canonicalSpreadsheetUrl(spreadsheetId);
        sheetsList = meta.sheets ?? [];

        const existingTitles = new Set(sheetsList.map((s) => s.properties.title));
        const missingSpecs = EXPORT_SPECS.filter((s) => !existingTitles.has(s.tabName));
        if (missingSpecs.length > 0) {
          await this.sheetsJson(accessToken, `/spreadsheets/${spreadsheetId}:batchUpdate`, {
            method: "POST",
            body: {
              requests: missingSpecs.map((s) => ({
                addSheet: {
                  properties: {
                    title: s.tabName,
                    gridProperties: {
                      rowCount: 1000,
                      columnCount: Math.max(15, s.columns.length),
                      frozenRowCount: 1,
                    },
                  },
                },
              })),
            },
          });
          const refreshed = await this.sheetsJson<{ sheets?: typeof sheetsList }>(
            accessToken,
            `/spreadsheets/${spreadsheetId}?fields=sheets.properties`
          );
          sheetsList = refreshed.sheets ?? sheetsList;
        }
      } catch (err) {
        const isNotFound = err instanceof GoogleApiHttpError && err.httpStatus === 404;
        if (!hasExplicitOverride && isNotFound) {
          // Stale auto-persisted spreadsheetId (deleted or no longer accessible): recover automatically by creating a new spreadsheet
          spreadsheetId = null;
          spreadsheetUrl = "";
          sheetsList = [];
        } else {
          throw err;
        }
      }
    }

    if (!spreadsheetId) {
      const created = await this.sheetsJson<{
        spreadsheetId: string;
        spreadsheetUrl?: string;
        sheets?: typeof sheetsList;
      }>(accessToken, "/spreadsheets", {
        method: "POST",
        body: {
          properties: { title: this.config.spreadsheetName },
          sheets: EXPORT_SPECS.map((s) => ({
            properties: {
              title: s.tabName,
              gridProperties: { rowCount: 1000, columnCount: Math.max(15, s.columns.length), frozenRowCount: 1 },
            },
          })),
        },
      });
      if (!created.spreadsheetId) {
        throw new Error("Google Sheets API did not return a spreadsheetId on creation.");
      }
      spreadsheetId = created.spreadsheetId;
      spreadsheetUrl = canonicalSpreadsheetUrl(spreadsheetId);
      sheetsList = created.sheets ?? [];
    }

    const sheetPropsByTitle = new Map<string, { sheetId: number; rowCount: number; columnCount: number }>();
    for (const s of sheetsList) {
      sheetPropsByTitle.set(s.properties.title, {
        sheetId: s.properties.sheetId,
        rowCount: s.properties.gridProperties?.rowCount ?? 1000,
        columnCount: s.properties.gridProperties?.columnCount ?? 26,
      });
    }
    return { spreadsheetId, spreadsheetUrl, sheetPropsByTitle };
  }

  private async ensureGridSizeAndHeaderStyle(
    accessToken: string,
    spreadsheetId: string,
    sheetMeta: { sheetId: number; rowCount: number; columnCount: number },
    rowsNeeded: number,
    colsNeeded: number
  ): Promise<void> {
    const requests: Array<Record<string, unknown>> = [];
    if (rowsNeeded > sheetMeta.rowCount || colsNeeded > sheetMeta.columnCount) {
      requests.push({
        updateSheetProperties: {
          properties: {
            sheetId: sheetMeta.sheetId,
            gridProperties: {
              rowCount: Math.max(sheetMeta.rowCount, rowsNeeded + 50),
              columnCount: Math.max(sheetMeta.columnCount, colsNeeded),
              frozenRowCount: 1,
            },
          },
          fields: "gridProperties.rowCount,gridProperties.columnCount,gridProperties.frozenRowCount",
        },
      });
      sheetMeta.rowCount = Math.max(sheetMeta.rowCount, rowsNeeded + 50);
      sheetMeta.columnCount = Math.max(sheetMeta.columnCount, colsNeeded);
    } else {
      requests.push({
        updateSheetProperties: {
          properties: {
            sheetId: sheetMeta.sheetId,
            gridProperties: { frozenRowCount: 1 },
          },
          fields: "gridProperties.frozenRowCount",
        },
      });
    }

    requests.push({
      repeatCell: {
        range: {
          sheetId: sheetMeta.sheetId,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: colsNeeded,
        },
        cell: {
          userEnteredFormat: {
            textFormat: { bold: true },
          },
        },
        fields: "userEnteredFormat.textFormat.bold",
      },
    });

    await this.sheetsJson(accessToken, `/spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: "POST",
      body: { requests },
    });
  }

  private parseRowTimestampMs(row: Record<string, unknown>, tableName: string): number | null {
    const raw =
      tableName === "jobs"
        ? row.posted_at
        : tableName === "news" || tableName === "research_papers"
        ? row.published_at
        : null;
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

  public buildDeduplicatedTabRows(
    spec: ExportSpec,
    canonicalNames?: Map<string, string>,
    opts?: {
      exportScope?: ExportScope;
      freshnessWindowHours?: number;
      refNow?: Date;
    }
  ): {
    orderedIds: string[];
    rowMap: Map<string, Array<string | number>>;
    skippedRejected: number;
    skippedStale24h: number;
    skippedDuplicate: number;
    failedValidation: number;
  } {
    const namesMap = canonicalNames ?? this.db.fetchCanonicalNameMap();
    const rawRows = this.db.fetchDataset(spec.tableName);
    const scope: ExportScope = opts?.exportScope ?? "qualified_24h";
    const windowHours = opts?.freshnessWindowHours ?? this.config.freshnessWindowHours ?? 24;
    const refMs = (opts?.refNow ?? new Date()).getTime();
    const minMs = refMs - windowHours * 3600_000;
    const maxMs = refMs + 5 * 60_000;

    const orderedIds: string[] = [];
    const rowMap = new Map<string, Array<string | number>>();
    let skippedRejected = 0;
    let skippedStale24h = 0;
    let skippedDuplicate = 0;
    let failedValidation = 0;

    for (const row of rawRows) {
      const rid = String(row[spec.idColumn] ?? "").trim();
      if (!rid) {
        failedValidation += 1;
        continue;
      }
      if (rowMap.has(rid)) {
        skippedDuplicate += 1;
        continue;
      }
      if (scope === "qualified_24h" && spec.tableName !== "entity_mapping_log") {
        const verStatus = String(row.verification_status ?? "");
        if (verStatus === "Rejected") {
          skippedRejected += 1;
          continue;
        }
        if (spec.tableName === "jobs" || spec.tableName === "news") {
          const tsMs = this.parseRowTimestampMs(row, spec.tableName);
          if (tsMs === null || tsMs < minMs || tsMs > maxMs) {
            skippedStale24h += 1;
            continue;
          }
        }
      }

      const enrichedRow: Record<string, unknown> = { ...row };
      if (spec.tableName === "startups" || spec.tableName === "products") {
        const cid = String(row.canonical_entity_id ?? "").trim();
        enrichedRow.canonical_entity_name = cid ? namesMap.get(cid) ?? "" : "";
      } else if (spec.tableName === "jobs") {
        const cid = String(row.canonical_company_id ?? "").trim();
        enrichedRow.canonical_company_name = cid ? namesMap.get(cid) ?? "" : "";
      }
      orderedIds.push(rid);
      rowMap.set(
        rid,
        spec.columns.map((c) => formatExportCell(c, enrichedRow, true))
      );
    }
    return {
      orderedIds,
      rowMap,
      skippedRejected,
      skippedStale24h,
      skippedDuplicate,
      failedValidation,
    };
  }

  private async verifyWrittenTab(
    accessToken: string,
    spreadsheetId: string,
    spec: ExportSpec
  ): Promise<{ headerValid: boolean; verifiedRows: number; duplicateCount: number }> {
    const range = encodeURIComponent(`'${spec.tabName}'!A:A`);
    const data = await this.sheetsJson<{ values?: unknown[][] }>(
      accessToken,
      `/spreadsheets/${spreadsheetId}/values/${range}?majorDimension=ROWS`
    );
    const rows = data.values ?? [];
    if (rows.length === 0) {
      return { headerValid: false, verifiedRows: 0, duplicateCount: 0 };
    }
    const headerValid = String(rows[0]?.[0] ?? "").trim() === spec.columns[0];
    const uniqueIds = new Set<string>();
    let nonEmptyRowCount = 0;
    for (let i = 1; i < rows.length; i++) {
      const idVal = String(rows[i]?.[0] ?? "").trim();
      if (idVal) {
        nonEmptyRowCount += 1;
        uniqueIds.add(idVal);
      }
    }
    return {
      headerValid,
      verifiedRows: uniqueIds.size,
      duplicateCount: Math.max(0, nonEmptyRowCount - uniqueIds.size),
    };
  }

  public getStatus(): SheetsConnectionStatus {
    const saConfigured = this.isConfigured();
    const credentialSource = this.liveCredentialSource ?? this.getCredentialSource();
    const saved = this.db.getSheetsSyncState();
    const envSpreadsheetId = this.config.spreadsheetId?.trim() || null;
    const spreadsheetId = envSpreadsheetId ?? saved?.spreadsheetId ?? null;
    const spreadsheetUrl = spreadsheetId ? canonicalSpreadsheetUrl(spreadsheetId) : null;

    // Do not report Connected unless a real Google API request succeeded in this active session
    const effectiveStatus: "Connected" | "Not Connected" | "Sync Failed" = this.liveSessionVerified
      ? saved?.status === "Sync Failed"
        ? "Sync Failed"
        : "Connected"
      : saved?.status === "Sync Failed"
      ? "Sync Failed"
      : "Not Connected";

    const authRequired = !this.liveSessionVerified && !saConfigured;

    return {
      status: effectiveStatus,
      configured: this.liveSessionVerified || saConfigured,
      authRequired,
      credentialSource,
      verifiedAccountEmail: this.liveSessionVerified ? this.verifiedAccountEmail : null,
      grantedScopes: this.liveSessionVerified ? this.grantedScopes : [],
      tokenExpiresInSeconds: this.liveSessionVerified ? this.tokenExpiresInSeconds : null,
      spreadsheetId,
      spreadsheetUrl,
      lastSyncAt: saved?.lastSuccessAt ?? null,
      lastAttemptAt: saved?.lastAttemptAt ?? null,
      lastMode: saved?.lastSyncMode ?? null,
      tabRowCounts: saved?.tabRowCounts ?? {},
      tabStatuses: saved?.tabStatuses ?? {},
      rowsAdded: saved?.rowsAdded ?? 0,
      rowsUpdated: saved?.rowsUpdated ?? 0,
      rowsUnchanged: saved?.rowsUnchanged ?? 0,
      rowsSkipped: saved?.rowsSkipped ?? 0,
      rowsFailed: saved?.rowsFailed ?? 0,
      publicAccessStatus: saved?.publicAccessStatus ?? "unknown",
      publicViewerVerified: saved?.publicViewerVerified ?? false,
      publicAccessError: saved?.publicAccessError ?? null,
      lastError: saved?.lastError ?? null,
    };
  }

  private safeResolveTargetSpreadsheetId(overrideId?: string | null, createNew = false): string | null {
    try {
      return this.resolveTargetSpreadsheetId(overrideId, createNew);
    } catch {
      return createNew ? null : this.db.getSheetsSyncState()?.spreadsheetId ?? null;
    }
  }

  private splitRangeEntryInHalf(entry: {
    range: string;
    values: Array<Array<string | number>>;
  }): Array<{ range: string; values: Array<Array<string | number>> }> | null {
    if (entry.values.length <= 1) return null;
    const match = entry.range.match(/^(.+!A)(\d+):([A-Z]+)(\d+)$/);
    if (!match) return null;
    const [, prefix, startRowStr, colEnd, endRowStr] = match;
    const startRow = Number(startRowStr);
    const endRow = Number(endRowStr);
    if (!Number.isFinite(startRow) || !Number.isFinite(endRow)) return null;
    const mid = Math.floor(entry.values.length / 2);
    const firstValues = entry.values.slice(0, mid);
    const secondValues = entry.values.slice(mid);
    const firstEnd = startRow + firstValues.length - 1;
    const secondStart = firstEnd + 1;
    const secondEnd = secondStart + secondValues.length - 1;
    return [
      { range: `${prefix}${startRow}:${colEnd}${firstEnd}`, values: firstValues },
      { range: `${prefix}${secondStart}:${colEnd}${secondEnd}`, values: secondValues },
    ];
  }

  private isPayloadTooLargeError(err: unknown): boolean {
    if (err instanceof GoogleApiHttpError && err.httpStatus === 413) return true;
    const msg = err instanceof Error ? err.message : String(err);
    return /413|payload too large|request entity too large|exceeds the maximum allowed/i.test(msg);
  }

  private async sendBatchWithSplit(
    accessToken: string,
    spreadsheetId: string,
    batch: Array<{ range: string; values: Array<Array<string | number>> }>
  ): Promise<void> {
    if (batch.length === 0) return;
    try {
      await this.sheetsJson(accessToken, `/spreadsheets/${spreadsheetId}/values:batchUpdate`, {
        method: "POST",
        body: {
          valueInputOption: "RAW",
          data: batch,
        },
      });
    } catch (err) {
      if (!this.isPayloadTooLargeError(err)) {
        throw err;
      }
      if (batch.length > 1) {
        const mid = Math.floor(batch.length / 2);
        await this.sendBatchWithSplit(accessToken, spreadsheetId, batch.slice(0, mid));
        await this.sendBatchWithSplit(accessToken, spreadsheetId, batch.slice(mid));
        return;
      }
      const splitSingle = this.splitRangeEntryInHalf(batch[0]);
      if (splitSingle) {
        await this.sendBatchWithSplit(accessToken, spreadsheetId, [splitSingle[0]]);
        await this.sendBatchWithSplit(accessToken, spreadsheetId, [splitSingle[1]]);
        return;
      }
      throw err;
    }
  }

  private async batchWriteRanges(
    accessToken: string,
    spreadsheetId: string,
    dataEntries: Array<{ range: string; values: Array<Array<string | number>> }>
  ): Promise<void> {
    if (dataEntries.length === 0) return;

    const maxBytesPerCall = 750_000;
    const maxRowsPerCall = 1000;
    let currentBatch: Array<{ range: string; values: Array<Array<string | number>> }> = [];
    let currentRows = 0;
    let currentBytes = 0;

    const flushBatch = async () => {
      if (currentBatch.length === 0) return;
      const toSend = currentBatch;
      currentBatch = [];
      currentRows = 0;
      currentBytes = 0;
      await this.sendBatchWithSplit(accessToken, spreadsheetId, toSend);
    };

    for (const entry of dataEntries) {
      const entryBytes = Buffer.byteLength(JSON.stringify(entry), "utf-8");
      const entryRows = entry.values.length;
      if (
        currentBatch.length > 0 &&
        (currentBatch.length >= 200 ||
          currentRows + entryRows > maxRowsPerCall ||
          currentBytes + entryBytes > maxBytesPerCall)
      ) {
        await flushBatch();
      }
      currentBatch.push(entry);
      currentRows += entryRows;
      currentBytes += entryBytes;
    }
    await flushBatch();
  }

  private async verifyAnonymousSpreadsheetRead(
    spreadsheetId: string
  ): Promise<{ readable: boolean; status: number | null; detail: string }> {
    if (!this.publicCheckBase) {
      return {
        readable: true,
        status: null,
        detail: "Anonymous HTTP check skipped (local Drive mock mode).",
      };
    }
    const encodedId = encodeURIComponent(spreadsheetId);
    const probeUrl = `${this.publicCheckBase}/${encodedId}/gviz/tq?tqx=out:csv&sheet=Startups&tq=${encodeURIComponent("select A limit 2")}`;
    try {
      const resp = await fetch(probeUrl, {
        method: "GET",
        redirect: "manual",
        headers: {
          Accept: "text/csv,text/plain;q=0.9,*/*;q=0.8",
        },
      });
      const location = resp.headers.get("location") || "";
      if (resp.status >= 300 && resp.status < 400) {
        if (/accounts\.google\.com|ServiceLogin/i.test(location)) {
          return {
            readable: false,
            status: resp.status,
            detail: `Unauthenticated request redirected to Google Sign-In (${resp.status}). Public Viewer access is NOT active.`,
          };
        }
        return {
          readable: false,
          status: resp.status,
          detail: `Unauthenticated request returned unexpected redirect (${resp.status}${location ? ` -> ${redactSecrets(location)}` : ""}).`,
        };
      }
      if (resp.status === 200) {
        const body = await resp.text();
        if (/accounts\.google\.com\/ServiceLogin|Sign in - Google Accounts/i.test(body)) {
          return {
            readable: false,
            status: 200,
            detail: "Unauthenticated request returned Google Sign-In HTML page instead of spreadsheet CSV.",
          };
        }
        return {
          readable: true,
          status: 200,
          detail: "Separate unauthenticated HTTP GET returned HTTP 200 CSV data.",
        };
      }
      return {
        readable: false,
        status: resp.status,
        detail: `Unauthenticated read check returned HTTP ${resp.status}.`,
      };
    } catch (err) {
      return {
        readable: false,
        status: null,
        detail: `Unauthenticated read check failed: ${redactSecrets(err instanceof Error ? err.message : String(err))}`,
      };
    }
  }

  private async ensureAndVerifyPublicViewerAccess(
    accessToken: string,
    spreadsheetId: string
  ): Promise<{
    status: PublicAccessStatus;
    verified: boolean;
    permissionId: string | null;
    error: string | null;
  }> {
    if (Boolean(this.config.apiBaseUrl) && !this.config.driveApiBaseUrl) {
      return {
        status: "not_configured",
        verified: false,
        permissionId: null,
        error: "Google Drive Permissions API endpoint not configured for this test harness; public link access not verified.",
      };
    }

    const encodedId = encodeURIComponent(spreadsheetId);
    const hasPublicViewerRole = (perms: Array<{ id?: string; type?: string; role?: string }>) =>
      perms.find(
        (p) =>
          p.type === "anyone" &&
          (p.role === "reader" || p.role === "commenter" || p.role === "writer")
      );

    try {
      const existing = await this.driveJson<{
        permissions?: Array<{ id?: string; type?: string; role?: string; allowFileDiscovery?: boolean }>;
      }>(
        accessToken,
        `/files/${encodedId}/permissions?fields=permissions(id,type,role,allowFileDiscovery)&supportsAllDrives=true`
      );
      let matched = hasPublicViewerRole(existing.permissions ?? []);

      if (!matched) {
        await this.driveJson<{ id?: string; type?: string; role?: string }>(
          accessToken,
          `/files/${encodedId}/permissions?supportsAllDrives=true`,
          {
            method: "POST",
            body: {
              role: "reader",
              type: "anyone",
              allowFileDiscovery: false,
            },
          }
        );
        // Verify via an actual Drive permissions read-back response
        const readback = await this.driveJson<{
          permissions?: Array<{ id?: string; type?: string; role?: string; allowFileDiscovery?: boolean }>;
        }>(
          accessToken,
          `/files/${encodedId}/permissions?fields=permissions(id,type,role,allowFileDiscovery)&supportsAllDrives=true`
        );
        matched = hasPublicViewerRole(readback.permissions ?? []);
      }

      if (matched) {
        const anonRead = await this.verifyAnonymousSpreadsheetRead(spreadsheetId);
        if (!anonRead.readable) {
          return {
            status: "policy_blocked",
            verified: false,
            permissionId: matched.id ?? null,
            error: `Drive permissions listed 'anyone' (${matched.role}), but unauthenticated verification failed: ${anonRead.detail}`,
          };
        }
        return {
          status: "public_viewer",
          verified: true,
          permissionId: matched.id ?? null,
          error: null,
        };
      }
      return {
        status: "policy_blocked",
        verified: false,
        permissionId: null,
        error:
          "Google Drive permissions read-back did not confirm 'Anyone with the link — Viewer'. Check Drive sharing settings.",
      };
    } catch (err) {
      const msg = redactSecrets(err instanceof Error ? err.message : String(err));
      const isPolicyOrPerm =
        err instanceof GoogleApiHttpError && (err.httpStatus === 403 || err.httpStatus === 400);
      return {
        status: isPolicyOrPerm ? "policy_blocked" : "unknown",
        verified: false,
        permissionId: null,
        error: isPolicyOrPerm
          ? `Public link sharing ("Anyone with the link — Viewer") was blocked by Google Workspace/Drive policy or missing Drive permissions (${msg}). Data was still written to the spreadsheet; download the 6-CSV ZIP bundle for external sharing.`
          : `Unable to verify Google Drive public Viewer access (${msg}).`,
      };
    }
  }

  public async verifyConnection(opts?: {
    oauthAccessToken?: string | null;
    spreadsheetId?: string | null;
    createNew?: boolean;
  }): Promise<SheetsConnectionStatus> {
    const attemptAt = new Date().toISOString();
    const prev = this.db.getSheetsSyncState();
    const cleanOauth = this.sanitizeOAuthToken(opts?.oauthAccessToken);
    const hasOauth = Boolean(cleanOauth);
    const createNew = Boolean(opts?.createNew);
    if (!hasOauth && !this.isConfigured()) {
      this.liveSessionVerified = false;
      this.liveCredentialSource = null;
      this.verifiedAccountEmail = null;
      this.grantedScopes = [];
      this.tokenExpiresInSeconds = null;
      this.db.saveSheetsSyncState({
        status: "Not Connected",
        spreadsheetId: this.safeResolveTargetSpreadsheetId(opts?.spreadsheetId, createNew),
        spreadsheetUrl: createNew ? null : prev?.spreadsheetUrl ?? null,
        clearSpreadsheetTarget: createNew,
        lastSyncMode: prev?.lastSyncMode ?? null,
        lastAttemptAt: attemptAt,
        lastSuccessAt: prev?.lastSuccessAt ?? null,
        tabRowCounts: prev?.tabRowCounts ?? {},
        rowsAdded: prev?.rowsAdded ?? 0,
        rowsUpdated: prev?.rowsUpdated ?? 0,
        rowsUnchanged: prev?.rowsUnchanged ?? 0,
        lastError:
          "Google Service Account credentials are required. Paste a Service Account JSON key in the Setup Panel or configure GOOGLE_SHEETS_CREDENTIALS_JSON in the server environment.",
      });
      return { ...this.getStatus(), authRequired: true };
    }

    try {
      const auth = await this.resolveAuthToken(opts?.oauthAccessToken);
      const explicitTargetId =
        Boolean(opts?.spreadsheetId?.trim()) || (!createNew && Boolean(this.config.spreadsheetId?.trim()));
      let resolvedTargetId = this.resolveTargetSpreadsheetId(opts?.spreadsheetId, createNew);
      let spreadsheetUrl = createNew && !resolvedTargetId ? null : resolvedTargetId ? canonicalSpreadsheetUrl(resolvedTargetId) : prev?.spreadsheetUrl ?? null;
      let clearedStaleTarget = createNew && !resolvedTargetId;

      if (!this.config.apiBaseUrl || Boolean(this.config.driveApiBaseUrl)) {
        await this.driveJson<{ files?: Array<{ id?: string; name?: string }> }>(
          auth.accessToken,
          "/files?pageSize=1&fields=files(id,name)"
        );
      }

      if (resolvedTargetId) {
        try {
          const meta = await this.sheetsJson<{ spreadsheetId: string; spreadsheetUrl?: string }>(
            auth.accessToken,
            `/spreadsheets/${resolvedTargetId}?fields=spreadsheetId,spreadsheetUrl`
          );
          resolvedTargetId = meta.spreadsheetId || resolvedTargetId;
          spreadsheetUrl = canonicalSpreadsheetUrl(resolvedTargetId);
        } catch (sheetErr) {
          if (
            !explicitTargetId &&
            sheetErr instanceof GoogleApiHttpError &&
            (sheetErr.httpStatus === 403 || sheetErr.httpStatus === 404)
          ) {
            resolvedTargetId = null;
            spreadsheetUrl = null;
            clearedStaleTarget = true;
          } else {
            throw sheetErr;
          }
        }
      }

      this.liveSessionVerified = true;
      this.liveCredentialSource = auth.credentialSource;
      this.verifiedAccountEmail = auth.email;
      this.grantedScopes = auth.scopes;
      this.tokenExpiresInSeconds = auth.expiresInSeconds;

      this.db.saveSheetsSyncState({
        status: "Connected",
        spreadsheetId: resolvedTargetId,
        spreadsheetUrl,
        clearSpreadsheetTarget: clearedStaleTarget,
        lastSyncMode: prev?.lastSyncMode ?? "verify",
        lastAttemptAt: attemptAt,
        lastSuccessAt: prev?.lastSuccessAt ?? null,
        tabRowCounts: prev?.tabRowCounts ?? {},
        rowsAdded: prev?.rowsAdded ?? 0,
        rowsUpdated: prev?.rowsUpdated ?? 0,
        rowsUnchanged: prev?.rowsUnchanged ?? 0,
        lastError: null,
      });
      return { ...this.getStatus(), authRequired: false };
    } catch (err) {
      this.liveSessionVerified = false;
      this.liveCredentialSource = null;
      this.verifiedAccountEmail = null;
      this.grantedScopes = [];
      this.tokenExpiresInSeconds = null;
      const isAuthErr = err instanceof GoogleApiHttpError && err.httpStatus === 401;
      const safeErr = redactSecrets(err instanceof Error ? err.message : String(err));
      this.db.saveSheetsSyncState({
        status: "Sync Failed",
        spreadsheetId: this.safeResolveTargetSpreadsheetId(opts?.spreadsheetId),
        spreadsheetUrl: prev?.spreadsheetUrl ?? null,
        lastSyncMode: "verify",
        lastAttemptAt: attemptAt,
        lastSuccessAt: prev?.lastSuccessAt ?? null,
        tabRowCounts: prev?.tabRowCounts ?? {},
        rowsAdded: prev?.rowsAdded ?? 0,
        rowsUpdated: prev?.rowsUpdated ?? 0,
        rowsUnchanged: prev?.rowsUnchanged ?? 0,
        lastError: safeErr,
      });
      return { ...this.getStatus(), authRequired: isAuthErr };
    }
  }

  public async probeHealth(opts?: {
    oauthAccessToken?: string | null;
    spreadsheetId?: string | null;
  }): Promise<{
    status: IntegrationConnectionStatus;
    error: string | null;
    detail: string;
    credentialSource: "oauth" | "path" | "json_env" | "saved_config" | null;
    spreadsheetId: string | null;
    spreadsheetUrl: string | null;
    checkedAt: string;
  }> {
    const checkedAt = new Date().toISOString();
    const hasOauth = Boolean(this.sanitizeOAuthToken(opts?.oauthAccessToken));
    const saSource = this.getCredentialSource();
    const credentialSource: "oauth" | "path" | "json_env" | "saved_config" | null = hasOauth ? "oauth" : saSource;

    if (!hasOauth && !saSource) {
      this.liveSessionVerified = false;
      this.liveCredentialSource = null;
      this.verifiedAccountEmail = null;
      const saved = this.db.getSheetsSyncState();
      const savedId = this.safeResolveTargetSpreadsheetId(opts?.spreadsheetId) ?? saved?.spreadsheetId ?? null;
      return {
        status: "Not Configured",
        error: null,
        detail: "Google Service Account JSON not configured yet. Paste Service Account credentials in the Setup Panel or set GOOGLE_SHEETS_CREDENTIALS_JSON.",
        credentialSource: null,
        spreadsheetId: savedId,
        spreadsheetUrl: savedId ? canonicalSpreadsheetUrl(savedId) : saved?.spreadsheetUrl ?? null,
        checkedAt,
      };
    }

    const verified = await this.verifyConnection(opts);
    if (verified.status === "Connected") {
      return {
        status: "Configured",
        error: null,
        detail: verified.spreadsheetId
          ? `Verified live ${credentialSource === "oauth" ? "Google OAuth" : "Service Account"} access to spreadsheet ${verified.spreadsheetId}.`
          : `Verified live ${credentialSource === "oauth" ? "Google OAuth" : "Service Account"} Drive & Sheets readiness.`,
        credentialSource,
        spreadsheetId: verified.spreadsheetId,
        spreadsheetUrl: verified.spreadsheetUrl,
        checkedAt,
      };
    }

    return {
      status: "Connection Failed",
      error: verified.lastError || "Google Workspace verification failed.",
      detail: verified.lastError || "Google Workspace verification failed.",
      credentialSource,
      spreadsheetId: verified.spreadsheetId,
      spreadsheetUrl: verified.spreadsheetUrl,
      checkedAt,
    };
  }

  public async exportOrSync(
    mode: "full" | "incremental",
    opts?: {
      oauthAccessToken?: string | null;
      spreadsheetId?: string | null;
      createNew?: boolean;
      exportScope?: ExportScope;
    }
  ): Promise<SheetsSyncResult> {
    const attemptAt = new Date().toISOString();
    const prev = this.db.getSheetsSyncState();
    const hasOauth = Boolean(this.sanitizeOAuthToken(opts?.oauthAccessToken));
    const createNew = Boolean(opts?.createNew);
    const exportScope: ExportScope = opts?.exportScope ?? "all";
    const steps: ExportStepStatus[] = [];
    const emptySkippedBreakdown = {
      rejected: 0,
      stale24h: 0,
      duplicateOrInvalid: 0,
      unchanged: 0,
    };

    if (!hasOauth && !this.isConfigured()) {
      this.liveSessionVerified = false;
      this.liveCredentialSource = null;
      const errMsg =
        "Google Service Account credentials are required. Paste your Service Account JSON key in the Setup Panel or configure GOOGLE_SHEETS_CREDENTIALS_JSON in the server environment.";
      steps.push({
        step: 1,
        key: "auth",
        label: "Connect or configure Google access",
        status: "failed",
        detail: errMsg,
      });
      this.db.saveSheetsSyncState({
        status: "Not Connected",
        spreadsheetId: this.safeResolveTargetSpreadsheetId(opts?.spreadsheetId, createNew),
        spreadsheetUrl: createNew ? null : prev?.spreadsheetUrl ?? null,
        clearSpreadsheetTarget: createNew,
        lastSyncMode: mode,
        lastAttemptAt: attemptAt,
        lastSuccessAt: prev?.lastSuccessAt ?? null,
        tabRowCounts: prev?.tabRowCounts ?? {},
        rowsAdded: 0,
        rowsUpdated: 0,
        rowsUnchanged: 0,
        rowsSkipped: 0,
        rowsFailed: 0,
        publicAccessStatus: "not_configured",
        publicViewerVerified: false,
        publicAccessError: null,
        lastError: errMsg,
      });
      return {
        success: false,
        mode,
        exportScope,
        status: "Not Connected",
        authRequired: true,
        spreadsheetId: null,
        spreadsheetUrl: null,
        tabRowCounts: {},
        verifiedTabRowCounts: {},
        tabStatuses: {},
        rowsAdded: 0,
        rowsUpdated: 0,
        rowsUnchanged: 0,
        rowsSkipped: 0,
        rowsFailed: 0,
        skippedBreakdown: emptySkippedBreakdown,
        publicAccessStatus: "not_configured",
        publicViewerVerified: false,
        publicAccessError: null,
        steps,
        syncedAt: null,
        error: errMsg,
      };
    }

    try {
      const auth = await this.resolveAuthToken(opts?.oauthAccessToken);
      const accessToken = auth.accessToken;
      steps.push({
        step: 1,
        key: "auth",
        label: "Connect or configure Google access",
        status: "completed",
        detail: `Authenticated via ${auth.credentialSource === "oauth" ? "Google OAuth" : "Service Account"}${auth.email ? ` (${auth.email})` : ""}.`,
      });
      steps.push({
        step: 2,
        key: "connection",
        label: "Test connection",
        status: "completed",
        detail: "Verified Sheets & Drive API access token.",
      });

      const { spreadsheetId, spreadsheetUrl, sheetPropsByTitle } =
        await this.ensureSpreadsheetAndTabs(accessToken, opts?.spreadsheetId, createNew);
      steps.push({
        step: 3,
        key: "spreadsheet",
        label: "Create or select target spreadsheet",
        status: "completed",
        detail: `Using spreadsheet ${spreadsheetId} with all 6 required tabs.`,
      });

      const batchSize = 250;
      const tabRowCounts: Record<string, number> = {};
      const verifiedTabRowCounts: Record<string, number> = {};
      const tabStatuses: Record<string, TabExportStatus> = {};
      let totalAdded = 0;
      let totalUpdated = 0;
      let totalUnchanged = 0;
      let totalRejectedSkipped = 0;
      let totalStale24hSkipped = 0;
      let totalDupOrInvalidSkipped = 0;
      let totalFailedRows = 0;

      const canonicalNames = this.db.fetchCanonicalNameMap();
      const refNow = new Date();
      const preparedByTab = new Map<
        string,
        ReturnType<GoogleSheetsService["buildDeduplicatedTabRows"]>
      >();
      for (const spec of EXPORT_SPECS) {
        const prep = this.buildDeduplicatedTabRows(spec, canonicalNames, {
          exportScope,
          freshnessWindowHours: this.config.freshnessWindowHours ?? 24,
          refNow,
        });
        preparedByTab.set(spec.tabName, prep);
        totalRejectedSkipped += prep.skippedRejected;
        totalStale24hSkipped += prep.skippedStale24h;
        totalDupOrInvalidSkipped += prep.skippedDuplicate;
        totalFailedRows += prep.failedValidation;
      }

      if (mode === "full") {
        const formatRequests: Array<Record<string, unknown>> = [];
        for (const spec of EXPORT_SPECS) {
          const sheetMeta = sheetPropsByTitle.get(spec.tabName);
          if (!sheetMeta) continue;
          const prep = preparedByTab.get(spec.tabName)!;
          const rowsNeeded = prep.orderedIds.length + 1;
          const colsNeeded = spec.columns.length;
          if (rowsNeeded > sheetMeta.rowCount || colsNeeded > sheetMeta.columnCount) {
            formatRequests.push({
              updateSheetProperties: {
                properties: {
                  sheetId: sheetMeta.sheetId,
                  gridProperties: {
                    rowCount: Math.max(sheetMeta.rowCount, rowsNeeded + 50),
                    columnCount: Math.max(sheetMeta.columnCount, colsNeeded),
                    frozenRowCount: 1,
                  },
                },
                fields: "gridProperties.rowCount,gridProperties.columnCount,gridProperties.frozenRowCount",
              },
            });
            sheetMeta.rowCount = Math.max(sheetMeta.rowCount, rowsNeeded + 50);
            sheetMeta.columnCount = Math.max(sheetMeta.columnCount, colsNeeded);
          } else {
            formatRequests.push({
              updateSheetProperties: {
                properties: {
                  sheetId: sheetMeta.sheetId,
                  gridProperties: { frozenRowCount: 1 },
                },
                fields: "gridProperties.frozenRowCount",
              },
            });
          }
          formatRequests.push({
            repeatCell: {
              range: {
                sheetId: sheetMeta.sheetId,
                startRowIndex: 0,
                endRowIndex: 1,
                startColumnIndex: 0,
                endColumnIndex: colsNeeded,
              },
              cell: {
                userEnteredFormat: { textFormat: { bold: true } },
              },
              fields: "userEnteredFormat.textFormat.bold",
            },
          });
        }
        if (formatRequests.length > 0) {
          await this.sheetsJson(accessToken, `/spreadsheets/${spreadsheetId}:batchUpdate`, {
            method: "POST",
            body: { requests: formatRequests },
          });
        }

        await this.sheetsJson(accessToken, `/spreadsheets/${spreadsheetId}/values:batchClear`, {
          method: "POST",
          body: {
            ranges: EXPORT_SPECS.map((s) => `'${s.tabName}'`),
          },
        });
      }

      let fatalAuthOrTargetError: string | null = null;
      for (const spec of EXPORT_SPECS) {
        const { orderedIds, rowMap } = preparedByTab.get(spec.tabName)!;
        const expectedRows = orderedIds.length;

        if (fatalAuthOrTargetError) {
          tabStatuses[spec.tabName] = {
            tabName: spec.tabName,
            status: "failed",
            expectedRows,
            writtenRows: 0,
            verifiedRows: 0,
            error: fatalAuthOrTargetError,
            message: `Skipped after earlier failure: ${fatalAuthOrTargetError}`,
          };
          verifiedTabRowCounts[spec.tabName] = 0;
          totalFailedRows += expectedRows;
          continue;
        }

        try {
          const sheetMeta = sheetPropsByTitle.get(spec.tabName);
          const colEnd = columnLetter(spec.columns.length);

          if (mode === "full") {
            const allValues: Array<Array<string | number>> = [
              spec.columns,
              ...orderedIds.map((id) => rowMap.get(id)!),
            ];
            const writeRanges: Array<{ range: string; values: Array<Array<string | number>> }> = [];
            for (let startIdx = 0; startIdx < allValues.length; startIdx += batchSize) {
              const chunk = allValues.slice(startIdx, startIdx + batchSize);
              const startRow = startIdx + 1;
              const endRow = startIdx + chunk.length;
              writeRanges.push({
                range: `'${spec.tabName}'!A${startRow}:${colEnd}${endRow}`,
                values: chunk,
              });
            }
            await this.batchWriteRanges(accessToken, spreadsheetId, writeRanges);
            totalAdded += expectedRows;
            tabRowCounts[spec.tabName] = expectedRows;
          } else {
            const readRange = encodeURIComponent(`'${spec.tabName}'!A1:${colEnd}`);
            const existingResp = await this.sheetsJson<{ values?: unknown[][] }>(
              accessToken,
              `/spreadsheets/${spreadsheetId}/values/${readRange}?majorDimension=ROWS`
            );
            const existingValues = existingResp.values ?? [];
            const hasHeader =
              existingValues.length > 0 &&
              existingValues[0]?.[0] === spec.columns[0] &&
              existingValues[0]?.length === spec.columns.length;

            const existingRowById = new Map<string, { rowNum: number; cells: string[] }>();
            let duplicateDetectedInSheet = false;
            for (let i = 1; i < existingValues.length; i++) {
              const row = existingValues[i] ?? [];
              const idVal = String(row[0] ?? "").trim();
              if (!idVal) continue;
              if (existingRowById.has(idVal)) {
                duplicateDetectedInSheet = true;
                continue;
              }
              existingRowById.set(idVal, {
                rowNum: i + 1,
                cells: spec.columns.map((_, idx) => String(row[idx] ?? "")),
              });
            }

            if (duplicateDetectedInSheet || (!hasHeader && existingValues.length > 0)) {
              const allValues: Array<Array<string | number>> = [
                spec.columns,
                ...orderedIds.map((id) => rowMap.get(id)!),
              ];
              if (sheetMeta) {
                await this.ensureGridSizeAndHeaderStyle(
                  accessToken,
                  spreadsheetId,
                  sheetMeta,
                  allValues.length,
                  spec.columns.length
                );
              }
              const clearRange = encodeURIComponent(`'${spec.tabName}'`);
              await this.sheetsJson(
                accessToken,
                `/spreadsheets/${spreadsheetId}/values/${clearRange}:clear`,
                { method: "POST", body: {} }
              );
              const ranges: Array<{ range: string; values: Array<Array<string | number>> }> = [];
              for (let startIdx = 0; startIdx < allValues.length; startIdx += batchSize) {
                const chunk = allValues.slice(startIdx, startIdx + batchSize);
                const startRow = startIdx + 1;
                const endRow = startIdx + chunk.length;
                ranges.push({
                  range: `'${spec.tabName}'!A${startRow}:${colEnd}${endRow}`,
                  values: chunk,
                });
              }
              await this.batchWriteRanges(accessToken, spreadsheetId, ranges);
              totalAdded += expectedRows;
              tabRowCounts[spec.tabName] = expectedRows;
            } else {
              const updates: Array<{ range: string; values: Array<Array<string | number>> }> = [];
              const appends: Array<Array<string | number>> = [];

              if (!hasHeader) {
                updates.push({
                  range: `'${spec.tabName}'!A1:${colEnd}1`,
                  values: [spec.columns],
                });
              }

              for (const id of orderedIds) {
                const targetRow = rowMap.get(id)!;
                const existing = existingRowById.get(id);
                if (!existing) {
                  appends.push(targetRow);
                } else {
                  const targetStrings = targetRow.map((v) => String(v));
                  const changed = targetStrings.some((v, idx) => v !== existing.cells[idx]);
                  if (changed) {
                    updates.push({
                      range: `'${spec.tabName}'!A${existing.rowNum}:${colEnd}${existing.rowNum}`,
                      values: [targetRow],
                    });
                    totalUpdated += 1;
                  } else {
                    totalUnchanged += 1;
                  }
                }
              }

              const lastExistingRowNum = Math.max(1, existingValues.length);
              const finalRowsNeeded = lastExistingRowNum + appends.length;
              if (sheetMeta) {
                await this.ensureGridSizeAndHeaderStyle(
                  accessToken,
                  spreadsheetId,
                  sheetMeta,
                  finalRowsNeeded,
                  spec.columns.length
                );
              }

              for (let i = 0; i < appends.length; i += batchSize) {
                const chunk = appends.slice(i, i + batchSize);
                const startRow = lastExistingRowNum + 1 + i;
                const endRow = startRow + chunk.length - 1;
                updates.push({
                  range: `'${spec.tabName}'!A${startRow}:${colEnd}${endRow}`,
                  values: chunk,
                });
              }

              await this.batchWriteRanges(accessToken, spreadsheetId, updates);
              totalAdded += appends.length;
              tabRowCounts[spec.tabName] = expectedRows;
            }
          }

          const { headerValid, verifiedRows, duplicateCount } = await this.verifyWrittenTab(
            accessToken,
            spreadsheetId,
            spec
          );
          verifiedTabRowCounts[spec.tabName] = verifiedRows;

          if (!headerValid) {
            tabStatuses[spec.tabName] = {
              tabName: spec.tabName,
              status: "failed",
              expectedRows,
              writtenRows: expectedRows,
              verifiedRows,
              error: `Header column mismatch on '${spec.tabName}'`,
              message: `Verification failed: expected header '${spec.columns[0]}' in A1`,
            };
            totalFailedRows += expectedRows;
          } else if (duplicateCount > 0) {
            tabStatuses[spec.tabName] = {
              tabName: spec.tabName,
              status: "failed",
              expectedRows,
              writtenRows: expectedRows,
              verifiedRows,
              error: `Duplicate rows detected on '${spec.tabName}' (${duplicateCount} duplicate IDs)`,
              message: `Verification failed: ${duplicateCount} duplicate IDs found`,
            };
            totalFailedRows += duplicateCount;
          } else if (mode === "incremental" ? verifiedRows < expectedRows : verifiedRows !== expectedRows) {
            tabStatuses[spec.tabName] = {
              tabName: spec.tabName,
              status: "failed",
              expectedRows,
              writtenRows: expectedRows,
              verifiedRows,
              error: `Row count mismatch (${verifiedRows} verified vs ${expectedRows} expected)`,
              message: `Verification mismatch: ${verifiedRows.toLocaleString()} verified vs ${expectedRows.toLocaleString()} DB rows`,
            };
            totalFailedRows += Math.abs(expectedRows - verifiedRows);
          } else {
            tabStatuses[spec.tabName] = {
              tabName: spec.tabName,
              status: "success",
              expectedRows,
              writtenRows: expectedRows,
              verifiedRows,
              error: null,
              message:
                verifiedRows > expectedRows
                  ? `Verified ${verifiedRows.toLocaleString()} rows (${expectedRows.toLocaleString()} current + ${(verifiedRows - expectedRows).toLocaleString()} preserved)`
                  : `Verified ${verifiedRows.toLocaleString()} rows`,
            };
          }
        } catch (tabErr) {
          const tabMsg = redactSecrets(tabErr instanceof Error ? tabErr.message : String(tabErr));
          verifiedTabRowCounts[spec.tabName] = 0;
          totalFailedRows += expectedRows;
          tabStatuses[spec.tabName] = {
            tabName: spec.tabName,
            status: "failed",
            expectedRows,
            writtenRows: 0,
            verifiedRows: 0,
            error: tabMsg,
            message: `Failed: ${tabMsg}`,
          };
          if (tabErr instanceof GoogleApiHttpError && tabErr.httpStatus === 401) {
            this.liveSessionVerified = false;
            this.liveCredentialSource = null;
          }
          if (/HTTP (401|403|404)/.test(tabMsg)) {
            fatalAuthOrTargetError = tabMsg;
          }
        }
      }

      const skippedBreakdown = {
        rejected: totalRejectedSkipped,
        stale24h: totalStale24hSkipped,
        duplicateOrInvalid: totalDupOrInvalidSkipped,
        unchanged: totalUnchanged,
      };
      const totalSkipped =
        totalRejectedSkipped + totalStale24hSkipped + totalDupOrInvalidSkipped + totalUnchanged;

      const failedTabs = EXPORT_SPECS.filter((s) => tabStatuses[s.tabName]?.status !== "success");
      const allSixSucceeded = failedTabs.length === 0;
      const syncedAt = new Date().toISOString();

      steps.push({
        step: 4,
        key: "write_tabs",
        label: "Export all six datasets",
        status: allSixSucceeded ? "completed" : "failed",
        detail: allSixSucceeded
          ? `Wrote ${Object.values(tabRowCounts).reduce((a, b) => a + b, 0).toLocaleString()} records across 6 tabs (+${totalAdded} inserted, ~${totalUpdated} updated, ${totalSkipped} skipped).`
          : `Failed writing one or more tabs (${failedTabs.map((t) => t.tabName).join(", ")}).`,
      });
      steps.push({
        step: 5,
        key: "verify_tabs",
        label: "Verify row counts in each tab",
        status: allSixSucceeded ? "completed" : "failed",
        detail: allSixSucceeded
          ? EXPORT_SPECS.map((s) => `${s.tabName}: ${verifiedTabRowCounts[s.tabName] ?? 0}`).join(" · ")
          : `${6 - failedTabs.length}/6 tabs verified.`,
      });

      if (!allSixSucceeded) {
        const failedSummary = failedTabs
          .map((s) => `${s.tabName} (${tabStatuses[s.tabName]?.error || "verification failed"})`)
          .join("; ");
        const errMsg = `${6 - failedTabs.length}/6 tabs verified. Failed tabs: ${failedSummary}`;
        const authRequired = /HTTP 401/i.test(errMsg);
        if (authRequired) {
          this.liveSessionVerified = false;
          this.liveCredentialSource = null;
        }
        steps.push({
          step: 6,
          key: "public_access",
          label: "Verify public Viewer access",
          status: "skipped",
          detail: "Skipped public permission check because worksheet verification did not complete.",
        });
        steps.push({
          step: 7,
          key: "share_url",
          label: "Display shareable Google Sheets URL",
          status: "skipped",
          detail: "Spreadsheet URL withheld until all 6 tabs pass verification.",
        });
        const preservedUrl = prev?.lastSuccessAt ? (prev.spreadsheetUrl ?? null) : null;
        const preservedId = prev?.lastSuccessAt ? (prev.spreadsheetId ?? spreadsheetId) : spreadsheetId;
        this.db.saveSheetsSyncState({
          status: "Sync Failed",
          spreadsheetId: preservedId,
          spreadsheetUrl: preservedUrl,
          lastSyncMode: mode,
          lastAttemptAt: attemptAt,
          lastSuccessAt: prev?.lastSuccessAt ?? null,
          tabRowCounts: prev?.lastSuccessAt ? (prev.tabRowCounts ?? verifiedTabRowCounts) : verifiedTabRowCounts,
          tabStatuses,
          rowsAdded: totalAdded,
          rowsUpdated: totalUpdated,
          rowsUnchanged: totalUnchanged,
          rowsSkipped: totalSkipped,
          rowsFailed: totalFailedRows,
          publicAccessStatus: prev?.lastSuccessAt ? (prev.publicAccessStatus ?? "unknown") : "unknown",
          publicViewerVerified: prev?.lastSuccessAt ? Boolean(prev.publicViewerVerified) : false,
          publicAccessError: prev?.lastSuccessAt ? (prev.publicAccessError ?? null) : null,
          lastError: errMsg,
        });
        return {
          success: false,
          mode,
          exportScope,
          status: "Sync Failed",
          authRequired,
          spreadsheetId: preservedId,
          spreadsheetUrl: preservedUrl,
          tabRowCounts,
          verifiedTabRowCounts,
          tabStatuses,
          rowsAdded: totalAdded,
          rowsUpdated: totalUpdated,
          rowsUnchanged: totalUnchanged,
          rowsSkipped: totalSkipped,
          rowsFailed: totalFailedRows,
          skippedBreakdown,
          publicAccessStatus: "unknown",
          publicViewerVerified: false,
          publicAccessError: null,
          steps,
          syncedAt: null,
          error: errMsg,
        };
      }

      const publicShare = await this.ensureAndVerifyPublicViewerAccess(accessToken, spreadsheetId);

      // Final existence check via Sheets API before persisting/returning final /edit URL
      const existenceCheck = await this.sheetsJson<{ spreadsheetId: string; spreadsheetUrl?: string }>(
        accessToken,
        `/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=spreadsheetId,spreadsheetUrl`
      );
      const finalSpreadsheetId = existenceCheck.spreadsheetId || spreadsheetId;
      const finalSpreadsheetUrl = canonicalSpreadsheetUrl(finalSpreadsheetId);

      steps.push({
        step: 6,
        key: "public_access",
        label: "Verify public Viewer access",
        status: publicShare.verified
          ? "completed"
          : publicShare.status === "policy_blocked"
          ? "blocked"
          : "failed",
        detail: publicShare.verified
          ? `Confirmed 'Anyone with the link — Viewer' via Google Drive Permissions API${publicShare.permissionId ? ` (permission ${publicShare.permissionId})` : ""}.`
          : publicShare.error || "Public Viewer permission could not be verified.",
      });
      steps.push({
        step: 7,
        key: "share_url",
        label: "Display shareable Google Sheets URL",
        status: "completed",
        detail: publicShare.verified
          ? `Public link ready: ${finalSpreadsheetUrl}`
          : `Private spreadsheet URL: ${finalSpreadsheetUrl} (public link blocked/unverified — use ZIP fallback for external viewers if needed).`,
      });

      this.liveSessionVerified = true;
      this.liveCredentialSource = auth.credentialSource;
      this.verifiedAccountEmail = auth.email;
      this.grantedScopes = auth.scopes;
      this.tokenExpiresInSeconds = auth.expiresInSeconds;

      this.db.saveSheetsSyncState({
        status: "Connected",
        spreadsheetId: finalSpreadsheetId,
        spreadsheetUrl: finalSpreadsheetUrl,
        lastSyncMode: mode,
        lastAttemptAt: attemptAt,
        lastSuccessAt: syncedAt,
        tabRowCounts: verifiedTabRowCounts,
        tabStatuses,
        rowsAdded: totalAdded,
        rowsUpdated: totalUpdated,
        rowsUnchanged: totalUnchanged,
        rowsSkipped: totalSkipped,
        rowsFailed: totalFailedRows,
        publicAccessStatus: publicShare.status,
        publicViewerVerified: publicShare.verified,
        publicAccessError: publicShare.error,
        lastError: null,
      });

      return {
        success: true,
        mode,
        exportScope,
        status: "Connected",
        authRequired: false,
        spreadsheetId: finalSpreadsheetId,
        spreadsheetUrl: finalSpreadsheetUrl,
        tabRowCounts,
        verifiedTabRowCounts,
        tabStatuses,
        rowsAdded: totalAdded,
        rowsUpdated: totalUpdated,
        rowsUnchanged: totalUnchanged,
        rowsSkipped: totalSkipped,
        rowsFailed: totalFailedRows,
        skippedBreakdown,
        publicAccessStatus: publicShare.status,
        publicViewerVerified: publicShare.verified,
        publicAccessError: publicShare.error,
        steps,
        syncedAt,
        error: null,
      };
    } catch (err) {
      const msg = redactSecrets(err instanceof Error ? err.message : String(err));
      const authRequired =
        (err instanceof GoogleApiHttpError && err.httpStatus === 401) || /HTTP 401/i.test(msg);
      if (authRequired) {
        this.liveSessionVerified = false;
        this.liveCredentialSource = null;
        this.verifiedAccountEmail = null;
      }
      if (steps.length === 0) {
        steps.push({
          step: 1,
          key: "auth",
          label: "Connect or configure Google access",
          status: "failed",
          detail: msg,
        });
      }
      const targetId = this.safeResolveTargetSpreadsheetId(opts?.spreadsheetId, createNew);
      const tabStatuses: Record<string, TabExportStatus> = {};
      for (const spec of EXPORT_SPECS) {
        tabStatuses[spec.tabName] = {
          tabName: spec.tabName,
          status: "failed",
          expectedRows: 0,
          writtenRows: 0,
          verifiedRows: 0,
          error: msg,
          message: `Failed: ${msg}`,
        };
      }
      const hasPriorValid = Boolean(!createNew && prev?.lastSuccessAt && prev?.spreadsheetUrl);
      this.db.saveSheetsSyncState({
        status: "Sync Failed",
        spreadsheetId: hasPriorValid ? (prev?.spreadsheetId ?? targetId) : targetId,
        spreadsheetUrl: hasPriorValid ? (prev?.spreadsheetUrl ?? null) : null,
        lastSyncMode: mode,
        lastAttemptAt: attemptAt,
        lastSuccessAt: prev?.lastSuccessAt ?? null,
        tabRowCounts: prev?.tabRowCounts ?? {},
        tabStatuses,
        rowsAdded: 0,
        rowsUpdated: 0,
        rowsUnchanged: 0,
        rowsSkipped: 0,
        rowsFailed: 0,
        publicAccessStatus: hasPriorValid ? (prev?.publicAccessStatus ?? "unknown") : "unknown",
        publicViewerVerified: hasPriorValid ? Boolean(prev?.publicViewerVerified) : false,
        publicAccessError: hasPriorValid ? (prev?.publicAccessError ?? null) : null,
        lastError: msg,
      });
      return {
        success: false,
        mode,
        exportScope,
        status: "Sync Failed",
        authRequired,
        spreadsheetId: hasPriorValid ? (prev?.spreadsheetId ?? targetId) : targetId,
        spreadsheetUrl: hasPriorValid ? (prev?.spreadsheetUrl ?? null) : null,
        tabRowCounts: {},
        verifiedTabRowCounts: {},
        tabStatuses,
        rowsAdded: 0,
        rowsUpdated: 0,
        rowsUnchanged: 0,
        rowsSkipped: 0,
        rowsFailed: 0,
        skippedBreakdown: emptySkippedBreakdown,
        publicAccessStatus: "unknown",
        publicViewerVerified: false,
        publicAccessError: null,
        steps,
        syncedAt: null,
        error: msg,
      };
    }
  }
}
