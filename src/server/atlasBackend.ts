import fs from "node:fs";
import path from "node:path";
import {
  AtlasDatabase,
  type AuditEntryInput,
  type CanonicalEntityRow,
  type EntityMappingLogInput,
  type JobInput,
  type NewsInput,
  type ProductInput,
  type ResearchPaperInput,
  type StartupInput,
  type VerificationStatus,
  sha256Prefix,
} from "./atlasDb.ts";
import {
  EXPORT_SPECS,
  GoogleSheetsService,
  type SheetsConnectionStatus,
  type SheetsSyncResult,
  formatExportCell,
} from "./googleSheets.ts";
import { PoliteHttpClient } from "./httpClient.ts";
import {
  GeminiLLMProvider,
  LLMRouter,
  OpenAICompatibleLLMProvider,
} from "./llmRouter.ts";

export interface AtlasConfig {
  rootDir: string;
  atlasDir: string;
  dataDir: string;
  exportsDir: string;
  dbPath: string;
  freshnessWindowHours: number;
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

export function loadAtlasConfig(atlasDir: string): AtlasConfig {
  const rootDir = path.resolve(atlasDir, "..");
  const dataDir = path.resolve(atlasDir, "data");
  const exportsDir = path.resolve(dataDir, "exports");
  const rawDbUrl = process.env.DATABASE_URL || "sqlite:///data/frontier_atlas.db";
  let dbPath = path.resolve(dataDir, "frontier_atlas.db");
  if (rawDbUrl.startsWith("sqlite:///")) {
    const rel = rawDbUrl.slice("sqlite:///".length);
    dbPath = path.isAbsolute(rel) ? rel : path.resolve(atlasDir, rel);
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
    groqApiKey: process.env.GROQ_API_KEY?.trim() || null,
    groqModel: process.env.GROQ_MODEL?.trim() || "llama-3.3-70b-versatile",
    llama3ApiKey: process.env.LLAMA3_API_KEY?.trim() || null,
    llama3Model: process.env.LLAMA3_MODEL?.trim() || "meta-llama/Llama-3.3-70B-Instruct",
    llama3EndpointUrl:
      process.env.LLAMA3_ENDPOINT_URL?.trim() || "https://api.together.xyz/v1/chat/completions",
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

function createLLMRouter(config: AtlasConfig): LLMRouter {
  return new LLMRouter([
    new GeminiLLMProvider(config.geminiApiKey, config.geminiModel),
    new OpenAICompatibleLLMProvider({
      providerName: "groq",
      apiKey: config.groqApiKey,
      model: config.groqModel,
      endpointUrl: "https://api.groq.com/openai/v1/chat/completions",
      timeoutMs: config.requestTimeoutMs,
    }),
    new OpenAICompatibleLLMProvider({
      providerName: "llama3",
      apiKey: config.llama3ApiKey,
      model: config.llama3Model,
      endpointUrl: config.llama3EndpointUrl,
      timeoutMs: config.requestTimeoutMs,
    }),
    new OpenAICompatibleLLMProvider({
      providerName: "deepseek",
      apiKey: config.deepseekApiKey,
      model: config.deepseekModel,
      endpointUrl: "https://api.deepseek.com/v1/chat/completions",
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
    if (items.length === 0) return null;
  }
  const targetNorm = normText(primaryValue);
  const urlHints = [fallbackUrl, sourceUrlHint]
    .filter((u): u is string => Boolean(u && typeof u === "string"))
    .map((u) => u.toLowerCase());

  for (const item of items) {
    const targetObj =
      item.paper && typeof item.paper === "object" && !Array.isArray(item.paper)
        ? (item.paper as Record<string, unknown>)
        : item;
    const itemJson = JSON.stringify(item).toLowerCase();
    for (const hint of urlHints) {
      if (itemJson.includes(hint)) {
        return stringifyObjectValues(item);
      }
    }
    for (const key of ["name", "title", "headline", "full_name", "jobTitle", "position", "text", "id"]) {
      const v = targetObj[key] ?? item[key];
      if (typeof v === "string" && targetNorm && (normText(v) === targetNorm || normText(v).endsWith(`/${targetNorm}`))) {
        return stringifyObjectValues(item);
      }
    }
  }
  return null;
}

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
        return {
          url,
          status,
          accessible: true,
          title: extractJsonFeedTitle(payload),
          text: flattenJsonText(payload),
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
    const text = `${title ?? ""} ${stripHtmlToText(body)}`.trim();
    return {
      url,
      status,
      accessible: true,
      title,
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

  private async fetchSnapshot(
    url: string,
    opts: { maxAttempts?: number; timeoutMs?: number; maxCrawlDelayMs?: number } = {}
  ): Promise<SourceSnapshot> {
    if (!isValidHttpUrl(url)) {
      return { url, status: 0, accessible: false, title: null, text: "", jsonPayload: null, xmlItems: null, error: "invalid_url" };
    }
    const existing = this.cache.get(url);
    if (existing) return existing;

    const res = await this.http.fetch(url, {
      timeoutMs: opts.timeoutMs ?? Math.min(this.config.requestTimeoutMs, 10000),
      maxAttempts: opts.maxAttempts ?? 2,
      maxCrawlDelayMs: opts.maxCrawlDelayMs,
      headers:
        this.config.githubToken && url.includes("api.github.com")
          ? { Authorization: `Bearer ${this.config.githubToken}` }
          : undefined,
    });

    const snap = this.buildSnapshot(res.url || url, res.status, res.ok, res.content || "", res.contentType || "", res.error);
    this.cache.set(url, snap);
    return snap;
  }

  public async verifyRecord(
    category: "startups" | "products" | "research_papers" | "jobs" | "news",
    rec: Record<string, unknown>,
    opts: { liveCheck: boolean; bulkSnapshotOnly?: boolean; duplicateOf?: string | null; checkedAtIso: string }
  ): Promise<Record<string, unknown>> {
    const now = new Date(opts.checkedAtIso);
    const sourceUrl = String(rec.source_url ?? "");
    const meta: Record<string, unknown> = {
      ...((rec.source_metadata as Record<string, unknown>) || {}),
      verification_mode: opts.liveCheck ? "live_http_check" : "offline_unverified",
    };
    const issues: string[] = [];

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
      const outdatedOnly = issues.filter((i) => i.startsWith("outdated:"));
      const status: VerificationStatus =
        placeholderReasons.length > 0 || outdatedOnly.length > 0 ? "Rejected" : "Unverified";
      const rejReason = [...placeholderReasons, ...outdatedOnly].join("; ") || null;
      const exactReason =
        rejReason ||
        "Live HTTP verification was not performed (offline audit mode); evidence cannot be fabricated.";
      meta.audit_issues = Array.from(new Set(issues)).sort();
      meta.source_evidence_excerpt = null;
      meta.verification_reason = exactReason;
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
    const seededApiUrl = typeof meta.api_url === "string" && isValidHttpUrl(meta.api_url) ? meta.api_url : null;
    const useSeededApiSnapshot =
      Boolean(opts.bulkSnapshotOnly && seededApiUrl && this.cache.has(seededApiUrl) && !this.cache.has(fetchSourceUrl));

    if (useSeededApiSnapshot) {
      meta.verification_mode = "live_api_snapshot_check";
    }

    const primarySnap = useSeededApiSnapshot
      ? this.cache.get(seededApiUrl!)!
      : await this.fetchSnapshot(fetchSourceUrl);

    let secondaryUrl: string | null = null;
    if (!useSeededApiSnapshot) {
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
          cand = `https://api.crossref.org/works/${rec.doi}`;
        }
        secondaryUrl = cand;
      }
    }

    if (secondaryUrl === sourceUrl || secondaryUrl === fetchSourceUrl) {
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
    if (secondarySnap) {
      meta.secondary_url_checked = secondarySnap.url;
      meta.secondary_http_status = secondarySnap.status;
      meta.secondary_accessible = secondarySnap.accessible;
      if (category === "news" && secondarySnap.accessible && secondarySnap.text) {
        meta.full_text_excerpt = secondarySnap.text.slice(0, 2000);
        if ((!rec.summary || String(rec.summary).length < 180) && secondarySnap.text.length > 80) {
          out.summary = secondarySnap.text.slice(0, 1500);
        }
      }
    }

    if (!primarySnap.accessible) {
      issues.push(`source_unavailable:${primarySnap.error || "unreachable"}`);
      const outdatedOnly = issues.filter((i) => i.startsWith("outdated:"));
      const status: VerificationStatus =
        placeholderReasons.length > 0 || outdatedOnly.length > 0 ? "Rejected" : "Source Unavailable";
      const rejReason =
        status === "Rejected" ? [...placeholderReasons, ...outdatedOnly].join("; ") || null : null;
      const exactReason =
        rejReason || `Primary source URL could not be accessed (${primarySnap.error || "unreachable"}).`;
      meta.audit_issues = Array.from(new Set(issues)).sort();
      meta.source_evidence_excerpt = null;
      meta.verification_reason = exactReason;
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

    const primaryClaim = String(rec.name ?? rec.title ?? rec.headline ?? "");
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
        if (combinedText.includes(rec.founding_date.slice(0, 4))) {
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
      if (rec.description) {
        if (textSupportsClaim(String(rec.description), combinedText, 0.55)) supportedFields.push("description");
        else unsupportedClaims.push("description");
      }
      if (rec.category && rec.category !== "Unknown") {
        if (
          textSupportsClaim(String(rec.category), combinedText, 0.7) ||
          rec.category === "Show HN Launch"
        ) {
          supportedFields.push("category");
        } else {
          unsupportedClaims.push("category");
        }
      }
      if (rec.website) {
        const dom = extractDomain(String(rec.website));
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
        } else if (dom && combinedText.toLowerCase().includes(dom)) {
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
        if (combinedText.toLowerCase().includes(rec.github_repository.toLowerCase())) {
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
          String(rec.source_name ?? "").startsWith("greenhouse:")
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
      if (rec.summary) {
        if (textSupportsClaim(String(rec.summary).slice(0, 300), combinedText, 0.55)) {
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
    meta.audit_issues = Array.from(new Set(issues)).sort();

    const outdatedIssues = issues.filter((i) => i.startsWith("outdated:") || i === "future_collected_at");
    let status: VerificationStatus;
    let rejectionReason: string | null = null;

    if (placeholderReasons.length > 0) {
      status = "Rejected";
      rejectionReason = `Placeholder or fabricated signal detected: ${placeholderReasons.join(", ")}`;
    } else if (opts.duplicateOf) {
      status = "Rejected";
      rejectionReason = `Duplicate of existing record ${opts.duplicateOf}`;
    } else if (outdatedIssues.length > 0) {
      status = "Rejected";
      rejectionReason = `Outdated or invalid timestamp: ${outdatedIssues.join(", ")}`;
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
    entityType: "startup" | "product" | "company";
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
  page: number
): Promise<{ records: RawRecord[]; errors: CollectorError[]; hasMore: boolean }> {
  const url = "https://yc-oss.github.io/api/companies/all.json";
  const res = await http.fetch(url, { timeoutMs: config.requestTimeoutMs });
  if (!res.ok) {
    return {
      records: [],
      errors: [{ source: "yc_oss_directory", url, error: res.error || "fetch_failed" }],
      hasMore: false,
    };
  }
  verifier.seedSnapshot(url, res.status, res.content, res.contentType);

  let companies: unknown;
  try {
    companies = JSON.parse(res.content);
  } catch (err) {
    return {
      records: [],
      errors: [{ source: "yc_oss_directory", url, error: `invalid_json: ${String(err)}` }],
      hasMore: false,
    };
  }
  if (!Array.isArray(companies)) {
    return {
      records: [],
      errors: [{ source: "yc_oss_directory", url, error: "unexpected_payload_shape" }],
      hasMore: false,
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

  return { records, errors: [], hasMore };
}

async function collectProducts(
  config: AtlasConfig,
  http: PoliteHttpClient,
  verifier: LiveSourceVerifier,
  limit: number,
  page: number
): Promise<{ records: RawRecord[]; errors: CollectorError[]; hasMore: boolean }> {
  const safePage = Math.max(1, page);
  const errors: CollectorError[] = [];
  const hfRecords: RawRecord[] = [];
  const ghRecords: RawRecord[] = [];
  const hnRecords: RawRecord[] = [];
  const nowIso = new Date().toISOString();

  const ghTarget = config.githubToken ? Math.round(limit * 0.4) : Math.min(250, Math.round(limit * 0.3));
  const hnTarget = Math.min(500, Math.round(limit * 0.3));
  const hfTarget = Math.max(limit - ghTarget - hnTarget, Math.round(limit * 0.45));

  // Source A: Hugging Face Spaces (cursor paginated, fast, no auth needed)
  const fetchHfSpaces = async () => {
    let nextUrl: string | null = `https://huggingface.co/api/spaces?sort=likes&direction=-1&limit=100`;
    let pageIdx = 1;
    // Skip cursor pages if page > 1
    const maxPagesToWalk = safePage + Math.ceil((hfTarget + 200) / 100) + 2;
    const seenHf = new Set<string>();

    while (nextUrl && pageIdx <= maxPagesToWalk && hfRecords.length < limit) {
      const curUrl = nextUrl;
      const res = await http.fetch(curUrl, { timeoutMs: config.requestTimeoutMs });
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
    for (const query of queries) {
      if (hitRateLimit || ghRecords.length >= Math.max(ghTarget, limit * 0.45)) break;
      let curPage = safePage;
      while (ghRecords.length < Math.max(ghTarget, limit * 0.45) && curPage < safePage + 4) {
        const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=100&page=${curPage}`;
        const res = await http.fetch(url, {
          headers: ghHeaders,
          timeoutMs: config.requestTimeoutMs,
          maxAttempts: 2,
        });
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
    for (let offset = 0; offset < pagesToFetch && hnRecords.length < limit; offset++) {
      const hnPage = Math.max(0, safePage - 1) + offset;
      const url = `https://hn.algolia.com/api/v1/search_by_date?tags=show_hn&hitsPerPage=100&page=${hnPage}`;
      const res = await http.fetch(url, { timeoutMs: config.requestTimeoutMs });
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

  const finalRecords = merged.slice(0, limit);
  return { records: finalRecords, errors, hasMore: finalRecords.length >= limit };
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
): Promise<{ records: RawRecord[]; errors: CollectorError[]; hasMore: boolean }> {
  const safePage = Math.max(1, page);
  const errors: CollectorError[] = [];
  const hfPapers: RawRecord[] = [];
  const arxivPapers: RawRecord[] = [];
  const oaPapers: RawRecord[] = [];
  const crPapers: RawRecord[] = [];
  const nowIso = new Date().toISOString();

  // 1. Hugging Face Daily Papers (includes direct githubRepo + githubStars!)
  const fetchHfPapers = async () => {
    const url = "https://huggingface.co/api/daily_papers?limit=100";
    const res = await http.fetch(url, { timeoutMs: config.requestTimeoutMs });
    if (!res.ok) {
      errors.push({ source: "huggingface_daily_papers", url, error: res.error || "fetch_failed" });
      return;
    }
    verifier.seedSnapshot(url, res.status, res.content, res.contentType);
    try {
      const arr = JSON.parse(res.content);
      if (!Array.isArray(arr)) return;
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
        const pubDt = parseUtcDatetime(paper.publishedAt ?? item.publishedAt);
        const pubDate = pubDt ? pubDt.toISOString().slice(0, 10) : null;
        const ghRepo = validateOptionalUrl(paper.githubRepo) || findFirstGithubRepo(abstract);
        const ghStars = typeof paper.githubStars === "number" && paper.githubStars >= 0 ? paper.githubStars : null;
        hfPapers.push({
          title,
          abstract,
          authors,
          publication_date: pubDate,
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
            upvotes: paper.upvotes ?? null,
            ai_keywords: Array.isArray(paper.ai_keywords) ? paper.ai_keywords : [],
            github_metrics: ghRepo
              ? { stars: ghStars, source: "huggingface_daily_papers", metrics_updated_at: nowIso }
              : null,
          },
        });
      }
    } catch (err) {
      errors.push({ source: "huggingface_daily_papers", url, error: `invalid_json: ${String(err)}` });
    }
  };

  // 2. arXiv Atom API (100/page)
  const fetchArxiv = async () => {
    const pagesNeeded = Math.min(6, Math.max(1, Math.ceil((limit * 0.4) / 100)));
    for (let offset = 0; offset < pagesNeeded && arxivPapers.length < limit; offset++) {
      const pIdx = safePage - 1 + offset;
      const start = pIdx * 100;
      const maxRes = Math.min(100, Math.max(10, limit));
      const arxivUrl = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent("cat:cs.AI OR cat:cs.LG OR cat:cs.CL")}&start=${start}&max_results=${maxRes}&sortBy=submittedDate&sortOrder=descending`;
      const res = await http.fetch(arxivUrl, { timeoutMs: Math.max(config.requestTimeoutMs, 25000) });
      if (!res.ok) {
        errors.push({ source: "arxiv", url: arxivUrl, error: res.error || "fetch_failed" });
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
        const pubDate = published ? published.slice(0, 10) : null;
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
          doi: doi || null,
          arxiv_id: arxivId,
          github_repository: githubRepo,
          github_stars: null,
          official_website: null,
          source_name: "arxiv",
          source_url: normalizeUrl(idUrl),
          collected_at: nowIso,
          source_metadata: { api_url: arxivUrl, comment },
        });
      }
    }
  };

  // 3. OpenAlex API (100/page)
  const fetchOpenAlex = async () => {
    const pagesNeeded = Math.min(10, Math.max(1, Math.ceil((limit * 0.7) / 100)));
    for (let offset = 0; offset < pagesNeeded && oaPapers.length < limit; offset++) {
      const curPage = safePage + offset;
      const perPage = Math.min(100, Math.max(15, limit));
      const oaUrl = `https://api.openalex.org/works?search=${encodeURIComponent("artificial intelligence")}&per-page=${perPage}&page=${curPage}&sort=publication_date:desc`;
      const res = await http.fetch(oaUrl, { timeoutMs: config.requestTimeoutMs });
      if (!res.ok) {
        errors.push({ source: "openalex", url: oaUrl, error: res.error || "fetch_failed" });
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
          oaPapers.push({
            title,
            abstract,
            authors,
            publication_date: typeof work.publication_date === "string" ? work.publication_date : null,
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
              openalex_id: oaId,
              openalex_api_url: oaApiUrl,
              cited_by_count: work.cited_by_count ?? null,
              type: work.type ?? null,
            },
          });
        }
      } catch (err) {
        errors.push({ source: "openalex", url: oaUrl, error: `invalid_json: ${String(err)}` });
        break;
      }
    }
  };

  // 4. Crossref API (100/page)
  const fetchCrossref = async () => {
    const pagesNeeded = Math.min(6, Math.max(1, Math.ceil((limit * 0.4) / 100)));
    for (let offsetIdx = 0; offsetIdx < pagesNeeded && crPapers.length < limit; offsetIdx++) {
      const rows = Math.min(100, Math.max(10, limit));
      const offset = (safePage - 1 + offsetIdx) * rows;
      const crUrl = `https://api.crossref.org/works?query=${encodeURIComponent("large language model")}&rows=${rows}&offset=${offset}&sort=published&order=desc`;
      const res = await http.fetch(crUrl, { timeoutMs: config.requestTimeoutMs });
      if (!res.ok) {
        errors.push({ source: "crossref", url: crUrl, error: res.error || "fetch_failed" });
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
          const pubDate =
            Array.isArray(dateParts) && dateParts.length > 0
              ? dateParts.map((p, idx) => (idx > 0 ? String(p).padStart(2, "0") : String(p))).join("-")
              : null;
          crPapers.push({
            title,
            abstract,
            authors,
            publication_date: pubDate,
            doi: typeof item.DOI === "string" ? item.DOI : null,
            arxiv_id: null,
            github_repository: findFirstGithubRepo(abstract),
            github_stars: null,
            official_website: null,
            source_name: "crossref",
            source_url: normalizeUrl(itemUrl),
            collected_at: nowIso,
            source_metadata: { api_url: crUrl, publisher: item.publisher ?? null, type: item.type ?? null },
          });
        }
      } catch (err) {
        errors.push({ source: "crossref", url: crUrl, error: `invalid_json: ${String(err)}` });
        break;
      }
    }
  };

  await Promise.all([fetchHfPapers(), fetchArxiv(), fetchOpenAlex(), fetchCrossref()]);

  // Interleave & deduplicate by normalized title / source_url
  const all: RawRecord[] = [];
  const seenKeys = new Set<string>();
  const addPaper = (rec: RawRecord) => {
    const key = String(rec.source_url).toLowerCase();
    const titleKey = normText(String(rec.title ?? ""));
    if (seenKeys.has(key) || (titleKey && seenKeys.has(`t:${titleKey}`))) return;
    seenKeys.add(key);
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
    const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
    if (config.githubToken) headers.Authorization = `Bearer ${config.githubToken}`;
    const ghRes = await http.fetch(`https://api.github.com/repos/${slug}`, {
      headers,
      timeoutMs: 8000,
      maxAttempts: 1,
    });
    if (ghRes.status === 403 || ghRes.status === 429) {
      ghRateLimited = true;
      for (const rec of slugToRecords.get(slug) ?? []) {
        const meta = (rec.source_metadata as Record<string, unknown>) || {};
        meta.github_metrics = {
          ...(typeof meta.github_metrics === "object" && meta.github_metrics ? meta.github_metrics : {}),
          stars: rec.github_stars ?? null,
          metrics_status: `rate_limited_http_${ghRes.status}`,
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
          metrics_status: ghRes.error || `http_${ghRes.status || 0}`,
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

  return { records: limited, errors, hasMore: limited.length >= limit };
}

async function collectJobs(
  config: AtlasConfig,
  http: PoliteHttpClient,
  verifier: LiveSourceVerifier,
  limit: number,
  page: number
): Promise<{ records: RawRecord[]; errors: CollectorError[]; hasMore: boolean }> {
  const safePage = Math.max(1, page);
  const errors: CollectorError[] = [];
  const combined: RawRecord[] = [];
  const nowIso = new Date().toISOString();

  const tasks: Array<Promise<void>> = [];

  // 1. Remotive
  tasks.push(
    (async () => {
      const remUrl = `https://remotive.com/api/remote-jobs?limit=${Math.min(200, Math.max(100, limit))}`;
      const res = await http.fetch(remUrl, { timeoutMs: config.requestTimeoutMs });
      if (!res.ok) {
        errors.push({ source: "remotive", url: remUrl, error: res.error || "fetch_failed" });
        return;
      }
      verifier.seedSnapshot(remUrl, res.status, res.content, res.contentType);
      try {
        const payload = JSON.parse(res.content) as Record<string, unknown>;
        const jobs = Array.isArray(payload.jobs) ? (payload.jobs as Array<Record<string, unknown>>) : [];
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
          combined.push({
            title,
            company,
            location: normalizeUnknownText(job.candidate_required_location || "Remote"),
            employment_type: normalizeUnknownText(job.job_type),
            description: desc,
            posted_at: postedAt.toISOString(),
            application_url: appUrl,
            source_name: "remotive",
            source_url: appUrl,
            collected_at: nowIso,
            source_metadata: { board: "remotive", category: job.category ?? null, remotive_id: job.id ?? null, api_url: remUrl },
          });
        }
      } catch (err) {
        errors.push({ source: "remotive", url: remUrl, error: `invalid_json: ${String(err)}` });
      }
    })()
  );

  // 2. Arbeitnow (multi-page)
  tasks.push(
    (async () => {
      for (let p = safePage; p < safePage + 4; p++) {
        const arbUrl = `https://www.arbeitnow.com/api/job-board-api?page=${p}`;
        const res = await http.fetch(arbUrl, { timeoutMs: config.requestTimeoutMs });
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
            combined.push({
              title,
              company,
              location: normalizeUnknownText(job.location),
              employment_type: empType,
              description: desc,
              posted_at: postedAt.toISOString(),
              application_url: appUrl,
              source_name: "arbeitnow",
              source_url: appUrl,
              collected_at: nowIso,
              source_metadata: { board: "arbeitnow", tags: job.tags ?? [], remote: job.remote ?? null, api_url: arbUrl },
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
      const res = await http.fetch(wwrUrl, { timeoutMs: config.requestTimeoutMs });
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
        const res = await http.fetch(jUrl, { timeoutMs: config.requestTimeoutMs });
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
        const res = await http.fetch(ghUrl, { timeoutMs: config.requestTimeoutMs });
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
        const res = await http.fetch(ashUrl, { timeoutMs: Math.max(config.requestTimeoutMs, 25000) });
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
      const res = await http.fetch(himUrl, { timeoutMs: config.requestTimeoutMs });
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
      const res = await http.fetch(rokUrl, { timeoutMs: config.requestTimeoutMs });
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
        const res = await http.fetch(levUrl, { timeoutMs: config.requestTimeoutMs });
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

  await Promise.all(tasks);

  combined.sort((a, b) => String(b.posted_at).localeCompare(String(a.posted_at)));
  // Keep newest fresh records first (or all qualifying AI records up to Math.max(limit, 250) when freshness filtering will narrow further)
  const cap = Math.max(limit, 500);
  const sliced = combined.slice(0, cap);
  return { records: sliced, errors, hasMore: combined.length > cap };
}

async function collectNews(
  config: AtlasConfig,
  http: PoliteHttpClient,
  verifier: LiveSourceVerifier,
  limit: number,
  page: number
): Promise<{ records: RawRecord[]; errors: CollectorError[]; hasMore: boolean }> {
  const safePage = Math.max(1, page);
  const errors: CollectorError[] = [];
  const records: RawRecord[] = [];
  const nowIso = new Date().toISOString();

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
          const res = await http.fetch(src.url, { timeoutMs: Math.min(config.requestTimeoutMs, 10000), maxAttempts: 1 });
          if (!res.ok) {
            errors.push({ source: src.name, url: src.url, error: res.error || "fetch_failed" });
            return;
          }
          verifier.seedSnapshot(src.url, res.status, res.content, res.contentType);
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
        })
      : [];

  // Hacker News Algolia stories (filtered for qualifying AI news)
  let gotHn = false;
  const hnTask = (async () => {
    for (let offset = 0; offset < 2; offset++) {
      const hnPage = Math.max(0, safePage - 1) + offset;
      const hnUrl = `https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=100&page=${hnPage}`;
      const hnRes = await http.fetch(hnUrl, { timeoutMs: config.requestTimeoutMs });
      if (!hnRes.ok) {
        errors.push({ source: "hn_algolia", url: hnUrl, error: hnRes.error || "fetch_failed" });
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
        }
      } catch (err) {
        errors.push({ source: "hn_algolia", url: hnUrl, error: `invalid_json: ${String(err)}` });
        break;
      }
    }
  })();

  await Promise.all([...feedTasks, hnTask]);

  records.sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)));
  const cap = Math.max(limit, 300);
  const sliced = records.slice(0, cap);
  return { records: sliced, errors, hasMore: records.length > cap || gotHn };
}

function csvEscape(val: string | number): string {
  const s = String(val);
  if (s.includes('"') || s.includes(",") || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ---------- Main Backend Service ----------

export class AtlasBackendService {
  private readonly config: AtlasConfig;
  private readonly db: AtlasDatabase;
  private readonly http: PoliteHttpClient;
  private readonly llmRouter: LLMRouter;
  private readonly sheets: GoogleSheetsService;

  constructor(atlasDir: string) {
    this.config = loadAtlasConfig(atlasDir);
    this.db = new AtlasDatabase(this.config.dbPath);
    this.db.initializeSchema();
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

  public getStatus(): Record<string, unknown> {
    const counts = this.db.countRecords();
    const verificationCounts = this.db.getVerificationCounts();
    const checkpoints = this.db.fetchCheckpoints();
    const failureCount = this.db.getFailureCount();
    const auditTrail = this.db.fetchAuditTrail({ limit: 50 });

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

    return {
      counts,
      verificationCounts,
      auditTrail,
      failureCount,
      targets: {
        startups: this.config.targetStartups,
        products: this.config.targetProducts,
        research_papers: this.config.targetResearchPapers,
      },
      freshnessWindowHours: this.config.freshnessWindowHours,
      credentials: {
        geminiConfigured: Boolean(this.config.geminiApiKey),
        geminiModel: this.config.geminiModel,
        groqConfigured: Boolean(this.config.groqApiKey),
        llama3Configured: Boolean(this.config.llama3ApiKey),
        deepseekConfigured: Boolean(this.config.deepseekApiKey),
        llmChain: this.llmRouter.allProviderNames(),
        llmDemoFallbackActive: !this.llmRouter.isConfigured(),
        githubTokenConfigured: Boolean(this.config.githubToken),
        googleSheetsConfigured: this.sheets.isConfigured(),
        googleSheetsSpreadsheetId: Boolean(this.config.googleSheetsSpreadsheetId || sheetsStatus.spreadsheetId),
      },
      sheetsStatus,
      storage: {
        backend: "sqlite",
        sqlitePath: this.config.dbPath,
      },
      checkpoints,
      qualityReport,
      csvExports,
    };
  }

  public getDataset(category: string, limit: number): Record<string, unknown> {
    const rows = this.db.fetchDataset(category, limit);
    return { category, rows, count: rows.length };
  }

  public getAuditTrail(opts: {
    category?: string | null;
    recordId?: string | null;
    limit?: number;
  }): Record<string, unknown> {
    const entries = this.db.fetchAuditTrail(opts);
    return { entries, count: entries.length };
  }

  public exportAllCsv(): {
    outputDir: string;
    rowCounts: Record<string, number>;
    files: Record<string, string>;
  } {
    fs.mkdirSync(this.config.exportsDir, { recursive: true });
    const rowCounts: Record<string, number> = {};
    const files: Record<string, string> = {};

    for (const spec of EXPORT_SPECS) {
      const rawRows = this.db.fetchDataset(spec.tableName);
      const seenIds = new Set<string>();
      const lines: string[] = [spec.columns.map(csvEscape).join(",")];
      let count = 0;

      for (const row of rawRows) {
        const rowId = String(row[spec.idColumn] ?? "");
        if (!rowId || seenIds.has(rowId)) continue;
        seenIds.add(rowId);
        const cells = spec.columns.map((col) => csvEscape(formatExportCell(col, row, false)));
        lines.push(cells.join(","));
        count++;
      }

      const targetFile = path.resolve(this.config.exportsDir, spec.csvFilename);
      fs.writeFileSync(targetFile, `${lines.join("\n")}\n`, "utf-8");
      rowCounts[spec.tabName] = count;
      files[spec.tabName] = targetFile;
    }

    return {
      outputDir: this.config.exportsDir,
      rowCounts,
      files,
    };
  }

  public async exportGoogleSheets(opts?: {
    oauthAccessToken?: string | null;
    spreadsheetId?: string | null;
  }): Promise<SheetsSyncResult> {
    return this.sheets.exportOrSync("full", opts);
  }

  public async syncGoogleSheets(opts?: {
    oauthAccessToken?: string | null;
    spreadsheetId?: string | null;
  }): Promise<SheetsSyncResult> {
    return this.sheets.exportOrSync("incremental", opts);
  }

  public async verifyGoogleSheetsConnection(opts?: {
    oauthAccessToken?: string | null;
    spreadsheetId?: string | null;
  }): Promise<SheetsConnectionStatus> {
    return this.sheets.verifyConnection(opts);
  }

  public async runPipeline(opts: {
    categories: string[];
    limit: number;
    page: number;
    skipAutoSheetsSync?: boolean;
    onLog?: (msg: string) => void;
  }): Promise<Record<string, unknown>> {
    const log = opts.onLog ?? (() => {});
    const safePage = Math.max(1, opts.page);
    const limit = Math.max(1, opts.limit);
    const verifier = new LiveSourceVerifier(this.config, this.http);
    const existingEntities = this.db.fetchDataset("canonical_entities") as unknown as CanonicalEntityRow[];
    const resolver = new EntityResolver(existingEntities);

    const categoryQuality: Record<string, unknown> = {};
    const unavailableSources: string[] = [];
    const collectorErrors: Array<Record<string, unknown>> = [];
    const overallVerSummary: Record<VerificationStatus, number> = {
      Verified: 0,
      "Partially Verified": 0,
      Unverified: 0,
      "Source Unavailable": 0,
      Rejected: 0,
    };

    for (const cat of opts.categories) {
      log(`[${cat}] Collecting page ${safePage} (limit=${limit})...`);
      let batch: { records: RawRecord[]; errors: CollectorError[]; hasMore: boolean };
      try {
        if (cat === "startups") batch = await collectStartups(this.config, this.http, this.llmRouter, verifier, limit, safePage);
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
        log(`[${cat}] Collector error: ${msg}`);
        continue;
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

      if (cat === "jobs" || cat === "news") {
        const now = new Date();
        const dateField = cat === "jobs" ? "posted_at" : "published_at";
        const accepted: RawRecord[] = [];
        let rejectedOlder = 0;
        let rejectedMissing = 0;
        let rejectedFuture = 0;

        for (const rec of working) {
          const dt = parseUtcDatetime(rec[dateField]);
          const fresh = isWithinFreshnessWindow(dt, now, this.config.freshnessWindowHours);
          if (fresh.ok) {
            accepted.push(rec);
          } else {
            rejectedCount++;
            if (fresh.reason === "missing_published_at") rejectedMissing++;
            else if (fresh.reason === "future_publication_date") rejectedFuture++;
            else rejectedOlder++;
            if (rejectionSamples.length < 5) rejectionSamples.push(fresh.reason);
            this.db.recordFailure({
              stage: "freshness",
              category: cat,
              sourceUrl: (rec.source_url as string | null) ?? null,
              reason: fresh.reason,
              payload: rec,
            });
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
        working = accepted.slice(0, limit);
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

      const bulkSnapshotOnly = uniqueRecords.length > 100;
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
          { liveCheck: true, bulkSnapshotOnly, checkedAtIso }
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
        }
      }

      // Persist category records
      if (cat === "startups") this.db.upsertStartups(verified as unknown as StartupInput[]);
      else if (cat === "products") this.db.upsertProducts(verified as unknown as ProductInput[]);
      else if (cat === "research_papers") this.db.upsertResearchPapers(verified as unknown as ResearchPaperInput[]);
      else if (cat === "jobs") this.db.upsertJobs(verified as unknown as JobInput[]);
      else if (cat === "news") this.db.upsertNews(verified as unknown as NewsInput[]);

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
      // Keep audit inserts fast by sampling/bounding for huge batches if needed, or batch insert all
      this.db.recordAuditEntries(auditEntries);

      const nextCursor = batch.hasMore ? `page:${safePage + 1}` : `page:${safePage}`;
      this.db.saveCheckpoint(`pipeline:${cat}`, cat, nextCursor, verified.length);

      const persistedCounts = this.db.countRecords();
      const persistedTotal = persistedCounts[cat] ?? 0;
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
        target_minimum: targetMin,
        target_met: targetMin !== null ? persistedTotal >= targetMin : null,
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

    const qualityReport = {
      generated_at_utc: new Date().toISOString(),
      categories: categoryQuality,
      entity_resolution: resolver.getStats(),
      verification_summary: overallVerSummary,
      unavailable_sources: Array.from(new Set(unavailableSources)),
    };
    fs.mkdirSync(this.config.dataDir, { recursive: true });
    fs.writeFileSync(
      path.resolve(this.config.dataDir, "quality_report.json"),
      JSON.stringify(qualityReport, null, 2),
      "utf-8"
    );

    const csvSummary = this.exportAllCsv();
    log("Refreshed CSV exports across all 6 datasets.");

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

    return {
      databaseCounts: this.db.countRecords(),
      verificationCounts: this.db.getVerificationCounts(),
      collectorErrors,
      qualityReport,
      csvExportDir: csvSummary.outputDir,
      sheetsSync,
    };
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

      const verified = await mapConcurrent(parsedRows, this.config.maxConcurrency, (rec) =>
        verifier.verifyRecord(
          cat as "startups" | "products" | "research_papers" | "jobs" | "news",
          rec,
          { liveCheck: opts.liveCheck, bulkSnapshotOnly: parsedRows.length > 200, checkedAtIso }
        )
      );

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
    this.exportAllCsv();

    return {
      auditedCategories,
      auditEntriesLogged: auditEntries.length,
      duplicatesRemoved: totalDuplicatesRemoved,
      databaseCounts: this.db.countRecords(),
      verificationCounts: this.db.getVerificationCounts(),
    };
  }
}
