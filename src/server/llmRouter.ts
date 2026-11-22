/**
 * Multi-tier LLM extraction router with token-aware intelligent chunking,
 * recursive sub-chunking on context-limit / 413 errors, exponential backoff retries,
 * and source-evidence verification.
 *
 * Provider chain:
 *   1. Google Gemini Flash (@google/genai) - primary when GEMINI_API_KEY is configured
 *   2. Groq (OpenAI-compatible REST) - fallback when GROQ_API_KEY is configured
 *   3. Llama 3 (OpenAI-compatible REST) - fallback when LLAMA3_API_KEY is configured
 *   4. DeepSeek (OpenAI-compatible REST) - fallback when DEEPSEEK_API_KEY is configured
 *   + Honest heuristic demo fallback when zero API keys are configured (marked Unverified)
 */

import { GoogleGenAI } from "@google/genai";

export interface TextChunk {
  index: number;
  totalChunks: number;
  text: string;
  estimatedTokens: number;
  startChar: number;
  endChar: number;
}

export class PayloadTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadTooLargeError";
  }
}

export class RateLimitError extends Error {
  public readonly retryAfterMs: number | null;
  constructor(message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class TransientProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientProviderError";
  }
}

export class FatalProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalProviderError";
  }
}

export class MalformedJSONError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedJSONError";
  }
}

const SYSTEM_INSTRUCTION =
  "You are a precision data-extraction engine. Return valid JSON ONLY with a top-level 'records' array. " +
  "Extract strictly from the provided source text. Never fabricate URLs, dates, metrics, or descriptions. " +
  "Use null or 'Unknown' if a field is absent in the text.";

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 3.8));
}

