import fs from "node:fs";
import path from "node:path";
import {
  AtlasDatabase,
  type AuditEntryInput,
  type CanonicalEntityRow,
  type EntityMappingLogInput,
  type JobInput,
  type NewsInput,
  type PipelineRunRecord,
  type ProductInput,
  type ResearchPaperInput,
  type SchedulerStateRecord,
  type SourceOutcomeRecord,
  type StartupInput,
  type VerificationStatus,
  sha256Prefix,
} from "./atlasDb.ts";
import {
  EXPORT_SPECS,
  type ExportSpec,
  GoogleSheetsService,
  type SheetsConnectionStatus,
  type SheetsSyncResult,
  formatExportCell,
} from "./googleSheets.ts";
import { PoliteHttpClient } from "./httpClient.ts";
import {
  GeminiLLMProvider,
  type IntegrationConnectionStatus,
  LLMRouter,
  OpenAICompatibleLLMProvider,
  redactSecrets,
} from "./llmRouter.ts";
import { createZipArchive } from "./zipArchive.ts";

export interface AtlasConfig {
  rootDir: string;
  atlasDir: string;
  dataDir: string;
  exportsDir: string;
  dbPath: string;
  freshnessWindowHours: number;
  dailyCollectionUtcTime: string;
  dailyCollectionEnabled: boolean;
  targetStartups: number;
  targetProducts: number;
  targetResearchPapers: number;
  userAgent: string;
  requestTimeoutMs: number;
  maxConcurrency: number;
  rateLimitPerSecond: number;
  respectRobotsTxt: boolean;
  geminiApiKey: string | null;
  geminiModel: string;
  geminiFallbackModel: string | null;
  groqApiKey: string | null;
  groqModel: string;
  llama3ApiKey: string | null;
  llama3Model: string;
  llama3EndpointUrl: string;
  deepseekApiKey: string | null;
  deepseekModel: string;
  githubToken: string | null;
  googleSheetsCredentialsPath: string | null;
  googleSheetsCredentialsJson: string | null;
  googleSheetsSpreadsheetId: string | null;
  googleSheetsSpreadsheetName: string;
}

export function normalizeUtcTimeHHMM(raw: string | null | undefined, fallback = "02:00"): string {
  const s = (raw ?? "").trim();
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallback;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    return fallback;
  }
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export function computeNextUtcRunIso(
  utcTime: string,
  now: Date = new Date(),
  lastScheduledAt?: string | null
): string {
  const normalized = normalizeUtcTimeHHMM(utcTime, "02:00");
  const [hhStr, mmStr] = normalized.split(":");
  const hh = Number(hhStr);
  const mm = Number(mmStr);
  const candidate = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh, mm, 0, 0)
  );
  const lastMs = lastScheduledAt ? Date.parse(lastScheduledAt) : Number.NaN;
  if (candidate.getTime() <= now.getTime() || (Number.isFinite(lastMs) && candidate.getTime() <= lastMs)) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return candidate.toISOString();
}

export function loadAtlasConfig(atlasDir: string): AtlasConfig {
  const rootDir = path.resolve(atlasDir, "..");
  const dataDir = path.resolve(atlasDir, "data");
  const exportsDir = path.resolve(dataDir, "exports");
  const rawDbUrl = process.env.DATABASE_URL || "sqlite:///data/frontier_atlas_recovered.db";
  const recoveredDefaultPath = path.resolve(dataDir, "frontier_atlas_recovered.db");
  let dbPath = recoveredDefaultPath;
  if (rawDbUrl.startsWith("sqlite:///")) {
    const rel = rawDbUrl.slice("sqlite:///".length);
    const resolved = path.isAbsolute(rel) ? rel : path.resolve(atlasDir, rel);
    // Guard against legacy container/env DATABASE_URL pointing to the corrupted original frontier_atlas.db
    dbPath =
      path.basename(resolved) === "frontier_atlas.db" && fs.existsSync(recoveredDefaultPath)
        ? recoveredDefaultPath
        : resolved;
  }
  const parseIntEnv = (val: string | undefined, def: number) => {
    const n = Number(val);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
  };
  const parseFloatEnv = (val: string | undefined, def: number) => {
    const n = Number(val);
    return Number.isFinite(n) && n > 0 ? n : def;
  };
  const parseBoolEnv = (val: string | undefined, def: boolean) => {
    if (val === undefined || val === "") return def;
    return !["false", "0", "no", "off"].includes(val.trim().toLowerCase());
  };
  return {
    rootDir,
    atlasDir,
    dataDir,
    exportsDir,
    dbPath,
    freshnessWindowHours: parseIntEnv(process.env.FRESHNESS_WINDOW_HOURS, 24),
    dailyCollectionUtcTime: normalizeUtcTimeHHMM(process.env.DAILY_COLLECTION_UTC_TIME, "02:00"),
    dailyCollectionEnabled: parseBoolEnv(process.env.DAILY_COLLECTION_ENABLED, true),
    targetStartups: 1000,
    targetProducts: 1000,
    targetResearchPapers: 1000,
    userAgent: process.env.USER_AGENT || "FrontierAtlasBot/1.0 (+https://github.com/frontier-atlas)",
    requestTimeoutMs: parseIntEnv(process.env.REQUEST_TIMEOUT_SECONDS, 20) * 1000,
    maxConcurrency: Math.min(12, Math.max(1, parseIntEnv(process.env.MAX_CONCURRENCY, 8))),
    rateLimitPerSecond: Math.min(20, Math.max(0.5, parseFloatEnv(process.env.RATE_LIMIT_PER_SECOND, 4))),
    respectRobotsTxt: parseBoolEnv(process.env.RESPECT_ROBOTS_TXT, true),
    geminiApiKey: process.env.GEMINI_API_KEY?.trim() || null,
    geminiModel: process.env.GEMINI_MODEL?.trim() || "gemini-4-hydrogen",
    geminiFallbackModel:
      process.env.GEMINI_FALLBACK_MODEL?.trim() ||
      ((process.env.GEMINI_MODEL?.trim() || "gemini-4-hydrogen") === "gemini-4-hydrogen"
        ? "gemini-3.1-flash-lite"
        : null),
    groqApiKey: process.env.GROQ_API_KEY?.trim() || null,
    groqModel: process.env.GROQ_MODEL?.trim() || "llama-3.3-70b-versatile",
    llama3ApiKey: process.env.LLAMA3_API_KEY?.trim() || null,
    llama3Model: process.env.LLAMA3_MODEL?.trim() || "llama-3.1-8b-instant",
    llama3EndpointUrl:
      process.env.LLAMA3_ENDPOINT_URL?.trim() || "https://api.groq.com/openai/v1/chat/completions",
    deepseekApiKey: process.env.DEEPSEEK_API_KEY?.trim() || null,
    deepseekModel: process.env.DEEPSEEK_MODEL?.trim() || "deepseek-chat",
    githubToken: process.env.GITHUB_TOKEN?.trim() || null,
    googleSheetsCredentialsPath: process.env.GOOGLE_SHEETS_CREDENTIALS_PATH?.trim() || null,
    googleSheetsCredentialsJson: process.env.GOOGLE_SHEETS_CREDENTIALS_JSON?.trim() || null,
    googleSheetsSpreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID?.trim() || null,
    googleSheetsSpreadsheetName:
      process.env.GOOGLE_SHEETS_SPREADSHEET_NAME?.trim() || "FrontierAtlas Intelligence",
  };
}

// ---------- Utility helpers ----------

const UNKNOWN_PLACEHOLDERS = new Set([
  "",
  "unknown",
  "n/a",
  "na",
  "none",
  "null",
  "tbd",
  "unspecified",
  "-",
]);

function normalizeUnknownText(value: unknown): string {
  if (value === null || value === undefined) return "Unknown";
  const cleaned = String(value).trim();
  if (UNKNOWN_PLACEHOLDERS.has(cleaned.toLowerCase())) return "Unknown";
  return cleaned;
}

function makeStableId(prefix: string, ...parts: Array<string | null | undefined>): string {
  const normalized = parts
    .map((p) => (p ?? "").trim().toLowerCase())
    .filter(Boolean);
  return `${prefix}_${sha256Prefix(normalized.join("|"), 16)}`;
}

function isValidHttpUrl(raw: string | null | undefined): raw is string {
  if (!raw || typeof raw !== "string") return false;
  try {
    const u = new URL(raw.trim());
    return (u.protocol === "http:" || u.protocol === "https:") && Boolean(u.hostname);
  } catch {
    return false;
  }
}

function normalizeUrl(raw: string): string {
  const u = new URL(raw.trim());
  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();
  let s = u.toString();
  if (u.pathname === "/" && !u.search && !u.hash && s.endsWith("/")) {
    s = s.slice(0, -1);
  }
  return s;
}

function validateOptionalUrl(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s || UNKNOWN_PLACEHOLDERS.has(s.toLowerCase())) return null;
  if (!isValidHttpUrl(s)) return null;
  return normalizeUrl(s);
}

function extractDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    const host = u.hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return null;
  }
}

function extractGithubRepoSlug(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/i);
  if (!m) return null;
  const parts = m[1].replace(/\.git$/i, "").split("/");
  if (parts.length < 2) return null;
  return `${parts[0]}/${parts[1]}`;
}

function findFirstGithubRepo(...texts: Array<string | null | undefined>): string | null {
  for (const t of texts) {
    if (!t) continue;
    const slug = extractGithubRepoSlug(t);
    if (slug) return `https://github.com/${slug}`;
  }
  return null;
}

export type TimestampPrecision = "verified_exact" | "relative_estimated" | "unverified";

const RELATIVE_TIME_RE =
  /^(?:about\s+|approx\.?\s+|~)?(?:(an|a|\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|wks?|w))\s+ago$/i;

