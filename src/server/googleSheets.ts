/**
 * Google Sheets API v4 integration with Service Account authentication,
 * paginated batch writes, quota retry/backoff, 6-tab formatting & creation,
 * duplicate-free incremental sync via stable record IDs, and read-back verification.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AtlasDatabase, TabExportStatus } from "./atlasDb.ts";
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

interface ServiceAccountCreds {
  client_email: string;
  private_key: string;
  token_uri: string;
  source: "path" | "json_env";
}

export interface GoogleSheetsConfig {
  atlasDir: string;
  rootDir: string;
  credentialsPath: string | null;
  credentialsJson: string | null;
  spreadsheetId: string | null;
  spreadsheetName: string;
  apiBaseUrl?: string; // Overrideable for local integration tests
  oauthTokenUrl?: string;
}

export interface SheetsSyncResult {
  success: boolean;
  mode: "full" | "incremental";
  status: "Connected" | "Not Connected" | "Sync Failed";
  spreadsheetId: string | null;
  spreadsheetUrl: string | null;
  tabRowCounts: Record<string, number>;
  verifiedTabRowCounts: Record<string, number>;
  tabStatuses: Record<string, TabExportStatus>;
  rowsAdded: number;
  rowsUpdated: number;
  rowsUnchanged: number;
  syncedAt: string | null;
  error: string | null;
}

export interface SheetsConnectionStatus {
  status: "Connected" | "Not Connected" | "Sync Failed";
  configured: boolean;
  credentialSource: "path" | "json_env" | null;
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
  lastError: string | null;
}

export class GoogleSheetsService {
  private cachedToken: { token: string; expiresAtMs: number } | null = null;
  private readonly apiBase: string;
  private readonly config: GoogleSheetsConfig;
  private readonly db: AtlasDatabase;

  constructor(config: GoogleSheetsConfig, db: AtlasDatabase) {
    this.config = config;
    this.db = db;
    this.apiBase = (config.apiBaseUrl || "https://sheets.googleapis.com/v4").replace(/\/+$/, "");
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

  public getCredentialSource(): "path" | "json_env" | null {
    if (this.config.credentialsJson && this.config.credentialsJson.trim()) {
      return "json_env";
    }
    if (this.resolveCredentialsPath()) {
      return "path";
    }
    return null;
  }

  public isConfigured(): boolean {
    return this.getCredentialSource() !== null;
  }

  private loadServiceAccountCredentials(): ServiceAccountCreds {
    let rawJsonText: string | null = null;
    let source: "path" | "json_env" = "path";

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
      if (!resolvedPath) {
        throw new Error(
          "Google Sheets credentials are not configured. Set GOOGLE_SHEETS_CREDENTIALS_PATH or GOOGLE_SHEETS_CREDENTIALS_JSON in server environment."
        );
      }
      rawJsonText = fs.readFileSync(resolvedPath, "utf-8");
      source = "path";
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
        scope: "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file",
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

  private async sheetsJson<T>(
    accessToken: string,
    pathSuffix: string,
    opts: { method?: string; body?: unknown } = {}
  ): Promise<T> {
    const resp = await this.fetchWithQuotaRetry(`${this.apiBase}${pathSuffix}`, {
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
      const apiMsg = (parsed as { error?: { message?: string } })?.error?.message;
      if (resp.status === 401) {
        throw new Error(
          `Google Sheets authentication expired or unauthorized (HTTP 401${apiMsg ? `: ${apiMsg}` : ""}). Re-authenticate with Google or check your Service Account credentials.`
        );
      }
      if (resp.status === 403) {
        throw new Error(
          `Google Sheets permission denied (HTTP 403${apiMsg ? `: ${apiMsg}` : ""}). Ensure the Google Sheets API is enabled and the spreadsheet is shared with Editor access.`
        );
      }
      if (resp.status === 404) {
        throw new Error(
          `Google Spreadsheet not found (HTTP 404${apiMsg ? `: ${apiMsg}` : ""}). Verify GOOGLE_SHEETS_SPREADSHEET_ID or leave it blank to create a new spreadsheet.`
        );
      }
      const errMsg = apiMsg || `Google Sheets API HTTP ${resp.status}`;
      throw new Error(errMsg);
    }
    return parsed as T;
  }

  private resolveTargetSpreadsheetId(overrideId?: string | null): string | null {
    const cleanOverride = overrideId?.trim();
    if (cleanOverride) {
      if (!/^[a-zA-Z0-9-_]{10,120}$/.test(cleanOverride)) {
        throw new Error("Invalid Google Spreadsheet ID format.");
      }
      return cleanOverride;
    }
    if (this.config.spreadsheetId?.trim()) {
      return this.config.spreadsheetId.trim();
    }
    return this.db.getSheetsSyncState()?.spreadsheetId ?? null;
  }

  private async resolveAuthToken(oauthAccessToken?: string | null): Promise<string> {
    const clean = oauthAccessToken?.trim();
    if (clean) return clean;
    const creds = this.loadServiceAccountCredentials();
    return this.getAccessToken(creds);
  }

  private async ensureSpreadsheetAndTabs(
    accessToken: string,
    overrideSpreadsheetId?: string | null
  ): Promise<{
    spreadsheetId: string;
    spreadsheetUrl: string;
    sheetPropsByTitle: Map<string, { sheetId: number; rowCount: number; columnCount: number }>;
  }> {
    let spreadsheetId = this.resolveTargetSpreadsheetId(overrideSpreadsheetId);
    let spreadsheetUrl: string;
    let sheetsList: Array<{ properties: { sheetId: number; title: string; gridProperties?: { rowCount?: number; columnCount?: number } } }> = [];

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
      spreadsheetUrl = created.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
      sheetsList = created.sheets ?? [];
    } else {
      const meta = await this.sheetsJson<{
        spreadsheetId: string;
        spreadsheetUrl?: string;
        sheets?: typeof sheetsList;
      }>(accessToken, `/spreadsheets/${spreadsheetId}?fields=spreadsheetId,spreadsheetUrl,sheets.properties`);
      spreadsheetUrl = meta.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
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

  private buildDeduplicatedTabRows(spec: ExportSpec): {
    orderedIds: string[];
    rowMap: Map<string, Array<string | number>>;
  } {
    const rawRows = this.db.fetchDataset(spec.tableName);
    const orderedIds: string[] = [];
    const rowMap = new Map<string, Array<string | number>>();
    for (const row of rawRows) {
      const rid = String(row[spec.idColumn] ?? "").trim();
      if (!rid || rowMap.has(rid)) continue;
      orderedIds.push(rid);
      rowMap.set(
        rid,
        spec.columns.map((c) => formatExportCell(c, row, true))
      );
    }
    return { orderedIds, rowMap };
  }

  private async verifyWrittenTab(
    accessToken: string,
    spreadsheetId: string,
    spec: ExportSpec
  ): Promise<{ headerValid: boolean; verifiedRows: number }> {
    const range = encodeURIComponent(`'${spec.tabName}'!A:A`);
    const data = await this.sheetsJson<{ values?: unknown[][] }>(
      accessToken,
      `/spreadsheets/${spreadsheetId}/values/${range}?majorDimension=ROWS`
    );
    const rows = data.values ?? [];
    if (rows.length === 0) {
      return { headerValid: false, verifiedRows: 0 };
    }
    const headerValid = String(rows[0]?.[0] ?? "").trim() === spec.columns[0];
    const uniqueIds = new Set<string>();
    for (let i = 1; i < rows.length; i++) {
      const idVal = String(rows[i]?.[0] ?? "").trim();
      if (idVal) uniqueIds.add(idVal);
    }
    return { headerValid, verifiedRows: uniqueIds.size };
  }

  public getStatus(): SheetsConnectionStatus {
    const configured = this.isConfigured();
    const credentialSource = this.getCredentialSource();
    const saved = this.db.getSheetsSyncState();
    const envSpreadsheetId = this.config.spreadsheetId?.trim() || null;
    const spreadsheetId = envSpreadsheetId ?? saved?.spreadsheetId ?? null;
    const spreadsheetUrl =
      (envSpreadsheetId ? `https://docs.google.com/spreadsheets/d/${envSpreadsheetId}` : null) ??
      saved?.spreadsheetUrl ??
      (spreadsheetId ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}` : null);

    if (!configured && (!saved || saved.status === "Not Connected")) {
      return {
        status: "Not Connected",
        configured: false,
        credentialSource: null,
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
        lastError: saved?.lastError ?? null,
      };
    }

    return {
      status: saved?.status ?? "Not Connected",
      configured: configured || saved?.status === "Connected",
      credentialSource,
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
      lastError: saved?.lastError ?? null,
    };
  }

  private safeResolveTargetSpreadsheetId(overrideId?: string | null): string | null {
    try {
      return this.resolveTargetSpreadsheetId(overrideId);
    } catch {
      return this.db.getSheetsSyncState()?.spreadsheetId ?? null;
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
      await this.sheetsJson(accessToken, `/spreadsheets/${spreadsheetId}/values:batchUpdate`, {
        method: "POST",
        body: {
          valueInputOption: "RAW",
          data: currentBatch,
        },
      });
      currentBatch = [];
      currentRows = 0;
      currentBytes = 0;
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

  public async verifyConnection(opts?: {
    oauthAccessToken?: string | null;
    spreadsheetId?: string | null;
  }): Promise<SheetsConnectionStatus> {
    const attemptAt = new Date().toISOString();
    const prev = this.db.getSheetsSyncState();
    const hasOauth = Boolean(opts?.oauthAccessToken?.trim());
    if (!hasOauth && !this.isConfigured()) {
      this.db.saveSheetsSyncState({
        status: "Not Connected",
        spreadsheetId: this.safeResolveTargetSpreadsheetId(opts?.spreadsheetId),
        spreadsheetUrl: prev?.spreadsheetUrl ?? null,
        lastSyncMode: prev?.lastSyncMode ?? null,
        lastAttemptAt: attemptAt,
        lastSuccessAt: prev?.lastSuccessAt ?? null,
        tabRowCounts: prev?.tabRowCounts ?? {},
        rowsAdded: prev?.rowsAdded ?? 0,
        rowsUpdated: prev?.rowsUpdated ?? 0,
        rowsUnchanged: prev?.rowsUnchanged ?? 0,
        lastError: "Google Sheets authorization required. Click 'Sign in with Google' to connect your Google Drive & Sheets account.",
      });
      return this.getStatus();
    }

    try {
      const token = await this.resolveAuthToken(opts?.oauthAccessToken);
      const targetId = this.resolveTargetSpreadsheetId(opts?.spreadsheetId);
      let spreadsheetUrl = prev?.spreadsheetUrl ?? null;
      if (targetId) {
        const meta = await this.sheetsJson<{ spreadsheetId: string; spreadsheetUrl?: string }>(
          token,
          `/spreadsheets/${targetId}?fields=spreadsheetId,spreadsheetUrl`
        );
        spreadsheetUrl = meta.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${targetId}`;
      }
      this.db.saveSheetsSyncState({
        status: "Connected",
        spreadsheetId: targetId,
        spreadsheetUrl,
        lastSyncMode: prev?.lastSyncMode ?? "verify",
        lastAttemptAt: attemptAt,
        lastSuccessAt: prev?.lastSuccessAt ?? null,
        tabRowCounts: prev?.tabRowCounts ?? {},
        rowsAdded: prev?.rowsAdded ?? 0,
        rowsUpdated: prev?.rowsUpdated ?? 0,
        rowsUnchanged: prev?.rowsUnchanged ?? 0,
        lastError: null,
      });
    } catch (err) {
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
        lastError: err instanceof Error ? err.message : String(err),
      });
    }
    return this.getStatus();
  }

  public async exportOrSync(
    mode: "full" | "incremental",
    opts?: { oauthAccessToken?: string | null; spreadsheetId?: string | null }
  ): Promise<SheetsSyncResult> {
    const attemptAt = new Date().toISOString();
    const prev = this.db.getSheetsSyncState();
    const hasOauth = Boolean(opts?.oauthAccessToken?.trim());

    if (!hasOauth && !this.isConfigured()) {
      const errMsg =
        "Google Sheets authorization required. Click 'Sign in with Google' to authorize Google Drive & Sheets access before exporting.";
      this.db.saveSheetsSyncState({
        status: "Not Connected",
        spreadsheetId: this.safeResolveTargetSpreadsheetId(opts?.spreadsheetId),
        spreadsheetUrl: prev?.spreadsheetUrl ?? null,
        lastSyncMode: mode,
        lastAttemptAt: attemptAt,
        lastSuccessAt: prev?.lastSuccessAt ?? null,
        tabRowCounts: prev?.tabRowCounts ?? {},
        rowsAdded: 0,
        rowsUpdated: 0,
        rowsUnchanged: 0,
        lastError: null,
      });
      return {
        success: false,
        mode,
        status: "Not Connected",
        spreadsheetId: null,
        spreadsheetUrl: null,
        tabRowCounts: {},
        verifiedTabRowCounts: {},
        tabStatuses: {},
        rowsAdded: 0,
        rowsUpdated: 0,
        rowsUnchanged: 0,
        syncedAt: null,
        error: errMsg,
      };
    }

    try {
      const accessToken = await this.resolveAuthToken(opts?.oauthAccessToken);
      const { spreadsheetId, spreadsheetUrl, sheetPropsByTitle } =
        await this.ensureSpreadsheetAndTabs(accessToken, opts?.spreadsheetId);

      const batchSize = 250;
      const tabRowCounts: Record<string, number> = {};
      const verifiedTabRowCounts: Record<string, number> = {};
      const tabStatuses: Record<string, TabExportStatus> = {};
      let totalAdded = 0;
      let totalUpdated = 0;
      let totalUnchanged = 0;

      const preparedByTab = new Map<
        string,
        { orderedIds: string[]; rowMap: Map<string, Array<string | number>> }
      >();
      for (const spec of EXPORT_SPECS) {
        preparedByTab.set(spec.tabName, this.buildDeduplicatedTabRows(spec));
      }

      if (mode === "full") {
        // 1) Resize grids + bold/freeze header rows across all 6 tabs in one :batchUpdate
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

        // 2) Clear all 6 tabs in one values:batchClear request
        await this.sheetsJson(accessToken, `/spreadsheets/${spreadsheetId}/values:batchClear`, {
          method: "POST",
          body: {
            ranges: EXPORT_SPECS.map((s) => `'${s.tabName}'`),
          },
        });
      }

      // 3) Process, write, and verify each of the 6 tabs individually with explicit per-tab outcomes
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

          const { headerValid, verifiedRows } = await this.verifyWrittenTab(
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
          } else if (verifiedRows !== expectedRows) {
            tabStatuses[spec.tabName] = {
              tabName: spec.tabName,
              status: "failed",
              expectedRows,
              writtenRows: expectedRows,
              verifiedRows,
              error: `Row count mismatch (${verifiedRows} verified vs ${expectedRows} expected)`,
              message: `Verification mismatch: ${verifiedRows.toLocaleString()} verified vs ${expectedRows.toLocaleString()} DB rows`,
            };
          } else {
            tabStatuses[spec.tabName] = {
              tabName: spec.tabName,
              status: "success",
              expectedRows,
              writtenRows: expectedRows,
              verifiedRows,
              error: null,
              message: `Verified ${verifiedRows.toLocaleString()} rows`,
            };
          }
        } catch (tabErr) {
          const tabMsg = tabErr instanceof Error ? tabErr.message : String(tabErr);
          verifiedTabRowCounts[spec.tabName] = 0;
          tabStatuses[spec.tabName] = {
            tabName: spec.tabName,
            status: "failed",
            expectedRows,
            writtenRows: 0,
            verifiedRows: 0,
            error: tabMsg,
            message: `Failed: ${tabMsg}`,
          };
          if (/HTTP (401|403|404)/.test(tabMsg)) {
            fatalAuthOrTargetError = tabMsg;
          }
        }
      }

      const failedTabs = EXPORT_SPECS.filter((s) => tabStatuses[s.tabName]?.status !== "success");
      const allSixSucceeded = failedTabs.length === 0;
      const syncedAt = new Date().toISOString();

      if (!allSixSucceeded) {
        const failedSummary = failedTabs
          .map((s) => `${s.tabName} (${tabStatuses[s.tabName]?.error || "verification failed"})`)
          .join("; ");
        const errMsg = `${6 - failedTabs.length}/6 tabs verified. Failed tabs: ${failedSummary}`;
        this.db.saveSheetsSyncState({
          status: "Sync Failed",
          spreadsheetId,
          spreadsheetUrl,
          lastSyncMode: mode,
          lastAttemptAt: attemptAt,
          lastSuccessAt: prev?.lastSuccessAt ?? null,
          tabRowCounts: verifiedTabRowCounts,
          tabStatuses,
          rowsAdded: totalAdded,
          rowsUpdated: totalUpdated,
          rowsUnchanged: totalUnchanged,
          lastError: errMsg,
        });
        return {
          success: false,
          mode,
          status: "Sync Failed",
          spreadsheetId,
          spreadsheetUrl,
          tabRowCounts,
          verifiedTabRowCounts,
          tabStatuses,
          rowsAdded: totalAdded,
          rowsUpdated: totalUpdated,
          rowsUnchanged: totalUnchanged,
          syncedAt: null,
          error: errMsg,
        };
      }

      this.db.saveSheetsSyncState({
        status: "Connected",
        spreadsheetId,
        spreadsheetUrl,
        lastSyncMode: mode,
        lastAttemptAt: attemptAt,
        lastSuccessAt: syncedAt,
        tabRowCounts: verifiedTabRowCounts,
        tabStatuses,
        rowsAdded: totalAdded,
        rowsUpdated: totalUpdated,
        rowsUnchanged: totalUnchanged,
        lastError: null,
      });

      return {
        success: true,
        mode,
        status: "Connected",
        spreadsheetId,
        spreadsheetUrl,
        tabRowCounts,
        verifiedTabRowCounts,
        tabStatuses,
        rowsAdded: totalAdded,
        rowsUpdated: totalUpdated,
        rowsUnchanged: totalUnchanged,
        syncedAt,
        error: null,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const targetId = this.safeResolveTargetSpreadsheetId(opts?.spreadsheetId);
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
      this.db.saveSheetsSyncState({
        status: "Sync Failed",
        spreadsheetId: targetId,
        spreadsheetUrl: prev?.spreadsheetUrl ?? null,
        lastSyncMode: mode,
        lastAttemptAt: attemptAt,
        lastSuccessAt: prev?.lastSuccessAt ?? null,
        tabRowCounts: prev?.tabRowCounts ?? {},
        tabStatuses,
        rowsAdded: 0,
        rowsUpdated: 0,
        rowsUnchanged: 0,
        lastError: msg,
      });
      return {
        success: false,
        mode,
        status: "Sync Failed",
        spreadsheetId: targetId,
        spreadsheetUrl: prev?.spreadsheetUrl ?? null,
        tabRowCounts: {},
        verifiedTabRowCounts: {},
        tabStatuses,
        rowsAdded: 0,
        rowsUpdated: 0,
        rowsUnchanged: 0,
        syncedAt: null,
        error: msg,
      };
    }
  }
}