export function chunkText(
  text: string,
  opts: { maxTokens?: number; overlapTokens?: number } = {}
): TextChunk[] {
  const cleaned = (text || "").trim();
  if (!cleaned) return [];

  const maxTokens = opts.maxTokens ?? 6000;
  const overlapTokens = opts.overlapTokens ?? 200;
  const maxChars = Math.max(400, Math.floor(maxTokens * 3.8));
  const overlapChars = Math.max(0, Math.min(Math.floor(overlapTokens * 3.8), Math.floor(maxChars / 3)));

  if (cleaned.length <= maxChars) {
    return [
      {
        index: 0,
        totalChunks: 1,
        text: cleaned,
        estimatedTokens: estimateTokens(cleaned),
        startChar: 0,
        endChar: cleaned.length,
      },
    ];
  }

  let segments = cleaned
    .split(/\n\s*\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length <= 1) {
    segments = cleaned
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const rawChunks: Array<[number, number, string]> = [];
  let currentParts: string[] = [];
  let currentLen = 0;
  let cursor = 0;
  let chunkStart = 0;

  for (const seg of segments) {
    if (seg.length > maxChars) {
      if (currentParts.length > 0) {
        const joined = currentParts.join("\n\n");
        rawChunks.push([chunkStart, cursor, joined]);
        currentParts = [];
        currentLen = 0;
      }
      let pos = 0;
      while (pos < seg.length) {
        const end = Math.min(seg.length, pos + maxChars);
        const piece = seg.slice(pos, end);
        rawChunks.push([cursor + pos, cursor + end, piece]);
        if (end === seg.length) break;
        pos = Math.max(pos + 1, end - overlapChars);
      }
      cursor += seg.length + 2;
      chunkStart = cursor;
      continue;
    }

    const addedLen = seg.length + (currentParts.length > 0 ? 2 : 0);
    if (currentLen + addedLen > maxChars && currentParts.length > 0) {
      const joined = currentParts.join("\n\n");
      rawChunks.push([chunkStart, chunkStart + joined.length, joined]);

      const overlapParts: string[] = [];
      let overlapLen = 0;
      for (let i = currentParts.length - 1; i >= 0; i--) {
        const prev = currentParts[i];
        if (overlapLen + prev.length <= overlapChars) {
          overlapParts.unshift(prev);
          overlapLen += prev.length + 2;
        } else {
          break;
        }
      }
      currentParts = [...overlapParts, seg];
      currentLen =
        currentParts.reduce((s, p) => s + p.length, 0) + Math.max(0, (currentParts.length - 1) * 2);
      chunkStart = Math.max(0, chunkStart + joined.length - overlapLen);
    } else {
      currentParts.push(seg);
      currentLen += addedLen;
    }
    cursor += seg.length + 2;
  }

  if (currentParts.length > 0) {
    const joined = currentParts.join("\n\n");
    rawChunks.push([chunkStart, Math.min(cleaned.length, chunkStart + joined.length), joined]);
  }

  const total = rawChunks.length;
  return rawChunks.map(([startChar, endChar, chunkStr], idx) => ({
    index: idx,
    totalChunks: total,
    text: chunkStr,
    estimatedTokens: estimateTokens(chunkStr),
    startChar,
    endChar,
  }));
}

export function parseJsonResponse(raw: string): Record<string, unknown> {
  const trimmed = (raw || "").trim();
  if (!trimmed) throw new MalformedJSONError("Empty LLM JSON response");

  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(stripped);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    if (Array.isArray(parsed)) {
      return { records: parsed };
    }
    throw new MalformedJSONError("LLM returned non-object JSON");
  } catch (err) {
    const firstBrace = stripped.indexOf("{");
    const lastBrace = stripped.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        const slice = JSON.parse(stripped.slice(firstBrace, lastBrace + 1));
        if (slice && typeof slice === "object" && !Array.isArray(slice)) {
          return slice as Record<string, unknown>;
        }
      } catch {
        // Fall through to MalformedJSONError
      }
    }
    throw new MalformedJSONError(`Malformed LLM JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function buildExtractionPrompt(category: string, sourceUrl: string, chunkBody: string): string {
  const schemaHints: Record<string, string> = {
    startups:
      'Each record: {"name": string, "description": string|null, "website": string|null, "industry": string|null, "location": string|null, "founding_date": string|null, "evidence_quote": string|null}',
    products:
      'Each record: {"name": string, "description": string|null, "website": string|null, "category": string|null, "company_name": string|null, "evidence_quote": string|null}',
    research_papers:
      'Each record: {"title": string, "abstract": string|null, "authors": string[], "publication_date": string|null, "doi": string|null, "arxiv_id": string|null, "github_repository": string|null, "evidence_quote": string|null}',
    jobs:
      'Each record: {"title": string, "company": string, "location": string|null, "employment_type": string|null, "description": string|null, "posted_at": string|null, "application_url": string|null, "evidence_quote": string|null}',
    news:
      'Each record: {"headline": string, "summary": string|null, "publisher": string|null, "published_at": string|null, "article_url": string|null, "category": string|null, "evidence_quote": string|null}',
  };

  return (
    `Category: ${category}\n` +
    `Source URL: ${sourceUrl}\n` +
    `Schema: {"records": [${schemaHints[category] ?? "{}"}]}\n\n` +
    `Extract only records explicitly present in the source text below:\n` +
    `---\n${chunkBody}\n---`
  );
}

export interface LLMProvider {
  readonly providerName: string;
  isConfigured(): boolean;
  generateJson(prompt: string, systemInstruction?: string): Promise<Record<string, unknown>>;
}

function classifyHttpError(providerName: string, status: number, bodyText: string, retryAfterHeader: string | null): Error {
  const lower = bodyText.toLowerCase();
  if (
    status === 413 ||
    lower.includes("context length") ||
    lower.includes("token limit") ||
    lower.includes("maximum context") ||
    lower.includes("too many tokens") ||
    lower.includes("payload too large")
  ) {
    return new PayloadTooLargeError(`${providerName} context/payload limit (${status})`);
  }
  if (status === 429) {
    const sec = retryAfterHeader && /^\d+$/.test(retryAfterHeader.trim()) ? Number(retryAfterHeader) * 1000 : null;
    return new RateLimitError(`${providerName} rate limit (429)`, sec);
  }
  if (status === 401 || status === 403) {
    return new FatalProviderError(`${providerName} authentication error (HTTP ${status})`);
  }
  if (status >= 500) {
    return new TransientProviderError(`${providerName} upstream server error (HTTP ${status})`);
  }
  return new FatalProviderError(`${providerName} client error (HTTP ${status}): ${bodyText.slice(0, 200)}`);
}

export class GeminiLLMProvider implements LLMProvider {
  public readonly providerName = "gemini";

  constructor(
    private readonly apiKey: string | null,
    private readonly model: string
  ) {}

  public isConfigured(): boolean {
    return Boolean(this.apiKey && this.apiKey.trim());
  }

  public async generateJson(prompt: string, systemInstruction = SYSTEM_INSTRUCTION): Promise<Record<string, unknown>> {
    if (!this.isConfigured()) {
      throw new FatalProviderError("GEMINI_API_KEY is not configured");
    }
    const ai = new GoogleGenAI({
      apiKey: this.apiKey!,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
    const isGemini4Series = this.model.startsWith("gemini-4-");
    try {
      const response = await ai.models.generateContent({
        model: this.model,
        contents: prompt,
        config: isGemini4Series
          ? {
              systemInstruction,
              responseMimeType: "application/json",
            }
          : {
              systemInstruction,
              responseMimeType: "application/json",
              temperature: 0,
            },
      });
      return parseJsonResponse(response.text ?? "");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const lower = msg.toLowerCase();
      if (err instanceof MalformedJSONError) throw err;
      if (lower.includes("413") || lower.includes("token") || lower.includes("context") || lower.includes("too large")) {
        throw new PayloadTooLargeError(`gemini context/payload limit: ${msg}`);
      }
      if (lower.includes("429") || lower.includes("quota") || lower.includes("resource_exhausted")) {
        throw new RateLimitError(`gemini rate limit: ${msg}`);
      }
      if (lower.includes("401") || lower.includes("403") || lower.includes("api key")) {
        throw new FatalProviderError(`gemini auth error: ${msg}`);
      }
      throw new TransientProviderError(`gemini request error: ${msg}`);
    }
  }
}

export class OpenAICompatibleLLMProvider implements LLMProvider {
  public readonly providerName: string;

  constructor(private readonly opts: {
    providerName: string;
    apiKey: string | null;
    model: string;
    endpointUrl: string;
    timeoutMs?: number;
  }) {
    this.providerName = opts.providerName;
  }

  public isConfigured(): boolean {
    return Boolean(this.opts.apiKey && this.opts.apiKey.trim());
  }

  public async generateJson(prompt: string, systemInstruction = SYSTEM_INSTRUCTION): Promise<Record<string, unknown>> {
    if (!this.isConfigured()) {
      throw new FatalProviderError(`${this.providerName} API key is not configured`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 25_000);
    try {
      const resp = await fetch(this.opts.endpointUrl, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.opts.model,
          messages: [
            { role: "system", content: systemInstruction },
            { role: "user", content: prompt },
          ],
          response_format: { type: "json_object" },
          temperature: 0,
        }),
      });
      const bodyText = await resp.text();
      if (!resp.ok) {
        throw classifyHttpError(this.providerName, resp.status, bodyText, resp.headers.get("retry-after"));
      }
      const data = JSON.parse(bodyText) as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new MalformedJSONError(`${this.providerName} returned empty message content`);
      }
      return parseJsonResponse(content);
    } catch (err) {
      if (
        err instanceof PayloadTooLargeError ||
        err instanceof RateLimitError ||
        err instanceof FatalProviderError ||
        err instanceof TransientProviderError ||
        err instanceof MalformedJSONError
      ) {
        throw err;
      }
      const msg = err instanceof Error ? (err.name === "AbortError" ? "timeout" : err.message) : String(err);
      throw new TransientProviderError(`${this.providerName} network error: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

async function runWithRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err instanceof FatalProviderError || err instanceof PayloadTooLargeError) {
        throw err;
      }
      const isRetryable =
        err instanceof RateLimitError ||
        err instanceof TransientProviderError ||
        err instanceof MalformedJSONError;
      if (!isRetryable || attempt === maxAttempts) {
        throw err;
      }
      const baseMs =
        err instanceof RateLimitError && err.retryAfterMs !== null
          ? Math.min(15_000, err.retryAfterMs)
          : Math.min(10_000, 750 * Math.pow(2, attempt - 1));
      const jitter = Math.floor(Math.random() * 250);
      await new Promise((r) => setTimeout(r, baseMs + jitter));
    }
  }
  throw lastErr;
}