export function parseUtcDatetimeWithMeta(
  raw: unknown,
  refNow: Date = new Date()
): { date: Date | null; precision: TimestampPrecision } {
  if (raw === null || raw === undefined) return { date: null, precision: "unverified" };
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return { date: null, precision: "unverified" };
    const yr = raw.getUTCFullYear();
    return yr >= 1970 && yr <= 2100 ? { date: raw, precision: "verified_exact" } : { date: null, precision: "unverified" };
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    if (raw < 10_000_000) return { date: null, precision: "unverified" }; // Reject small non-epoch numbers like "2025"
    const ms = raw > 1e12 ? raw : raw * 1000;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return { date: null, precision: "unverified" };
    const yr = d.getUTCFullYear();
    return yr >= 1970 && yr <= 2100 ? { date: d, precision: "verified_exact" } : { date: null, precision: "unverified" };
  }
  const s = String(raw).trim();
  if (!s || UNKNOWN_PLACEHOLDERS.has(s.toLowerCase()) || /^\d{4}$/.test(s)) {
    return { date: null, precision: "unverified" };
  }
  if (/^(?:just\s+now|moments?\s+ago)$/i.test(s)) {
    return { date: new Date(refNow.getTime()), precision: "relative_estimated" };
  }
  const relMatch = s.match(RELATIVE_TIME_RE);
  if (relMatch) {
    const qtyRaw = relMatch[1].toLowerCase();
    const qty = qtyRaw === "a" || qtyRaw === "an" ? 1 : Number(qtyRaw);
    const unit = relMatch[2].toLowerCase();
    let unitMs = 0;
    if (unit.startsWith("s")) unitMs = 1000;
    else if (unit.startsWith("m")) unitMs = 60_000;
    else if (unit.startsWith("h")) unitMs = 3600_000;
    else if (unit.startsWith("d")) unitMs = 86400_000;
    else if (unit.startsWith("w")) unitMs = 7 * 86400_000;
    if (Number.isFinite(qty) && qty >= 0 && unitMs > 0) {
      return {
        date: new Date(refNow.getTime() - Math.round(qty * unitMs)),
        precision: "relative_estimated",
      };
    }
  }
  // Reject vague undated words ("today", "yesterday", "recent", "soon") cleanly
  if (/\b(?:ago|today|yesterday|recent|soon|just now)\b/i.test(s)) {
    return { date: null, precision: "unverified" };
  }
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n < 10_000_000) return { date: null, precision: "unverified" };
    const ms = n > 1e12 ? n : n * 1000;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return { date: null, precision: "unverified" };
    const yr = d.getUTCFullYear();
    return yr >= 1970 && yr <= 2100 ? { date: d, precision: "verified_exact" } : { date: null, precision: "unverified" };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T00:00:00.000Z`);
    return Number.isNaN(d.getTime()) ? { date: null, precision: "unverified" } : { date: d, precision: "verified_exact" };
  }
  if (/^\d{4}-\d{2}$/.test(s)) {
    const d = new Date(`${s}-01T00:00:00.000Z`);
    return Number.isNaN(d.getTime()) ? { date: null, precision: "unverified" } : { date: d, precision: "verified_exact" };
  }
  // If ISO datetime omits timezone offset/Z, treat explicitly as UTC rather than host local time
  const normalizedIso =
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(s)
      ? `${s.replace(" ", "T")}Z`
      : s;
  const parsed = Date.parse(normalizedIso);
  if (Number.isNaN(parsed)) return { date: null, precision: "unverified" };
  const d = new Date(parsed);
  const yr = d.getUTCFullYear();
  return yr >= 1970 && yr <= 2100 ? { date: d, precision: "verified_exact" } : { date: null, precision: "unverified" };
}

export function parseUtcDatetime(raw: unknown, refNow: Date = new Date()): Date | null {
  return parseUtcDatetimeWithMeta(raw, refNow).date;
}

export function isWithinFreshnessWindow(
  dt: Date | null,
  ref: Date,
  windowHours = 24,
  maxFutureSkewMinutes = 5
): { ok: boolean; reason: string } {
  if (!dt) return { ok: false, reason: "missing_published_at" };
  const diffMs = ref.getTime() - dt.getTime();
  if (diffMs < -maxFutureSkewMinutes * 60_000) {
    return { ok: false, reason: "future_publication_date" };
  }
  if (diffMs > windowHours * 3600_000) {
    return { ok: false, reason: "older_than_freshness_window" };
  }
  return { ok: true, reason: "within_window" };
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, num) => {
      const code = Number(num);
      return Number.isFinite(code) ? String.fromCharCode(code) : _;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : _;
    });
}

function stripHtmlToText(html: string): string {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  const stripped = withoutScripts.replace(/<[^>]+>/g, " ");
  return decodeHtmlEntities(stripped).replace(/\s+/g, " ").trim();
}

function extractHtmlTitle(html: string): string | null {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) {
    const clean = decodeHtmlEntities(titleMatch[1]).replace(/\s+/g, " ").trim();
    if (clean) return clean.slice(0, 512);
  }
  const ogMatch =
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
  if (ogMatch?.[1]) {
    const clean = decodeHtmlEntities(ogMatch[1]).replace(/\s+/g, " ").trim();
    if (clean) return clean.slice(0, 512);
  }
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match?.[1]) {
    const clean = stripHtmlToText(h1Match[1]);
    if (clean) return clean.slice(0, 512);
  }
  return null;
}

function extractHtmlMetaDescription(html: string): string | null {
  const candidates = [
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i),
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i),
    html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i),
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i),
  ];
  for (const m of candidates) {
    if (m?.[1]) {
      const clean = decodeHtmlEntities(m[1]).replace(/\s+/g, " ").trim();
      if (
        clean.length >= 15 &&
        !PLACEHOLDER_TEXT_RE.test(clean) &&
        !PARKED_DOMAIN_RE.test(clean)
      ) {
        return clean.slice(0, 1500);
      }
    }
  }
  return null;
}

function extractXmlTag(block: string, tagName: string): string | null {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "i");
  const m = block.match(re);
  if (!m?.[1]) return null;
  return decodeHtmlEntities(m[1]).trim();
}

function extractXmlTags(block: string, tagName: string): string[] {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "gi");
  const results: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(block)) !== null) {
    results.push(match[1]);
  }
  return results;
}

export function createLLMRouter(config: AtlasConfig): LLMRouter {
  const llama3UsesGroq = !config.llama3EndpointUrl || config.llama3EndpointUrl.includes("api.groq.com");
  const llama3EffectiveKey = config.llama3ApiKey || (llama3UsesGroq ? config.groqApiKey : null);

  return new LLMRouter([
    new GeminiLLMProvider(
      config.geminiApiKey,
      config.geminiModel,
      config.requestTimeoutMs,
      config.geminiFallbackModel
    ),
    new OpenAICompatibleLLMProvider({
      providerName: "groq",
      apiKey: config.groqApiKey,
      model: config.groqModel,
      endpointUrl: "https://api.groq.com/openai/v1/chat/completions",
      via: "groq",
      timeoutMs: config.requestTimeoutMs,
    }),
    new OpenAICompatibleLLMProvider({
      providerName: "llama3",
      apiKey: llama3EffectiveKey,
      model: config.llama3Model,
      endpointUrl: config.llama3EndpointUrl || "https://api.groq.com/openai/v1/chat/completions",
      via: llama3UsesGroq ? "groq" : "custom_endpoint",
      timeoutMs: config.requestTimeoutMs,
    }),
    new OpenAICompatibleLLMProvider({
      providerName: "deepseek",
      apiKey: config.deepseekApiKey,
      model: config.deepseekModel,
      endpointUrl: "https://api.deepseek.com/v1/chat/completions",
      via: "deepseek",
      timeoutMs: config.requestTimeoutMs,
    }),
  ]);
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, concurrency), Math.max(1, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        results[i] = await fn(items[i], i);
      }
    })
  );
  return results;
}

// Multi-tier LLM extraction helper: Gemini Flash -> Groq -> Llama 3 -> DeepSeek (+ heuristic demo fallback)
export async function extractStructuredWithGemini(
  config: AtlasConfig,
  rawText: string,
  category: string,
  sourceUrl = "https://unknown.invalid"
): Promise<Array<Record<string, unknown>>> {
  const router = createLLMRouter(config);
  const res = await router.extractStructured({
    category,
    sourceUrl,
    sourceName: "llm_extraction",
    sourceText: rawText,
    allowHeuristicFallback: true,
  });
  return res.records;
}

// ---------- Source Verification ----------

const PLACEHOLDER_DOMAINS = new Set([
  "example.com",
  "example.org",
  "example.net",
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "test.local",
  "dummy.com",
]);

const PLACEHOLDER_TEXT_RE =
  /\b(?:lorem\s+ipsum|placeholder|dummy\s+(?:company|record|startup|product)|mock\s+(?:record|company|data)|sample\s+(?:record|startup|data)|fabricated|this\s+domain\s+is\s+(?:for\s+use\s+in\s+illustrative\s+examples|available\s+for\s+purchase))\b/i;

const PARKED_DOMAIN_RE =
  /\b(?:namebright|coming\s+soon|domain\s+is\s+for\s+sale|buy\s+this\s+domain|hugedomains|sedo\s+domain\s+parking|afternic|dan\.com|domain\s+parking|this\s+domain\s+(?:name\s+)?may\s+be\s+for\s+sale|expired\s+domain)\b/i;

const FACILITY_CONTEXT_RE =
  /\b(?:factory|factories|manufacturing\s+plant|assembly\s+plant|production\s+facility|plant|branch(?:\s+office)?|regional\s+office|satellite\s+office|field\s+office|warehouse|distribution\s+center|fulfillment\s+center|retail\s+store|showroom)\b/i;

const HQ_CONTEXT_RE =
  /\b(?:headquarter(?:s|ed)?|hq|corporate\s+headquarters|global\s+headquarters|main\s+office|corporate\s+office|based\s+in|founded\s+in)\b/i;

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "are",
  "was",
  "were",
  "has",
  "have",
  "using",
  "via",
  "api",
  "inc",
  "llc",
  "ltd",
  "corp",
]);

function normText(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function meaningfulTokens(text: string | null | undefined): string[] {
  const matches = normText(text).match(/[a-z0-9]+/g) ?? [];
  return matches.filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function textSupportsClaim(
  claim: string | null | undefined,
  sourceText: string,
  minTokenRatio = 0.65
): boolean {
  if (!claim || !sourceText) return false;
  const normClaim = normText(claim);
  if (!normClaim || normClaim === "unknown") return false;
  const normSrc = normText(sourceText);
  if (normSrc.includes(normClaim)) return true;
  const claimTokens = meaningfulTokens(normClaim);
  if (claimTokens.length === 0) return false;
  const srcTokens = new Set(meaningfulTokens(normSrc));
  if (srcTokens.size === 0) return false;
  let matched = 0;
  for (const tok of claimTokens) {
    if (srcTokens.has(tok)) matched++;
  }
  return matched / claimTokens.length >= minTokenRatio;
}

function extractEvidenceExcerpt(
  claim: string | null | undefined,
  sourceText: string,
  radius = 120
): string | null {
  if (!claim || !sourceText) return null;
  const cleanSrc = sourceText.replace(/\s+/g, " ").trim();
  const normSrc = cleanSrc.toLowerCase();
  const normClaim = normText(claim);
  if (!normClaim) return null;

  const idx = normSrc.indexOf(normClaim);
  if (idx !== -1) {
    const start = Math.max(0, idx - radius);
    const end = Math.min(cleanSrc.length, idx + normClaim.length + radius);
    const snippet = cleanSrc.slice(start, end).trim();
    return `${start > 0 ? "..." : ""}${snippet}${end < cleanSrc.length ? "..." : ""}`;
  }
  if (textSupportsClaim(claim, sourceText)) {
    for (const tok of meaningfulTokens(claim)) {
      const tIdx = normSrc.indexOf(tok);
      if (tIdx !== -1) {
        const start = Math.max(0, tIdx - radius);
        const end = Math.min(cleanSrc.length, tIdx + tok.length + radius);
        const snippet = cleanSrc.slice(start, end).trim();
        return `${start > 0 ? "..." : ""}${snippet}${end < cleanSrc.length ? "..." : ""}`;
      }
    }
  }
  return null;
}

function assessLocationEvidence(
  location: string | null | undefined,
  sourceText: string
): { resolved: string; supported: boolean; hqGuarded: boolean } {
  const cleaned = (location ?? "").trim();
  if (!cleaned || cleaned.toLowerCase() === "unknown" || !sourceText) {
    return { resolved: "Unknown", supported: false, hqGuarded: false };
  }
  const normSrc = normText(sourceText);
  const primarySeg = normText(cleaned.split(",")[0]);
  const candidates = [normText(cleaned)];
  if (primarySeg && primarySeg !== candidates[0] && primarySeg.length >= 3) {
    candidates.push(primarySeg);
  }
  const positions: Array<[number, number]> = [];
  for (const cand of candidates) {
    let start = 0;
    while (true) {
      const idx = normSrc.indexOf(cand, start);
      if (idx === -1) break;
      positions.push([idx, idx + cand.length]);
      start = idx + cand.length;
    }
    if (positions.length > 0) break;
  }
  if (positions.length === 0) {
    return { resolved: "Unknown", supported: false, hqGuarded: false };
  }
  let sawFacilityOnly = false;
  for (const [startIdx, endIdx] of positions) {
    const window = normSrc.slice(Math.max(0, startIdx - 90), Math.min(normSrc.length, endIdx + 90));
    if (HQ_CONTEXT_RE.test(window)) {
      return { resolved: cleaned, supported: true, hqGuarded: false };
    }
    if (FACILITY_CONTEXT_RE.test(window)) {
      sawFacilityOnly = true;
    }
  }
  if (sawFacilityOnly) {
    return { resolved: "Unknown", supported: false, hqGuarded: true };
  }
  return { resolved: cleaned, supported: true, hqGuarded: false };
}

interface SourceSnapshot {
  url: string;
  status: number;
  accessible: boolean;
  title: string | null;
  metaDescription?: string | null;
  text: string;
  jsonPayload: unknown;
  xmlItems: string[] | null;
  error: string | null;
}

function flattenJsonText(payload: unknown, maxChars = 200000): string {
  const parts: string[] = [];
  let total = 0;
  const walk = (node: unknown): void => {
    if (total >= maxChars || node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
    } else if (typeof node === "object") {
      for (const val of Object.values(node as Record<string, unknown>)) walk(val);
    } else if (typeof node === "string" || typeof node === "number") {
      const s = String(node).trim();
      if (s) {
        parts.push(s);
        total += s.length + 1;
      }
    }
  };
  walk(payload);
  return parts.join(" ").slice(0, maxChars);
}

function extractJsonFeedTitle(payload: unknown): string | null {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const obj = payload as Record<string, unknown>;
    for (const key of ["full_name", "title", "name", "headline"]) {
      const v = obj[key];
      if (typeof v === "string" && v.trim()) return v.trim().slice(0, 250);
    }
  }
  return null;
}

function stringifyObjectValues(item: Record<string, unknown>): string {
  return Object.values(item)
    .filter((v) => v !== null && v !== undefined)
    .map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v)))
    .join(" ");
}

function matchJsonItemText(
  payload: unknown,
  primaryValue: string,
  fallbackUrl?: string | null,
  sourceUrlHint?: string | null
): string | null {
  let items: Array<Record<string, unknown>> = [];
  if (Array.isArray(payload)) {
    items = payload.filter((x): x is Record<string, unknown> => Boolean(x && typeof x === "object"));
  } else if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    for (const key of ["items", "results", "jobs", "data", "hits", "works", "papers"]) {
      const v = obj[key];
      if (Array.isArray(v)) {
        items = v.filter((x): x is Record<string, unknown> => Boolean(x && typeof x === "object"));
        break;
      }
    }
    if (items.length === 0 && obj.message && typeof obj.message === "object" && !Array.isArray(obj.message)) {
      const msg = obj.message as Record<string, unknown>;
      if (Array.isArray(msg.items)) {
        items = msg.items.filter((x): x is Record<string, unknown> => Boolean(x && typeof x === "object"));
      } else if (typeof msg.DOI === "string" || Array.isArray(msg.title) || typeof msg.title === "string") {
        items = [msg];
      }
    }
    if (
      items.length === 0 &&
      (typeof obj.id === "string" ||
        typeof obj.id === "number" ||
        typeof obj.objectID === "string" ||
        typeof obj.name === "string" ||
        typeof obj.title === "string" ||
        typeof obj.full_name === "string" ||
        typeof obj.headline === "string")
    ) {
      items = [obj];
    }
    if (items.length === 0) return null;
  }
  const targetNorm = normText(primaryValue);
  const urlHints = [fallbackUrl, sourceUrlHint]
    .filter((u): u is string => Boolean(u && typeof u === "string"))
    .map((u) => u.toLowerCase());

  const idHints: string[] = [];
  for (const hint of urlHints) {
    const hnMatch = hint.match(/news\.ycombinator\.com\/item\?id=(\d+)/i);
    if (hnMatch?.[1]) idHints.push(hnMatch[1]);
    const hfMatch = hint.match(/huggingface\.co\/spaces\/([^?#]+)/i);
    if (hfMatch?.[1]) idHints.push(hfMatch[1].replace(/\/+$/, ""));
    const doiMatch = hint.match(/doi\.org\/(.+)$/i);
    if (doiMatch?.[1]) idHints.push(decodeURIComponent(doiMatch[1]).toLowerCase());
  }

  const urlMatchCache = jsonLowerCache;
  for (const item of items) {
    const targetObj =
      item.paper && typeof item.paper === "object" && !Array.isArray(item.paper)
        ? (item.paper as Record<string, unknown>)
        : item;
    for (const urlKey of [
      "url",
      "website",
      "link",
      "html_url",
      "source_url",
      "api_url",
      "jobUrl",
      "applyUrl",
      "absolute_url",
      "applicationLink",
      "guid",
      "URL",
      "landing_page_url",
    ]) {
      const uVal = targetObj[urlKey] ?? item[urlKey];
      if (typeof uVal === "string" && uVal) {
        const lowerU = uVal.toLowerCase();
        if (urlHints.some((hint) => lowerU === hint || lowerU.includes(hint))) {
          return stringifyObjectValues(item);
        }
      }
    }
    const slugVal = targetObj.slug ?? item.slug;
    if (typeof slugVal === "string" && slugVal) {
      const lowerSlug = slugVal.toLowerCase();
      if (urlHints.some((hint) => hint.endsWith(`/${lowerSlug}`) || hint.endsWith(`/${lowerSlug}/`))) {
        return stringifyObjectValues(item);
      }
    }
    const objId = String(targetObj.objectID ?? targetObj.id ?? item.objectID ?? item.id ?? "")
      .trim()
      .toLowerCase();
    const objDoi = String(targetObj.DOI ?? targetObj.doi ?? item.DOI ?? "").trim().toLowerCase();
    if (objId && idHints.some((idH) => objId === idH || objId.endsWith(`/${idH}`))) {
      return stringifyObjectValues(item);
    }
    if (objDoi && idHints.some((idH) => objDoi === idH)) {
      return stringifyObjectValues(item);
    }
    for (const key of ["name", "title", "headline", "full_name", "jobTitle", "position", "text", "id"]) {
      const rawVal = targetObj[key] ?? item[key];
      const candidates = Array.isArray(rawVal) ? rawVal.filter((x): x is string => typeof x === "string") : typeof rawVal === "string" ? [rawVal] : [];
      for (const v of candidates) {
        const cleanV = normText(v).replace(/^show hn\s*[:\-]\s*/i, "").trim();
        if (
          targetNorm &&
          (normText(v) === targetNorm || cleanV === targetNorm || normText(v).endsWith(`/${targetNorm}`))
        ) {
          return stringifyObjectValues(item);
        }
      }
    }
  }
  if (urlHints.length > 0) {
    for (const item of items) {
      let itemJson = urlMatchCache.get(item);
      if (itemJson === undefined) {
        itemJson = JSON.stringify(item).toLowerCase();
        urlMatchCache.set(item, itemJson);
      }
      for (const hint of urlHints) {
        if (itemJson.includes(hint)) {
          return stringifyObjectValues(item);
        }
      }
    }
  }
  return null;
}

const jsonLowerCache = new WeakMap<object, string>();

function matchXmlItemText(
  xmlItems: string[],
  primaryValue: string,
  fallbackUrl?: string | null,
  sourceUrlHint?: string | null
): string | null {
  const targetNorm = normText(primaryValue);
  const urlHints = [fallbackUrl, sourceUrlHint]
    .filter((u): u is string => Boolean(u && typeof u === "string"))
    .map((u) => u.toLowerCase());

  for (const item of xmlItems) {
    const lowerItem = item.toLowerCase();
    for (const hint of urlHints) {
      if (lowerItem.includes(hint)) {
        return stripHtmlToText(item);
      }
    }
    const titleText = extractXmlTag(item, "title") ?? "";
    if (targetNorm && (normText(titleText) === targetNorm || normText(titleText).includes(targetNorm))) {
      return stripHtmlToText(item);
    }
  }
  return null;
}

class LiveSourceVerifier {
  private readonly cache = new Map<string, SourceSnapshot>();
  private readonly config: AtlasConfig;
  private readonly http: PoliteHttpClient;

  constructor(config: AtlasConfig, http: PoliteHttpClient) {
    this.config = config;
    this.http = http;
  }

  public seedSnapshot(url: string, status: number, content: string, contentType: string): void {
    if (!url || this.cache.has(url)) return;
    const snap = this.buildSnapshot(url, status, true, content, contentType, null);
    this.cache.set(url, snap);
  }

  private buildSnapshot(
    url: string,
    status: number,
    ok: boolean,
    body: string,
    contentType: string,
    error: string | null
  ): SourceSnapshot {
    if (!ok) {
      return {
        url,
        status,
        accessible: false,
        title: null,
        text: "",
        jsonPayload: null,
        xmlItems: null,
        error: error || `http_${status}`,
      };
    }

    const ctype = (contentType || "").toLowerCase();
    const stripped = body.trimStart();

    if (ctype.includes("application/pdf") || stripped.startsWith("%PDF-")) {
      return {
        url,
        status,
        accessible: true,
        title: "PDF Document",
        text: "",
        jsonPayload: null,
        xmlItems: null,
        error: "pdf_binary_not_text",
      };
    }

    if (ctype.includes("json") || stripped.startsWith("{") || stripped.startsWith("[")) {
      try {
        const payload = JSON.parse(body);
        const isLargeArray = Array.isArray(payload) && payload.length > 250;
        return {
          url,
          status,
          accessible: true,
          title: extractJsonFeedTitle(payload),
          text: isLargeArray ? "" : flattenJsonText(payload),
          jsonPayload: payload,
          xmlItems: null,
          error: null,
        };
      } catch {
        // Fall through to HTML/text extraction
      }
    }

    if (
      ctype.includes("xml") ||
      stripped.startsWith("<?xml") ||
      stripped.startsWith("<feed") ||
      stripped.startsWith("<rss")
    ) {
      const title = extractXmlTag(body, "title");
      const items = extractXmlTags(body, "item");
      const entries = items.length > 0 ? items : extractXmlTags(body, "entry");
      return {
        url,
        status,
        accessible: true,
        title,
        text: stripHtmlToText(body).slice(0, 200000),
        jsonPayload: null,
        xmlItems: entries.length > 0 ? entries : null,
        error: null,
      };
    }

    const title = extractHtmlTitle(body);
    const metaDescription = extractHtmlMetaDescription(body);
    const text = `${title ?? ""} ${metaDescription ?? ""} ${stripHtmlToText(body)}`.trim();
    return {
      url,
      status,
      accessible: true,
      title,
      metaDescription,
      text,
      jsonPayload: null,
      xmlItems: null,
      error: null,
    };
  }

  private isPlaceholderUrl(url: string | null | undefined): boolean {
    if (!url) return false;
    const dom = extractDomain(url);
    if (!dom) return false;
    if (PLACEHOLDER_DOMAINS.has(dom)) return true;
    return /\.(?:example|test|invalid|localhost)$/.test(dom);
  }

  private isPublicApiOrFeedUrl(rawUrl: string): boolean {
    const lower = rawUrl.toLowerCase();
    return (
      lower.includes("yc-oss.github.io/api/") ||
      lower.includes("export.arxiv.org/api/") ||
      lower.includes("api.openalex.org/") ||
      lower.includes("api.crossref.org/") ||
      lower.includes("api.github.com/") ||
      lower.includes("huggingface.co/api/") ||
      lower.includes("hn.algolia.com/api/") ||
      lower.includes("boards-api.greenhouse.io/") ||
      lower.includes("api.ashbyhq.com/") ||
      lower.includes("api.lever.co/") ||
      lower.includes("remotive.com/api/") ||
      lower.includes("arbeitnow.com/api/") ||
      lower.includes("jobicy.com/api/") ||
      lower.includes("himalayas.app/jobs/api/") ||
      lower.includes("remoteok.com/api") ||
      /\/(?:feed|rss)(?:\/|\.(?:xml|rss))?(?:\?|$)/i.test(lower) ||
      /\.(?:rss|xml|atom)(?:\?|$)/i.test(lower)
    );
  }

  private async fetchSnapshot(
    url: string,
    opts: { maxAttempts?: number; timeoutMs?: number; maxCrawlDelayMs?: number } = {}
  ): Promise<SourceSnapshot> {
    if (!isValidHttpUrl(url)) {
      return { url, status: 0, accessible: false, title: null, text: "", jsonPayload: null, xmlItems: null, error: "invalid_url" };
    }
    const existing = this.cache.get(url);
    if (existing) return existing;

    const isApiOrFeed = this.isPublicApiOrFeedUrl(url);
    const res = await this.http.fetch(url, {
      timeoutMs: opts.timeoutMs ?? Math.min(this.config.requestTimeoutMs, 10000),
      maxAttempts: opts.maxAttempts ?? 2,
      maxCrawlDelayMs: opts.maxCrawlDelayMs,
      checkRobots: !isApiOrFeed,
      headers:
        this.config.githubToken && url.includes("api.github.com")
          ? { Authorization: `Bearer ${this.config.githubToken}` }
          : undefined,
    });

    const snap = this.buildSnapshot(res.url || url, res.status, res.ok, res.content || "", res.contentType || "", res.error);
    this.cache.set(url, snap);
    return snap;
  }

  private resolveAuthoritativeApiUrl(
    category: "startups" | "products" | "research_papers" | "jobs" | "news",
    rec: Record<string, unknown>,
    meta: Record<string, unknown>,
    sourceUrl: string
  ): string | null {
    if (category === "research_papers") {
      if (typeof meta.openalex_api_url === "string" && isValidHttpUrl(meta.openalex_api_url)) {
        return meta.openalex_api_url;
      }
      if (typeof rec.arxiv_id === "string" && rec.arxiv_id.trim()) {
        return `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(rec.arxiv_id.trim())}`;
      }
      if (typeof rec.doi === "string" && rec.doi.trim()) {
        return `https://api.crossref.org/works/${encodeURIComponent(rec.doi.trim())}`;
      }
    } else if (category === "products") {
      const hfMatch = sourceUrl.match(/https?:\/\/huggingface\.co\/spaces\/([^?#]+)/i);
      if (hfMatch?.[1]) {
        return `https://huggingface.co/api/spaces/${hfMatch[1].replace(/\/+$/, "")}`;
      }
      const hnMatch = sourceUrl.match(/https?:\/\/news\.ycombinator\.com\/item\?id=(\d+)/i);
      if (hnMatch?.[1]) {
        return `https://hn.algolia.com/api/v1/items/${hnMatch[1]}`;
      }
      const ghSlug = extractGithubRepoSlug(sourceUrl);
      if (ghSlug) {
        return `https://api.github.com/repos/${ghSlug}`;
      }
    } else if (category === "news") {
      const hnMatch = sourceUrl.match(/https?:\/\/news\.ycombinator\.com\/item\?id=(\d+)/i);
      if (hnMatch?.[1]) {
        return `https://hn.algolia.com/api/v1/items/${hnMatch[1]}`;
      }
    }
    return null;
  }

  public async verifyRecord(
    category: "startups" | "products" | "research_papers" | "jobs" | "news",
    rec: Record<string, unknown>,
    opts: {
      liveCheck: boolean;
      bulkSnapshotOnly?: boolean;
      duplicateOf?: string | null;
      checkedAtIso: string;
    }
  ): Promise<Record<string, unknown>> {
    const now = new Date(opts.checkedAtIso);
    const sourceUrl = String(rec.source_url ?? "");
    const meta: Record<string, unknown> = {
      ...((rec.source_metadata as Record<string, unknown>) || {}),
      verification_mode: opts.liveCheck ? "live_http_check" : "offline_unverified",
    };
    const issues: string[] = [];
    const primaryClaim = String(rec.name ?? rec.title ?? rec.headline ?? "");

    const collectedDt = parseUtcDatetime(rec.collected_at);
    if (collectedDt && collectedDt.getTime() > now.getTime() + 10 * 60_000) {
      issues.push("future_collected_at");
    }

    if (category === "jobs" || category === "news") {
      const pubField = category === "jobs" ? "posted_at" : "published_at";
      const pubDt = parseUtcDatetime(rec[pubField]);
      const fresh = isWithinFreshnessWindow(pubDt, now, this.config.freshnessWindowHours);
      if (!fresh.ok) issues.push(`outdated:${fresh.reason}`);
    }

    let derivedRoleFamily: string | null = null;
    let derivedRemote: { remote_eligible: boolean | "Unknown"; evidence: string | null } | null = null;
    if (category === "jobs") {
      const tagsList = Array.isArray(meta.tags) ? meta.tags.map(String) : [];
      derivedRoleFamily = classifyJobRoleFamily(
        String(rec.title ?? ""),
        [String(meta.category ?? ""), String(meta.department ?? ""), ...tagsList].join(" "),
        (rec.description as string | null) ?? null
      );
      derivedRemote = detectJobRemoteEligibility(
        (rec.location as string | null) ?? null,
        (rec.employment_type as string | null) ?? null,
        (rec.description as string | null) ?? null,
        meta
      );
      meta.role_family = derivedRoleFamily;
      meta.remote_eligible = derivedRemote.remote_eligible;
      if (derivedRemote.evidence) meta.remote_evidence = derivedRemote.evidence;

      const qualifiesAi = isQualifyingAiJob(
        String(rec.source_name ?? ""),
        String(rec.title ?? ""),
        tagsList,
        String(meta.category ?? meta.department ?? ""),
        (rec.description as string | null) ?? null
      );
      if (!qualifiesAi) {
        issues.push("non_ai_role_scope");
      }
    }

    if (category === "news") {
      const qualifiesAiNews = isQualifyingAiNews(
        String(rec.source_name ?? ""),
        String(rec.headline ?? ""),
        (rec.summary as string | null) ?? null
      );
      if (!qualifiesAiNews) {
        issues.push("non_ai_news_scope");
      }
    }

    if (opts.duplicateOf) {
      issues.push("duplicate_record");
      meta.duplicate_of = opts.duplicateOf;
    }

    const incompleteFields: string[] = [];
    if (category === "startups") {
      if (!rec.description) incompleteFields.push("description");
      if (!rec.website && !rec.official_website) incompleteFields.push("website");
      if (rec.industry === "Unknown") incompleteFields.push("industry");
      if (rec.location === "Unknown") incompleteFields.push("location");
    } else if (category === "products") {
      if (!rec.description) incompleteFields.push("description");
      if (!rec.website && !rec.official_website) incompleteFields.push("website");
      if (rec.company_name === "Unknown") incompleteFields.push("company_name");
      if (rec.category === "Unknown") incompleteFields.push("category");
    } else if (category === "research_papers") {
      if (!rec.abstract) incompleteFields.push("abstract");
      if (!Array.isArray(rec.authors) || rec.authors.length === 0) incompleteFields.push("authors");
      if (!rec.publication_date) incompleteFields.push("publication_date");
    } else if (category === "jobs") {
      if (rec.company === "Unknown") incompleteFields.push("company");
      if (rec.location === "Unknown") incompleteFields.push("location");
      if (rec.employment_type === "Unknown") incompleteFields.push("employment_type");
      if (!rec.description) incompleteFields.push("description");
    } else if (category === "news") {
      if (!rec.summary) incompleteFields.push("summary");
      if (rec.publisher === "Unknown") incompleteFields.push("publisher");
    }
    if (incompleteFields.length > 0) {
      issues.push("incomplete_fields");
      meta.incomplete_fields = incompleteFields;
    } else {
      delete meta.incomplete_fields;
    }

    const placeholderReasons: string[] = [];
    for (const u of [rec.source_url, rec.website, rec.official_website, rec.application_url, rec.article_url]) {
      if (typeof u === "string" && this.isPlaceholderUrl(u)) {
        placeholderReasons.push(`placeholder_domain:${extractDomain(u)}`);
        break;
      }
    }
    const fieldsBlob = [rec.name, rec.title, rec.headline, rec.description, rec.summary, rec.abstract]
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .join(" ");
    const pm = fieldsBlob.match(PLACEHOLDER_TEXT_RE);
    if (pm) placeholderReasons.push(`placeholder_text:${pm[0].toLowerCase()}`);
    if (placeholderReasons.length > 0) issues.push(...placeholderReasons);

    const out: Record<string, unknown> = {
      ...rec,
      last_checked_at: opts.checkedAtIso,
    };
    if (category === "startups" || category === "products") {
      const site = (rec.official_website as string | null) || (rec.website as string | null);
      if (site) out.official_website = site;
    }

    if (!opts.liveCheck) {
      const scopeOrDateRejected = issues.filter(
        (i) => i.startsWith("outdated:") || i === "non_ai_role_scope" || i === "non_ai_news_scope"
      );
      const status: VerificationStatus =
        placeholderReasons.length > 0 || scopeOrDateRejected.length > 0 ? "Rejected" : "Unverified";
      const rejReason = [...placeholderReasons, ...scopeOrDateRejected].join("; ") || null;
      const exactReason =
        rejReason ||
        "Live HTTP verification was not performed (offline audit mode); evidence cannot be fabricated.";
      meta.audit_issues = Array.from(new Set(issues)).sort();
      meta.source_evidence_excerpt = null;
      meta.verification_reason = exactReason;
      meta.verified_fields = [];
      meta.unverified_fields = Array.from(new Set(incompleteFields));
      meta.confidence_score = 0;
      if (category === "startups") {
        const siteUrl = (out.official_website as string | null) || (out.website as string | null);
        meta.startup_verification_report = {
          company_name_match: { matched: false, claimed: String(rec.name ?? ""), evidence: null, source_url: sourceUrl },
          official_website_validity: {
            valid_url: isValidHttpUrl(siteUrl),
            accessible: null,
            http_status: null,
            url: siteUrl,
            page_title: null,
            error: "offline_not_checked",
          },
          description_match: { matched: false, claimed: (rec.description as string | null) ?? null, evidence: null },
          industry_evidence: { matched: false, claimed: String(rec.industry ?? "Unknown"), evidence: null },
          location_evidence: { matched: false, claimed: String(rec.location ?? "Unknown"), evidence: null, hq_guard_triggered: false },
          source_accessibility: {
            accessible: false,
            http_status: null,
            source_url: sourceUrl,
            source_title: (rec.source_title as string | null) ?? null,
            error: "offline_not_checked",
          },
          verification_timestamp: opts.checkedAtIso,
          exact_reason: exactReason,
        };
      }
      out.supported_fields = [];
      out.verification_status = status;
      out.rejection_reason = rejReason;
      out.source_metadata = meta;
      return out;
    }

    const fetchSourceUrl = sourceUrl.startsWith("http://arxiv.org/")
      ? `https://${sourceUrl.slice("http://".length)}`
      : sourceUrl;
    const seededApiUrl =
      typeof meta.api_url === "string" && isValidHttpUrl(meta.api_url)
        ? meta.api_url
        : category === "startups" && rec.source_name === "yc_oss_directory"
        ? "https://yc-oss.github.io/api/companies/all.json"
        : null;
    let useSeededApiSnapshot =
      Boolean(opts.bulkSnapshotOnly && seededApiUrl && this.cache.has(seededApiUrl) && !this.cache.has(fetchSourceUrl));

    if (useSeededApiSnapshot) {
      meta.verification_mode = "live_api_snapshot_check";
    }

    let primarySnap = useSeededApiSnapshot
      ? this.cache.get(seededApiUrl!)!
      : await this.fetchSnapshot(fetchSourceUrl);

    // If a seeded feed snapshot scrolled past an older record, or primary HTML timed out/403'd,
    // query the record's authoritative item-level API endpoint when available.
    const extractMatchedPrimary = (snap: SourceSnapshot): { ok: boolean; text: string } => {
      if (!snap.accessible) return { ok: false, text: "" };
      if (snap.jsonPayload !== null) {
        const matched = matchJsonItemText(snap.jsonPayload, primaryClaim, null, fetchSourceUrl);
        return { ok: Boolean(matched), text: matched ?? "" };
      }
      if (snap.xmlItems !== null) {
        const matchedXml = matchXmlItemText(snap.xmlItems, primaryClaim, null, fetchSourceUrl);
        return { ok: Boolean(matchedXml || textSupportsClaim(primaryClaim, snap.text, 0.7)), text: matchedXml ?? snap.text };
      }
      return { ok: true, text: snap.text };
    };

    let primaryMatch = extractMatchedPrimary(primarySnap);
    if (!primarySnap.accessible || (primarySnap.jsonPayload !== null && !primaryMatch.ok)) {
      const authApiUrl = this.resolveAuthoritativeApiUrl(category, rec, meta, fetchSourceUrl);
      if (authApiUrl && authApiUrl !== fetchSourceUrl && authApiUrl !== seededApiUrl) {
        const apiSnap = await this.fetchSnapshot(authApiUrl, {
          maxAttempts: 2,
          timeoutMs: 8000,
          maxCrawlDelayMs: 2500,
        });
        const apiMatch = extractMatchedPrimary(apiSnap);
        if (apiSnap.accessible && (apiMatch.ok || apiSnap.text)) {
          if (!primarySnap.accessible && primarySnap.error) {
            meta.html_source_error = primarySnap.error;
          }
          meta.authoritative_api_url = authApiUrl;
          meta.verification_mode = "live_api_corroboration";
          primarySnap = apiSnap;
          primaryMatch = apiMatch;
          useSeededApiSnapshot = false;
        }
      } else if (seededApiUrl && this.cache.has(seededApiUrl)) {
        const seededSnap = this.cache.get(seededApiUrl)!;
        const seededMatch = extractMatchedPrimary(seededSnap);
        if (seededSnap.accessible && seededMatch.ok) {
          if (!primarySnap.accessible && primarySnap.error) {
            meta.html_source_error = primarySnap.error;
          }
          meta.verification_mode = "live_api_snapshot_check";
          primarySnap = seededSnap;
          primaryMatch = seededMatch;
          useSeededApiSnapshot = true;
        }
      }
    }

    let secondaryUrl: string | null = null;
    if (!useSeededApiSnapshot || category === "products" || category === "startups") {
      if (category === "startups" || category === "products") {
        secondaryUrl = ((out.official_website as string | null) || (out.website as string | null)) ?? null;
      } else if (category === "jobs") {
        secondaryUrl = (rec.application_url as string | null) ?? null;
      } else if (category === "news") {
        secondaryUrl = (rec.article_url as string | null) ?? null;
      } else if (category === "research_papers") {
        let cand = (meta.openalex_api_url as string | null) || (rec.official_website as string | null) || null;
        if (cand && cand.includes("openalex.org/W") && !cand.includes("api.openalex.org")) {
          const wId = cand.replace(/\/+$/, "").split("/").pop();
          cand = `https://api.openalex.org/works/${wId}`;
        }
        if (!cand && rec.arxiv_id) {
          cand = `https://export.arxiv.org/api/query?id_list=${rec.arxiv_id}`;
        }
        if (!cand && rec.doi) {
          cand = `https://api.crossref.org/works/${encodeURIComponent(String(rec.doi))}`;
        }
        secondaryUrl = cand;
      }
    }

    // In large already-Verified bulk snapshots, skip redundant secondary homepage fetches
    if (
      opts.bulkSnapshotOnly &&
      useSeededApiSnapshot &&
      (category === "startups" || category === "products") &&
      rec.verification_status === "Verified"
    ) {
      secondaryUrl = null;
    }

    if (secondaryUrl === sourceUrl || secondaryUrl === fetchSourceUrl || secondaryUrl === meta.authoritative_api_url) {
      secondaryUrl = null;
    }
    // For huggingface_spaces products whose website is the space page itself while primary is the HF Space API
    if (
      category === "products" &&
      rec.source_name === "huggingface_spaces" &&
      useSeededApiSnapshot &&
      secondaryUrl &&
      secondaryUrl.startsWith("https://huggingface.co/spaces/")
    ) {
      secondaryUrl = null;
    }

    const secondarySnap =
      secondaryUrl && isValidHttpUrl(secondaryUrl)
        ? await this.fetchSnapshot(secondaryUrl, {
            maxAttempts: 1,
            timeoutMs: category === "news" || category === "jobs" ? 4000 : 5500,
            maxCrawlDelayMs: category === "news" || category === "jobs" ? 1500 : 3000,
          })
        : null;

    meta.source_http_status = primarySnap.status;
    if (primarySnap.error) meta.source_error = primarySnap.error;
    else delete meta.source_error;

    if (secondarySnap) {
      meta.secondary_url_checked = secondarySnap.url;
      meta.secondary_http_status = secondarySnap.status;
      meta.secondary_accessible = secondarySnap.accessible;
      if (category === "products" && secondarySnap.accessible && !rec.description && secondarySnap.metaDescription) {
        out.description = secondarySnap.metaDescription;
        const descIdx = incompleteFields.indexOf("description");
        if (descIdx !== -1) {
          incompleteFields.splice(descIdx, 1);
          if (incompleteFields.length === 0) delete meta.incomplete_fields;
          else meta.incomplete_fields = incompleteFields;
        }
      }
      if (category === "news" && secondarySnap.accessible && secondarySnap.text) {
        meta.full_text_excerpt = secondarySnap.text.slice(0, 2000);
        if ((!rec.summary || String(rec.summary).length < 180) && secondarySnap.text.length > 80) {
          out.summary = secondarySnap.text.slice(0, 1500);
          const sumIdx = incompleteFields.indexOf("summary");
          if (sumIdx !== -1) {
            incompleteFields.splice(sumIdx, 1);
            if (incompleteFields.length === 0) {
              delete meta.incomplete_fields;
            } else {
              meta.incomplete_fields = incompleteFields;
            }
          }
        }
      }
    }

    // For news items where the RSS feed / HN link timed out but the primary article_url succeeded and corroborates headline
    if (!primarySnap.accessible && category === "news" && secondarySnap?.accessible) {
      if (textSupportsClaim(String(rec.headline ?? ""), secondarySnap.text, 0.7)) {
        meta.rss_or_aggregator_error = primarySnap.error;
        meta.verification_mode = "live_article_corroboration";
        primarySnap = secondarySnap;
        primaryMatch = { ok: true, text: secondarySnap.text };
      }
    }

    if (!primarySnap.accessible) {
      issues.push(`source_unavailable:${primarySnap.error || "unreachable"}`);
      const scopeOrDateRejected = issues.filter(
        (i) => i.startsWith("outdated:") || i === "non_ai_role_scope" || i === "non_ai_news_scope"
      );
      const status: VerificationStatus =
        placeholderReasons.length > 0 || scopeOrDateRejected.length > 0 ? "Rejected" : "Source Unavailable";
      const rejReason =
        status === "Rejected" ? [...placeholderReasons, ...scopeOrDateRejected].join("; ") || null : null;
      const exactReason =
        rejReason || `Primary source URL could not be accessed (${primarySnap.error || "unreachable"}).`;
      meta.audit_issues = Array.from(new Set(issues)).sort();
      meta.source_evidence_excerpt = null;
      meta.verification_reason = exactReason;
      meta.verified_fields = [];
      meta.unverified_fields = Array.from(new Set(incompleteFields));
      meta.confidence_score = 0;
      if (category === "startups") {
        const siteUrl = (out.official_website as string | null) || (out.website as string | null);
        meta.startup_verification_report = {
          company_name_match: { matched: false, claimed: String(rec.name ?? ""), evidence: null, source_url: sourceUrl },
          official_website_validity: {
            valid_url: isValidHttpUrl(siteUrl),
            accessible: secondarySnap ? secondarySnap.accessible : null,
            http_status: secondarySnap ? secondarySnap.status : null,
            url: siteUrl,
            page_title: secondarySnap ? secondarySnap.title : null,
            error: secondarySnap ? secondarySnap.error : null,
          },
          description_match: { matched: false, claimed: (rec.description as string | null) ?? null, evidence: null },
          industry_evidence: { matched: false, claimed: String(rec.industry ?? "Unknown"), evidence: null },
          location_evidence: { matched: false, claimed: String(rec.location ?? "Unknown"), evidence: null, hq_guard_triggered: false },
          source_accessibility: {
            accessible: false,
            http_status: primarySnap.status,
            source_url: sourceUrl,
            source_title: primarySnap.title,
            error: primarySnap.error || "unreachable",
          },
          verification_timestamp: opts.checkedAtIso,
          exact_reason: exactReason,
        };
      }
      out.source_title = secondarySnap?.accessible ? secondarySnap.title : null;
      out.supported_fields = [];
      out.verification_status = status;
      out.rejection_reason = rejReason;
      out.source_metadata = meta;
      return out;
    }

    let primaryEvidenceText = primarySnap.text;
    if (primarySnap.jsonPayload !== null) {
      const matchedItem = matchJsonItemText(primarySnap.jsonPayload, primaryClaim, secondaryUrl, fetchSourceUrl);
      primaryEvidenceText = matchedItem ?? "";
    } else if (primarySnap.xmlItems !== null) {
      const matchedXml = matchXmlItemText(primarySnap.xmlItems, primaryClaim, secondaryUrl, fetchSourceUrl);
      primaryEvidenceText = matchedXml ?? primarySnap.text;
    }
    const combinedText = [primaryEvidenceText, secondarySnap?.accessible ? secondarySnap.text : ""]
      .filter(Boolean)
      .join(" ");

    const bodyPlaceholderMatch = combinedText.slice(0, 2000).match(PLACEHOLDER_TEXT_RE);
    if (bodyPlaceholderMatch) {
      const r = `placeholder_text:${bodyPlaceholderMatch[0].toLowerCase()}`;
      if (!issues.includes(r)) issues.push(r);
      if (!placeholderReasons.includes(r)) placeholderReasons.push(r);
    }

    const resolvedTitle =
      (secondarySnap?.accessible && secondarySnap.title ? secondarySnap.title : null) ||
      primarySnap.title ||
      (textSupportsClaim(primaryClaim, primaryEvidenceText) ? primaryClaim : null);
    out.source_title = resolvedTitle ? resolvedTitle.slice(0, 512) : null;

    const supportedFields: string[] = [];
    const unsupportedClaims: string[] = [];
    let primaryOk = false;

    let descOk = false;
    let websiteOk = false;
    let siteParked = false;
    let industryOk = false;
    let locOk = false;
    let hqGuarded = false;
    const originalLocation = String(rec.location ?? "Unknown");

    if (category === "startups") {
      primaryOk = textSupportsClaim(String(rec.name ?? ""), combinedText, 0.8);
      if (primaryOk) supportedFields.push("name");
      else unsupportedClaims.push("name");

      if (rec.description) {
        if (textSupportsClaim(String(rec.description), combinedText, 0.55)) {
          supportedFields.push("description");
          descOk = true;
        } else {
          unsupportedClaims.push("description");
        }
      }

      if (rec.website) {
        const dom = extractDomain(String(rec.website));
        if (secondarySnap) {
          if (secondarySnap.accessible) {
            const secBlob = `${secondarySnap.title ?? ""} ${secondarySnap.text.slice(0, 1200)}`;
            if (PARKED_DOMAIN_RE.test(secBlob)) {
              siteParked = true;
              issues.push("parked_or_forsale_website");
              meta.parked_website_detected = true;
              websiteOk = false;
            } else {
              websiteOk = true;
            }
          } else {
            websiteOk = false;
          }
        } else {
          websiteOk = Boolean(primarySnap.accessible && dom && combinedText.toLowerCase().includes(dom));
        }
        if (websiteOk) supportedFields.push("website");
        else unsupportedClaims.push("website");
      }

      if (rec.industry && rec.industry !== "Unknown") {
        if (textSupportsClaim(String(rec.industry), combinedText, 0.7)) {
          supportedFields.push("industry");
          industryOk = true;
        } else {
          unsupportedClaims.push("industry");
        }
      }

      if (rec.location && rec.location !== "Unknown") {
        const locAssess = assessLocationEvidence(String(rec.location), combinedText);
        locOk = locAssess.supported;
        hqGuarded = locAssess.hqGuarded;
        if (locOk) {
          supportedFields.push("location");
          out.location = locAssess.resolved;
        } else {
          out.location = "Unknown";
          unsupportedClaims.push("location");
          if (hqGuarded) {
            meta.hq_guard_triggered = true;
            issues.push("hq_branch_guard_triggered");
          }
        }
      }

      if (typeof rec.founding_date === "string" && rec.founding_date) {
        const fdYear = rec.founding_date.slice(0, 4);
        const epochMatch = (primaryEvidenceText.match(/\b\d{9,10}\b/g) ?? []).some((tok) => {
          const ms = Number(tok) * 1000;
          if (!Number.isFinite(ms)) return false;
          try {
            return new Date(ms).toISOString().slice(0, 10) === rec.founding_date;
          } catch {
            return false;
          }
        });
        if (combinedText.includes(fdYear) || epochMatch) {
          supportedFields.push("founding_date");
        } else {
          unsupportedClaims.push("founding_date");
        }
      }
    } else if (category === "products") {
      primaryOk = textSupportsClaim(String(rec.name ?? ""), combinedText, 0.8);
      if (primaryOk) supportedFields.push("name");
      else unsupportedClaims.push("name");

      if (rec.company_name && rec.company_name !== "Unknown") {
        if (textSupportsClaim(String(rec.company_name), combinedText, 0.75)) supportedFields.push("company_name");
        else unsupportedClaims.push("company_name");
      }
      const resolvedDesc = out.description ?? rec.description;
      if (resolvedDesc) {
        const descStr = String(resolvedDesc);
        // Handle structured Hugging Face Space summary facts against live HF API JSON
        const hfDescFacts =
          rec.source_name === "huggingface_spaces"
            ? [String(meta.sdk ?? ""), String(meta.likes ?? ""), String(rec.company_name ?? "")].filter(
                (t) => t && t !== "null" && t !== "Unknown"
              )
            : [];
        const hfFactsSupported =
          hfDescFacts.length >= 2 &&
          hfDescFacts.every((tok) => combinedText.toLowerCase().includes(tok.toLowerCase()));
        if (hfFactsSupported || textSupportsClaim(descStr, combinedText, 0.55)) {
          supportedFields.push("description");
        } else {
          unsupportedClaims.push("description");
        }
      }
      if (rec.category && rec.category !== "Unknown") {
        if (
          textSupportsClaim(String(rec.category), combinedText, 0.7) ||
          rec.category === "Show HN Launch" ||
          (rec.source_name === "huggingface_spaces" && rec.category === "AI Space")
        ) {
          supportedFields.push("category");
        } else {
          unsupportedClaims.push("category");
        }
      }
      if (rec.website) {
        const siteStr = String(rec.website);
        const dom = extractDomain(siteStr);
        if (secondarySnap) {
          const secBlob = `${secondarySnap.title ?? ""} ${secondarySnap.text.slice(0, 1200)}`;
          if (secondarySnap.accessible && PARKED_DOMAIN_RE.test(secBlob)) {
            issues.push("parked_or_forsale_website");
            unsupportedClaims.push("website");
          } else if (secondarySnap.accessible) {
            supportedFields.push("website");
          } else {
            unsupportedClaims.push("website");
          }
        } else if (
          (dom && combinedText.toLowerCase().includes(dom)) ||
          (rec.source_name === "huggingface_spaces" &&
            siteStr.startsWith("https://huggingface.co/spaces/") &&
            typeof meta.space_id === "string" &&
            combinedText.toLowerCase().includes(meta.space_id.toLowerCase()))
        ) {
          supportedFields.push("website");
        } else {
          unsupportedClaims.push("website");
        }
      }
    } else if (category === "research_papers") {
      primaryOk = textSupportsClaim(String(rec.title ?? ""), combinedText, 0.75);
      if (primaryOk) supportedFields.push("title");
      else unsupportedClaims.push("title");

      if (rec.abstract) {
        if (textSupportsClaim(String(rec.abstract).slice(0, 300), combinedText, 0.55)) {
          supportedFields.push("abstract");
        } else {
          unsupportedClaims.push("abstract");
        }
      }
      if (Array.isArray(rec.authors) && rec.authors.length > 0) {
        const first = String(rec.authors[0]);
        const last = first.split(/\s+/).pop() || first;
        if (textSupportsClaim(last, combinedText, 0.8)) supportedFields.push("authors");
        else unsupportedClaims.push("authors");
      }
      if (typeof rec.doi === "string" && rec.doi) {
        if (combinedText.toLowerCase().includes(rec.doi.toLowerCase())) supportedFields.push("doi");
        else unsupportedClaims.push("doi");
      }
      if (typeof rec.arxiv_id === "string" && rec.arxiv_id) {
        const baseId = rec.arxiv_id.split("v")[0].toLowerCase();
        if (combinedText.toLowerCase().includes(baseId) || sourceUrl.toLowerCase().includes(baseId)) {
          supportedFields.push("arxiv_id");
        } else {
          unsupportedClaims.push("arxiv_id");
        }
      }
      if (typeof rec.github_repository === "string" && rec.github_repository) {
        const ghSlug = extractGithubRepoSlug(rec.github_repository)?.toLowerCase() ?? "";
        if (
          combinedText.toLowerCase().includes(rec.github_repository.toLowerCase()) ||
          (ghSlug && combinedText.toLowerCase().includes(ghSlug))
        ) {
          supportedFields.push("github_repository");
        } else {
          unsupportedClaims.push("github_repository");
        }
      }
    } else if (category === "jobs") {
      primaryOk = textSupportsClaim(String(rec.title ?? ""), combinedText, 0.75);
      if (primaryOk) supportedFields.push("title");
      else unsupportedClaims.push("title");

      if (rec.company && rec.company !== "Unknown") {
        if (
          textSupportsClaim(String(rec.company), combinedText, 0.75) ||
          String(rec.source_name ?? "").startsWith("greenhouse:") ||
          String(rec.source_name ?? "").startsWith("ashby:")
        ) {
          supportedFields.push("company");
        } else {
          unsupportedClaims.push("company");
        }
      }
      if (rec.description) {
        if (textSupportsClaim(String(rec.description).slice(0, 300), combinedText, 0.55)) {
          supportedFields.push("description");
        } else {
          unsupportedClaims.push("description");
        }
      }
      if (rec.location && rec.location !== "Unknown") {
        const locAssess = assessLocationEvidence(String(rec.location), combinedText);
        if (
          locAssess.supported ||
          (String(rec.location).toLowerCase() === "remote" && combinedText.toLowerCase().includes("remote"))
        ) {
          supportedFields.push("location");
          if (locAssess.supported) out.location = locAssess.resolved;
        } else {
          out.location = "Unknown";
          unsupportedClaims.push("location");
          if (locAssess.hqGuarded) {
            meta.hq_guard_triggered = true;
            issues.push("hq_branch_guard_triggered");
          }
        }
      }
      if (rec.employment_type && rec.employment_type !== "Unknown") {
        if (textSupportsClaim(String(rec.employment_type), combinedText, 0.7)) {
          supportedFields.push("employment_type");
        } else {
          unsupportedClaims.push("employment_type");
        }
      }
      if (derivedRoleFamily && derivedRoleFamily !== "Unknown") {
        supportedFields.push("role_family");
      }
      if (derivedRemote && derivedRemote.remote_eligible !== "Unknown") {
        supportedFields.push("remote_eligible");
      }
    } else if (category === "news") {
      primaryOk = textSupportsClaim(String(rec.headline ?? ""), combinedText, 0.75);
      if (primaryOk) supportedFields.push("headline");
      else unsupportedClaims.push("headline");

      if (rec.publisher && rec.publisher !== "Unknown") {
        if (
          textSupportsClaim(String(rec.publisher), combinedText, 0.7) ||
          rec.publisher === "Hacker News"
        ) {
          supportedFields.push("publisher");
        } else {
          unsupportedClaims.push("publisher");
        }
      }
      if (rec.summary || out.summary) {
        const sumVal = String(out.summary ?? rec.summary ?? "");
        if (textSupportsClaim(sumVal.slice(0, 300), combinedText, 0.55)) {
          supportedFields.push("summary");
        } else {
          unsupportedClaims.push("summary");
        }
      }
      if (rec.article_url) {
        if (
          secondarySnap?.accessible ||
          combinedText.toLowerCase().includes(String(rec.article_url).toLowerCase())
        ) {
          supportedFields.push("article_url");
        } else {
          unsupportedClaims.push("article_url");
        }
      }
    }

    if (!primaryOk) issues.push("mismatched_source_content");

    meta.source_evidence_excerpt = primaryOk ? extractEvidenceExcerpt(primaryClaim, combinedText) : null;
    meta.unsupported_fields = unsupportedClaims;
    meta.verified_fields = supportedFields;
    meta.unverified_fields = Array.from(new Set([...unsupportedClaims, ...incompleteFields]));
    meta.audit_issues = Array.from(new Set(issues)).sort();

    const outdatedOrScopeIssues = issues.filter(
      (i) =>
        i.startsWith("outdated:") ||
        i === "future_collected_at" ||
        i === "non_ai_role_scope" ||
        i === "non_ai_news_scope"
    );
    let status: VerificationStatus;
    let rejectionReason: string | null = null;

    if (placeholderReasons.length > 0) {
      status = "Rejected";
      rejectionReason = `Placeholder or fabricated signal detected: ${placeholderReasons.join(", ")}`;
    } else if (opts.duplicateOf) {
      status = "Rejected";
      rejectionReason = `Duplicate of existing record ${opts.duplicateOf}`;
    } else if (outdatedOrScopeIssues.length > 0) {
      status = "Rejected";
      rejectionReason = `Dataset qualification failed: ${outdatedOrScopeIssues.join(", ")}`;
    } else if (!primaryOk || supportedFields.length === 0) {
      status = "Unverified";
      rejectionReason = primarySnap.accessible
        ? "Accessible source did not corroborate primary record name/title"
        : null;
    } else if (supportedFields.length >= 2 && unsupportedClaims.length === 0 && incompleteFields.length === 0) {
      status = "Verified";
    } else {
      status = "Partially Verified";
    }

    // Evidence-grounded confidence score derived strictly from corroborated fields & accessible primary/secondary URLs
    const totalFieldsAssessed = supportedFields.length + unsupportedClaims.length + incompleteFields.length;
    const fieldRatio = totalFieldsAssessed > 0 ? supportedFields.length / totalFieldsAssessed : 0;
    const sourceWeight =
      meta.verification_mode === "live_http_check" || meta.verification_mode === "live_api_corroboration"
        ? 0.25
        : 0.2;
    let confidenceScore = 0;
    if (status === "Verified") {
      confidenceScore = Number(Math.min(1.0, sourceWeight + 0.75 * fieldRatio).toFixed(3));
    } else if (status === "Partially Verified") {
      confidenceScore = Number(Math.min(0.89, sourceWeight + 0.65 * fieldRatio).toFixed(3));
    }
    meta.confidence_score = confidenceScore;

    let verificationReason: string;
    if (status === "Verified") {
      verificationReason = `All required fields (${supportedFields.join(", ")}) were corroborated by accessible live source content.`;
    } else if (status === "Partially Verified") {
      const gapParts: string[] = [];
      if (unsupportedClaims.length > 0) gapParts.push(`uncorroborated fields: ${unsupportedClaims.join(", ")}`);
      if (incompleteFields.length > 0) gapParts.push(`missing/unknown fields: ${incompleteFields.join(", ")}`);
      if (secondarySnap && !secondarySnap.accessible) {
        gapParts.push(`official website unreachable (${secondarySnap.error || `http_${secondarySnap.status}`})`);
      }
      verificationReason = `Supported fields: ${supportedFields.join(", ")}; ${
        gapParts.length > 0 ? gapParts.join("; ") : "insufficient evidence across all required fields"
      }`;
    } else {
      verificationReason = rejectionReason || "Source did not sufficiently corroborate record claims.";
    }
    meta.verification_reason = verificationReason;

    if (category === "startups") {
      const siteUrl = (out.official_website as string | null) || (out.website as string | null);
      meta.startup_verification_report = {
        company_name_match: {
          matched: primaryOk,
          claimed: String(rec.name ?? ""),
          evidence: primaryOk ? extractEvidenceExcerpt(String(rec.name ?? ""), combinedText, 90) : null,
          source_url: sourceUrl,
        },
        official_website_validity: {
          valid_url: isValidHttpUrl(siteUrl),
          accessible: secondarySnap
            ? secondarySnap.accessible
            : siteUrl === sourceUrl
            ? primarySnap.accessible
            : websiteOk,
          http_status: secondarySnap
            ? secondarySnap.status
            : siteUrl === sourceUrl
            ? primarySnap.status
            : null,
          url: siteUrl,
          page_title: secondarySnap ? secondarySnap.title : null,
          error: siteParked
            ? "parked_or_forsale_domain"
            : secondarySnap
            ? secondarySnap.error
            : siteUrl
            ? null
            : "missing_website",
        },
        description_match: {
          matched: descOk,
          claimed: (rec.description as string | null) ?? null,
          evidence:
            descOk && rec.description
              ? extractEvidenceExcerpt(String(rec.description).slice(0, 80), combinedText, 100)
              : null,
        },
        industry_evidence: {
          matched: industryOk,
          claimed: String(rec.industry ?? "Unknown"),
          evidence: industryOk ? extractEvidenceExcerpt(String(rec.industry ?? ""), combinedText, 80) : null,
        },
        location_evidence: {
          matched: locOk,
          claimed: originalLocation,
          evidence: locOk
            ? extractEvidenceExcerpt(originalLocation.split(",")[0], combinedText, 80)
            : null,
          hq_guard_triggered: hqGuarded,
        },
        source_accessibility: {
          accessible: primarySnap.accessible,
          http_status: primarySnap.status,
          source_url: sourceUrl,
          source_title: (out.source_title as string | null) ?? null,
          error: primarySnap.error,
        },
        verification_timestamp: opts.checkedAtIso,
        exact_reason: verificationReason,
      };
    }

    out.supported_fields = supportedFields;
    out.verification_status = status;
    out.rejection_reason = rejectionReason;
    out.source_metadata = meta;
    return out;
  }
}

// ---------- Entity Resolution ----------

const LEGAL_SUFFIXES = new Set([
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "llc",
  "ltd",
  "limited",
  "plc",
  "gmbh",
  "ag",
  "sa",
  "sas",
  "sarl",
  "bv",
  "nv",
  "pty",
  "co",
  "company",
  "lp",
  "llp",
  "pbc",
]);

const GENERIC_HOST_DOMAINS = new Set([
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "linkedin.com",
  "twitter.com",
  "x.com",
  "medium.com",
  "substack.com",
  "ycombinator.com",
  "news.ycombinator.com",
  "arxiv.org",
  "huggingface.co",
  "notion.site",
  "docs.google.com",
  "arbeitnow.com",
  "remotive.com",
  "weworkremotely.com",
  "jobicy.com",
  "himalayas.app",
  "remoteok.com",
  "boards.greenhouse.io",
  "job-boards.greenhouse.io",
  "jobs.ashbyhq.com",
  "jobs.lever.co",
]);

export function normalizeEntityName(rawName: string): string {
  if (!rawName || !rawName.trim()) return "";
  let text = rawName.normalize("NFKC").toLowerCase().trim();
  text = text.replace(/[_-]+/g, " ").replace(/[^\p{L}\p{N}\s]+/gu, " ");
  const tokens = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  return tokens.join(" ");
}

function isSpecificCompanyDomain(domain: string | null): boolean {
  if (!domain) return false;
  const lower = domain.toLowerCase().trim();
  if (GENERIC_HOST_DOMAINS.has(lower)) return false;
  for (const suffix of [".github.io", ".substack.com", ".medium.com", ".notion.site", ".blogspot.com"]) {
    if (lower.endsWith(suffix)) return false;
  }
  return lower.includes(".");
}

function bigramSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const bigramsA = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const bg = a.slice(i, i + 2);
    bigramsA.set(bg, (bigramsA.get(bg) ?? 0) + 1);
  }
  let intersection = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const bg = b.slice(i, i + 2);
    const cnt = bigramsA.get(bg) ?? 0;
    if (cnt > 0) {
      intersection++;
      bigramsA.set(bg, cnt - 1);
    }
  }
  return (2 * intersection) / (a.length + b.length - 2);
}