export function verifyExtractionAgainstSource(
  record: Record<string, unknown>,
  sourceText: string
): { grounded: boolean; matchedTerms: string[] } {
  const normSrc = sourceText.toLowerCase();
  const primary = String(record.name ?? record.title ?? record.headline ?? "").trim().toLowerCase();
  const quote = String(record.evidence_quote ?? "").trim().toLowerCase();
  const matchedTerms: string[] = [];

  if (primary && normSrc.includes(primary)) {
    matchedTerms.push("primary_name");
  }
  if (quote && quote.length >= 8 && normSrc.includes(quote.slice(0, 40))) {
    matchedTerms.push("evidence_quote");
  }
  return {
    grounded: matchedTerms.length > 0,
    matchedTerms,
  };
}

export function extractWithHeuristicDemo(
  category: string,
  sourceUrl: string,
  sourceName: string,
  sourceText: string
): Array<Record<string, unknown>> {
  const cleaned = (sourceText || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  const sentences = cleaned.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length >= 12);
  const firstSentence = sentences[0] ?? cleaned.slice(0, 260);
  const urlMatch = cleaned.match(/https?:\/\/[^\s"'<>]+/i)?.[0] ?? null;
  const ghMatch = cleaned.match(/https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/i)?.[0] ?? null;
  const isoDateMatch = cleaned.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] ?? null;
  const titleCandidate = firstSentence.split(/\s+(?:is|builds|announced|launches|released|raised)\b/i)[0]?.trim() || firstSentence.slice(0, 80);

  const baseMeta = {
    llm_provider: null,
    llm_configured: false,
    extraction_mode: "heuristic_demo_fallback",
  };

  if (category === "startups") {
    return [
      {
        name: titleCandidate.slice(0, 120),
        description: firstSentence.slice(0, 400),
        website: urlMatch,
        industry: "AI & Software",
        location: "Unknown",
        founding_date: isoDateMatch,
        source_url: sourceUrl,
        source_name: sourceName,
        verification_status: "Unverified",
        supported_fields: [],
        source_metadata: baseMeta,
      },
    ];
  }
  if (category === "products") {
    return [
      {
        name: titleCandidate.slice(0, 120),
        description: firstSentence.slice(0, 400),
        website: urlMatch || ghMatch,
        category: "AI Tool",
        company_name: "Unknown",
        source_url: sourceUrl,
        source_name: sourceName,
        verification_status: "Unverified",
        supported_fields: [],
        source_metadata: baseMeta,
      },
    ];
  }
  if (category === "research_papers") {
    return [
      {
        title: titleCandidate.slice(0, 160),
        abstract: cleaned.slice(0, 600),
        authors: [],
        publication_date: isoDateMatch,
        doi: null,
        arxiv_id: null,
        github_repository: ghMatch,
        source_url: sourceUrl,
        source_name: sourceName,
        verification_status: "Unverified",
        supported_fields: [],
        source_metadata: baseMeta,
      },
    ];
  }
  if (category === "jobs") {
    return [
      {
        title: titleCandidate.slice(0, 140),
        company: "Unknown",
        location: "Unknown",
        employment_type: "Unknown",
        description: cleaned.slice(0, 600),
        posted_at: isoDateMatch,
        application_url: urlMatch || sourceUrl,
        source_url: sourceUrl,
        source_name: sourceName,
        verification_status: "Unverified",
        supported_fields: [],
        source_metadata: baseMeta,
      },
    ];
  }
  return [
    {
      headline: titleCandidate.slice(0, 180),
      summary: firstSentence.slice(0, 500),
      publisher: "Unknown",
      published_at: isoDateMatch,
      article_url: urlMatch || sourceUrl,
      category: "AI",
      source_url: sourceUrl,
      source_name: sourceName,
      verification_status: "Unverified",
      supported_fields: [],
      source_metadata: baseMeta,
    },
  ];
}

export interface LLMExtractionResult {
  category: string;
  sourceUrl: string;
  records: Array<Record<string, unknown>>;
  providerUsed: string | null;
  mode: "live_llm" | "heuristic_demo_fallback" | "error";
  llmConnected: boolean;
  chunksProcessed: number;
  subChunksSplit: number;
  attemptedProviders: string[];
  errors: string[];
}

export class LLMRouter {
  private readonly maxInputTokens: number;
  private readonly overlapTokens: number;

  constructor(
    private readonly providers: LLMProvider[],
    opts: { maxInputTokens?: number; overlapTokens?: number } = {}
  ) {
    this.maxInputTokens = opts.maxInputTokens ?? 5500;
    this.overlapTokens = opts.overlapTokens ?? 180;
  }

  public configuredProviderNames(): string[] {
    return this.providers.filter((p) => p.isConfigured()).map((p) => p.providerName);
  }

  public allProviderNames(): string[] {
    return this.providers.map((p) => p.providerName);
  }

  public isConfigured(): boolean {
    return this.providers.some((p) => p.isConfigured());
  }

  private async callProviders(
    prompt: string
  ): Promise<{ payload: Record<string, unknown>; providerName: string; attemptedProviders: string[] }> {
    const configured = this.providers.filter((p) => p.isConfigured());
    if (configured.length === 0) {
      throw new FatalProviderError(
        "No LLM provider configured (set GEMINI_API_KEY, GROQ_API_KEY, LLAMA3_API_KEY, or DEEPSEEK_API_KEY)."
      );
    }

    const errors: string[] = [];
    const attemptedProviders: string[] = [];
    for (const provider of configured) {
      attemptedProviders.push(provider.providerName);
      try {
        const payload = await runWithRetry(() => provider.generateJson(prompt), 3);
        return { payload, providerName: provider.providerName, attemptedProviders };
      } catch (err) {
        if (err instanceof PayloadTooLargeError) {
          throw err;
        }
        errors.push(`${provider.providerName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new Error(`All configured LLM providers failed: ${errors.join("; ")}`);
  }

  private async extractChunkRecursive(
    category: string,
    sourceUrl: string,
    text: string,
    tokenBudget: number,
    depth = 0
  ): Promise<{
    rawRecords: Array<Record<string, unknown>>;
    providerUsed: string | null;
    attemptedProviders: string[];
    subSplits: number;
    errors: string[];
  }> {
    const prompt = buildExtractionPrompt(category, sourceUrl, text);
    try {
      const { payload, providerName, attemptedProviders } = await this.callProviders(prompt);
      const recs = Array.isArray(payload.records)
        ? payload.records.filter((r): r is Record<string, unknown> => Boolean(r && typeof r === "object"))
        : [];
      return { rawRecords: recs, providerUsed: providerName, attemptedProviders, subSplits: 0, errors: [] };
    } catch (err) {
      if (err instanceof PayloadTooLargeError && depth < 3 && tokenBudget > 600) {
        const nextBudget = Math.max(600, Math.floor(tokenBudget / 2));
        const subChunks = chunkText(text, {
          maxTokens: nextBudget,
          overlapTokens: Math.min(100, this.overlapTokens),
        });
        const merged: Array<Record<string, unknown>> = [];
        const subErrors: string[] = [];
        const attemptedSet = new Set<string>();
        let lastProvider: string | null = null;
        let totalSplits = 1;
        for (const sub of subChunks) {
          const res = await this.extractChunkRecursive(category, sourceUrl, sub.text, nextBudget, depth + 1);
          merged.push(...res.rawRecords);
          subErrors.push(...res.errors);
          for (const p of res.attemptedProviders) attemptedSet.add(p);
          totalSplits += res.subSplits;
          if (res.providerUsed) lastProvider = res.providerUsed;
        }
        return {
          rawRecords: merged,
          providerUsed: lastProvider,
          attemptedProviders: Array.from(attemptedSet),
          subSplits: totalSplits,
          errors: subErrors,
        };
      }
      return {
        rawRecords: [],
        providerUsed: null,
        attemptedProviders: [],
        subSplits: 0,
        errors: [err instanceof Error ? err.message : String(err)],
      };
    }
  }

  public async extractStructured(opts: {
    category: string;
    sourceUrl: string;
    sourceName: string;
    sourceText: string;
    allowHeuristicFallback?: boolean;
  }): Promise<LLMExtractionResult> {
    const result: LLMExtractionResult = {
      category: opts.category,
      sourceUrl: opts.sourceUrl,
      records: [],
      providerUsed: null,
      mode: "error",
      llmConnected: false,
      chunksProcessed: 0,
      subChunksSplit: 0,
      attemptedProviders: [],
      errors: [],
    };

    if (!opts.sourceText || !opts.sourceText.trim()) {
      result.errors.push("Empty source text");
      return result;
    }

    if (!this.isConfigured()) {
      const msg =
        "No LLM provider configured (GEMINI_API_KEY, GROQ_API_KEY, LLAMA3_API_KEY, DEEPSEEK_API_KEY).";
      if (opts.allowHeuristicFallback) {
        result.mode = "heuristic_demo_fallback";
        result.llmConnected = false;
        result.errors.push(`${msg} Executed deterministic heuristic fallback (records marked Unverified).`);
        result.chunksProcessed = 1;
        result.records = extractWithHeuristicDemo(
          opts.category,
          opts.sourceUrl,
          opts.sourceName,
          opts.sourceText
        );
        return result;
      }
      result.mode = "error";
      result.errors.push(msg);
      return result;
    }

    const chunks = chunkText(opts.sourceText, {
      maxTokens: this.maxInputTokens,
      overlapTokens: this.overlapTokens,
    });

    const seenKeys = new Set<string>();
    const attemptedSet = new Set<string>();
    for (const chunk of chunks) {
      result.chunksProcessed += 1;
      const chunkRes = await this.extractChunkRecursive(
        opts.category,
        opts.sourceUrl,
        chunk.text,
        this.maxInputTokens
      );
      if (chunkRes.providerUsed) {
        result.providerUsed = chunkRes.providerUsed;
        result.mode = "live_llm";
        result.llmConnected = true;
      }
      for (const p of chunkRes.attemptedProviders) attemptedSet.add(p);
      result.subChunksSplit += chunkRes.subSplits;
      result.errors.push(...chunkRes.errors);

      for (const raw of chunkRes.rawRecords) {
        const verification = verifyExtractionAgainstSource(raw, opts.sourceText);
        if (!verification.grounded) continue;
        const key = String(raw.name ?? raw.title ?? raw.headline ?? "").trim().toLowerCase();
        if (!key || seenKeys.has(key)) continue;
        seenKeys.add(key);

        const copy: Record<string, unknown> = { ...raw };
        delete copy.evidence_quote;
        copy.source_url = copy.source_url || opts.sourceUrl;
        copy.source_name = copy.source_name || opts.sourceName;
        // LLM outputs remain Unverified until corroborated by LiveSourceVerifier
        copy.verification_status = "Unverified";
        copy.supported_fields = [];
        copy.source_metadata = {
          ...((copy.source_metadata as Record<string, unknown>) || {}),
          llm_provider: result.providerUsed,
          llm_evidence_verification: verification,
        };
        result.records.push(copy);
      }
    }
    result.attemptedProviders = Array.from(attemptedSet);

    return result;
  }
}