function computeNameSimilarity(normA: string, normB: string): number {
  if (!normA || !normB) return 0;
  if (normA === normB) return 1;
  const seqRatio = bigramSimilarity(normA, normB);
  const tokensA = new Set(normA.split(" ").filter(Boolean));
  const tokensB = new Set(normB.split(" ").filter(Boolean));
  if (tokensA.size === 0 || tokensB.size === 0) return seqRatio;
  let inter = 0;
  for (const t of tokensA) if (tokensB.has(t)) inter++;
  const union = new Set([...tokensA, ...tokensB]).size;
  const jaccard = inter / union;
  if (tokensA.size === 1 && tokensB.size === 1 && normA.replace(/\s+/g, "") !== normB.replace(/\s+/g, "")) {
    return Math.min(seqRatio, 0.84);
  }
  if (tokensA.size >= 2 && tokensB.size >= 2 && jaccard < 0.55) {
    return Math.min(seqRatio, 0.78);
  }
  return Number((0.65 * seqRatio + 0.35 * jaccard).toFixed(4));
}

export class EntityResolver {
  private readonly entities: CanonicalEntityRow[] = [];
  private readonly logs: EntityMappingLogInput[] = [];
  private readonly stats: Record<string, number> = {
    total_logged: 0,
    exact_match: 0,
    auto_merge: 0,
    manual_review: 0,
    new_entity: 0,
    rejected: 0,
  };

  constructor(existingEntities: CanonicalEntityRow[]) {
    this.entities.push(...existingEntities);
  }

  private registerEntity(rawName: string, normalized: string, entityType: string, domain: string | null): CanonicalEntityRow {
    const cid = makeStableId("ent", entityType, normalized, domain ?? "");
    const existing = this.entities.find((e) => e.canonical_id === cid);
    if (existing) return existing;
    const row: CanonicalEntityRow = {
      canonical_id: cid,
      canonical_name: rawName,
      normalized_name: normalized,
      entity_type: entityType,
      primary_domain: domain,
      aliases_json: JSON.stringify([rawName]),
      created_at: new Date().toISOString(),
    };
    this.entities.push(row);
    return row;
  }

  private addAlias(ent: CanonicalEntityRow, alias: string): void {
    try {
      const arr = JSON.parse(ent.aliases_json || "[]");
      if (Array.isArray(arr) && !arr.includes(alias)) {
        arr.push(alias);
        ent.aliases_json = JSON.stringify(arr);
      }
    } catch {
      ent.aliases_json = JSON.stringify([ent.canonical_name, alias]);
    }
  }

  public resolve(opts: {
    rawName: string;
    entityType: "startup" | "product" | "company" | "publisher";
    website?: string | null;
    sourceUrl: string;
  }): string {
    const cleanRaw = opts.rawName.trim();
    const normalized = normalizeEntityName(cleanRaw) || cleanRaw.toLowerCase();
    let domain = extractDomain(opts.website) || (!opts.website ? extractDomain(opts.sourceUrl) : null);
    if (!isSpecificCompanyDomain(domain)) domain = null;

    const sameType = this.entities.filter((e) => e.entity_type === opts.entityType);
    const exact = sameType.find((e) => {
      if (e.normalized_name === normalized) return true;
      try {
        const aliases = JSON.parse(e.aliases_json || "[]") as string[];
        return aliases.some((a) => normalizeEntityName(a) === normalized);
      } catch {
        return false;
      }
    });

    const recordDecision = (
      canonical: CanonicalEntityRow,
      method: string,
      confidence: number,
      decision: string,
      reason: string
    ) => {
      const nowIso = new Date().toISOString();
      const mapId = makeStableId("map", cleanRaw, canonical.canonical_id, opts.sourceUrl, method);
      this.logs.push({
        mapping_id: mapId,
        raw_name: cleanRaw,
        normalized_name: normalized,
        canonical_name: canonical.canonical_name,
        canonical_id: canonical.canonical_id,
        source_url: opts.sourceUrl,
        match_method: method,
        confidence,
        decision,
        timestamp: nowIso,
        entity_type: opts.entityType,
        match_reason: reason,
      });
      this.stats.total_logged += 1;
      if (decision in this.stats) this.stats[decision] += 1;
    };

    const domainsConflict = (a: string | null, b: string | null) =>
      isSpecificCompanyDomain(a) && isSpecificCompanyDomain(b) && a!.toLowerCase() !== b!.toLowerCase();

    if (exact) {
      if (domainsConflict(domain, exact.primary_domain)) {
        const created = this.registerEntity(cleanRaw, normalized, opts.entityType, domain);
        recordDecision(
          created,
          "domain_conflict_guard",
          0.65,
          "manual_review",
          `Normalized name '${normalized}' matched '${exact.canonical_name}' but domains differ (${domain} vs ${exact.primary_domain}); kept separate for review.`
        );
        return created.canonical_id;
      }
      const isExact = cleanRaw.toLowerCase() === exact.canonical_name.toLowerCase();
      const decision = isExact ? "exact_match" : "auto_merge";
      const method = isExact ? "exact_normalized" : "legal_suffix_or_alias_match";
      this.addAlias(exact, cleanRaw);
      recordDecision(
        exact,
        method,
        isExact ? 1.0 : 0.98,
        decision,
        `Matched canonical entity '${exact.canonical_name}' via normalized form '${normalized}'.`
      );
      return exact.canonical_id;
    }

    const compact = normalized.replace(/\s+/g, "");
    const compactCand = sameType.find(
      (e) => e.normalized_name.replace(/\s+/g, "") === compact && !domainsConflict(domain, e.primary_domain)
    );
    if (compactCand && (compact.length >= 5 || (domain && compactCand.primary_domain === domain))) {
      this.addAlias(compactCand, cleanRaw);
      recordDecision(
        compactCand,
        "compact_spacing_match",
        domain && compactCand.primary_domain === domain ? 0.96 : 0.93,
        "auto_merge",
        `Compact key '${compact}' matched '${compactCand.canonical_name}' with spacing normalization.`
      );
      return compactCand.canonical_id;
    }

    let best: CanonicalEntityRow | null = null;
    let bestScore = 0;
    for (const cand of sameType) {
      if (domainsConflict(domain, cand.primary_domain)) continue;
      const score = computeNameSimilarity(normalized, cand.normalized_name);
      if (score > bestScore) {
        bestScore = score;
        best = cand;
      }
    }

    if (best && bestScore >= 0.92) {
      this.addAlias(best, cleanRaw);
      recordDecision(
        best,
        "fuzzy_high_confidence",
        bestScore,
        "auto_merge",
        `High fuzzy similarity (${bestScore.toFixed(3)} >= 0.92) with no domain conflict.`
      );
      return best.canonical_id;
    }

    if (best && bestScore >= 0.8) {
      const created = this.registerEntity(cleanRaw, normalized, opts.entityType, domain);
      recordDecision(
        created,
        "fuzzy_uncertain",
        bestScore,
        "manual_review",
        `Uncertain similarity (${bestScore.toFixed(3)}) to '${best.canonical_name}'; not auto-merged to prevent false positives.`
      );
      return created.canonical_id;
    }

    const created = this.registerEntity(cleanRaw, normalized, opts.entityType, domain);
    recordDecision(
      created,
      "new_canonical",
      1.0,
      "new_entity",
      "No sufficiently similar canonical entity found; registered new canonical entity."
    );
    return created.canonical_id;
  }

  public getEntities(): CanonicalEntityRow[] {
    return this.entities;
  }

  public getLogs(): EntityMappingLogInput[] {
    return this.logs;
  }

  public getStats(): Record<string, number> {
    return { ...this.stats };
  }
}

// ---------- Collectors ----------

type RawRecord = Record<string, unknown>;
type CollectorError = { source: string; url: string; error: string };
interface CollectionBatchResult {
  records: RawRecord[];
  errors: CollectorError[];
  hasMore: boolean;
  sourceOutcomes: SourceOutcomeRecord[];
}

const AI_ROLE_TITLE_OR_TAG_RE =
  /\b(ai|artificial intelligence|machine learning|deep learning|llm|large language model|generative ai|genai|nlp|natural language|computer vision|mlops|ai\/ml|data scien|robotics|foundation model|research scientist|research engineer|inference|alignment|transformer|rag|agentic|pytorch|tensorflow|neural|copilot|autonomous)\b/i;

const AI_DESC_STRONG_RE =
  /\b(artificial intelligence|machine learning|deep learning|large language model|generative ai|computer vision|natural language processing|mlops|ai engineer|ai architect|ai scientist|ai researcher|llm|neural network|foundation model)\b/i;

const AI_NEWS_RE =
  /\b(ai|artificial intelligence|machine learning|deep learning|llm|llms|large language model|generative|chatgpt|openai|anthropic|claude|gemini|deepseek|mistral|hugging face|huggingface|pytorch|neural|transformer|diffusion|robotics|autonomous|nvidia|agentic|rag|reasoning model|copilot|midjourney|meta ai|xai|grok|cohere|perplexity|alignment|safety benchmark)\b/i;

function isAiNativeJobBoard(sourceName: string): boolean {
  return /^(?:greenhouse|ashby):(?:anthropic|scaleai|xai|togetherai|openai|perplexity|cohere|cursor|elevenlabs|harvey)$/.test(
    sourceName
  );
}

function isQualifyingAiJob(
  sourceName: string,
  title: string,
  tagsOrSkills: string[],
  category: string,
  description: string | null
): boolean {
  if (isAiNativeJobBoard(sourceName)) return true;
  if (AI_ROLE_TITLE_OR_TAG_RE.test(title)) return true;
  if (AI_ROLE_TITLE_OR_TAG_RE.test(category)) return true;
  if (tagsOrSkills.some((t) => AI_ROLE_TITLE_OR_TAG_RE.test(t))) return true;
  if (description && AI_DESC_STRONG_RE.test(description.slice(0, 1200))) return true;
  return false;
}

function isQualifyingAiNews(sourceName: string, headline: string, summary: string | null): boolean {
  const dedicatedAiFeeds = new Set([
    "huggingface_blog",
    "mit_news_ai",
    "google_blog",
    "techcrunch_ai",
    "openai_news",
    "wired_ai",
    "marktechpost",
    "the_decoder",
    "theverge_ai",
    "siliconangle_ai",
  ]);
  if (dedicatedAiFeeds.has(sourceName)) return true;
  return AI_NEWS_RE.test(headline) || Boolean(summary && AI_NEWS_RE.test(summary.slice(0, 800)));
}

export function classifyJobRoleFamily(
  title: string,
  categoryOrTags = "",
  description: string | null = null
): string {
  const titleBlob = `${title} ${categoryOrTags}`.trim();
  const fullBlob = `${titleBlob} ${(description ?? "").slice(0, 800)}`;
  if (/\b(?:safety|alignment|evals|evaluation|red team|trust & safety|policy)\b/i.test(titleBlob)) {
    return "AI Safety & Alignment";
  }
  if (/\b(?:robotics|embodied|autonomous|perception|manipulation|firmware|mechatronics)\b/i.test(titleBlob)) {
    return "Robotics & Autonomous Systems";
  }
  if (/\b(?:research scientist|research engineer|applied scientist|scientist|postdoc|researcher)\b/i.test(titleBlob)) {
    return "Research & Science";
  }
  if (/\b(?:mlops|ml infra|ai infra|inference|kubernetes|distributed systems|gpu|cuda|kernel|platform|infrastructure)\b/i.test(titleBlob)) {
    return "Infrastructure & MLOps";
  }
  if (/\b(?:data scientist|data engineer|analytics engineer|business intelligence)\b/i.test(titleBlob)) {
    return "Data Science & Analytics";
  }
  if (/\b(?:product manager|product designer|design|solutions architect|solutions engineer|forward deployed|gtm|sales|account)\b/i.test(titleBlob)) {
    return "AI Product & Solutions";
  }
  if (/\b(?:ai|ml|machine learning|deep learning|llm|nlp|computer vision|genai|generative)\b/i.test(fullBlob)) {
    return "ML & AI Engineering";
  }
  if (/\b(?:software|backend|frontend|full[- ]?stack|systems|developer)\b/i.test(titleBlob)) {
    return "Software Engineering";
  }
  return "Unknown";
}

export function detectJobRemoteEligibility(
  location: string | null | undefined,
  employmentType: string | null | undefined,
  description: string | null | undefined,
  metadata: Record<string, unknown> = {}
): { remote_eligible: boolean | "Unknown"; evidence: string | null } {
  if (metadata.remote === true || metadata.isRemote === true) {
    return { remote_eligible: true, evidence: "source_metadata remote flag is true" };
  }
  if (metadata.remote === false || metadata.isRemote === false) {
    return { remote_eligible: false, evidence: "source_metadata remote flag is false" };
  }
  const loc = (location ?? "").trim();
  const emp = (employmentType ?? "").trim();
  const combinedHead = `${loc} ${emp}`.trim();
  if (/\b(?:remote|work from home|wfh|distributed|anywhere)\b/i.test(combinedHead)) {
    return { remote_eligible: true, evidence: `Location/type states '${combinedHead}'` };
  }
  if (/\b(?:on[- ]?site|in[- ]?office|in[- ]?person)\b/i.test(combinedHead)) {
    return { remote_eligible: false, evidence: `Location/type states '${combinedHead}'` };
  }
  const desc = (description ?? "").slice(0, 1200);
  if (/\b(?:fully remote|remote[- ]first|100% remote|work from anywhere)\b/i.test(desc)) {
    return { remote_eligible: true, evidence: "Description explicitly states remote eligibility" };
  }
  if (/\b(?:in-?person|on-?site|in-?office|hybrid)\b/i.test(desc)) {
    return { remote_eligible: false, evidence: "Description states on-site, in-office, or hybrid attendance" };
  }
  return { remote_eligible: "Unknown", evidence: null };
}

export { LiveSourceVerifier, matchJsonItemText };

function parseLinkNextUrl(linkHeader: string | null | undefined): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    if (part.includes('rel="next"') || part.includes("rel='next'")) {
      const m = part.match(/<([^>]+)>/);
      if (m?.[1] && isValidHttpUrl(m[1])) return m[1];
    }
  }
  return null;
}

async function collectStartups(
  config: AtlasConfig,
  http: PoliteHttpClient,
  llmRouter: LLMRouter,
  verifier: LiveSourceVerifier,
  limit: number,
  page: number,
  onLog?: (msg: string) => void
): Promise<CollectionBatchResult> {
  const url = "https://yc-oss.github.io/api/companies/all.json";
  const res = await http.fetch(url, { timeoutMs: config.requestTimeoutMs, maxAttempts: 2, checkRobots: false });
  if (!res.ok) {
    const errText = res.error || "fetch_failed";
    return {
      records: [],
      errors: [{ source: "yc_oss_directory", url, error: errText }],
      hasMore: false,
      sourceOutcomes: [
        {
          category: "startups",
          source: "yc_oss_directory",
          url,
          status: "failed",
          discoveredCount: 0,
          retried: res.attempts > 1,
          attempts: res.attempts,
          httpStatus: res.status || null,
          error: errText,
        },
      ],
    };
  }
  verifier.seedSnapshot(url, res.status, res.content, res.contentType);

  let companies: unknown;
  try {
    companies = JSON.parse(res.content);
  } catch (err) {
    const errText = `invalid_json: ${String(err)}`;
    return {
      records: [],
      errors: [{ source: "yc_oss_directory", url, error: errText }],
      hasMore: false,
      sourceOutcomes: [
        {
          category: "startups",
          source: "yc_oss_directory",
          url,
          status: "failed",
          discoveredCount: 0,
          retried: res.attempts > 1,
          attempts: res.attempts,
          httpStatus: res.status || null,
          error: errText,
        },
      ],
    };
  }
  if (!Array.isArray(companies)) {
    return {
      records: [],
      errors: [{ source: "yc_oss_directory", url, error: "unexpected_payload_shape" }],
      hasMore: false,
      sourceOutcomes: [
        {
          category: "startups",
          source: "yc_oss_directory",
          url,
          status: "failed",
          discoveredCount: 0,
          retried: res.attempts > 1,
          attempts: res.attempts,
          httpStatus: res.status || null,
          error: "unexpected_payload_shape",
        },
      ],
    };
  }

  const ordered = companies
    .filter((c): c is Record<string, unknown> => Boolean(c && typeof c === "object" && String((c as Record<string, unknown>).name ?? "").trim()))
    .sort((a, b) => {
      const actA = String(a.status ?? "").toLowerCase() === "active" ? 1 : 0;
      const actB = String(b.status ?? "").toLowerCase() === "active" ? 1 : 0;
      if (actA !== actB) return actB - actA;
      const tsA = typeof a.launched_at === "number" ? a.launched_at : 0;
      const tsB = typeof b.launched_at === "number" ? b.launched_at : 0;
      return tsB - tsA;
    });

  const safePage = Math.max(1, page);
  const startIdx = (safePage - 1) * limit;
  const pageSlice = ordered.slice(startIdx, startIdx + limit);
  const hasMore = startIdx + limit < ordered.length;
  const nowIso = new Date().toISOString();

  const records: RawRecord[] = [];
  for (const item of pageSlice) {
    const name = String(item.name ?? "").trim();
    if (!name) continue;
    const website = validateOptionalUrl(item.website);
    const slug = item.slug ?? item.id;
    let sourceUrl = String(item.url ?? "").trim();
    if (!sourceUrl && slug) sourceUrl = `https://www.ycombinator.com/companies/${slug}`;
    if (!isValidHttpUrl(sourceUrl)) sourceUrl = url;

    const launchedDt = parseUtcDatetime(item.launched_at);
    const foundingDate = launchedDt ? launchedDt.toISOString().slice(0, 10) : null;
    const industries = Array.isArray(item.industries) ? item.industries : [];
    const industry = normalizeUnknownText(item.industry || industries[0]);
    const desc = String(item.one_liner || item.long_description || "").trim().slice(0, 3500) || null;

    records.push({
      name,
      description: desc,
      website,
      official_website: website,
      industry,
      location: normalizeUnknownText(item.all_locations),
      founding_date: foundingDate,
      source_name: "yc_oss_directory",
      source_url: normalizeUrl(sourceUrl),
      collected_at: nowIso,
      source_metadata: {
        api_url: url,
        batch: item.batch ?? null,
        status: item.status ?? null,
        team_size: item.team_size ?? null,
        tags: Array.isArray(item.tags) ? item.tags : [],
        yc_industries: industries,
      },
    });
  }

  // Optional polite LLM enrichment for small runs when records lack descriptions
  if (llmRouter.isConfigured() && limit <= 25) {
    const incomplete = records.filter((r) => (!r.description || r.industry === "Unknown") && r.website).slice(0, 3);
    for (const rec of incomplete) {
      const siteUrl = String(rec.website);
      const pageRes = await http.fetch(siteUrl, { timeoutMs: 7000, maxAttempts: 1, deduplicate: true });
      if (!pageRes.ok || !pageRes.content) continue;
      const text = stripHtmlToText(pageRes.content).slice(0, 12000);
      if (text.length < 100) continue;
      const llmRes = await llmRouter.extractStructured({
        category: "startups",
        sourceUrl: siteUrl,
        sourceName: "yc_oss_directory_llm",
        sourceText: text,
        onLog,
      });
      const hit = llmRes.records[0];
      if (hit) {
        if (!rec.description && typeof hit.description === "string" && hit.description.trim()) {
          rec.description = hit.description.trim().slice(0, 3500);
        }
        if (rec.industry === "Unknown" && typeof hit.industry === "string" && hit.industry.trim()) {
          rec.industry = normalizeUnknownText(hit.industry);
        }
        const meta = (rec.source_metadata as Record<string, unknown>) || {};
        meta.llm_enrichment_provider = llmRes.providerUsed;
        rec.source_metadata = meta;
      }
    }
  }

  return {
    records,
    errors: [],
    hasMore,
    sourceOutcomes: [
      {
        category: "startups",
        source: "yc_oss_directory",
        url,
        status: records.length > 0 ? "ok" : "empty",
        discoveredCount: records.length,
        retried: res.attempts > 1,
        attempts: res.attempts,
        httpStatus: res.status || null,
        error: null,
      },
    ],
  };
}

async function collectProducts(
  config: AtlasConfig,
  http: PoliteHttpClient,
  verifier: LiveSourceVerifier,
  limit: number,
  page: number
): Promise<CollectionBatchResult> {
  const safePage = Math.max(1, page);
  const errors: CollectorError[] = [];
  const sourceOutcomes: SourceOutcomeRecord[] = [];
  const hfRecords: RawRecord[] = [];
  const ghRecords: RawRecord[] = [];
  const hnRecords: RawRecord[] = [];
  const nowIso = new Date().toISOString();

  const ghTarget = config.githubToken ? Math.round(limit * 0.4) : Math.min(250, Math.round(limit * 0.3));
  const hnTarget = Math.min(500, Math.round(limit * 0.3));
  const hfTarget = Math.max(limit - ghTarget - hnTarget, Math.round(limit * 0.45));

  // Track per-source attempts/httpStatus cleanly
  const srcTelemetry = new Map<string, { attempts: number; httpStatus: number | null }>([
    ["huggingface_spaces", { attempts: 0, httpStatus: null }],
    ["github_repositories", { attempts: 0, httpStatus: null }],
    ["show_hn", { attempts: 0, httpStatus: null }],
  ]);

  // Source A: Hugging Face Spaces (cursor paginated, fast, no auth needed)
  const fetchHfSpaces = async () => {
    let nextUrl: string | null = `https://huggingface.co/api/spaces?sort=likes&direction=-1&limit=100`;
    let pageIdx = 1;
    // Skip cursor pages if page > 1
    const maxPagesToWalk = safePage + Math.ceil((hfTarget + 200) / 100) + 2;
    const seenHf = new Set<string>();
    const tel = srcTelemetry.get("huggingface_spaces")!;

    while (nextUrl && pageIdx <= maxPagesToWalk && hfRecords.length < limit) {
      const curUrl = nextUrl;
      const res = await http.fetch(curUrl, { timeoutMs: config.requestTimeoutMs, checkRobots: false });
      tel.attempts = Math.max(tel.attempts, res.attempts);
      tel.httpStatus = res.status || tel.httpStatus;
      if (!res.ok) {
        errors.push({ source: "huggingface_spaces", url: curUrl, error: res.error || "fetch_failed" });
        break;
      }
      verifier.seedSnapshot(curUrl, res.status, res.content, res.contentType);

      try {
        const items = JSON.parse(res.content);
        if (!Array.isArray(items) || items.length === 0) break;
        if (pageIdx >= safePage) {
          for (const sp of items as Array<Record<string, unknown>>) {
            const spId = String(sp.id ?? "").trim();
            if (!spId || seenHf.has(spId)) continue;
            seenHf.add(spId);
            const parts = spId.split("/");
            const owner = parts.length > 1 ? parts[0] : "HuggingFace";
            const name = parts.length > 1 ? parts.slice(1).join("/") : spId;
            const spaceUrl = normalizeUrl(`https://huggingface.co/spaces/${spId}`);
            const sdk = normalizeUnknownText(sp.sdk || "AI Space");
            const likes = typeof sp.likes === "number" ? sp.likes : null;
            const runtimeStage = (sp.runtime as Record<string, unknown> | undefined)?.stage ?? null;
            hfRecords.push({
              name: name.slice(0, 200),
              description: `Hugging Face Space (${sdk})${likes !== null ? ` with ${likes} likes` : ""} by ${owner}.`,
              website: spaceUrl,
              official_website: spaceUrl,
              category: sdk === "Unknown" ? "AI Space" : sdk,
              company_name: normalizeUnknownText(owner),
              source_name: "huggingface_spaces",
              source_url: spaceUrl,
              collected_at: nowIso,
              source_metadata: {
                api_url: curUrl,
                space_id: spId,
                likes,
                sdk: sp.sdk ?? null,
                runtime_stage: runtimeStage,
                created_at: sp.createdAt ?? null,
              },
            });
          }
        }
      } catch (err) {
        errors.push({ source: "huggingface_spaces", url: curUrl, error: `invalid_json: ${String(err)}` });
        break;
      }
      nextUrl = parseLinkNextUrl(res.headers.link);
      pageIdx++;
    }
  };

  // Source B: GitHub Repositories Search (respects 403/429 gracefully)
  const fetchGithubProducts = async () => {
    const ghHeaders: Record<string, string> = { Accept: "application/vnd.github+json" };
    if (config.githubToken) ghHeaders.Authorization = `Bearer ${config.githubToken}`;
    const seenUrls = new Set<string>();
    const queries = [
      "topic:ai stars:>100",
      "topic:llm stars:>50",
      "topic:developer-tools stars:>200",
      "topic:machine-learning stars:>200",
    ];
    let hitRateLimit = false;
    const tel = srcTelemetry.get("github_repositories")!;
    for (const query of queries) {
      if (hitRateLimit || ghRecords.length >= Math.max(ghTarget, limit * 0.45)) break;
      let curPage = safePage;
      while (ghRecords.length < Math.max(ghTarget, limit * 0.45) && curPage < safePage + 4) {
        const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=100&page=${curPage}`;
        const res = await http.fetch(url, {
          headers: ghHeaders,
          timeoutMs: config.requestTimeoutMs,
          maxAttempts: 2,
          checkRobots: false,
        });
        tel.attempts = Math.max(tel.attempts, res.attempts);
        tel.httpStatus = res.status || tel.httpStatus;
        if (!res.ok) {
          errors.push({ source: "github_search", url, error: res.error || "fetch_failed" });
          if (res.status === 403 || res.status === 429) hitRateLimit = true;
          break;
        }
        verifier.seedSnapshot(url, res.status, res.content, res.contentType);
        try {
          const payload = JSON.parse(res.content) as Record<string, unknown>;
          const items = Array.isArray(payload.items) ? (payload.items as Array<Record<string, unknown>>) : [];
          if (items.length === 0) break;
          for (const repo of items) {
            const name = String(repo.name ?? "").trim();
            const htmlUrl = String(repo.html_url ?? "").trim();
            if (!name || !htmlUrl || seenUrls.has(htmlUrl)) continue;
            seenUrls.add(htmlUrl);
            const homepage = validateOptionalUrl(repo.homepage);
            const topics = Array.isArray(repo.topics) ? repo.topics : [];
            const category = normalizeUnknownText(topics[0] ?? repo.language);
            const owner = normalizeUnknownText((repo.owner as Record<string, unknown> | undefined)?.login);
            ghRecords.push({
              name,
              description: String(repo.description ?? "").trim() || null,
              website: homepage || htmlUrl,
              official_website: homepage || htmlUrl,
              category,
              company_name: owner,
              source_name: "github_repositories",
              source_url: normalizeUrl(htmlUrl),
              collected_at: nowIso,
              source_metadata: {
                api_url: url,
                stars: repo.stargazers_count ?? null,
                forks: repo.forks_count ?? null,
                language: repo.language ?? null,
                full_name: repo.full_name ?? null,
              },
            });
          }
          if (items.length < 100) break;
          curPage++;
        } catch (err) {
          errors.push({ source: "github_search", url, error: `invalid_json: ${String(err)}` });
          break;
        }
      }
    }
  };

  // Source C: Show HN Algolia (multi-page)
  const fetchShowHn = async () => {
    const pagesToFetch = Math.min(6, Math.max(1, Math.ceil(hnTarget / 80)));
    const tel = srcTelemetry.get("show_hn")!;
    for (let offset = 0; offset < pagesToFetch && hnRecords.length < limit; offset++) {
      const hnPage = Math.max(0, safePage - 1) + offset;
      const url = `https://hn.algolia.com/api/v1/search_by_date?tags=show_hn&hitsPerPage=100&page=${hnPage}`;
      const res = await http.fetch(url, { timeoutMs: config.requestTimeoutMs, checkRobots: false });
      tel.attempts = Math.max(tel.attempts, res.attempts);
      tel.httpStatus = res.status || tel.httpStatus;
      if (!res.ok) {
        errors.push({ source: "show_hn", url, error: res.error || "fetch_failed" });
        break;
      }
      verifier.seedSnapshot(url, res.status, res.content, res.contentType);
      try {
        const payload = JSON.parse(res.content) as Record<string, unknown>;
        const hits = Array.isArray(payload.hits) ? (payload.hits as Array<Record<string, unknown>>) : [];
        if (hits.length === 0) break;
        for (const hit of hits) {
          const rawTitle = String(hit.title ?? "").trim();
          const productUrl = validateOptionalUrl(hit.url);
          if (!rawTitle || !productUrl) continue;
          const name = rawTitle.replace(/^Show HN:\s*|^Show HN\s*-\s*/i, "").trim() || rawTitle;
          const hnItemUrl = `https://news.ycombinator.com/item?id=${hit.objectID}`;
          hnRecords.push({
            name: name.slice(0, 200),
            description: String(hit.story_text ?? "").trim().slice(0, 2000) || null,
            website: productUrl,
            official_website: productUrl,
            category: "Show HN Launch",
            company_name: normalizeUnknownText(hit.author),
            source_name: "show_hn",
            source_url: normalizeUrl(hnItemUrl),
            collected_at: nowIso,
            source_metadata: {
              api_url: url,
              points: hit.points ?? null,
              created_at: hit.created_at ?? null,
            },
          });
        }
      } catch (err) {
        errors.push({ source: "show_hn", url, error: `invalid_json: ${String(err)}` });
        break;
      }
    }
  };

  await Promise.all([fetchHfSpaces(), fetchGithubProducts(), fetchShowHn()]);

  // Blend cleanly across all sources and backfill up to limit from whichever sources succeeded
  const merged: RawRecord[] = [];
  const seenKey = new Set<string>();
  const pushUnique = (rec: RawRecord) => {
    const key = `${String(rec.name).toLowerCase()}|${String(rec.source_url).toLowerCase()}`;
    if (seenKey.has(key)) return false;
    seenKey.add(key);
    merged.push(rec);
    return true;
  };

  for (const r of ghRecords.slice(0, ghTarget)) pushUnique(r);
  for (const r of hnRecords.slice(0, hnTarget)) pushUnique(r);
  for (const r of hfRecords) {
    if (merged.length >= limit) break;
    pushUnique(r);
  }
  for (const r of [...ghRecords.slice(ghTarget), ...hnRecords.slice(hnTarget)]) {
    if (merged.length >= limit) break;
    pushUnique(r);
  }

  const pushSourceSummary = (source: string, url: string, count: number) => {
    const err = errors.find((e) => e.source === source || (source === "github_repositories" && e.source === "github_search"));
    const tel = srcTelemetry.get(source) ?? { attempts: 1, httpStatus: null };
    if (err && count === 0) {
      sourceOutcomes.push({
        category: "products",
        source,
        url: err.url,
        status: "failed",
        discoveredCount: 0,
        retried: tel.attempts > 1,
        attempts: Math.max(1, tel.attempts),
        httpStatus: tel.httpStatus,
        error: err.error,
      });
    } else {
      sourceOutcomes.push({
        category: "products",
        source,
        url,
        status: count > 0 ? "ok" : "empty",
        discoveredCount: count,
        retried: tel.attempts > 1,
        attempts: Math.max(1, tel.attempts),
        httpStatus: tel.httpStatus,
        error: err ? err.error : null,
      });
    }
  };
  pushSourceSummary("huggingface_spaces", "https://huggingface.co/api/spaces", hfRecords.length);
  pushSourceSummary("github_repositories", "https://api.github.com/search/repositories", ghRecords.length);
  pushSourceSummary("show_hn", "https://hn.algolia.com/api/v1/search_by_date?tags=show_hn", hnRecords.length);

  const finalRecords = merged.slice(0, limit);
  return { records: finalRecords, errors, hasMore: finalRecords.length >= limit, sourceOutcomes };
}

function reconstructOpenAlexAbstract(inv: unknown): string | null {
  if (!inv || typeof inv !== "object" || Array.isArray(inv)) return null;
  const positions: Array<[number, string]> = [];
  for (const [word, idxs] of Object.entries(inv as Record<string, unknown>)) {
    if (!Array.isArray(idxs)) continue;
    for (const idx of idxs) {
      if (typeof idx === "number") positions.push([idx, word]);
    }
  }
  if (positions.length === 0) return null;
  positions.sort((a, b) => a[0] - b[0]);
  return positions.map((p) => p[1]).join(" ").trim() || null;
}

async function collectResearchPapers(
  config: AtlasConfig,
  http: PoliteHttpClient,
  verifier: LiveSourceVerifier,
  limit: number,
  page: number
): Promise<CollectionBatchResult> {
  const safePage = Math.max(1, page);
  const errors: CollectorError[] = [];
  const sourceOutcomes: SourceOutcomeRecord[] = [];
  const hfPapers: RawRecord[] = [];
  const arxivPapers: RawRecord[] = [];
  const oaPapers: RawRecord[] = [];
  const crPapers: RawRecord[] = [];
  const nowIso = new Date().toISOString();

  const refNow = new Date();
  const maxReasonableYear = refNow.getUTCFullYear() + 1;
  const countFresh = (recs: RawRecord[]) =>
    recs.filter((r) =>
      isWithinFreshnessWindow(parseUtcDatetime(r.published_at ?? r.publication_date, refNow), refNow, config.freshnessWindowHours).ok
    ).length;

  // 1. Hugging Face Daily Papers (includes direct githubRepo + githubStars + exact UTC publishedAt!)
  const fetchHfPapers = async () => {
    const url = "https://huggingface.co/api/daily_papers?limit=100";
    const res = await http.fetch(url, { timeoutMs: config.requestTimeoutMs, maxAttempts: 2, checkRobots: false });
    if (!res.ok) {
      const errText = res.error || "fetch_failed";
      errors.push({ source: "huggingface_daily_papers", url, error: errText });
      sourceOutcomes.push({
        category: "research_papers",
        source: "huggingface_daily_papers",
        url,
        status: "failed",
        discoveredCount: 0,
        freshCount: 0,
        retried: res.attempts > 1,
        attempts: res.attempts,
        httpStatus: res.status || null,
        error: errText,
      });
      return;
    }
    verifier.seedSnapshot(url, res.status, res.content, res.contentType);
    try {
      const arr = JSON.parse(res.content);
      if (!Array.isArray(arr)) {
        sourceOutcomes.push({
          category: "research_papers",
          source: "huggingface_daily_papers",
          url,
          status: "empty",
          discoveredCount: 0,
          freshCount: 0,
          retried: res.attempts > 1,
          attempts: res.attempts,
          httpStatus: res.status || null,
          error: null,
        });
        return;
      }
      for (const item of arr as Array<Record<string, unknown>>) {
        const paper = (item.paper as Record<string, unknown> | undefined) ?? item;
        const paperIdRaw = String(paper.id ?? "").trim();
        const title = String(paper.title ?? item.title ?? "").replace(/\s+/g, " ").trim();
        if (!title || !paperIdRaw) continue;
        const isArxivId = /^\d{4}\.\d{4,5}/.test(paperIdRaw);
        const sourceUrl = isArxivId
          ? `https://arxiv.org/abs/${paperIdRaw}`
          : `https://huggingface.co/papers/${paperIdRaw}`;
        const authorsRaw = Array.isArray(paper.authors) ? (paper.authors as Array<Record<string, unknown>>) : [];
        const authors = authorsRaw
          .map((a) => String(a.name ?? (a.user as Record<string, unknown> | undefined)?.fullname ?? "").trim())
          .filter(Boolean);
        const abstract = String(paper.summary ?? item.summary ?? "").replace(/\s+/g, " ").trim() || null;
        const pubMeta = parseUtcDatetimeWithMeta(paper.publishedAt ?? item.publishedAt);
        const pubDt = pubMeta.date && pubMeta.date.getUTCFullYear() <= maxReasonableYear ? pubMeta.date : null;
        const pubAtIso = pubDt ? pubDt.toISOString() : null;
        const pubDate = pubDt ? pubDt.toISOString().slice(0, 10) : null;
        const ghRepo = validateOptionalUrl(paper.githubRepo) || findFirstGithubRepo(abstract);
        const ghStars = typeof paper.githubStars === "number" && paper.githubStars >= 0 ? paper.githubStars : null;
        hfPapers.push({
          title,
          abstract,
          authors,
          publication_date: pubDate,
          published_at: pubAtIso,
          doi: null,
          arxiv_id: isArxivId ? paperIdRaw : null,
          github_repository: ghRepo ? findFirstGithubRepo(ghRepo) || ghRepo : null,
          github_stars: ghStars,
          official_website: `https://huggingface.co/papers/${paperIdRaw}`,
          source_name: "huggingface_daily_papers",
          source_url: normalizeUrl(sourceUrl),
          collected_at: nowIso,
          source_metadata: {
            api_url: url,
            published_at_utc: pubAtIso,
            timestamp_precision: pubDt ? pubMeta.precision : "unverified",
            upvotes: paper.upvotes ?? null,
            ai_keywords: Array.isArray(paper.ai_keywords) ? paper.ai_keywords : [],
            github_metrics: ghRepo
              ? { stars: ghStars, source: "huggingface_daily_papers", metrics_updated_at: nowIso }
              : null,
          },
        });
      }
      sourceOutcomes.push({
        category: "research_papers",
        source: "huggingface_daily_papers",
        url,
        status: hfPapers.length > 0 ? "ok" : "empty",
        discoveredCount: hfPapers.length,
        freshCount: countFresh(hfPapers),
        retried: res.attempts > 1,
        attempts: res.attempts,
        httpStatus: res.status || null,
        error: null,
      });
    } catch (err) {
      const errText = `invalid_json: ${String(err)}`;
      errors.push({ source: "huggingface_daily_papers", url, error: errText });
      sourceOutcomes.push({
        category: "research_papers",
        source: "huggingface_daily_papers",
        url,
        status: "failed",
        discoveredCount: 0,
        freshCount: 0,
        retried: res.attempts > 1,
        attempts: res.attempts,
        httpStatus: res.status || null,
        error: errText,
      });
    }
  };

  // 2. arXiv Atom API (100/page, exact UTC submitted timestamp)
  const fetchArxiv = async () => {
    const pagesNeeded = Math.min(6, Math.max(1, Math.ceil((limit * 0.4) / 100)));
    let arxivErr: string | null = null;
    let lastStatus: number | null = null;
    let totalAttempts = 0;
    const baseUrl = "https://export.arxiv.org/api/query";
    for (let offset = 0; offset < pagesNeeded && arxivPapers.length < limit; offset++) {
      const pIdx = safePage - 1 + offset;
      const start = pIdx * 100;
      const maxRes = Math.min(100, Math.max(10, limit));
      const arxivUrl = `${baseUrl}?search_query=${encodeURIComponent("cat:cs.AI OR cat:cs.LG OR cat:cs.CL")}&start=${start}&max_results=${maxRes}&sortBy=submittedDate&sortOrder=descending`;
      const res = await http.fetch(arxivUrl, {
        timeoutMs: Math.max(config.requestTimeoutMs, 25000),
        maxAttempts: 2,
        checkRobots: false,
      });
      totalAttempts = Math.max(totalAttempts, res.attempts);
      lastStatus = res.status || lastStatus;
      if (!res.ok) {
        arxivErr = res.error || "fetch_failed";
        errors.push({ source: "arxiv", url: arxivUrl, error: arxivErr });
        break;
      }
      verifier.seedSnapshot(arxivUrl, res.status, res.content, res.contentType);
      const entries = extractXmlTags(res.content, "entry");
      if (entries.length === 0) break;
      for (const entry of entries) {
        const title = (extractXmlTag(entry, "title") ?? "").replace(/\s+/g, " ").trim();
        let idUrl = (extractXmlTag(entry, "id") ?? "").trim();
        if (!title || !idUrl) continue;
        if (idUrl.startsWith("http://arxiv.org/")) idUrl = `https://${idUrl.slice("http://".length)}`;
        const arxivId = idUrl.replace(/\/+$/, "").split("/").pop() ?? null;
        const summary = extractXmlTag(entry, "summary")?.replace(/\s+/g, " ").trim() || null;
        const published = extractXmlTag(entry, "published");
        const pubMeta = parseUtcDatetimeWithMeta(published);
        const pubDt = pubMeta.date && pubMeta.date.getUTCFullYear() <= maxReasonableYear ? pubMeta.date : null;
        const pubAtIso = pubDt ? pubDt.toISOString() : null;
        const pubDate = pubDt ? pubDt.toISOString().slice(0, 10) : null;
        const comment = extractXmlTag(entry, "arxiv:comment");
        const doi = extractXmlTag(entry, "arxiv:doi");
        const authors = extractXmlTags(entry, "author")
          .map((a) => extractXmlTag(a, "name")?.trim() || "")
          .filter(Boolean);
        const githubRepo = findFirstGithubRepo(summary, comment);
        arxivPapers.push({
          title,
          abstract: summary,
          authors,
          publication_date: pubDate,
          published_at: pubAtIso,
          doi: doi || null,
          arxiv_id: arxivId,
          github_repository: githubRepo,
          github_stars: null,
          official_website: null,
          source_name: "arxiv",
          source_url: normalizeUrl(idUrl),
          collected_at: nowIso,
          source_metadata: {
            api_url: arxivUrl,
            published_at_utc: pubAtIso,
            timestamp_precision: pubDt ? pubMeta.precision : "unverified",
            comment,
          },
        });
      }
    }
    sourceOutcomes.push({
      category: "research_papers",
      source: "arxiv",
      url: baseUrl,
      status: arxivPapers.length > 0 ? "ok" : arxivErr ? "failed" : "empty",
      discoveredCount: arxivPapers.length,
      freshCount: countFresh(arxivPapers),
      retried: totalAttempts > 1,
      attempts: Math.max(1, totalAttempts),
      httpStatus: lastStatus,
      error: arxivErr,
    });
  };

  // 3. OpenAlex API (100/page, date-only metadata — never fabricate timestamps)
  const fetchOpenAlex = async () => {
    const pagesNeeded = Math.min(10, Math.max(1, Math.ceil((limit * 0.7) / 100)));
    let oaErr: string | null = null;
    let lastStatus: number | null = null;
    let totalAttempts = 0;
    const baseUrl = "https://api.openalex.org/works";
    for (let offset = 0; offset < pagesNeeded && oaPapers.length < limit; offset++) {
      const curPage = safePage + offset;
      const perPage = Math.min(100, Math.max(15, limit));
      const oaUrl = `${baseUrl}?search=${encodeURIComponent("artificial intelligence")}&per-page=${perPage}&page=${curPage}&sort=publication_date:desc&mailto=frontier-atlas@users.noreply.github.com`;
      const res = await http.fetch(oaUrl, {
        timeoutMs: Math.max(config.requestTimeoutMs, 25000),
        maxAttempts: 2,
        checkRobots: false,
      });
      totalAttempts = Math.max(totalAttempts, res.attempts);
      lastStatus = res.status || lastStatus;
      if (!res.ok) {
        oaErr = res.error || "fetch_failed";
        errors.push({ source: "openalex", url: oaUrl, error: oaErr });
        break;
      }
      verifier.seedSnapshot(oaUrl, res.status, res.content, res.contentType);
      try {
        const payload = JSON.parse(res.content) as Record<string, unknown>;
        const works = Array.isArray(payload.results) ? (payload.results as Array<Record<string, unknown>>) : [];
        if (works.length === 0) break;
        for (const work of works) {
          const title = String(work.title ?? "").trim();
          const primaryLoc = (work.primary_location as Record<string, unknown>) || {};
          const landingUrl = String(primaryLoc.landing_page_url || work.id || "").trim();
          if (!title || !isValidHttpUrl(landingUrl)) continue;
          const abstract = reconstructOpenAlexAbstract(work.abstract_inverted_index);
          const authorships = Array.isArray(work.authorships) ? (work.authorships as Array<Record<string, unknown>>) : [];
          const authors = authorships
            .map((a) => String((a.author as Record<string, unknown> | undefined)?.display_name ?? "").trim())
            .filter(Boolean);
          const oaId = String(work.id ?? "").trim() || null;
          const oaApiUrl =
            oaId && oaId.includes("openalex.org/")
              ? `https://api.openalex.org/works/${oaId.replace(/\/+$/, "").split("/").pop()}`
              : null;
          let doi = typeof work.doi === "string" ? work.doi.trim() : null;
          if (doi) {
            doi = doi.replace(/^https?:\/\/doi\.org\//i, "").replace(/^doi:/i, "").trim() || null;
          }
          const arxivId = landingUrl.toLowerCase().includes("arxiv")
            ? landingUrl.replace(/\/+$/, "").split("/").pop() ?? null
            : null;
          const createdDt = parseUtcDatetimeWithMeta(work.created_date);
          const rawPubYear = typeof work.publication_date === "string" ? Number(work.publication_date.slice(0, 4)) : NaN;
          const pubDate =
            typeof work.publication_date === "string" &&
            Number.isFinite(rawPubYear) &&
            rawPubYear >= 1950 &&
            rawPubYear <= maxReasonableYear
              ? work.publication_date
              : null;
          const exactPubAt =
            createdDt.date &&
            createdDt.date.getUTCFullYear() <= maxReasonableYear &&
            typeof work.created_date === "string" &&
            work.created_date.includes("T")
              ? createdDt.date.toISOString()
              : null;
          oaPapers.push({
            title,
            abstract,
            authors,
            publication_date: pubDate,
            published_at: exactPubAt,
            doi,
            arxiv_id: arxivId,
            github_repository: findFirstGithubRepo(abstract, title, landingUrl),
            github_stars: null,
            official_website: oaId,
            source_name: "openalex",
            source_url: normalizeUrl(landingUrl),
            collected_at: nowIso,
            source_metadata: {
              api_url: oaUrl,
              published_at_utc: exactPubAt,
              timestamp_precision: exactPubAt ? "verified_exact" : pubDate ? "date_only" : "unverified",
              openalex_id: oaId,
              openalex_api_url: oaApiUrl,
              cited_by_count: work.cited_by_count ?? null,
              type: work.type ?? null,
            },
          });
        }
      } catch (err) {
        oaErr = `invalid_json: ${String(err)}`;
        errors.push({ source: "openalex", url: oaUrl, error: oaErr });
        break;
      }
    }
    sourceOutcomes.push({
      category: "research_papers",
      source: "openalex",
      url: baseUrl,
      status: oaPapers.length > 0 ? "ok" : oaErr ? "failed" : "empty",
      discoveredCount: oaPapers.length,
      freshCount: countFresh(oaPapers),
      retried: totalAttempts > 1,
      attempts: Math.max(1, totalAttempts),
      httpStatus: lastStatus,
      error: oaErr,
    });
  };

  // 4. Crossref API (100/page)
  const fetchCrossref = async () => {
    const pagesNeeded = Math.min(6, Math.max(1, Math.ceil((limit * 0.4) / 100)));
    let crErr: string | null = null;
    let lastStatus: number | null = null;
    let totalAttempts = 0;
    const baseUrl = "https://api.crossref.org/works";
    for (let offsetIdx = 0; offsetIdx < pagesNeeded && crPapers.length < limit; offsetIdx++) {
      const rows = Math.min(100, Math.max(10, limit));
      const offset = (safePage - 1 + offsetIdx) * rows;
      const crUrl = `${baseUrl}?query=${encodeURIComponent("large language model")}&rows=${rows}&offset=${offset}&sort=published&order=desc`;
      const res = await http.fetch(crUrl, { timeoutMs: config.requestTimeoutMs, maxAttempts: 2, checkRobots: false });
      totalAttempts = Math.max(totalAttempts, res.attempts);
      lastStatus = res.status || lastStatus;
      if (!res.ok) {
        crErr = res.error || "fetch_failed";
        errors.push({ source: "crossref", url: crUrl, error: crErr });
        break;
      }
      verifier.seedSnapshot(crUrl, res.status, res.content, res.contentType);
      try {
        const payload = JSON.parse(res.content) as Record<string, unknown>;
        const items =
          ((payload.message as Record<string, unknown> | undefined)?.items as Array<Record<string, unknown>>) || [];
        if (items.length === 0) break;
        for (const item of items) {
          const titles = Array.isArray(item.title) ? item.title : [];
          const title = titles[0] ? String(titles[0]).trim() : "";
          const itemUrl = String(item.URL ?? "").trim();
          if (!title || !isValidHttpUrl(itemUrl)) continue;
          const rawAbs = typeof item.abstract === "string" ? item.abstract : null;
          const abstract = rawAbs ? stripHtmlToText(rawAbs) : null;
          const authorsRaw = Array.isArray(item.author) ? (item.author as Array<Record<string, unknown>>) : [];
          const authors = authorsRaw
            .map((a) => `${String(a.given ?? "")} ${String(a.family ?? "")}`.trim())
            .filter(Boolean);
          const dateParts = (
            ((item.published as Record<string, unknown> | undefined)?.["date-parts"] as unknown[][]) || [[]]
          )[0];
          const rawYear = Array.isArray(dateParts) && dateParts.length > 0 ? Number(dateParts[0]) : NaN;
          const pubDate =
            Array.isArray(dateParts) &&
            dateParts.length > 0 &&
            Number.isFinite(rawYear) &&
            rawYear >= 1950 &&
            rawYear <= maxReasonableYear
              ? dateParts.map((p, idx) => (idx > 0 ? String(p).padStart(2, "0") : String(p))).join("-")
              : null;
          const createdDtRaw = (item.created as Record<string, unknown> | undefined)?.["date-time"];
          const parsedCreatedDt = parseUtcDatetime(createdDtRaw);
          const createdDt =
            parsedCreatedDt && parsedCreatedDt.getUTCFullYear() <= maxReasonableYear ? parsedCreatedDt : null;
          crPapers.push({
            title,
            abstract,
            authors,
            publication_date: pubDate,
            published_at: createdDt ? createdDt.toISOString() : null,
            doi: typeof item.DOI === "string" ? item.DOI : null,
            arxiv_id: null,
            github_repository: findFirstGithubRepo(abstract),
            github_stars: null,
            official_website: null,
            source_name: "crossref",
            source_url: normalizeUrl(itemUrl),
            collected_at: nowIso,
            source_metadata: {
              api_url: crUrl,
              published_at_utc: createdDt ? createdDt.toISOString() : null,
              timestamp_precision: createdDt ? "verified_exact" : pubDate ? "date_only" : "unverified",
              publisher: item.publisher ?? null,
              type: item.type ?? null,
            },
          });
        }
      } catch (err) {
        crErr = `invalid_json: ${String(err)}`;
        errors.push({ source: "crossref", url: crUrl, error: crErr });
        break;
      }
    }
    sourceOutcomes.push({
      category: "research_papers",
      source: "crossref",
      url: baseUrl,
      status: crPapers.length > 0 ? "ok" : crErr ? "failed" : "empty",
      discoveredCount: crPapers.length,
      freshCount: countFresh(crPapers),
      retried: totalAttempts > 1,
      attempts: Math.max(1, totalAttempts),
      httpStatus: lastStatus,
      error: crErr,
    });
  };

  await Promise.all([fetchHfPapers(), fetchArxiv(), fetchOpenAlex(), fetchCrossref()]);

  // Interleave & deduplicate by normalized source_url / arxiv_id / doi / normalized title
  const all: RawRecord[] = [];
  const seenKeys = new Set<string>();
  const addPaper = (rec: RawRecord) => {
    const key = String(rec.source_url).toLowerCase();
    const arxivKey = rec.arxiv_id ? `ax:${String(rec.arxiv_id).toLowerCase().replace(/v\d+$/, "")}` : null;
    const doiKey = rec.doi ? `doi:${String(rec.doi).toLowerCase()}` : null;
    const titleKey = normText(String(rec.title ?? ""));
    if (
      seenKeys.has(key) ||
      (arxivKey && seenKeys.has(arxivKey)) ||
      (doiKey && seenKeys.has(doiKey)) ||
      (titleKey && seenKeys.has(`t:${titleKey}`))
    ) {
      return;
    }
    seenKeys.add(key);
    if (arxivKey) seenKeys.add(arxivKey);
    if (doiKey) seenKeys.add(doiKey);
    if (titleKey) seenKeys.add(`t:${titleKey}`);
    all.push(rec);
  };

  // Prioritize HF daily papers (which contain GitHub stars), then round-robin across arXiv, OpenAlex, Crossref
  for (const r of hfPapers) addPaper(r);
  const maxLen = Math.max(arxivPapers.length, oaPapers.length, crPapers.length);
  for (let i = 0; i < maxLen && all.length < limit; i++) {
    if (arxivPapers[i]) addPaper(arxivPapers[i]);
    if (all.length >= limit) break;
    if (oaPapers[i]) addPaper(oaPapers[i]);
    if (all.length >= limit) break;
    if (crPapers[i]) addPaper(crPapers[i]);
  }

  const limited = all.slice(0, limit);

  // Enrich associated GitHub repository metrics & stars concurrently (respects rate limits cleanly)
  const slugToRecords = new Map<string, RawRecord[]>();
  for (const rec of limited) {
    if (!rec.github_repository) continue;
    const slug = extractGithubRepoSlug(String(rec.github_repository));
    if (!slug) continue;
    // Skip re-querying GitHub API if Hugging Face already supplied stars unless GITHUB_TOKEN is configured
    if (!config.githubToken && typeof rec.github_stars === "number") continue;
    const arr = slugToRecords.get(slug) ?? [];
    arr.push(rec);
    slugToRecords.set(slug, arr);
  }

  const maxSlugsToEnrich = config.githubToken ? 200 : 40;
  const slugsToEnrich = Array.from(slugToRecords.keys()).slice(0, maxSlugsToEnrich);
  let ghRateLimited = false;
  await mapConcurrent(slugsToEnrich, 4, async (slug) => {
    const metricsCheckedAt = new Date().toISOString();
    if (ghRateLimited) {
      for (const rec of slugToRecords.get(slug) ?? []) {
        const meta = (rec.source_metadata as Record<string, unknown>) || {};
        if (!meta.github_metrics) {
          meta.github_metrics = {
            stars: rec.github_stars ?? null,
            metrics_status: "rate_limited",
            metrics_updated_at: metricsCheckedAt,
          };
          rec.source_metadata = meta;
        }
      }
      return;
    }
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (config.githubToken) headers.Authorization = `Bearer ${config.githubToken}`;
    const ghRes = await http.fetch(`https://api.github.com/repos/${slug}`, {
      headers,
      timeoutMs: 8000,
      maxAttempts: 1,
      checkRobots: false,
    });
    const rlRemaining = ghRes.headers["x-ratelimit-remaining"] ?? null;
    const rlLimit = ghRes.headers["x-ratelimit-limit"] ?? null;
    const rlResetRaw = ghRes.headers["x-ratelimit-reset"];
    const rlResetIso =
      rlResetRaw && /^\d+$/.test(rlResetRaw.trim()) ? new Date(Number(rlResetRaw) * 1000).toISOString() : null;

    if (ghRes.status === 403 || ghRes.status === 429) {
      ghRateLimited = true;
      for (const rec of slugToRecords.get(slug) ?? []) {
        const meta = (rec.source_metadata as Record<string, unknown>) || {};
        meta.github_metrics = {
          ...(typeof meta.github_metrics === "object" && meta.github_metrics ? meta.github_metrics : {}),
          stars: rec.github_stars ?? null,
          metrics_status: `rate_limited_http_${ghRes.status}`,
          rate_limit_remaining: rlRemaining !== null ? Number(rlRemaining) : 0,
          rate_limit_limit: rlLimit !== null ? Number(rlLimit) : null,
          rate_limit_reset_at: rlResetIso,
          authenticated: Boolean(config.githubToken),
          metrics_updated_at: metricsCheckedAt,
        };
        rec.source_metadata = meta;
      }
      return;
    }
    if (!ghRes.ok) {
      for (const rec of slugToRecords.get(slug) ?? []) {
        const meta = (rec.source_metadata as Record<string, unknown>) || {};
        meta.github_metrics = {
          ...(typeof meta.github_metrics === "object" && meta.github_metrics ? meta.github_metrics : {}),
          stars: rec.github_stars ?? null,
          metrics_status: redactSecrets(ghRes.error || `http_${ghRes.status || 0}`),
          rate_limit_remaining: rlRemaining !== null ? Number(rlRemaining) : null,
          rate_limit_reset_at: rlResetIso,
          authenticated: Boolean(config.githubToken),
          metrics_updated_at: metricsCheckedAt,
        };
        rec.source_metadata = meta;
      }
      return;
    }
    try {
      const ghJson = JSON.parse(ghRes.content) as Record<string, unknown>;
      const stars = typeof ghJson.stargazers_count === "number" ? ghJson.stargazers_count : null;
      const metrics = {
        stars,
        forks: typeof ghJson.forks_count === "number" ? ghJson.forks_count : null,
        open_issues: typeof ghJson.open_issues_count === "number" ? ghJson.open_issues_count : null,
        watchers: typeof ghJson.subscribers_count === "number" ? ghJson.subscribers_count : null,
        language: ghJson.language ?? null,
        updated_at: ghJson.updated_at ?? null,
        metrics_updated_at: metricsCheckedAt,
        rate_limit_remaining: rlRemaining !== null ? Number(rlRemaining) : null,
        rate_limit_limit: rlLimit !== null ? Number(rlLimit) : null,
        rate_limit_reset_at: rlResetIso,
        authenticated: Boolean(config.githubToken),
        metrics_status: "verified_github_api",
      };
      for (const rec of slugToRecords.get(slug) ?? []) {
        if (stars !== null && stars >= 0) rec.github_stars = stars;
        const meta = (rec.source_metadata as Record<string, unknown>) || {};
        meta.github_metrics = metrics;
        rec.source_metadata = meta;
      }
    } catch {
      // Ignore parse error
    }
  });

  // Track metrics_updated_at even for repositories beyond the per-run GitHub enrichment cap
  const enrichedSlugsSet = new Set(slugsToEnrich);
  for (const [slug, recs] of slugToRecords.entries()) {
    if (enrichedSlugsSet.has(slug)) continue;
    for (const rec of recs) {
      const meta = (rec.source_metadata as Record<string, unknown>) || {};
      if (!meta.github_metrics) {
        meta.github_metrics = {
          stars: rec.github_stars ?? null,
          metrics_status: "deferred_rate_budget",
          metrics_updated_at: nowIso,
        };
        rec.source_metadata = meta;
      }
    }
  }

  return { records: limited, errors, hasMore: limited.length >= limit, sourceOutcomes };
}

async function collectJobs(
  config: AtlasConfig,
  http: PoliteHttpClient,
  verifier: LiveSourceVerifier,
  limit: number,
  page: number
): Promise<CollectionBatchResult> {
  const safePage = Math.max(1, page);
  const errors: CollectorError[] = [];
  const sourceOutcomes: SourceOutcomeRecord[] = [];
  const combined: RawRecord[] = [];
  const now = new Date();
  const nowIso = now.toISOString();
  const srcTelemetry = new Map<string, { attempts: number; httpStatus: number | null }>();
  const trackTel = (source: string, attempts: number, httpStatus: number) => {
    const prev = srcTelemetry.get(source) ?? { attempts: 0, httpStatus: null };
    srcTelemetry.set(source, {
      attempts: Math.max(prev.attempts, attempts),
      httpStatus: httpStatus || prev.httpStatus,
    });
  };

  const recordOutcome = (outcome: SourceOutcomeRecord) => {
    sourceOutcomes.push(outcome);
  };

  const tasks: Array<Promise<void>> = [];

  // 1. Remotive
  tasks.push(
    (async () => {
      const remUrl = `https://remotive.com/api/remote-jobs?limit=${Math.min(200, Math.max(100, limit))}`;
      const res = await http.fetch(remUrl, { timeoutMs: config.requestTimeoutMs, maxAttempts: 2, checkRobots: false });
      trackTel("remotive", res.attempts, res.status);
      if (!res.ok) {
        const err = res.error || "fetch_failed";
        errors.push({ source: "remotive", url: remUrl, error: err });
        recordOutcome({ category: "jobs", source: "remotive", url: remUrl, status: "failed", discoveredCount: 0, freshCount: 0, retried: res.attempts > 1, attempts: res.attempts, httpStatus: res.status || null, error: err });
        return;
      }
      verifier.seedSnapshot(remUrl, res.status, res.content, res.contentType);
      try {
        const payload = JSON.parse(res.content) as Record<string, unknown>;
        const jobs = Array.isArray(payload.jobs) ? (payload.jobs as Array<Record<string, unknown>>) : [];
        let added = 0;
        let freshAdded = 0;
        for (const job of jobs) {
          const title = String(job.title ?? "").trim();
          const company = String(job.company_name ?? "").trim();
          const appUrl = validateOptionalUrl(job.url);
          const postedAt = parseUtcDatetime(job.publication_date);
          if (!title || !company || !appUrl || !postedAt) continue;
          const desc = job.description ? stripHtmlToText(String(job.description)).slice(0, 4000) : null;
          const cat = normalizeUnknownText(job.category);
          const tags = Array.isArray(job.tags) ? job.tags.map(String) : [];
          if (!isQualifyingAiJob("remotive", title, tags, cat, desc)) continue;
          const locText = normalizeUnknownText(job.candidate_required_location || "Remote");
          const empType = normalizeUnknownText(job.job_type);
          const roleFamily = classifyJobRoleFamily(title, `${cat} ${tags.join(" ")}`, desc);
          const remoteInfo = detectJobRemoteEligibility(locText, empType, desc, { remote: true });
          combined.push({
            title,
            company,
            location: locText,
            employment_type: empType,
            description: desc,
            posted_at: postedAt.toISOString(),
            application_url: appUrl,
            source_name: "remotive",
            source_url: appUrl,
            collected_at: nowIso,
            source_metadata: {
              board: "remotive",
              category: job.category ?? null,
              remotive_id: job.id ?? null,
              api_url: remUrl,
              role_family: roleFamily,
              remote_eligible: remoteInfo.remote_eligible,
              remote_evidence: remoteInfo.evidence,
            },
          });
          added++;
          if (isWithinFreshnessWindow(postedAt, now, config.freshnessWindowHours).ok) freshAdded++;
        }
        recordOutcome({ category: "jobs", source: "remotive", url: remUrl, status: added > 0 ? "ok" : "empty", discoveredCount: added, freshCount: freshAdded, retried: res.attempts > 1, attempts: res.attempts, httpStatus: res.status || null, error: null });
      } catch (err) {
        const errText = `invalid_json: ${String(err)}`;
        errors.push({ source: "remotive", url: remUrl, error: errText });
        recordOutcome({ category: "jobs", source: "remotive", url: remUrl, status: "failed", discoveredCount: 0, freshCount: 0, retried: res.attempts > 1, attempts: res.attempts, httpStatus: res.status || null, error: errText });
      }
    })()
  );

  // 2. Arbeitnow (multi-page)
  tasks.push(
    (async () => {
      for (let p = safePage; p < safePage + 4; p++) {
        const arbUrl = `https://www.arbeitnow.com/api/job-board-api?page=${p}`;
        const res = await http.fetch(arbUrl, { timeoutMs: config.requestTimeoutMs, checkRobots: false });
        trackTel("arbeitnow", res.attempts, res.status);
        if (!res.ok) {
          errors.push({ source: "arbeitnow", url: arbUrl, error: res.error || "fetch_failed" });
          break;
        }
        verifier.seedSnapshot(arbUrl, res.status, res.content, res.contentType);
        try {
          const payload = JSON.parse(res.content) as Record<string, unknown>;
          const items = Array.isArray(payload.data) ? (payload.data as Array<Record<string, unknown>>) : [];
          if (items.length === 0) break;
          for (const job of items) {
            const title = String(job.title ?? "").trim();
            const company = String(job.company_name ?? "").trim();
            const appUrl = validateOptionalUrl(job.url);
            const postedAt = parseUtcDatetime(job.created_at);
            if (!title || !company || !appUrl || !postedAt) continue;
            const desc = job.description ? stripHtmlToText(String(job.description)).slice(0, 4000) : null;
            const tags = Array.isArray(job.tags) ? job.tags.map(String) : [];
            if (!isQualifyingAiJob("arbeitnow", title, tags, "", desc)) continue;
            const jobTypes = Array.isArray(job.job_types) ? job.job_types : [];
            const empType = normalizeUnknownText(jobTypes[0] ?? (job.remote ? "Remote" : null));
            const locText = normalizeUnknownText(job.location);
            const roleFamily = classifyJobRoleFamily(title, tags.join(" "), desc);
            const remoteInfo = detectJobRemoteEligibility(locText, empType, desc, { remote: job.remote });
            combined.push({
              title,
              company,
              location: locText,
              employment_type: empType,
              description: desc,
              posted_at: postedAt.toISOString(),
              application_url: appUrl,
              source_name: "arbeitnow",
              source_url: appUrl,
              collected_at: nowIso,
              source_metadata: {
                board: "arbeitnow",
                tags: job.tags ?? [],
                remote: job.remote ?? null,
                api_url: arbUrl,
                role_family: roleFamily,
                remote_eligible: remoteInfo.remote_eligible,
                remote_evidence: remoteInfo.evidence,
              },
            });
          }
        } catch (err) {
          errors.push({ source: "arbeitnow", url: arbUrl, error: `invalid_json: ${String(err)}` });
          break;
        }
      }
    })()
  );

  // 3. We Work Remotely RSS
  tasks.push(
    (async () => {
      const wwrUrl = "https://weworkremotely.com/remote-jobs.rss";
      const res = await http.fetch(wwrUrl, { timeoutMs: config.requestTimeoutMs, checkRobots: false });
      trackTel("weworkremotely", res.attempts, res.status);
      if (!res.ok) {
        errors.push({ source: "weworkremotely", url: wwrUrl, error: res.error || "fetch_failed" });
        return;
      }
      verifier.seedSnapshot(wwrUrl, res.status, res.content, res.contentType);
      const items = extractXmlTags(res.content, "item");
      for (const item of items) {
        const rawTitle = (extractXmlTag(item, "title") ?? "").trim();
        const appUrl = validateOptionalUrl(extractXmlTag(item, "link"));
        const postedAt = parseUtcDatetime(extractXmlTag(item, "pubDate"));
        if (!rawTitle || !appUrl || !postedAt) continue;
        const colonIdx = rawTitle.indexOf(": ");
        const company = colonIdx > 0 ? rawTitle.slice(0, colonIdx).trim() : "Unknown";
        const title = colonIdx > 0 ? rawTitle.slice(colonIdx + 2).trim() : rawTitle;
        const cat = normalizeUnknownText(extractXmlTag(item, "category"));
        const skillsRaw = extractXmlTag(item, "skills") ?? "";
        const skills = skillsRaw.split(/[,/]/).map((s) => s.trim()).filter(Boolean);
        const descRaw = extractXmlTag(item, "description");
        const desc = descRaw ? stripHtmlToText(descRaw).slice(0, 4000) : null;
        if (!isQualifyingAiJob("weworkremotely", title, skills, cat, desc)) continue;
        const region = extractXmlTag(item, "region") || extractXmlTag(item, "country") || "Remote";
        combined.push({
          title,
          company: normalizeUnknownText(company),
          location: normalizeUnknownText(region),
          employment_type: normalizeUnknownText(extractXmlTag(item, "type")),
          description: desc,
          posted_at: postedAt.toISOString(),
          application_url: appUrl,
          source_name: "weworkremotely",
          source_url: appUrl,
          collected_at: nowIso,
          source_metadata: { board: "weworkremotely", category: cat, api_url: wwrUrl },
        });
      }
    })()
  );

  // 4. Jobicy API
  tasks.push(
    (async () => {
      for (const jUrl of [
        "https://jobicy.com/api/v2/remote-jobs?count=50&tag=ai",
        "https://jobicy.com/api/v2/remote-jobs?count=50",
      ]) {
        const res = await http.fetch(jUrl, { timeoutMs: config.requestTimeoutMs, checkRobots: false });
        trackTel("jobicy", res.attempts, res.status);
        if (!res.ok) {
          errors.push({ source: "jobicy", url: jUrl, error: res.error || "fetch_failed" });
          continue;
        }
        verifier.seedSnapshot(jUrl, res.status, res.content, res.contentType);
        try {
          const payload = JSON.parse(res.content) as Record<string, unknown>;
          const jobs = Array.isArray(payload.jobs) ? (payload.jobs as Array<Record<string, unknown>>) : [];
          for (const job of jobs) {
            const title = String(job.jobTitle ?? "").trim();
            const company = String(job.companyName ?? "").trim();
            const appUrl = validateOptionalUrl(job.url);
            const postedAt = parseUtcDatetime(job.pubDate);
            if (!title || !company || !appUrl || !postedAt) continue;
            const desc = job.jobDescription ? stripHtmlToText(String(job.jobDescription)).slice(0, 4000) : null;
            const inds = Array.isArray(job.jobIndustry) ? job.jobIndustry.map(String) : [];
            if (!isQualifyingAiJob("jobicy", title, inds, inds[0] ?? "", desc)) continue;
            const jobType = Array.isArray(job.jobType) ? job.jobType[0] : job.jobType;
            combined.push({
              title,
              company,
              location: normalizeUnknownText(job.jobGeo || "Remote"),
              employment_type: normalizeUnknownText(jobType),
              description: desc,
              posted_at: postedAt.toISOString(),
              application_url: appUrl,
              source_name: "jobicy",
              source_url: appUrl,
              collected_at: nowIso,
              source_metadata: { board: "jobicy", job_id: job.id ?? null, api_url: jUrl },
            });
          }
        } catch (err) {
          errors.push({ source: "jobicy", url: jUrl, error: `invalid_json: ${String(err)}` });
        }
      }
    })()
  );

  // 5. Greenhouse AI company boards
  for (const board of ["anthropic", "scaleai", "xai", "togetherai"]) {
    tasks.push(
      (async () => {
        const ghUrl = `https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true`;
        const res = await http.fetch(ghUrl, {
          timeoutMs: Math.max(config.requestTimeoutMs, 25000),
          checkRobots: false,
        });
        trackTel(`greenhouse:${board}`, res.attempts, res.status);
        if (!res.ok) {
          errors.push({ source: `greenhouse:${board}`, url: ghUrl, error: res.error || "fetch_failed" });
          return;
        }
        verifier.seedSnapshot(ghUrl, res.status, res.content, res.contentType);
        try {
          const payload = JSON.parse(res.content) as Record<string, unknown>;
          const jobs = Array.isArray(payload.jobs) ? (payload.jobs as Array<Record<string, unknown>>) : [];
          for (const job of jobs) {
            const title = String(job.title ?? "").trim();
            const appUrl = validateOptionalUrl(job.absolute_url);
            const postedAt = parseUtcDatetime(job.updated_at || job.first_published);
            if (!title || !appUrl || !postedAt) continue;
            const locName = (job.location as Record<string, unknown> | undefined)?.name;
            combined.push({
              title,
              company: board.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
              location: normalizeUnknownText(locName),
              employment_type: "Full-Time",
              description: job.content ? stripHtmlToText(String(job.content)).slice(0, 4000) : null,
              posted_at: postedAt.toISOString(),
              application_url: appUrl,
              source_name: `greenhouse:${board}`,
              source_url: appUrl,
              collected_at: nowIso,
              source_metadata: { board: "greenhouse", greenhouse_id: job.id ?? null, api_url: ghUrl },
            });
          }
        } catch (err) {
          errors.push({ source: `greenhouse:${board}`, url: ghUrl, error: `invalid_json: ${String(err)}` });
        }
      })()
    );
  }

  // 6. Ashby AI company boards
  for (const board of ["openai", "perplexity", "cohere", "cursor", "elevenlabs", "harvey"]) {
    tasks.push(
      (async () => {
        const ashUrl = `https://api.ashbyhq.com/posting-api/job-board/${board}`;
        const res = await http.fetch(ashUrl, {
          timeoutMs: Math.max(config.requestTimeoutMs, 25000),
          checkRobots: false,
        });
        trackTel(`ashby:${board}`, res.attempts, res.status);
        if (!res.ok) {
          errors.push({ source: `ashby:${board}`, url: ashUrl, error: res.error || "fetch_failed" });
          return;
        }
        verifier.seedSnapshot(ashUrl, res.status, res.content, res.contentType);
        try {
          const payload = JSON.parse(res.content) as Record<string, unknown>;
          const jobs = Array.isArray(payload.jobs) ? (payload.jobs as Array<Record<string, unknown>>) : [];
          for (const job of jobs) {
            const title = String(job.title ?? "").trim();
            const appUrl = validateOptionalUrl(job.jobUrl || job.applyUrl);
            const postedAt = parseUtcDatetime(job.publishedAt);
            if (!title || !appUrl || !postedAt) continue;
            const desc =
              typeof job.descriptionPlain === "string"
                ? job.descriptionPlain.slice(0, 4000)
                : typeof job.descriptionHtml === "string"
                ? stripHtmlToText(job.descriptionHtml).slice(0, 4000)
                : null;
            combined.push({
              title,
              company: board.replace(/\b\w/g, (c) => c.toUpperCase()),
              location: normalizeUnknownText(job.location || (job.isRemote ? "Remote" : null)),
              employment_type: normalizeUnknownText(job.employmentType || "Full-Time"),
              description: desc,
              posted_at: postedAt.toISOString(),
              application_url: appUrl,
              source_name: `ashby:${board}`,
              source_url: appUrl,
              collected_at: nowIso,
              source_metadata: { board: "ashby", department: job.department ?? null, api_url: ashUrl },
            });
          }
        } catch (err) {
          errors.push({ source: `ashby:${board}`, url: ashUrl, error: `invalid_json: ${String(err)}` });
        }
      })()
    );
  }

  // 7. Himalayas API
  tasks.push(
    (async () => {
      const himUrl = "https://himalayas.app/jobs/api/search?q=ai";
      const res = await http.fetch(himUrl, { timeoutMs: config.requestTimeoutMs, checkRobots: false });
      trackTel("himalayas", res.attempts, res.status);
      if (!res.ok) {
        errors.push({ source: "himalayas", url: himUrl, error: res.error || "fetch_failed" });
        return;
      }
      verifier.seedSnapshot(himUrl, res.status, res.content, res.contentType);
      try {
        const payload = JSON.parse(res.content) as Record<string, unknown>;
        const jobs = Array.isArray(payload.jobs) ? (payload.jobs as Array<Record<string, unknown>>) : [];
        for (const job of jobs) {
          const title = String(job.title ?? "").trim();
          const company = String(job.companyName ?? "").trim();
          const appUrl = validateOptionalUrl(job.applicationLink || job.guid);
          const postedAt = parseUtcDatetime(job.pubDate);
          if (!title || !company || !appUrl || !postedAt) continue;
          const descRaw = String(job.description ?? job.excerpt ?? "");
          const desc = descRaw ? stripHtmlToText(descRaw).slice(0, 4000) : null;
          const cats = Array.isArray(job.categories) ? job.categories.map(String) : [];
          if (!isQualifyingAiJob("himalayas", title, cats, cats[0] ?? "", desc)) continue;
          const locs = Array.isArray(job.locationRestrictions) && job.locationRestrictions.length > 0
            ? job.locationRestrictions.join(", ")
            : "Remote";
          combined.push({
            title,
            company,
            location: normalizeUnknownText(locs),
            employment_type: normalizeUnknownText(job.employmentType),
            description: desc,
            posted_at: postedAt.toISOString(),
            application_url: appUrl,
            source_name: "himalayas",
            source_url: appUrl,
            collected_at: nowIso,
            source_metadata: { board: "himalayas", api_url: himUrl },
          });
        }
      } catch (err) {
        errors.push({ source: "himalayas", url: himUrl, error: `invalid_json: ${String(err)}` });
      }
    })()
  );

  // 8. RemoteOK API
  tasks.push(
    (async () => {
      const rokUrl = "https://remoteok.com/api";
      const res = await http.fetch(rokUrl, {
        timeoutMs: Math.min(config.requestTimeoutMs, 15000),
        maxAttempts: 2,
        checkRobots: false,
      });
      trackTel("remoteok", res.attempts, res.status);
      if (!res.ok) {
        errors.push({ source: "remoteok", url: rokUrl, error: res.error || "fetch_failed" });
        return;
      }
      verifier.seedSnapshot(rokUrl, res.status, res.content, res.contentType);
      try {
        const arr = JSON.parse(res.content);
        if (!Array.isArray(arr)) return;
        for (const job of arr as Array<Record<string, unknown>>) {
          const title = String(job.position ?? "").trim();
          const company = String(job.company ?? "").trim();
          const appUrl = validateOptionalUrl(job.url || job.apply_url);
          const postedAt = parseUtcDatetime(job.date ?? job.epoch);
          if (!title || !company || !appUrl || !postedAt) continue;
          const desc = job.description ? stripHtmlToText(String(job.description)).slice(0, 4000) : null;
          const tags = Array.isArray(job.tags) ? job.tags.map(String) : [];
          if (!isQualifyingAiJob("remoteok", title, tags, "", desc)) continue;
          combined.push({
            title,
            company,
            location: normalizeUnknownText(job.location || "Remote"),
            employment_type: "Remote",
            description: desc,
            posted_at: postedAt.toISOString(),
            application_url: appUrl,
            source_name: "remoteok",
            source_url: appUrl,
            collected_at: nowIso,
            source_metadata: { board: "remoteok", tags, api_url: rokUrl },
          });
        }
      } catch (err) {
        errors.push({ source: "remoteok", url: rokUrl, error: `invalid_json: ${String(err)}` });
      }
    })()
  );

  // 9. Lever boards
  for (const board of ["palantir", "zoox"]) {
    tasks.push(
      (async () => {
        const levUrl = `https://api.lever.co/v0/postings/${board}?mode=json`;
        const res = await http.fetch(levUrl, {
          timeoutMs: Math.max(config.requestTimeoutMs, 25000),
          checkRobots: false,
        });
        trackTel(`lever:${board}`, res.attempts, res.status);
        if (!res.ok) {
          errors.push({ source: `lever:${board}`, url: levUrl, error: res.error || "fetch_failed" });
          return;
        }
        verifier.seedSnapshot(levUrl, res.status, res.content, res.contentType);
        try {
          const jobs = JSON.parse(res.content);
          if (!Array.isArray(jobs)) return;
          for (const job of jobs as Array<Record<string, unknown>>) {
            const title = String(job.text ?? "").trim();
            const appUrl = validateOptionalUrl(job.hostedUrl || job.applyUrl);
            const postedAt = parseUtcDatetime(job.createdAt);
            if (!title || !appUrl || !postedAt) continue;
            const cats = (job.categories as Record<string, unknown> | undefined) ?? {};
            const desc =
              typeof job.descriptionPlain === "string"
                ? job.descriptionPlain.slice(0, 4000)
                : typeof job.description === "string"
                ? stripHtmlToText(job.description).slice(0, 4000)
                : null;
            if (!isQualifyingAiJob(`lever:${board}`, title, [String(cats.team ?? "")], String(cats.department ?? ""), desc)) {
              continue;
            }
            combined.push({
              title,
              company: board.replace(/\b\w/g, (c) => c.toUpperCase()),
              location: normalizeUnknownText(cats.location),
              employment_type: normalizeUnknownText(cats.commitment),
              description: desc,
              posted_at: postedAt.toISOString(),
              application_url: appUrl,
              source_name: `lever:${board}`,
              source_url: appUrl,
              collected_at: nowIso,
              source_metadata: { board: "lever", team: cats.team ?? null, api_url: levUrl },
            });
          }
        } catch (err) {
          errors.push({ source: `lever:${board}`, url: levUrl, error: `invalid_json: ${String(err)}` });
        }
      })()
    );
  }

  // Finalize source outcomes for boards 2-9 based on combined + errors + telemetry
  await Promise.all(tasks);

  const countBySource = new Map<string, number>();
  const freshBySource = new Map<string, number>();
  for (const r of combined) {
    const sn = String(r.source_name ?? "");
    countBySource.set(sn, (countBySource.get(sn) ?? 0) + 1);
    const dt = parseUtcDatetime(r.posted_at, now);
    if (isWithinFreshnessWindow(dt, now, config.freshnessWindowHours).ok) {
      freshBySource.set(sn, (freshBySource.get(sn) ?? 0) + 1);
    }
  }
  const jobSourceSpecs: Array<[string, string]> = [
    ["arbeitnow", "https://www.arbeitnow.com/api/job-board-api"],
    ["weworkremotely", "https://weworkremotely.com/remote-jobs.rss"],
    ["jobicy", "https://jobicy.com/api/v2/remote-jobs"],
    ...["anthropic", "scaleai", "xai", "togetherai"].map(
      (b): [string, string] => [`greenhouse:${b}`, `https://boards-api.greenhouse.io/v1/boards/${b}/jobs`]
    ),
    ...["openai", "perplexity", "cohere", "cursor", "elevenlabs", "harvey"].map(
      (b): [string, string] => [`ashby:${b}`, `https://api.ashbyhq.com/posting-api/job-board/${b}`]
    ),
    ["himalayas", "https://himalayas.app/jobs/api/search?q=ai"],
    ["remoteok", "https://remoteok.com/api"],
    ...["palantir", "zoox"].map(
      (b): [string, string] => [`lever:${b}`, `https://api.lever.co/v0/postings/${b}?mode=json`]
    ),
  ];
  for (const [src, url] of jobSourceSpecs) {
    const cnt = countBySource.get(src) ?? 0;
    const freshCnt = freshBySource.get(src) ?? 0;
    const err = errors.find((e) => e.source === src);
    const tel = srcTelemetry.get(src) ?? { attempts: 1, httpStatus: null };
    recordOutcome({
      category: "jobs",
      source: src,
      url: err?.url ?? url,
      status: cnt > 0 ? "ok" : err ? "failed" : "empty",
      discoveredCount: cnt,
      freshCount: freshCnt,
      retried: tel.attempts > 1,
      attempts: Math.max(1, tel.attempts),
      httpStatus: tel.httpStatus,
      error: err ? err.error : null,
    });
  }

  combined.sort((a, b) => String(b.posted_at).localeCompare(String(a.posted_at)));
  // Keep generous pool for rolling 24h filtering
  const cap = Math.max(limit, 1500);
  const sliced = combined.slice(0, cap);
  return { records: sliced, errors, hasMore: combined.length > cap, sourceOutcomes };
}

async function collectNews(
  config: AtlasConfig,
  http: PoliteHttpClient,
  verifier: LiveSourceVerifier,
  limit: number,
  page: number
): Promise<CollectionBatchResult> {
  const safePage = Math.max(1, page);
  const errors: CollectorError[] = [];
  const sourceOutcomes: SourceOutcomeRecord[] = [];
  const records: RawRecord[] = [];
  const now = new Date();
  const nowIso = now.toISOString();

  const rssSources = [
    { name: "techcrunch_ai", url: "https://techcrunch.com/category/artificial-intelligence/feed/", publisher: "TechCrunch", category: "Startups & AI" },
    { name: "theverge_ai", url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml", publisher: "The Verge", category: "AI & Tech" },
    { name: "wired_ai", url: "https://www.wired.com/feed/tag/ai/latest/rss", publisher: "WIRED", category: "AI" },
    { name: "marktechpost", url: "https://www.marktechpost.com/feed/", publisher: "MarkTechPost", category: "AI Research & Engineering" },
    { name: "the_decoder", url: "https://the-decoder.com/feed/", publisher: "The Decoder", category: "AI Industry" },
    { name: "siliconangle_ai", url: "https://siliconangle.com/category/ai/feed/", publisher: "SiliconANGLE", category: "Enterprise AI" },
    { name: "simonwillison", url: "https://simonwillison.net/atom/everything/", publisher: "Simon Willison", category: "LLMs & Engineering" },
    { name: "huggingface_blog", url: "https://huggingface.co/blog/feed.xml", publisher: "Hugging Face Blog", category: "AI Research & Engineering" },
    { name: "mit_news_ai", url: "https://news.mit.edu/topic/mitartificial-intelligence2-rss.xml", publisher: "MIT News", category: "AI Research" },
    { name: "google_blog", url: "https://blog.google/technology/ai/rss/", publisher: "Google AI Blog", category: "AI" },
    { name: "openai_news", url: "https://openai.com/news/rss.xml", publisher: "OpenAI News", category: "AI" },
    { name: "arstechnica_tech", url: "https://feeds.arstechnica.com/arstechnica/technology-lab", publisher: "Ars Technica", category: "AI & Technology" },
    { name: "devto_ai", url: "https://dev.to/feed/tag/ai", publisher: "DEV Community", category: "AI Engineering" },
  ];

  const feedTasks =
    safePage === 1
      ? rssSources.map(async (src) => {
          let res = await http.fetch(src.url, {
            timeoutMs: Math.min(config.requestTimeoutMs, 12000),
            maxAttempts: 2,
            checkRobots: false,
          });
          let totalAttempts = res.attempts;
          let retried = res.attempts > 1;
          if (!res.ok) {
            retried = true;
            res = await http.fetch(src.url, {
              timeoutMs: Math.min(config.requestTimeoutMs, 15000),
              maxAttempts: 2,
              checkRobots: false,
            });
            totalAttempts += res.attempts;
          }
          if (!res.ok) {
            const err = res.error || "fetch_failed";
            errors.push({ source: src.name, url: src.url, error: err });
            sourceOutcomes.push({
              category: "news",
              source: src.name,
              url: src.url,
              status: "failed",
              discoveredCount: 0,
              freshCount: 0,
              retried,
              attempts: totalAttempts,
              httpStatus: res.status || null,
              error: err,
            });
            return;
          }
          verifier.seedSnapshot(src.url, res.status, res.content, res.contentType);
          const beforeCount = records.length;
          let freshCount = 0;
          const items = extractXmlTags(res.content, "item");
          if (items.length > 0) {
            for (const item of items) {
              const title = (extractXmlTag(item, "title") ?? "").trim();
              const link = validateOptionalUrl(extractXmlTag(item, "link"));
              const pubMeta = parseUtcDatetimeWithMeta(
                extractXmlTag(item, "pubDate") || extractXmlTag(item, "dc:date")
              );
              const pubDt = pubMeta.date;
              const contentRaw = (extractXmlTag(item, "content:encoded") ?? "").trim();
              const descRaw = (extractXmlTag(item, "description") ?? "").trim();
              const bestBody = contentRaw.length > descRaw.length ? contentRaw : descRaw;
              const summary = bestBody ? stripHtmlToText(bestBody).slice(0, 3000) || null : null;
              if (!title || !link || !pubDt) continue;
              if (!isQualifyingAiNews(src.name, title, summary)) continue;
              if (isWithinFreshnessWindow(pubDt, now, config.freshnessWindowHours).ok) freshCount++;
              records.push({
                headline: title,
                summary,
                publisher: src.publisher,
                published_at: pubDt.toISOString(),
                article_url: link,
                category: src.category,
                source_name: src.name,
                source_url: src.url,
                collected_at: nowIso,
                source_metadata: {
                  feed_type: "rss",
                  api_url: src.url,
                  timestamp_precision: pubMeta.precision,
                },
              });
            }
          } else {
            const entries = extractXmlTags(res.content, "entry");
            for (const entry of entries) {
              const title = (extractXmlTag(entry, "title") ?? "").trim();
              const linkMatch = entry.match(/<link[^>]+href=["']([^"']+)["']/i);
              const link = validateOptionalUrl(linkMatch?.[1] ?? extractXmlTag(entry, "link"));
              const pubMeta = parseUtcDatetimeWithMeta(
                extractXmlTag(entry, "published") || extractXmlTag(entry, "updated")
              );
              const pubDt = pubMeta.date;
              const contentRaw = extractXmlTag(entry, "content") || "";
              const sumTag = extractXmlTag(entry, "summary") || "";
              const sumRaw = contentRaw.length > sumTag.length ? contentRaw : sumTag;
              const summary = sumRaw ? stripHtmlToText(sumRaw).slice(0, 3000) || null : null;
              if (!title || !link || !pubDt) continue;
              if (!isQualifyingAiNews(src.name, title, summary)) continue;
              if (isWithinFreshnessWindow(pubDt, now, config.freshnessWindowHours).ok) freshCount++;
              records.push({
                headline: title,
                summary,
                publisher: src.publisher,
                published_at: pubDt.toISOString(),
                article_url: link,
                category: src.category,
                source_name: src.name,
                source_url: src.url,
                collected_at: nowIso,
                source_metadata: {
                  feed_type: "atom",
                  api_url: src.url,
                  timestamp_precision: pubMeta.precision,
                },
              });
            }
          }
          const added = records.length - beforeCount;
          sourceOutcomes.push({
            category: "news",
            source: src.name,
            url: src.url,
            status: added > 0 ? "ok" : "empty",
            discoveredCount: added,
            freshCount,
            retried,
            attempts: totalAttempts,
            httpStatus: res.status || null,
            error: null,
          });
        })
      : [];

  // Hacker News Algolia stories (filtered for qualifying AI news)
  let gotHn = false;
  let hnErr: string | null = null;
  let hnCount = 0;
  let hnFreshCount = 0;
  let hnStatus: number | null = null;
  let hnMaxAttempts = 1;
  const hnTask = (async () => {
    for (let offset = 0; offset < 2; offset++) {
      const hnPage = Math.max(0, safePage - 1) + offset;
      const hnUrl = `https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=100&page=${hnPage}`;
      const hnRes = await http.fetch(hnUrl, {
        timeoutMs: config.requestTimeoutMs,
        maxAttempts: 2,
        checkRobots: false,
      });
      hnMaxAttempts = Math.max(hnMaxAttempts, hnRes.attempts);
      hnStatus = hnRes.status || hnStatus;
      if (!hnRes.ok) {
        hnErr = hnRes.error || "fetch_failed";
        errors.push({ source: "hn_algolia", url: hnUrl, error: hnErr });
        break;
      }
      verifier.seedSnapshot(hnUrl, hnRes.status, hnRes.content, hnRes.contentType);
      try {
        const payload = JSON.parse(hnRes.content) as Record<string, unknown>;
        const hits = Array.isArray(payload.hits) ? (payload.hits as Array<Record<string, unknown>>) : [];
        if (hits.length > 0) gotHn = true;
        for (const hit of hits) {
          const title = String(hit.title ?? "").trim();
          const articleUrl = validateOptionalUrl(hit.url);
          const pubDt = parseUtcDatetime(hit.created_at);
          if (!title || !articleUrl || !pubDt) continue;
          const summary = typeof hit.story_text === "string" && hit.story_text.trim()
            ? stripHtmlToText(hit.story_text).slice(0, 1500)
            : null;
          if (!isQualifyingAiNews("hn_algolia", title, summary)) continue;
          const objId = hit.objectID ? String(hit.objectID) : null;
          if (isWithinFreshnessWindow(pubDt, now, config.freshnessWindowHours).ok) hnFreshCount++;
          records.push({
            headline: title,
            summary,
            publisher: "Hacker News",
            published_at: pubDt.toISOString(),
            article_url: articleUrl,
            category: "AI & Technology",
            source_name: "hn_algolia",
            source_url: objId ? `https://news.ycombinator.com/item?id=${objId}` : hnUrl,
            collected_at: nowIso,
            source_metadata: { points: hit.points ?? null, objectID: objId, api_url: hnUrl },
          });
          hnCount++;
        }
      } catch (err) {
        hnErr = `invalid_json: ${String(err)}`;
        errors.push({ source: "hn_algolia", url: hnUrl, error: hnErr });
        break;
      }
    }
    sourceOutcomes.push({
      category: "news",
      source: "hn_algolia",
      url: "https://hn.algolia.com/api/v1/search_by_date?tags=story",
      status: hnCount > 0 ? "ok" : hnErr ? "failed" : "empty",
      discoveredCount: hnCount,
      freshCount: hnFreshCount,
      retried: hnMaxAttempts > 1,
      attempts: hnMaxAttempts,
      httpStatus: hnStatus,
      error: hnCount === 0 ? hnErr : null,
    });
  })();

  await Promise.all([...feedTasks, hnTask]);

  records.sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)));
  const cap = Math.max(limit, 1000);
  const sliced = records.slice(0, cap);
  return { records: sliced, errors, hasMore: records.length > cap || gotHn, sourceOutcomes };
}

function csvEscape(val: string | number): string {
  const s = String(val);
  if (s.includes('"') || s.includes(",") || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function parseCsvRecords(content: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch === "\r") {
      if (content[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim());
  const out: Array<Record<string, string>> = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.length === 1 && cells[0] === "") continue;
    const obj: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) {
      if (!header[c]) continue;
      obj[header[c]] = cells[c] ?? "";
    }
    out.push(obj);
  }
  return out;
}

function parseSemiList(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseJsonMeta(raw: string | undefined): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseVerificationStatus(raw: string | undefined): VerificationStatus {
  const s = (raw ?? "").trim();
  if (
    s === "Verified" ||
    s === "Partially Verified" ||
    s === "Unverified" ||
    s === "Source Unavailable" ||
    s === "Rejected"
  ) {
    return s;
  }
  return "Unverified";
}

// ---------- Main Backend Service ----------

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

export async function probeGithubApi(
  http: PoliteHttpClient,
  githubToken: string | null,
  apiBaseUrl = "https://api.github.com"
): Promise<IntegrationHealthItem> {
  const checkedAt = new Date().toISOString();
  const base: Omit<IntegrationHealthItem, "status" | "detail" | "error" | "latencyMs"> = {
    id: "github",
    label: "GitHub REST API Enrichment",
    envKey: "GITHUB_TOKEN",
    checkedAt,
    tested: true,
  };

  if (!githubToken || !githubToken.trim()) {
    return {
      ...base,
      status: "Not Configured",
      detail: "GITHUB_TOKEN is not set. Unauthenticated public GitHub endpoints remain limited to 60 requests/hour.",
      error: null,
      latencyMs: null,
    };
  }

  const startedAt = Date.now();
  const cleanBase = apiBaseUrl.replace(/\/+$/, "");
  const res = await http.fetch(`${cleanBase}/rate_limit`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${githubToken.trim()}`,
    },
    checkRobots: false,
    timeoutMs: 8000,
    maxAttempts: 1,
  });
  const latencyMs = Date.now() - startedAt;

  if (!res.ok) {
    const safeDetail = redactSecrets(res.error || `HTTP ${res.status}`);
    let apiMessage = "";
    try {
      const parsed = JSON.parse(res.content) as { message?: string };
      if (parsed.message) apiMessage = redactSecrets(parsed.message);
    } catch {
      // Ignore parse failure
    }
    const errText =
      res.status === 401
        ? `GitHub authentication failed (HTTP 401${apiMessage ? `: ${apiMessage}` : ""}). Check GITHUB_TOKEN.`
        : res.status === 403 || res.status === 429
        ? `GitHub API rate-limited or forbidden (HTTP ${res.status}${apiMessage ? `: ${apiMessage}` : ""}).`
        : `GitHub API check failed (${safeDetail}${apiMessage ? `: ${apiMessage}` : ""}).`;
    return {
      ...base,
      status: "Connection Failed",
      detail: errText,
      error: errText,
      latencyMs,
    };
  }

  try {
    const payload = JSON.parse(res.content) as {
      resources?: { core?: { limit?: number; remaining?: number; reset?: number } };
    };
    const core = payload.resources?.core;
    const limit = typeof core?.limit === "number" ? core.limit : 5000;
    const remaining = typeof core?.remaining === "number" ? core.remaining : null;
    const detail =
      remaining !== null
        ? `Authenticated GitHub REST API verified (${remaining.toLocaleString()}/${limit.toLocaleString()} core requests/hr remaining).`
        : `Authenticated GitHub REST API verified (${limit.toLocaleString()} requests/hr limit).`;
    return {
      ...base,
      status: "Configured",
      detail,
      error: null,
      latencyMs,
    };
  } catch (err) {
    const errMsg = `GitHub API returned invalid JSON: ${redactSecrets(err instanceof Error ? err.message : String(err))}`;
    return {
      ...base,
      status: "Connection Failed",
      detail: errMsg,
      error: errMsg,
      latencyMs,
    };
  }
}

export interface ActiveRunStateSnapshot {
  id: string;
  triggerType: "manual" | "scheduled" | "daily_24h";
  mode: "full" | "daily_24h";
  status: "idle" | "running" | "completed" | "partial" | "failed";
  categories: string[];
  limit: number;
  page: number;
  startedAt: string | null;
  finishedAt: string | null;
  logs: string[];
  result: unknown | null;
  error: string | null;
}

export class AtlasBackendService {
  private readonly config: AtlasConfig;
  private readonly db: AtlasDatabase;
  private readonly http: PoliteHttpClient;
  private readonly llmRouter: LLMRouter;
  private readonly sheets: GoogleSheetsService;
  private latestHealth: IntegrationHealthSummary | null = null;
  private healthCheckInFlight: Promise<IntegrationHealthSummary> | null = null;
  private runInFlight: Promise<unknown> | null = null;
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private activeRunState: ActiveRunStateSnapshot = {
    id: "none",
    triggerType: "manual",
    mode: "full",
    status: "idle",
    categories: [],
    limit: 20,
    page: 1,
    startedAt: null,
    finishedAt: null,
    logs: [],
    result: null,
    error: null,
  };

  constructor(atlasDir: string) {
    this.config = loadAtlasConfig(atlasDir);
    this.db = new AtlasDatabase(this.config.dbPath);
    this.db.initializeSchema();
    this.db.markInterruptedRunsFailed();
    const hydrated = this.hydrateFromCsvExportsIfEmpty();
    this.ensureSchedulerInitialized();
    this.db.checkpointWal(hydrated ? "TRUNCATE" : "PASSIVE");
    this.http = new PoliteHttpClient({
      userAgent: this.config.userAgent,
      timeoutMs: this.config.requestTimeoutMs,
      rateLimitPerSecond: this.config.rateLimitPerSecond,
      respectRobotsTxt: this.config.respectRobotsTxt,
    });
    this.llmRouter = createLLMRouter(this.config);
    this.sheets = new GoogleSheetsService(
      {
        atlasDir: this.config.atlasDir,
        rootDir: this.config.rootDir,
        credentialsPath: this.config.googleSheetsCredentialsPath,
        credentialsJson: this.config.googleSheetsCredentialsJson,
        spreadsheetId: this.config.googleSheetsSpreadsheetId,
        spreadsheetName: this.config.googleSheetsSpreadsheetName,
      },
      this.db
    );
  }

  private ensureSchedulerInitialized(): SchedulerStateRecord {
    const existing = this.db.getSchedulerState();
    const now = new Date();
    if (existing) {
      const nextIso = existing.next_run_at || computeNextUtcRunIso(existing.utc_time, now, existing.last_run_at);
      if (nextIso !== existing.next_run_at) {
        const updated: SchedulerStateRecord = {
          ...existing,
          next_run_at: nextIso,
          updated_at: now.toISOString(),
        };
        this.db.saveSchedulerState(updated);
        return updated;
      }
      return existing;
    }
    const lastSuccess = this.db.getLastSuccessfulRun(false)?.completed_at ?? null;
    const latestRun = this.db.fetchPipelineRuns(1)[0];
    const initial: SchedulerStateRecord = {
      enabled: this.config.dailyCollectionEnabled,
      utc_time: this.config.dailyCollectionUtcTime,
      last_run_at: latestRun?.started_at ?? null,
      last_success_at: lastSuccess,
      next_run_at: computeNextUtcRunIso(this.config.dailyCollectionUtcTime, now, latestRun?.started_at ?? null),
      updated_at: now.toISOString(),
    };
    this.db.saveSchedulerState(initial);
    return initial;
  }

  public getSchedulerStatus(): SchedulerStateRecord {
    return this.ensureSchedulerInitialized();
  }

  public updateSchedulerConfig(opts: { enabled?: boolean; utcTime?: string }): SchedulerStateRecord {
    const current = this.ensureSchedulerInitialized();
    const nextUtc =
      opts.utcTime !== undefined ? normalizeUtcTimeHHMM(opts.utcTime, current.utc_time) : current.utc_time;
    const nextEnabled = opts.enabled !== undefined ? Boolean(opts.enabled) : current.enabled;
    const now = new Date();
    const updated: SchedulerStateRecord = {
      ...current,
      enabled: nextEnabled,
      utc_time: nextUtc,
      next_run_at: computeNextUtcRunIso(nextUtc, now, current.last_run_at),
      updated_at: now.toISOString(),
    };
    this.db.saveSchedulerState(updated);
    return updated;
  }

  public startScheduler(pollIntervalMs = 30_000): void {
    if (this.schedulerTimer) return;
    this.ensureSchedulerInitialized();
    this.schedulerTimer = setInterval(() => {
      void this.tickScheduler().catch(() => {});
    }, Math.max(1000, pollIntervalMs));
    this.schedulerTimer.unref?.();
  }

  public stopScheduler(): void {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  public async tickScheduler(now: Date = new Date()): Promise<boolean> {
    const state = this.ensureSchedulerInitialized();
    if (!state.enabled || !state.next_run_at) return false;
    const nextMs = Date.parse(state.next_run_at);
    if (!Number.isFinite(nextMs) || now.getTime() < nextMs) return false;
    if (this.isRunInProgress()) return false;

    const nowIso = now.toISOString();
    const advanced: SchedulerStateRecord = {
      ...state,
      last_run_at: nowIso,
      next_run_at: computeNextUtcRunIso(state.utc_time, now, nowIso),
      updated_at: nowIso,
    };
    this.db.saveSchedulerState(advanced);

    const started = this.startBackgroundRun({
      triggerType: "scheduled",
      mode: "daily_24h",
      categories: ["jobs", "news", "research_papers"],
      limit: 1000,
      page: 1,
      includeAllFresh24h: true,
    });
    return started.started;
  }

  public isRunInProgress(): boolean {
    return this.runInFlight !== null;
  }

  public getActiveRunState(): ActiveRunStateSnapshot {
    return { ...this.activeRunState };
  }

  public getDatabaseHealth() {
    return this.db.checkHealth();
  }

  public close(): void {
    this.stopScheduler();
    this.db.close();
  }

  private hydrateFromCsvExportsIfEmpty(): boolean {
    if (!fs.existsSync(this.config.exportsDir)) {
      return false;
    }
    const counts = this.db.countRecords();
    let hydratedAny = false;

    const readExport = (filename: string): Array<Record<string, string>> => {
      const p = path.resolve(this.config.exportsDir, filename);
      if (!fs.existsSync(p)) return [];
      return parseCsvRecords(fs.readFileSync(p, "utf-8"));
    };

    const startupRows = counts.startups === 0 || counts.entity_mapping_log === 0 ? readExport("startups.csv") : [];
    if (counts.startups === 0 && startupRows.length > 0) {
      const inputs: StartupInput[] = startupRows
        .filter((r) => r.startup_id && r.name && r.source_url)
        .map((r) => ({
          startup_id: r.startup_id,
          name: r.name,
          description: r.description || null,
          website: r.website || null,
          official_website: r.official_website || r.website || null,
          industry: r.industry || "Unknown",
          location: r.location || "Unknown",
          founding_date: r.founding_date || null,
          source_name: r.source_name || "unknown",
          source_url: r.source_url,
          source_title: r.source_title || null,
          collected_at: r.collected_at || new Date().toISOString(),
          last_checked_at: r.last_checked_at || null,
          supported_fields: parseSemiList(r.supported_fields),
          verification_status: parseVerificationStatus(r.verification_status),
          rejection_reason: r.rejection_reason || null,
          canonical_entity_id: r.canonical_entity_id || null,
          source_metadata: parseJsonMeta(r.source_metadata_json),
        }));
      if (inputs.length > 0) {
        this.db.upsertStartups(inputs);
        hydratedAny = true;
      }
    }

    const productRows = counts.products === 0 || counts.entity_mapping_log === 0 ? readExport("products.csv") : [];
    if (counts.products === 0 && productRows.length > 0) {
      const inputs: ProductInput[] = productRows
        .filter((r) => r.product_id && r.name && r.source_url)
        .map((r) => ({
          product_id: r.product_id,
          name: r.name,
          description: r.description || null,
          website: r.website || null,
          official_website: r.official_website || r.website || null,
          category: r.category || "Unknown",
          company_name: r.company_name || "Unknown",
          source_name: r.source_name || "unknown",
          source_url: r.source_url,
          source_title: r.source_title || null,
          collected_at: r.collected_at || new Date().toISOString(),
          last_checked_at: r.last_checked_at || null,
          supported_fields: parseSemiList(r.supported_fields),
          verification_status: parseVerificationStatus(r.verification_status),
          rejection_reason: r.rejection_reason || null,
          canonical_entity_id: r.canonical_entity_id || null,
          source_metadata: parseJsonMeta(r.source_metadata_json),
        }));
      if (inputs.length > 0) {
        this.db.upsertProducts(inputs);
        hydratedAny = true;
      }
    }

    if (counts.research_papers === 0) {
      const paperRows = readExport("research_papers.csv");
      if (paperRows.length > 0) {
        const inputs: ResearchPaperInput[] = paperRows
          .filter((r) => r.paper_id && r.title && r.source_url)
          .map((r) => {
            const starsRaw = r.github_stars?.trim();
            const starsParsed = starsRaw && /^\d+$/.test(starsRaw) ? Number(starsRaw) : null;
            const meta = parseJsonMeta(r.source_metadata_json);
            const publishedAt =
              r.published_at?.trim()
                ? r.published_at.trim()
                : typeof meta.published_at_utc === "string" && meta.published_at_utc
                ? meta.published_at_utc
                : null;
            return {
              paper_id: r.paper_id,
              title: r.title,
              abstract: r.abstract || null,
              authors: parseSemiList(r.authors),
              publication_date: r.publication_date || null,
              published_at: publishedAt,
              doi: r.doi || null,
              arxiv_id: r.arxiv_id || null,
              github_repository: r.github_repository || null,
              github_stars: starsParsed,
              official_website: r.official_website || null,
              source_name: r.source_name || "unknown",
              source_url: r.source_url,
              source_title: r.source_title || null,
              collected_at: r.collected_at || new Date().toISOString(),
              last_checked_at: r.last_checked_at || null,
              supported_fields: parseSemiList(r.supported_fields),
              verification_status: parseVerificationStatus(r.verification_status),
              rejection_reason: r.rejection_reason || null,
              source_metadata: parseJsonMeta(r.source_metadata_json),
            };
          });
        if (inputs.length > 0) {
          this.db.upsertResearchPapers(inputs);
          hydratedAny = true;
        }
      }
    }

    if (counts.jobs === 0) {
      const jobRows = readExport("jobs.csv");
      if (jobRows.length > 0) {
        const inputs: JobInput[] = jobRows
          .filter((r) => r.job_id && r.title && r.application_url && r.posted_at)
          .map((r) => ({
            job_id: r.job_id,
            title: r.title,
            company: r.company || "Unknown",
            location: r.location || "Unknown",
            employment_type: r.employment_type || "Unknown",
            description: r.description || null,
            posted_at: r.posted_at,
            application_url: r.application_url,
            official_website: r.official_website || null,
            source_name: r.source_name || "unknown",
            source_url: r.source_url || r.application_url,
            source_title: r.source_title || null,
            collected_at: r.collected_at || new Date().toISOString(),
            last_checked_at: r.last_checked_at || null,
            supported_fields: parseSemiList(r.supported_fields),
            verification_status: parseVerificationStatus(r.verification_status),
            rejection_reason: r.rejection_reason || null,
            canonical_company_id: r.canonical_company_id || null,
            source_metadata: parseJsonMeta(r.source_metadata_json),
          }));
        if (inputs.length > 0) {
          this.db.upsertJobs(inputs);
          hydratedAny = true;
        }
      }
    }

    if (counts.news === 0) {
      const newsRows = readExport("news.csv");
      if (newsRows.length > 0) {
        const inputs: NewsInput[] = newsRows
          .filter((r) => r.news_id && r.headline && r.article_url && r.published_at)
          .map((r) => ({
            news_id: r.news_id,
            headline: r.headline,
            summary: r.summary || null,
            publisher: r.publisher || "Unknown",
            published_at: r.published_at,
            article_url: r.article_url,
            official_website: r.official_website || null,
            category: r.category || "AI",
            source_name: r.source_name || null,
            source_url: r.source_url || r.article_url,
            source_title: r.source_title || null,
            collected_at: r.collected_at || new Date().toISOString(),
            last_checked_at: r.last_checked_at || null,
            supported_fields: parseSemiList(r.supported_fields),
            verification_status: parseVerificationStatus(r.verification_status),
            rejection_reason: r.rejection_reason || null,
            source_metadata: parseJsonMeta(r.source_metadata_json),
          }));
        if (inputs.length > 0) {
          this.db.upsertNews(inputs);
          hydratedAny = true;
        }
      }
    }

    if (counts.entity_mapping_log === 0) {
      const mappingRows = readExport("entity_mapping_log.csv");
      if (mappingRows.length > 0) {
        const canonicalMap = new Map<
          string,
          {
            canonical_id: string;
            canonical_name: string;
            normalized_name: string;
            entity_type: string;
            aliases: Set<string>;
            created_at: string;
          }
        >();
        const mappingInputs: EntityMappingLogInput[] = mappingRows
          .filter((r) => r.mapping_id && r.raw_name && r.canonical_id)
          .map((r) => {
            const conf = Number(r.confidence);
            const ts = r.timestamp || new Date().toISOString();
            const existing = canonicalMap.get(r.canonical_id);
            if (!existing) {
              canonicalMap.set(r.canonical_id, {
                canonical_id: r.canonical_id,
                canonical_name: r.canonical_name || r.raw_name,
                normalized_name: r.normalized_name || normalizeEntityName(r.canonical_name || r.raw_name),
                entity_type: r.entity_type || "company",
                aliases: new Set([r.raw_name]),
                created_at: ts,
              });
            } else {
              existing.aliases.add(r.raw_name);
            }
            return {
              mapping_id: r.mapping_id,
              raw_name: r.raw_name,
              normalized_name: r.normalized_name || normalizeEntityName(r.raw_name),
              canonical_name: r.canonical_name || r.raw_name,
              canonical_id: r.canonical_id,
              source_url: r.source_url || "",
              match_method: r.match_method || "imported_mapping",
              confidence: Number.isFinite(conf) ? conf : 1.0,
              decision: r.decision || "new_entity",
              timestamp: ts,
              entity_type: r.entity_type || "company",
              match_reason: r.match_reason || null,
            };
          });
        const domainByCanonical = new Map<string, string>();
        for (const s of startupRows) {
          if (s.canonical_entity_id && s.website) {
            const d = extractDomain(s.website);
            if (d && !GENERIC_HOST_DOMAINS.has(d)) domainByCanonical.set(s.canonical_entity_id, d);
          }
        }
        for (const p of productRows) {
          if (p.canonical_entity_id && p.website && !domainByCanonical.has(p.canonical_entity_id)) {
            const d = extractDomain(p.website);
            if (d && !GENERIC_HOST_DOMAINS.has(d)) domainByCanonical.set(p.canonical_entity_id, d);
          }
        }
        const canonicalRows: CanonicalEntityRow[] = Array.from(canonicalMap.values()).map((c) => ({
          canonical_id: c.canonical_id,
          canonical_name: c.canonical_name,
          normalized_name: c.normalized_name,
          entity_type: c.entity_type,
          primary_domain: domainByCanonical.get(c.canonical_id) ?? null,
          aliases_json: JSON.stringify(Array.from(c.aliases)),
          created_at: c.created_at,
        }));
        if (canonicalRows.length > 0) {
          this.db.upsertCanonicalEntities(canonicalRows);
        }
        if (mappingInputs.length > 0) {
          this.db.upsertEntityMappingLogs(mappingInputs);
          hydratedAny = true;
        }
      }
    }

    return hydratedAny;
  }

  private buildInitialUntestedHealth(): IntegrationHealthSummary {
    const dbHealth = this.db.checkHealth();
    const totalRows = Object.values(dbHealth.tableCounts).reduce((s, n) => s + n, 0);
    const items: IntegrationHealthItem[] = [
      {
        id: "sqlite",
        label: "SQLite Persistent Database",
        envKey: "DATABASE_URL",
        status: dbHealth.ok ? "Configured" : "Connection Failed",
        detail: dbHealth.ok
          ? `SQLite (${dbHealth.journalMode.toUpperCase()}) verified: ${totalRows.toLocaleString()} rows across 6 datasets.`
          : dbHealth.error || "SQLite health check failed.",
        error: dbHealth.ok ? null : dbHealth.error,
        latencyMs: 0,
        checkedAt: new Date().toISOString(),
        tested: true,
      },
      {
        id: "gemini",
        label: `Google Gemini (${this.config.geminiModel})`,
        envKey: "GEMINI_API_KEY",
        status: "Not Configured",
        detail: this.config.geminiApiKey
          ? "Credential present — awaiting live API test before marking Configured."
          : "GEMINI_API_KEY is not set in environment.",
        error: null,
        latencyMs: null,
        checkedAt: null,
        tested: !this.config.geminiApiKey,
      },
      {
        id: "groq",
        label: `Groq (${this.config.groqModel})`,
        envKey: "GROQ_API_KEY",
        status: "Not Configured",
        detail: this.config.groqApiKey
          ? "Credential present — awaiting live API test before marking Configured."
          : "GROQ_API_KEY is not set in environment.",
        error: null,
        latencyMs: null,
        checkedAt: null,
        tested: !this.config.groqApiKey,
      },
      {
        id: "llama3",
        label: `Llama 3 (${this.config.llama3Model})`,
        envKey: "GROQ_API_KEY / LLAMA3_API_KEY",
        status: "Not Configured",
        detail:
          this.config.llama3ApiKey || this.config.groqApiKey
            ? "Credential present — awaiting live API test before marking Configured."
            : "Neither GROQ_API_KEY nor LLAMA3_API_KEY is set in environment.",
        error: null,
        latencyMs: null,
        checkedAt: null,
        tested: !(this.config.llama3ApiKey || this.config.groqApiKey),
      },
      {
        id: "deepseek",
        label: `DeepSeek (${this.config.deepseekModel})`,
        envKey: "DEEPSEEK_API_KEY",
        status: "Not Configured",
        detail: this.config.deepseekApiKey
          ? "Credential present — awaiting live API test before marking Configured."
          : "DEEPSEEK_API_KEY is not set in environment.",
        error: null,
        latencyMs: null,
        checkedAt: null,
        tested: !this.config.deepseekApiKey,
      },
      {
        id: "github",
        label: "GitHub REST API Enrichment",
        envKey: "GITHUB_TOKEN",
        status: "Not Configured",
        detail: this.config.githubToken
          ? "Credential present — awaiting live API test before marking Configured."
          : "GITHUB_TOKEN is not set (public rate limit 60 req/hr).",
        error: null,
        latencyMs: null,
        checkedAt: null,
        tested: !this.config.githubToken,
      },
      {
        id: "google_sheets",
        label: "Google Sheets & Drive OAuth",
        envKey: "Workspace OAuth (drive.file, spreadsheets)",
        status: "Not Configured",
        detail: this.sheets.isConfigured()
          ? "Service Account configured — awaiting live API test before marking Configured."
          : "Sign in with Google to authorize Drive (drive.file) & Sheets spreadsheet creation/sync.",
        error: null,
        latencyMs: null,
        checkedAt: null,
        tested: !this.sheets.isConfigured(),
      },
    ];
    const byId: Record<string, IntegrationHealthItem> = {};
    for (const item of items) byId[item.id] = item;
    return { checkedAt: null, items, byId };
  }

  public getIntegrationHealthSummary(): IntegrationHealthSummary {
    return this.latestHealth ?? this.buildInitialUntestedHealth();
  }

  public async ensureInitialHealthChecked(): Promise<IntegrationHealthSummary> {
    if (this.latestHealth?.checkedAt) {
      const hasFailedLlm = ["gemini", "groq", "llama3", "deepseek"].some(
        (id) => this.latestHealth?.byId?.[id]?.status === "Connection Failed"
      );
      const checkedMs = Date.parse(this.latestHealth.checkedAt);
      const staleAfterFailure = hasFailedLlm && Number.isFinite(checkedMs) && Date.now() - checkedMs > 45_000;
      if (!staleAfterFailure) {
        return this.latestHealth;
      }
    }
    if (this.healthCheckInFlight) {
      return this.healthCheckInFlight;
    }
    return this.runIntegrationHealthChecks();
  }

  public async runIntegrationHealthChecks(opts?: {
    oauthAccessToken?: string | null;
    spreadsheetId?: string | null;
  }): Promise<IntegrationHealthSummary> {
    if (this.healthCheckInFlight && !opts?.oauthAccessToken && !opts?.spreadsheetId) {
      return this.healthCheckInFlight;
    }
    const task = (async (): Promise<IntegrationHealthSummary> => {
      const checkedAt = new Date().toISOString();
      const dbStart = Date.now();
      const dbHealth = this.db.checkHealth();
      const dbLatencyMs = Date.now() - dbStart;
      const totalDbRows = Object.values(dbHealth.tableCounts).reduce((s, n) => s + n, 0);

      const [llmProbes, githubProbe, sheetsProbe] = await Promise.all([
        this.llmRouter.probeProviders({ timeoutMs: 12_000 }),
        probeGithubApi(this.http, this.config.githubToken),
        this.sheets.probeHealth(opts),
      ]);

      const llmByName = new Map(llmProbes.map((p) => [p.provider, p]));
      const geminiProbe = llmByName.get("gemini");
      const groqProbe = llmByName.get("groq");
      const llama3Probe = llmByName.get("llama3");
      const deepseekProbe = llmByName.get("deepseek");

      const toLlmItem = (
        id: "gemini" | "groq" | "llama3" | "deepseek",
        label: string,
        envKey: string,
        probe: (typeof llmProbes)[number] | undefined,
        fallbackModel: string
      ): IntegrationHealthItem => {
        const status: IntegrationConnectionStatus = probe?.status ?? "Not Configured";
        const detail =
          status === "Configured"
            ? `Live probe succeeded (${probe?.model ?? fallbackModel} via ${probe?.via ?? id}${probe?.latencyMs !== null ? `, ${probe?.latencyMs}ms` : ""}).`
            : status === "Connection Failed"
            ? probe?.error || "Connection test failed."
            : id === "llama3"
            ? "Neither GROQ_API_KEY nor LLAMA3_API_KEY is set."
            : `${envKey} is not set.`;
        return {
          id,
          label,
          envKey,
          status,
          detail,
          error: status === "Connection Failed" ? probe?.error ?? "Connection test failed." : null,
          latencyMs: probe?.latencyMs ?? null,
          checkedAt: probe?.checkedAt ?? checkedAt,
          tested: true,
        };
      };

      const items: IntegrationHealthItem[] = [
        {
          id: "sqlite",
          label: "SQLite Persistent Database",
          envKey: "DATABASE_URL",
          status: dbHealth.ok ? "Configured" : "Connection Failed",
          detail: dbHealth.ok
            ? `SQLite (${dbHealth.journalMode.toUpperCase()}) verified: ${totalDbRows.toLocaleString()} records across 6 datasets.`
            : dbHealth.error || "SQLite check failed.",
          error: dbHealth.ok ? null : dbHealth.error,
          latencyMs: dbLatencyMs,
          checkedAt,
          tested: true,
        },
        toLlmItem(
          "gemini",
          `Google Gemini (${this.config.geminiModel})`,
          "GEMINI_API_KEY",
          geminiProbe,
          this.config.geminiModel
        ),
        toLlmItem(
          "groq",
          `Groq (${this.config.groqModel})`,
          "GROQ_API_KEY",
          groqProbe,
          this.config.groqModel
        ),
        toLlmItem(
          "llama3",
          `Llama 3 via ${llama3Probe?.via === "groq" ? "Groq" : "Endpoint"} (${this.config.llama3Model})`,
          "GROQ_API_KEY / LLAMA3_API_KEY",
          llama3Probe,
          this.config.llama3Model
        ),
        toLlmItem(
          "deepseek",
          `DeepSeek (${this.config.deepseekModel})`,
          "DEEPSEEK_API_KEY",
          deepseekProbe,
          this.config.deepseekModel
        ),
        githubProbe,
        {
          id: "google_sheets",
          label: "Google Sheets & Drive OAuth",
          envKey: "Workspace OAuth (drive.file, spreadsheets)",
          status: sheetsProbe.status,
          detail: sheetsProbe.detail,
          error: sheetsProbe.error,
          latencyMs: null,
          checkedAt: sheetsProbe.checkedAt,
          tested: true,
        },
      ];

      const byId: Record<string, IntegrationHealthItem> = {};
      for (const item of items) byId[item.id] = item;
      const summary: IntegrationHealthSummary = { checkedAt, items, byId };
      this.latestHealth = summary;
      return summary;
    })();

    this.healthCheckInFlight = task;
    try {
      return await task;
    } finally {
      if (this.healthCheckInFlight === task) {
        this.healthCheckInFlight = null;
      }
    }
  }

  public getStatus(): Record<string, unknown> {
    const counts = this.db.countRecords();
    const uniqueQualifiedCounts = this.db.countUniqueQualifiedRecords();
    const freshCounts24h = this.db.countFresh24h(this.config.freshnessWindowHours);
    const verificationCounts = this.db.getVerificationCounts();
    const checkpoints = this.db.fetchCheckpoints();
    const failureCount = this.db.getFailureCount();
    const auditTrail = this.db.fetchAuditTrail({ limit: 50 });
    const pipelineRuns = this.db.fetchPipelineRuns(12);
    const lastSuccessRun = this.db.getLastSuccessfulRun(false);
    const lastUsableRun = this.db.getLastSuccessfulRun(true);
    const scheduler = this.getSchedulerStatus();

    const qualityReportPath = path.resolve(this.config.dataDir, "quality_report.json");
    let qualityReport: unknown = null;
    if (fs.existsSync(qualityReportPath)) {
      try {
        qualityReport = JSON.parse(fs.readFileSync(qualityReportPath, "utf-8"));
      } catch {
        qualityReport = null;
      }
    }

    const csvExports = fs.existsSync(this.config.exportsDir)
      ? fs
          .readdirSync(this.config.exportsDir)
          .filter((f) => f.endsWith(".csv"))
          .sort()
      : [];

    const sheetsStatus: SheetsConnectionStatus = this.sheets.getStatus();
    const integrationHealth = this.getIntegrationHealthSummary();
    const byId = integrationHealth.byId;

    const anyLlmLiveVerified = ["gemini", "groq", "llama3", "deepseek"].some(
      (k) => byId[k]?.status === "Configured"
    );

    const latestCompletedOrPartial = pipelineRuns.find((r) => r.status !== "running") ?? null;

    return {
      counts,
      uniqueQualifiedCounts,
      latestRunNewCounts: latestCompletedOrPartial?.new_records_counts ?? {},
      freshCounts24h,
      verificationCounts,
      auditTrail,
      failureCount,
      pipelineRuns,
      scheduler,
      lastSuccessfulRunAt: lastSuccessRun?.completed_at ?? lastSuccessRun?.started_at ?? null,
      lastCollectionAt: lastUsableRun?.completed_at ?? lastUsableRun?.started_at ?? null,
      latestRunStatus: latestCompletedOrPartial?.status ?? null,
      lastSourceOutcomes: latestCompletedOrPartial?.source_outcomes ?? [],
      activeRun: this.getActiveRunState(),
      targets: {
        startups: this.config.targetStartups,
        products: this.config.targetProducts,
        research_papers: this.config.targetResearchPapers,
      },
      targetChecks: {
        startups: {
          uniqueCount: uniqueQualifiedCounts.startups,
          target: this.config.targetStartups,
          met: uniqueQualifiedCounts.startups >= this.config.targetStartups,
        },
        products: {
          uniqueCount: uniqueQualifiedCounts.products,
          target: this.config.targetProducts,
          met: uniqueQualifiedCounts.products >= this.config.targetProducts,
        },
        research_papers: {
          uniqueCount: uniqueQualifiedCounts.research_papers,
          target: this.config.targetResearchPapers,
          met: uniqueQualifiedCounts.research_papers >= this.config.targetResearchPapers,
        },
      },
      freshnessWindowHours: this.config.freshnessWindowHours,
      credentials: {
        geminiConfigured: byId.gemini?.status === "Configured",
        geminiModel: this.config.geminiModel,
        groqConfigured: byId.groq?.status === "Configured",
        llama3Configured: byId.llama3?.status === "Configured",
        deepseekConfigured: byId.deepseek?.status === "Configured",
        llmChain: this.llmRouter.allProviderNames(),
        configuredLlmChain: this.llmRouter.configuredProviderNames(),
        llmDemoFallbackActive: !anyLlmLiveVerified && !this.llmRouter.isConfigured(),
        githubTokenConfigured: byId.github?.status === "Configured",
        googleSheetsConfigured:
          byId.google_sheets?.status === "Configured" || sheetsStatus.status === "Connected",
        googleSheetsSpreadsheetId: Boolean(this.config.googleSheetsSpreadsheetId || sheetsStatus.spreadsheetId),
      },
      integrationHealth,
      sheetsStatus,
      storage: {
        backend: "sqlite",
        sqlitePath: this.config.dbPath,
        integrityCheck: integrationHealth.byId?.sqlite?.status === "Configured" ? "ok" : integrationHealth.byId?.sqlite?.error ?? "unknown",
      },
      checkpoints,
      qualityReport,
      csvExports,
    };
  }

  public getDataset(
    category: string,
    limit: number,
    window: "all" | "24h" = "all",
    offset = 0
  ): Record<string, unknown> {
    const windowHours = window === "24h" ? this.config.freshnessWindowHours : null;
    const rows = this.db.fetchDatasetWindow(category, { limit, offset, windowHours });
    const totalCount = this.db.countDatasetWindow(category, { windowHours });
    return {
      category,
      window,
      rows,
      count: rows.length,
      totalCount,
      truncated: offset + rows.length < totalCount,
    };
  }

  public getAuditTrail(opts: {
    category?: string | null;
    recordId?: string | null;
    limit?: number;
  }): Record<string, unknown> {
    const entries = this.db.fetchAuditTrail(opts);
    return { entries, count: entries.length };
  }

  private buildCsvForSpec(
    spec: ExportSpec,
    canonicalNames: Map<string, string>
  ): {
    tableName: string;
    tabName: string;
    csvFilename: string;
    rowCount: number;
    content: string;
  } {
    const rawRows = this.db.fetchDataset(spec.tableName);
    const seenIds = new Set<string>();
    const lines: string[] = [spec.columns.map(csvEscape).join(",")];
    let count = 0;

    for (const row of rawRows) {
      const rowId = String(row[spec.idColumn] ?? "");
      if (!rowId || seenIds.has(rowId)) continue;
      seenIds.add(rowId);

      const enrichedRow: Record<string, unknown> = { ...row };
      if (spec.tableName === "startups" || spec.tableName === "products") {
        const cid = String(row.canonical_entity_id ?? "").trim();
        enrichedRow.canonical_entity_name = cid ? canonicalNames.get(cid) ?? "" : "";
      } else if (spec.tableName === "jobs") {
        const cid = String(row.canonical_company_id ?? "").trim();
        enrichedRow.canonical_company_name = cid ? canonicalNames.get(cid) ?? "" : "";
      }

      const cells = spec.columns.map((col) => csvEscape(formatExportCell(col, enrichedRow, false)));
      lines.push(cells.join(","));
      count++;
    }

    return {
      tableName: spec.tableName,
      tabName: spec.tabName,
      csvFilename: spec.csvFilename,
      rowCount: count,
      content: `${lines.join("\n")}\n`,
    };
  }

  public buildAllCsvDatasets(): {
    datasets: Array<{
      tableName: string;
      tabName: string;
      csvFilename: string;
      rowCount: number;
      byteSize: number;
      content: string;
    }>;
    rowCounts: Record<string, number>;
    totalRows: number;
  } {
    const canonicalNames = this.db.fetchCanonicalNameMap();
    const datasets: Array<{
      tableName: string;
      tabName: string;
      csvFilename: string;
      rowCount: number;
      byteSize: number;
      content: string;
    }> = [];
    const rowCounts: Record<string, number> = {};
    let totalRows = 0;

    for (const spec of EXPORT_SPECS) {
      const built = this.buildCsvForSpec(spec, canonicalNames);
      const byteSize = Buffer.byteLength(built.content, "utf-8");
      datasets.push({ ...built, byteSize });
      rowCounts[spec.tabName] = built.rowCount;
      totalRows += built.rowCount;
    }

    return { datasets, rowCounts, totalRows };
  }

  public exportSingleCsv(csvFilename: string): {
    tableName: string;
    tabName: string;
    csvFilename: string;
    rowCount: number;
    filePath: string;
    content: string;
  } {
    const spec = EXPORT_SPECS.find((s) => s.csvFilename === csvFilename);
    if (!spec) {
      throw new Error(`Unsupported CSV filename: ${csvFilename}`);
    }
    const canonicalNames = this.db.fetchCanonicalNameMap();
    const built = this.buildCsvForSpec(spec, canonicalNames);
    fs.mkdirSync(this.config.exportsDir, { recursive: true });
    const targetFile = path.resolve(this.config.exportsDir, spec.csvFilename);
    fs.writeFileSync(targetFile, built.content, "utf-8");
    return {
      ...built,
      filePath: targetFile,
    };
  }

  public exportAllCsv(): {
    outputDir: string;
    rowCounts: Record<string, number>;
    files: Record<string, string>;
    totalRows: number;
    datasets: Array<{
      tableName: string;
      tabName: string;
      filename: string;
      rowCount: number;
      byteSize: number;
      downloadUrl: string;
    }>;
  } {
    fs.mkdirSync(this.config.exportsDir, { recursive: true });
    const built = this.buildAllCsvDatasets();
    const files: Record<string, string> = {};
    const datasetSummaries: Array<{
      tableName: string;
      tabName: string;
      filename: string;
      rowCount: number;
      byteSize: number;
      downloadUrl: string;
    }> = [];

    for (const ds of built.datasets) {
      const targetFile = path.resolve(this.config.exportsDir, ds.csvFilename);
      fs.writeFileSync(targetFile, ds.content, "utf-8");
      files[ds.tabName] = targetFile;
      datasetSummaries.push({
        tableName: ds.tableName,
        tabName: ds.tabName,
        filename: ds.csvFilename,
        rowCount: ds.rowCount,
        byteSize: ds.byteSize,
        downloadUrl: `/api/atlas/download/csv/${ds.csvFilename}`,
      });
    }

    return {
      outputDir: this.config.exportsDir,
      rowCounts: built.rowCounts,
      files,
      totalRows: built.totalRows,
      datasets: datasetSummaries,
    };
  }

  public buildCsvZipBundle(): {
    filename: string;
    buffer: Buffer;
    rowCounts: Record<string, number>;
    fileSizes: Record<string, number>;
    totalRows: number;
  } {
    fs.mkdirSync(this.config.exportsDir, { recursive: true });
    const built = this.buildAllCsvDatasets();
    const fileSizes: Record<string, number> = {};
    const modifiedAt = new Date();

    const entries = built.datasets.map((ds) => {
      const targetFile = path.resolve(this.config.exportsDir, ds.csvFilename);
      fs.writeFileSync(targetFile, ds.content, "utf-8");
      fileSizes[ds.csvFilename] = ds.byteSize;
      return {
        filename: ds.csvFilename,
        content: ds.content,
        modifiedAt,
      };
    });

    const buffer = createZipArchive(entries);
    return {
      filename: "frontier-atlas-datasets.zip",
      buffer,
      rowCounts: built.rowCounts,
      fileSizes,
      totalRows: built.totalRows,
    };
  }

  private syncSheetsHealthFromStatus(st: {
    status: "Connected" | "Not Connected" | "Sync Failed";
    credentialSource: "oauth" | "path" | "json_env" | null;
    verifiedAccountEmail?: string | null;
    spreadsheetId: string | null;
    lastError: string | null;
  }): void {
    if (!this.latestHealth) return;
    const mappedStatus: IntegrationConnectionStatus =
      st.status === "Connected"
        ? "Configured"
        : st.status === "Sync Failed"
        ? "Connection Failed"
        : "Not Configured";
    const srcLabel = st.credentialSource === "oauth" ? "Google OAuth" : "Service Account";
    const detail =
      mappedStatus === "Configured"
        ? st.spreadsheetId
          ? `Verified live ${srcLabel}${st.verifiedAccountEmail ? ` (${st.verifiedAccountEmail})` : ""} access to spreadsheet ${st.spreadsheetId}.`
          : `Verified live ${srcLabel}${st.verifiedAccountEmail ? ` (${st.verifiedAccountEmail})` : ""} Drive (drive.file) & Sheets readiness.`
        : mappedStatus === "Connection Failed"
        ? st.lastError || "Google Workspace verification failed."
        : "No active Google OAuth token or Service Account credentials. Click 'Sign in with Google' to authorize Drive (drive.file) & Sheets.";
    const checkedAt = new Date().toISOString();
    const updatedItem: IntegrationHealthItem = {
      id: "google_sheets",
      label: "Google Sheets & Drive OAuth",
      envKey: "Workspace OAuth (drive.file, spreadsheets)",
      status: mappedStatus,
      detail,
      error: mappedStatus === "Connection Failed" ? st.lastError || detail : null,
      latencyMs: null,
      checkedAt,
      tested: true,
    };
    this.latestHealth = {
      checkedAt: this.latestHealth.checkedAt ?? checkedAt,
      items: this.latestHealth.items.map((item) => (item.id === "google_sheets" ? updatedItem : item)),
      byId: { ...this.latestHealth.byId, google_sheets: updatedItem },
    };
  }

  public async exportGoogleSheets(opts?: {
    oauthAccessToken?: string | null;
    spreadsheetId?: string | null;
    createNew?: boolean;
  }): Promise<SheetsSyncResult> {
    const res = await this.sheets.exportOrSync("full", opts);
    this.syncSheetsHealthFromStatus(this.sheets.getStatus());
    return res;
  }

  public async syncGoogleSheets(opts?: {
    oauthAccessToken?: string | null;
    spreadsheetId?: string | null;
    createNew?: boolean;
  }): Promise<SheetsSyncResult> {
    const res = await this.sheets.exportOrSync("incremental", opts);
    this.syncSheetsHealthFromStatus(this.sheets.getStatus());
    return res;
  }

  public async verifyGoogleSheetsConnection(opts?: {
    oauthAccessToken?: string | null;
    spreadsheetId?: string | null;
    createNew?: boolean;
  }): Promise<SheetsConnectionStatus> {
    const res = await this.sheets.verifyConnection(opts);
    this.syncSheetsHealthFromStatus(res);
    return res;
  }

  public startBackgroundRun(opts: {
    triggerType?: "manual" | "scheduled" | "daily_24h";
    mode?: "full" | "daily_24h";
    categories: string[];
    limit: number;
    page: number;
    includeAllFresh24h?: boolean;
    skipAutoSheetsSync?: boolean;
  }): { started: boolean; conflict: boolean; run: ActiveRunStateSnapshot } {
    if (this.runInFlight) {
      return { started: false, conflict: true, run: this.getActiveRunState() };
    }
    const triggerType = opts.triggerType ?? "manual";
    const mode = opts.mode ?? "full";
    const runId = `run_${Date.now()}`;
    const startedAt = new Date().toISOString();

    this.activeRunState = {
      id: runId,
      triggerType,
      mode,
      status: "running",
      categories: opts.categories,
      limit: opts.limit,
      page: opts.page,
      startedAt,
      finishedAt: null,
      logs: [
        `Starting ${mode === "daily_24h" ? "24h fresh" : "pipeline"} collection (${triggerType}) for: ${opts.categories.join(", ")} (limit=${opts.limit}/category, page=${opts.page})`,
      ],
      result: null,
      error: null,
    };

    const appendLog = (line: string) => {
      this.activeRunState.logs = [...this.activeRunState.logs, line].slice(-80);
    };

    void this.runPipeline({
      runId,
      triggerType,
      mode,
      categories: opts.categories,
      limit: opts.limit,
      page: opts.page,
      includeAllFresh24h: opts.includeAllFresh24h,
      skipAutoSheetsSync: opts.skipAutoSheetsSync,
      onLog: appendLog,
    })
      .then((result) => {
        const finalStatus =
          (result.runStatus as ActiveRunStateSnapshot["status"] | undefined) ?? "completed";
        this.activeRunState.finishedAt = new Date().toISOString();
        this.activeRunState.result = result;
        this.activeRunState.status = finalStatus;
        const syncNote =
          result && typeof result === "object" && "sheetsSync" in result && result.sheetsSync
            ? (result.sheetsSync as { success?: boolean; error?: string | null }).success
              ? " Google Sheets incremental sync succeeded."
              : ` Google Sheets sync failed: ${(result.sheetsSync as { error?: string | null }).error ?? "unknown error"}`
            : "";
        appendLog(`Pipeline run ${finalStatus} and persisted to SQLite + CSV.${syncNote}`);
      })
      .catch((err) => {
        this.activeRunState.finishedAt = new Date().toISOString();
        this.activeRunState.status = "failed";
        this.activeRunState.error = err instanceof Error ? err.message : String(err);
        appendLog(`Pipeline run failed: ${this.activeRunState.error}`);
      });

    return { started: true, conflict: false, run: this.getActiveRunState() };
  }

  public async runPipeline(opts: {
    runId?: string;
    triggerType?: "manual" | "scheduled" | "daily_24h";
    mode?: "full" | "daily_24h";
    categories: string[];
    limit: number;
    page: number;
    includeAllFresh24h?: boolean;
    skipAutoSheetsSync?: boolean;
    collectorsOverride?: Partial<
      Record<
        "startups" | "products" | "research_papers" | "jobs" | "news",
        (limit: number, page: number) => Promise<CollectionBatchResult>
      >
    >;
    onLog?: (msg: string) => void;
  }): Promise<Record<string, unknown>> {
    if (this.runInFlight) {
      throw new Error("A pipeline collection run is already in progress.");
    }

    let releaseLock!: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    this.runInFlight = lockPromise;

    const execute = async (): Promise<Record<string, unknown>> => {
      const log = opts.onLog ?? (() => {});
      const runId = opts.runId || `run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const triggerType = opts.triggerType ?? "manual";
      const mode = opts.mode ?? "full";
      const safePage = Math.max(1, opts.page);
      const limit = Math.max(1, opts.limit);
      const keepAllFresh24h = Boolean(opts.includeAllFresh24h || mode === "daily_24h");
      const startedAt = new Date().toISOString();
      const initialHistorical = this.db.countRecords();
      const initialFresh24h = this.db.countFresh24h(this.config.freshnessWindowHours);

      this.db.createPipelineRun({
        runId,
        triggerType,
        mode,
        categories: opts.categories,
        startedAt,
        historicalCounts: initialHistorical,
        fresh24hCounts: initialFresh24h,
      });

      const verifier = new LiveSourceVerifier(this.config, this.http);
      const existingEntities = this.db.fetchDataset("canonical_entities") as unknown as CanonicalEntityRow[];
      const resolver = new EntityResolver(existingEntities);

      const categoryQuality: Record<string, unknown> = {};
      const unavailableSources: string[] = [];
      const collectorErrors: Array<Record<string, unknown>> = [];
      const allSourceOutcomes: SourceOutcomeRecord[] = [];
      let totalPersistedThisRun = 0;
      const overallVerSummary: Record<VerificationStatus, number> = {
        Verified: 0,
        "Partially Verified": 0,
        Unverified: 0,
        "Source Unavailable": 0,
        Rejected: 0,
      };

      try {
        for (const cat of opts.categories) {
          log(`[${cat}] Collecting page ${safePage} (limit=${limit}, mode=${mode})...`);
          let batch: CollectionBatchResult;
          try {
            const overrideFn = opts.collectorsOverride?.[cat as keyof NonNullable<typeof opts.collectorsOverride>];
            if (overrideFn) batch = await overrideFn(limit, safePage);
            else if (cat === "startups") batch = await collectStartups(this.config, this.http, this.llmRouter, verifier, limit, safePage, log);
            else if (cat === "products") batch = await collectProducts(this.config, this.http, verifier, limit, safePage);
            else if (cat === "research_papers") batch = await collectResearchPapers(this.config, this.http, verifier, limit, safePage);
            else if (cat === "jobs") batch = await collectJobs(this.config, this.http, verifier, limit, safePage);
            else if (cat === "news") batch = await collectNews(this.config, this.http, verifier, limit, safePage);
            else continue;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.db.recordFailure({ stage: "collect", category: cat, reason: msg });
            unavailableSources.push(`${cat}:collector_error`);
            collectorErrors.push({ category: cat, source: cat, error: msg });
            allSourceOutcomes.push({
              category: cat,
              source: cat,
              url: "",
              status: "failed",
              discoveredCount: 0,
              retried: false,
              attempts: 1,
              error: msg,
            });
            log(`[${cat}] Collector error: ${msg}`);
            continue;
          }

          if (Array.isArray(batch.sourceOutcomes)) {
            allSourceOutcomes.push(...batch.sourceOutcomes);
          }

          for (const err of batch.errors) {
            unavailableSources.push(err.source);
            collectorErrors.push({ category: cat, ...err });
            this.db.recordFailure({
              stage: "collect",
              category: cat,
              sourceUrl: err.url,
              reason: err.error,
              payload: err,
            });
          }

          let working = batch.records;
          let rejectedCount = 0;
          const rejectionSamples: string[] = [];
          let freshnessStats: Record<string, unknown> | null = null;
          const refNow = new Date();

          if (cat === "jobs" || cat === "news") {
            const dateField = cat === "jobs" ? "posted_at" : "published_at";
            const accepted: RawRecord[] = [];
            let rejectedOlder = 0;
            let rejectedMissing = 0;
            let rejectedFuture = 0;

            for (const rec of working) {
              const dt = parseUtcDatetime(rec[dateField], refNow);
              const fresh = isWithinFreshnessWindow(dt, refNow, this.config.freshnessWindowHours);
              if (fresh.ok) {
                accepted.push(rec);
              } else {
                rejectedCount++;
                if (fresh.reason === "missing_published_at") rejectedMissing++;
                else if (fresh.reason === "future_publication_date") rejectedFuture++;
                else rejectedOlder++;
                if (rejectionSamples.length < 5) rejectionSamples.push(fresh.reason);
                // Record invalid/future date anomalies cleanly without treating normal historical items as failures
                if (fresh.reason === "future_publication_date" || fresh.reason === "missing_published_at") {
                  this.db.recordFailure({
                    stage: "freshness",
                    category: cat,
                    sourceUrl: (rec.source_url as string | null) ?? null,
                    reason: fresh.reason,
                    payload: rec,
                  });
                }
              }
            }
            freshnessStats = {
              window_hours: this.config.freshnessWindowHours,
              evaluated: working.length,
              accepted: accepted.length,
              rejected_older: rejectedOlder,
              rejected_missing_date: rejectedMissing,
              rejected_future_date: rejectedFuture,
            };
            working = keepAllFresh24h ? accepted : accepted.slice(0, limit);
          } else if (cat === "research_papers") {
            let accepted = 0;
            let older = 0;
            let missing = 0;
            let future = 0;
            for (const rec of working) {
              const dt = parseUtcDatetime(rec.published_at ?? rec.publication_date, refNow);
              const fresh = isWithinFreshnessWindow(dt, refNow, this.config.freshnessWindowHours);
              if (fresh.ok) accepted++;
              else if (fresh.reason === "missing_published_at") missing++;
              else if (fresh.reason === "future_publication_date") future++;
              else older++;
            }
            freshnessStats = {
              window_hours: this.config.freshnessWindowHours,
              evaluated: working.length,
              accepted,
              rejected_older: older,
              rejected_missing_date: missing,
              rejected_future_date: future,
            };
          }

          // Assign deterministic IDs & deduplicate
          const seenKeys = new Set<string>();
          const uniqueRecords: RawRecord[] = [];
          let duplicates = 0;
          const missingFields: Record<string, number> = {};
          const sourceDistribution: Record<string, number> = {};

          for (const rec of working) {
            let id = "";
            let dedupKey = "";
            if (cat === "startups") {
              const key = String(rec.website || rec.source_url);
              id = makeStableId("stp", String(rec.name), key);
              dedupKey = `${String(rec.name).toLowerCase()}|${String(rec.source_url).toLowerCase()}`;
              rec.startup_id = id;
            } else if (cat === "products") {
              const key = String(rec.website || rec.source_url);
              const compKey = rec.company_name === "Unknown" ? null : String(rec.company_name);
              id = makeStableId("prd", String(rec.name), compKey, key);
              dedupKey = `${String(rec.name).toLowerCase()}|${String(rec.source_url).toLowerCase()}`;
              rec.product_id = id;
            } else if (cat === "research_papers") {
              const identity = String(rec.doi || rec.arxiv_id || rec.source_url);
              id = makeStableId("pap", identity, String(rec.title));
              dedupKey = String(rec.source_url).toLowerCase();
              rec.paper_id = id;
            } else if (cat === "jobs") {
              id = makeStableId("job", String(rec.application_url), String(rec.title), String(rec.company));
              dedupKey = String(rec.application_url).toLowerCase();
              rec.job_id = id;
            } else if (cat === "news") {
              id = makeStableId("nws", String(rec.article_url));
              dedupKey = String(rec.article_url).toLowerCase();
              rec.news_id = id;
            }

            if (seenKeys.has(dedupKey)) {
              duplicates++;
              continue;
            }
            seenKeys.add(dedupKey);
            uniqueRecords.push(rec);
            const srcName = String(rec.source_name ?? rec.publisher ?? "unknown");
            sourceDistribution[srcName] = (sourceDistribution[srcName] ?? 0) + 1;

            const tracked =
              cat === "startups"
                ? ["description", "website", "industry", "location", "founding_date"]
                : cat === "products"
                ? ["description", "website", "category", "company_name"]
                : cat === "research_papers"
                ? ["abstract", "authors", "publication_date", "doi", "arxiv_id", "github_repository", "github_stars"]
                : cat === "jobs"
                ? ["location", "employment_type", "description"]
                : ["summary", "category"];
            for (const f of tracked) {
              const val = rec[f];
              if (
                val === null ||
                val === undefined ||
                val === "" ||
                (Array.isArray(val) && val.length === 0) ||
                (typeof val === "string" && val.trim().toLowerCase() === "unknown")
              ) {
                missingFields[f] = (missingFields[f] ?? 0) + 1;
              }
            }
          }

          const bulkSnapshotOnly = uniqueRecords.length >= 20;
          log(
            `[${cat}] Verifying ${uniqueRecords.length} records against live ${
              bulkSnapshotOnly ? "API/feed snapshots" : "source URLs & websites"
            }...`
          );
          const checkedAtIso = new Date().toISOString();
          const verified = await mapConcurrent(uniqueRecords, this.config.maxConcurrency, (rec) =>
            verifier.verifyRecord(
              cat as "startups" | "products" | "research_papers" | "jobs" | "news",
              rec,
              { liveCheck: !opts.collectorsOverride, bulkSnapshotOnly, checkedAtIso }
            )
          );

          // Entity resolution
          for (const rec of verified) {
            if (cat === "startups") {
              rec.canonical_entity_id = resolver.resolve({
                rawName: String(rec.name),
                entityType: "startup",
                website: (rec.website as string | null) ?? null,
                sourceUrl: String(rec.source_url),
              });
            } else if (cat === "products") {
              rec.canonical_entity_id = resolver.resolve({
                rawName: String(rec.name),
                entityType: "product",
                website: (rec.website as string | null) ?? null,
                sourceUrl: String(rec.source_url),
              });
              if (rec.company_name && rec.company_name !== "Unknown") {
                resolver.resolve({
                  rawName: String(rec.company_name),
                  entityType: "company",
                  website: null,
                  sourceUrl: String(rec.source_url),
                });
              }
            } else if (cat === "jobs" && rec.company && rec.company !== "Unknown") {
              rec.canonical_company_id = resolver.resolve({
                rawName: String(rec.company),
                entityType: "company",
                website: null,
                sourceUrl: String(rec.source_url),
              });
            } else if (cat === "news" && rec.publisher && rec.publisher !== "Unknown") {
              resolver.resolve({
                rawName: String(rec.publisher),
                entityType: "publisher",
                website: (rec.official_website as string | null) ?? null,
                sourceUrl: String(rec.article_url || rec.source_url),
              });
            }
          }

          // Persist category records
          if (cat === "startups") this.db.upsertStartups(verified as unknown as StartupInput[]);
          else if (cat === "products") this.db.upsertProducts(verified as unknown as ProductInput[]);
          else if (cat === "research_papers") this.db.upsertResearchPapers(verified as unknown as ResearchPaperInput[]);
          else if (cat === "jobs") this.db.upsertJobs(verified as unknown as JobInput[]);
          else if (cat === "news") this.db.upsertNews(verified as unknown as NewsInput[]);
          totalPersistedThisRun += verified.length;

          const verBreakdown: Record<VerificationStatus, number> = {
            Verified: 0,
            "Partially Verified": 0,
            Unverified: 0,
            "Source Unavailable": 0,
            Rejected: 0,
          };
          const auditEntries: AuditEntryInput[] = [];
          for (const rec of verified) {
            const st = rec.verification_status as VerificationStatus;
            verBreakdown[st] = (verBreakdown[st] ?? 0) + 1;
            overallVerSummary[st] = (overallVerSummary[st] ?? 0) + 1;
            const meta = (rec.source_metadata as Record<string, unknown>) || {};
            const idCol =
              cat === "startups"
                ? "startup_id"
                : cat === "products"
                ? "product_id"
                : cat === "research_papers"
                ? "paper_id"
                : cat === "jobs"
                ? "job_id"
                : "news_id";
            const nameCol =
              cat === "research_papers" ? "title" : cat === "jobs" ? "title" : cat === "news" ? "headline" : "name";
            const supported = (rec.supported_fields as string[]) || [];
            const issues = (meta.audit_issues as string[]) || [];
            const reasonParts = [`Verified status assessed as '${st}'`];
            if (supported.length > 0) reasonParts.push(`supported fields: ${supported.join(", ")}`);
            if (issues.length > 0) reasonParts.push(`detected issues: ${issues.join(", ")}`);
            if (rec.rejection_reason) reasonParts.push(`reason: ${String(rec.rejection_reason)}`);

            auditEntries.push({
              category: cat,
              record_id: String(rec[idCol]),
              record_name: String(rec[nameCol] ?? ""),
              previous_status: null,
              new_status: st,
              issues,
              source_url: String(rec.source_url),
              source_title: (rec.source_title as string | null) ?? null,
              evidence_excerpt: (meta.source_evidence_excerpt as string | null) ?? null,
              reason: reasonParts.join("; "),
              checked_at: checkedAtIso,
            });
          }
          this.db.recordAuditEntries(auditEntries);

          const nextCursor = batch.hasMore ? `page:${safePage + 1}` : `page:${safePage}`;
          this.db.saveCheckpoint(`pipeline:${cat}`, cat, nextCursor, verified.length);

          const persistedCounts = this.db.countRecords();
          const persistedTotal = persistedCounts[cat] ?? 0;
          const uniqueQualified = this.db.countUniqueQualifiedRecords();
          const uniqueTotal =
            cat === "startups" || cat === "products" || cat === "research_papers"
              ? uniqueQualified[cat]
              : persistedTotal;
          const targetMin =
            cat === "startups"
              ? this.config.targetStartups
              : cat === "products"
              ? this.config.targetProducts
              : cat === "research_papers"
              ? this.config.targetResearchPapers
              : null;

          categoryQuality[cat] = {
            discovered: batch.records.length,
            extracted: batch.records.length,
            validated: working.length,
            rejected: rejectedCount,
            duplicates,
            persisted_total: persistedTotal,
            unique_qualified_total: uniqueTotal,
            target_minimum: targetMin,
            target_met: targetMin !== null ? uniqueTotal >= targetMin : null,
            verification_breakdown: verBreakdown,
            missing_fields: missingFields,
            source_distribution: sourceDistribution,
            freshness: freshnessStats,
            sample_rejection_reasons: rejectionSamples,
          };
          log(`[${cat}] Persisted ${verified.length} records (total in DB: ${persistedTotal}).`);
        }

        this.db.upsertCanonicalEntities(resolver.getEntities());
        this.db.upsertEntityMappingLogs(resolver.getLogs());

        const qualityReport = this.writeSyncedQualityReport(categoryQuality, unavailableSources);

        const csvSummary = this.exportAllCsv();
        this.db.checkpointWal("PASSIVE");
        log("Refreshed CSV exports across all 6 datasets and checkpointed SQLite WAL.");

        let sheetsSync: SheetsSyncResult | null = null;
        if (!opts.skipAutoSheetsSync && this.sheets.isConfigured()) {
          log("Synchronizing collected records to Google Sheets (incremental mode)...");
          sheetsSync = await this.sheets.exportOrSync("incremental");
          if (sheetsSync.success) {
            log(
              `Google Sheets synced (+${sheetsSync.rowsAdded} added, ${sheetsSync.rowsUpdated} updated, ${sheetsSync.rowsUnchanged} unchanged).`
            );
          } else {
            log(`Google Sheets sync failed: ${sheetsSync.error ?? "unknown error"}`);
          }
        }

        const finalHistorical = this.db.countRecords();
        const finalFresh24h = this.db.countFresh24h(this.config.freshnessWindowHours);
        const newRecordsCounts: Record<string, number> = {};
        for (const k of ["startups", "products", "research_papers", "jobs", "news", "entity_mapping_log"]) {
          newRecordsCounts[k] = Math.max(0, (finalHistorical[k] ?? 0) - (initialHistorical[k] ?? 0));
        }
        const totalNewInserted = Object.values(newRecordsCounts).reduce((s, n) => s + n, 0);
        const failedOutcomes = allSourceOutcomes.filter((s) => s.status === "failed");
        const okOrEmptyOutcomes = allSourceOutcomes.filter((s) => s.status !== "failed");
        const hasErrors = failedOutcomes.length > 0 || collectorErrors.length > 0 || Boolean(sheetsSync && !sheetsSync.success);
        const allSourcesFailed =
          allSourceOutcomes.length > 0 && okOrEmptyOutcomes.length === 0 && totalPersistedThisRun === 0;
        const runStatus: "completed" | "partial" | "failed" = allSourcesFailed
          ? "failed"
          : hasErrors
          ? "partial"
          : "completed";
        const completedAt = new Date().toISOString();
        const summaryText =
          runStatus === "completed"
            ? `Completed cleanly (${totalNewInserted} new, ${totalPersistedThisRun} processed across ${opts.categories.length} dataset(s)).`
            : runStatus === "partial"
            ? `Partial collection (${totalNewInserted} new, ${totalPersistedThisRun} processed; ${failedOutcomes.length} source error(s)).`
            : `Collection failed (${collectorErrors.length} error(s)); historical DB records preserved.`;

        this.db.completePipelineRun({
          runId,
          completedAt,
          status: runStatus,
          historicalCounts: finalHistorical,
          newRecordsCounts,
          fresh24hCounts: finalFresh24h,
          errors: collectorErrors,
          sourceOutcomes: allSourceOutcomes,
          summary: summaryText,
        });

        const sched = this.ensureSchedulerInitialized();
        this.db.saveSchedulerState({
          ...sched,
          last_run_at: completedAt,
          last_success_at: runStatus === "completed" ? completedAt : sched.last_success_at,
          updated_at: completedAt,
        });

        return {
          runId,
          runStatus,
          databaseCounts: finalHistorical,
          newRecordsCounts,
          freshCounts24h: finalFresh24h,
          verificationCounts: this.db.getVerificationCounts(),
          collectorErrors,
          sourceOutcomes: allSourceOutcomes,
          qualityReport,
          csvExportDir: csvSummary.outputDir,
          sheetsSync,
        };
      } catch (fatalErr) {
        const msg = fatalErr instanceof Error ? fatalErr.message : String(fatalErr);
        const completedAt = new Date().toISOString();
        this.db.completePipelineRun({
          runId,
          completedAt,
          status: "failed",
          historicalCounts: this.db.countRecords(),
          fresh24hCounts: this.db.countFresh24h(this.config.freshnessWindowHours),
          errors: [...collectorErrors, { source: "pipeline", error: msg }],
          sourceOutcomes: allSourceOutcomes,
          summary: `Fatal error: ${msg}`,
        });
        throw fatalErr;
      }
    };

    try {
      return await execute();
    } finally {
      if (this.runInFlight === lockPromise) {
        this.runInFlight = null;
      }
      releaseLock();
    }
  }

  public async auditExisting(opts: {
    categories: string[];
    liveCheck: boolean;
    removeDuplicates?: boolean;
  }): Promise<Record<string, unknown>> {
    const verifier = new LiveSourceVerifier(this.config, this.http);
    const auditedCategories: Record<string, Record<VerificationStatus, number>> = {};
    const auditEntries: AuditEntryInput[] = [];
    let totalDuplicatesRemoved = 0;
    const checkedAtIso = new Date().toISOString();

    for (const cat of opts.categories) {
      if (cat === "entity_mapping_log") {
        const rows = this.db.fetchDataset("entity_mapping_log");
        const canonicalIds = new Set(
          this.db.fetchDataset("canonical_entities").map((r) => String(r.canonical_id ?? ""))
        );
        const seen = new Set<string>();
        const dupIds: string[] = [];
        const summary: Record<VerificationStatus, number> = {
          Verified: 0,
          "Partially Verified": 0,
          Unverified: 0,
          "Source Unavailable": 0,
          Rejected: 0,
        };
        for (const r of rows) {
          const mapId = String(r.mapping_id ?? "");
          const rawName = String(r.raw_name ?? "").trim();
          const canonicalId = String(r.canonical_id ?? "").trim();
          const srcUrl = String(r.source_url ?? "").trim();
          const entityType = String(r.entity_type ?? "company").trim().toLowerCase();
          const key = `${rawName.toLowerCase()}|${canonicalId}|${srcUrl}|${entityType}`;
          const issues: string[] = [];
          if (seen.has(key)) {
            issues.push("duplicate_mapping");
            dupIds.push(mapId);
          } else {
            seen.add(key);
          }
          if (canonicalIds.size > 0 && !canonicalIds.has(canonicalId)) {
            issues.push("missing_canonical_entity");
          }
          if (issues.includes("duplicate_mapping")) {
            summary.Rejected++;
          } else if (issues.length > 0) {
            summary["Partially Verified"]++;
          } else if (!opts.liveCheck) {
            summary.Unverified++;
          } else {
            summary.Verified++;
          }
        }
        if (opts.removeDuplicates && dupIds.length > 0) {
          totalDuplicatesRemoved += this.db.deleteRecords("entity_mapping_log", dupIds);
        }
        auditedCategories.entity_mapping_log = summary;
        continue;
      }

      if (!["startups", "products", "research_papers", "jobs", "news"].includes(cat)) continue;
      const rawRows = this.db.fetchDataset(cat);
      const idCol =
        cat === "startups"
          ? "startup_id"
          : cat === "products"
          ? "product_id"
          : cat === "research_papers"
          ? "paper_id"
          : cat === "jobs"
          ? "job_id"
          : "news_id";
      const nameCol =
        cat === "research_papers" ? "title" : cat === "jobs" ? "title" : cat === "news" ? "headline" : "name";

      const prevStatusById = new Map<string, string | null>();
      const parsedRows: RawRecord[] = rawRows.map((row) => {
        const rec: RawRecord = { ...row };
        prevStatusById.set(String(row[idCol]), (row.verification_status as string | null) ?? null);
        if (typeof row.authors_json === "string") {
          try {
            rec.authors = JSON.parse(row.authors_json);
          } catch {
            rec.authors = [];
          }
        }
        if (typeof row.supported_fields_json === "string") {
          try {
            rec.supported_fields = JSON.parse(row.supported_fields_json);
          } catch {
            rec.supported_fields = [];
          }
        }
        if (typeof row.source_metadata_json === "string") {
          try {
            rec.source_metadata = JSON.parse(row.source_metadata_json);
          } catch {
            rec.source_metadata = {};
          }
        }
        return rec;
      });

      // Pre-seed unique authoritative API snapshots (api_url) concurrently when liveCheck is enabled
      // so bulk audits verify against genuine live API responses without N-fold redundant list fetches.
      if (opts.liveCheck) {
        const apiUrls = new Set<string>();
        if (cat === "startups" && parsedRows.some((r) => r.source_name === "yc_oss_directory")) {
          apiUrls.add("https://yc-oss.github.io/api/companies/all.json");
        }
        for (const rec of parsedRows) {
          const meta = (rec.source_metadata as Record<string, unknown>) || {};
          if (typeof meta.api_url === "string" && isValidHttpUrl(meta.api_url)) {
            apiUrls.add(meta.api_url);
          }
        }
        const uniqueApiList = Array.from(apiUrls).slice(0, 40);
        await mapConcurrent(uniqueApiList, 6, async (apiUrl) => {
          const res = await this.http.fetch(apiUrl, { timeoutMs: Math.max(this.config.requestTimeoutMs, 25000), maxAttempts: 2 });
          if (res.ok && res.content) {
            verifier.seedSnapshot(apiUrl, res.status, res.content, res.contentType);
          }
        });
      }

      // Backfill GitHub star metrics_updated_at & stars for research_papers with github_repository
      if (opts.liveCheck && cat === "research_papers") {
        const ghHeaders: Record<string, string> = {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        };
        if (this.config.githubToken) ghHeaders.Authorization = `Bearer ${this.config.githubToken}`;
        const slugToPapers = new Map<string, RawRecord[]>();
        for (const rec of parsedRows) {
          if (!rec.github_repository) continue;
          const slug = extractGithubRepoSlug(String(rec.github_repository));
          if (!slug) continue;
          const meta = (rec.source_metadata as Record<string, unknown>) || {};
          const existingGh = meta.github_metrics as Record<string, unknown> | undefined;
          if (!existingGh?.metrics_updated_at || rec.github_stars === null || rec.github_stars === undefined) {
            const list = slugToPapers.get(slug) ?? [];
            list.push(rec);
            slugToPapers.set(slug, list);
          }
        }
        const maxBackfillSlugs = this.config.githubToken ? 120 : 40;
        const slugsToQuery = Array.from(slugToPapers.keys()).slice(0, maxBackfillSlugs);
        let rateLimited = false;
        await mapConcurrent(slugsToQuery, 4, async (slug) => {
          const ts = new Date().toISOString();
          if (rateLimited) {
            for (const rec of slugToPapers.get(slug) ?? []) {
              const meta = (rec.source_metadata as Record<string, unknown>) || {};
              meta.github_metrics = {
                stars: rec.github_stars ?? null,
                metrics_status: rec.github_stars !== null ? "cached_rate_limited" : "rate_limited",
                authenticated: Boolean(this.config.githubToken),
                metrics_updated_at: ts,
              };
              rec.source_metadata = meta;
            }
            return;
          }
          const ghRes = await this.http.fetch(`https://api.github.com/repos/${slug}`, {
            headers: ghHeaders,
            timeoutMs: 8000,
            maxAttempts: 1,
          });
          const rlRemaining = ghRes.headers["x-ratelimit-remaining"] ?? null;
          const rlLimit = ghRes.headers["x-ratelimit-limit"] ?? null;
          const rlResetRaw = ghRes.headers["x-ratelimit-reset"];
          const rlResetIso =
            rlResetRaw && /^\d+$/.test(rlResetRaw.trim()) ? new Date(Number(rlResetRaw) * 1000).toISOString() : null;

          if (ghRes.status === 403 || ghRes.status === 429) {
            rateLimited = true;
            for (const rec of slugToPapers.get(slug) ?? []) {
              const meta = (rec.source_metadata as Record<string, unknown>) || {};
              meta.github_metrics = {
                stars: rec.github_stars ?? null,
                metrics_status: rec.github_stars !== null ? `cached_hf_rate_limited_${ghRes.status}` : `rate_limited_http_${ghRes.status}`,
                rate_limit_remaining: rlRemaining !== null ? Number(rlRemaining) : 0,
                rate_limit_limit: rlLimit !== null ? Number(rlLimit) : null,
                rate_limit_reset_at: rlResetIso,
                authenticated: Boolean(this.config.githubToken),
                metrics_updated_at: ts,
              };
              rec.source_metadata = meta;
            }
            return;
          }
          if (ghRes.ok) {
            try {
              const ghJson = JSON.parse(ghRes.content) as Record<string, unknown>;
              const stars = typeof ghJson.stargazers_count === "number" ? ghJson.stargazers_count : null;
              const metrics = {
                stars,
                forks: typeof ghJson.forks_count === "number" ? ghJson.forks_count : null,
                open_issues: typeof ghJson.open_issues_count === "number" ? ghJson.open_issues_count : null,
                watchers: typeof ghJson.subscribers_count === "number" ? ghJson.subscribers_count : null,
                language: ghJson.language ?? null,
                updated_at: ghJson.updated_at ?? null,
                metrics_updated_at: ts,
                rate_limit_remaining: rlRemaining !== null ? Number(rlRemaining) : null,
                rate_limit_limit: rlLimit !== null ? Number(rlLimit) : null,
                rate_limit_reset_at: rlResetIso,
                authenticated: Boolean(this.config.githubToken),
                metrics_status: "verified_github_api",
              };
              for (const rec of slugToPapers.get(slug) ?? []) {
                if (stars !== null && stars >= 0) rec.github_stars = stars;
                const meta = (rec.source_metadata as Record<string, unknown>) || {};
                meta.github_metrics = metrics;
                rec.source_metadata = meta;
              }
            } catch {
              // Ignore parse failure
            }
          } else {
            for (const rec of slugToPapers.get(slug) ?? []) {
              const meta = (rec.source_metadata as Record<string, unknown>) || {};
              meta.github_metrics = {
                stars: rec.github_stars ?? null,
                metrics_status: redactSecrets(ghRes.error || `http_${ghRes.status || 0}`),
                rate_limit_remaining: rlRemaining !== null ? Number(rlRemaining) : null,
                rate_limit_reset_at: rlResetIso,
                authenticated: Boolean(this.config.githubToken),
                metrics_updated_at: ts,
              };
              rec.source_metadata = meta;
            }
          }
        });
        const queriedSet = new Set(slugsToQuery);
        for (const [slug, recs] of slugToPapers.entries()) {
          if (queriedSet.has(slug)) continue;
          for (const rec of recs) {
            const meta = (rec.source_metadata as Record<string, unknown>) || {};
            if (!meta.github_metrics) {
              meta.github_metrics = {
                stars: rec.github_stars ?? null,
                source: rec.source_name ?? "unknown",
                metrics_status: rec.github_stars !== null ? "cached_source_budget_cap" : "deferred_rate_budget",
                metrics_updated_at: checkedAtIso,
              };
              rec.source_metadata = meta;
            }
          }
        }
      }

      const verified = await mapConcurrent(parsedRows, this.config.maxConcurrency, (rec) => {
        const currentStatus = String(rec.verification_status ?? "Unverified");
        const meta = (rec.source_metadata as Record<string, unknown>) || {};
        const hasSeededApi =
          (typeof meta.api_url === "string" && isValidHttpUrl(meta.api_url)) ||
          (cat === "startups" && rec.source_name === "yc_oss_directory");
        const useBulkSnapshot =
          parsedRows.length > 200 && (hasSeededApi || currentStatus === "Verified");
        return verifier.verifyRecord(
          cat as "startups" | "products" | "research_papers" | "jobs" | "news",
          rec,
          { liveCheck: opts.liveCheck, bulkSnapshotOnly: useBulkSnapshot, checkedAtIso }
        );
      });

      if (cat === "startups") this.db.upsertStartups(verified as unknown as StartupInput[]);
      else if (cat === "products") this.db.upsertProducts(verified as unknown as ProductInput[]);
      else if (cat === "research_papers") this.db.upsertResearchPapers(verified as unknown as ResearchPaperInput[]);
      else if (cat === "jobs") this.db.upsertJobs(verified as unknown as JobInput[]);
      else if (cat === "news") this.db.upsertNews(verified as unknown as NewsInput[]);

      const summary: Record<VerificationStatus, number> = {
        Verified: 0,
        "Partially Verified": 0,
        Unverified: 0,
        "Source Unavailable": 0,
        Rejected: 0,
      };
      for (const rec of verified) {
        const rid = String(rec[idCol]);
        const prev = prevStatusById.get(rid) ?? null;
        const nextSt = rec.verification_status as VerificationStatus;
        summary[nextSt] = (summary[nextSt] ?? 0) + 1;
        const meta = (rec.source_metadata as Record<string, unknown>) || {};
        const issues = (meta.audit_issues as string[]) || [];
        const supported = (rec.supported_fields as string[]) || [];
        const reasonParts = [
          prev && prev !== nextSt
            ? `Status changed from '${prev}' to '${nextSt}'`
            : `Verified status assessed as '${nextSt}'`,
        ];
        if (supported.length > 0) reasonParts.push(`supported fields: ${supported.join(", ")}`);
        if (issues.length > 0) reasonParts.push(`detected issues: ${issues.join(", ")}`);
        if (rec.rejection_reason) reasonParts.push(`reason: ${String(rec.rejection_reason)}`);

        auditEntries.push({
          category: cat,
          record_id: rid,
          record_name: String(rec[nameCol] ?? ""),
          previous_status: prev,
          new_status: nextSt,
          issues,
          source_url: String(rec.source_url ?? ""),
          source_title: (rec.source_title as string | null) ?? null,
          evidence_excerpt: (meta.source_evidence_excerpt as string | null) ?? null,
          reason: reasonParts.join("; "),
          checked_at: checkedAtIso,
        });
      }
      auditedCategories[cat] = summary;
    }

    if (auditEntries.length > 0) {
      this.db.recordAuditEntries(auditEntries);
    }

    // Refresh quality_report.json summary counts from persisted SQLite tables
    this.writeSyncedQualityReport();

    this.exportAllCsv();
    this.db.checkpointWal("PASSIVE");

    return {
      auditedCategories,
      auditEntriesLogged: auditEntries.length,
      duplicatesRemoved: totalDuplicatesRemoved,
      databaseCounts: this.db.countRecords(),
      verificationCounts: this.db.getVerificationCounts(),
    };
  }

  public writeSyncedQualityReport(
    categoryOverrides: Record<string, unknown> = {},
    unavailableSourcesOverride?: string[]
  ): Record<string, unknown> {
    const qualityReportPath = path.resolve(this.config.dataDir, "quality_report.json");
    let prevReport: {
      categories?: Record<string, Record<string, unknown>>;
      unavailable_sources?: string[];
    } = {};
    if (fs.existsSync(qualityReportPath)) {
      try {
        prevReport = JSON.parse(fs.readFileSync(qualityReportPath, "utf-8")) as {
          categories?: Record<string, Record<string, unknown>>;
          unavailable_sources?: string[];
        };
      } catch {
        prevReport = {};
      }
    }

    const latestVer = this.db.getVerificationCounts();
    const counts = this.db.countRecords();
    const uniqueQualified = this.db.countUniqueQualifiedRecords();
    const targets: Record<string, number | null> = {
      startups: this.config.targetStartups,
      products: this.config.targetProducts,
      research_papers: this.config.targetResearchPapers,
      jobs: null,
      news: null,
    };

    const categories: Record<string, Record<string, unknown>> = {};
    for (const catName of ["startups", "products", "research_papers", "jobs", "news"]) {
      const existing =
        (prevReport.categories && typeof prevReport.categories[catName] === "object"
          ? { ...prevReport.categories[catName] }
          : {}) as Record<string, unknown>;
      const rawOverride = categoryOverrides[catName];
      const override =
        rawOverride && typeof rawOverride === "object"
          ? { ...(rawOverride as Record<string, unknown>) }
          : {};
      const persistedTotal = counts[catName] ?? 0;
      const uniqueTotal =
        catName === "startups" || catName === "products" || catName === "research_papers"
          ? uniqueQualified[catName]
          : persistedTotal;
      const targetMin = targets[catName] ?? null;
      categories[catName] = {
        ...existing,
        ...override,
        persisted_total: persistedTotal,
        unique_qualified_total: uniqueTotal,
        target_minimum: targetMin,
        target_met: targetMin !== null ? uniqueTotal >= targetMin : null,
        verification_breakdown: latestVer.byCategory[catName] ?? {},
      };
    }

    const emlRows = this.db.fetchDataset("entity_mapping_log");
    const entityResolution = {
      total_logged: emlRows.length,
      exact_match: emlRows.filter((r) => r.decision === "exact_match").length,
      auto_merge: emlRows.filter((r) => r.decision === "auto_merge").length,
      manual_review: emlRows.filter((r) => r.decision === "manual_review").length,
      new_entity: emlRows.filter((r) => r.decision === "new_entity").length,
      rejected: emlRows.filter((r) => r.decision === "rejected").length,
    };

    const qualityReport = {
      generated_at_utc: new Date().toISOString(),
      categories,
      entity_resolution: entityResolution,
      verification_summary: latestVer.totals,
      unavailable_sources: Array.from(
        new Set(unavailableSourcesOverride ?? prevReport.unavailable_sources ?? [])
      ),
    };
    fs.mkdirSync(this.config.dataDir, { recursive: true });
    fs.writeFileSync(qualityReportPath, JSON.stringify(qualityReport, null, 2), "utf-8");
    return qualityReport;
  }
}
