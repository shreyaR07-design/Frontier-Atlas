/**
 * Polite asynchronous HTTP client with robots.txt policy enforcement,
 * per-domain rate limiting, exponential backoff, HTTP 429 Retry-After handling,
 * and anti-bot / CAPTCHA non-bypass compliance.
 */

export interface FetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxCrawlDelayMs?: number;
  userAgent?: string;
  checkRobots?: boolean;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  deduplicate?: boolean;
}

export interface FetchResult {
  url: string;
  status: number;
  ok: boolean;
  content: string;
  contentType: string;
  headers: Record<string, string>;
  error: string | null;
  blockedByRobots: boolean;
  skippedDuplicate: boolean;
  attempts: number;
}

interface RobotsRule {
  allow: string[];
  disallow: string[];
  crawlDelaySec: number | null;
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const RESTRICTED_STATUSES = new Set([401, 403, 451]);
const CAPTCHA_RE =
  /(?:cf-chl-|challenge-platform|g-recaptcha|hcaptcha\.com\/1\/api|captcha-delivery|px-captcha|just\s+a\s+moment\.\.\.)/i;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function parseRetryAfterMs(headerVal: string | null | undefined): number | null {
  if (!headerVal) return null;
  const trimmed = headerVal.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const sec = Number(trimmed);
    return Number.isFinite(sec) && sec >= 0 ? Math.min(20_000, sec * 1000) : null;
  }
  const dt = Date.parse(trimmed);
  if (!Number.isNaN(dt)) {
    const delta = dt - Date.now();
    return delta > 0 ? Math.min(20_000, delta) : 0;
  }
  return null;
}

function parseRobotsTxt(text: string, targetAgent: string): RobotsRule {
  const lines = text.split(/\r?\n/);
  const agentToken = targetAgent.split("/")[0].trim().toLowerCase();
  const blocks: Array<{ agents: string[]; allow: string[]; disallow: string[]; crawlDelay: number | null }> = [];
  let current: { agents: string[]; allow: string[]; disallow: string[]; crawlDelay: number | null } | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) {
      if (current && (current.allow.length > 0 || current.disallow.length > 0 || current.crawlDelay !== null)) {
        blocks.push(current);
        current = null;
      }
      continue;
    }
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim().toLowerCase();
    const val = line.slice(colonIdx + 1).trim();

    if (key === "user-agent") {
      if (!current || current.allow.length > 0 || current.disallow.length > 0 || current.crawlDelay !== null) {
        if (current) blocks.push(current);
        current = { agents: [], allow: [], disallow: [], crawlDelay: null };
      }
      current.agents.push(val.toLowerCase());
    } else if (current) {
      if (key === "disallow" && val) current.disallow.push(val);
      else if (key === "allow" && val) current.allow.push(val);
      else if (key === "crawl-delay") {
        const n = Number(val);
        if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
      }
    }
  }
  if (current) blocks.push(current);

  const specific = blocks.filter((b) => b.agents.some((a) => a === agentToken || agentToken.includes(a) && a !== "*"));
  const wildcard = blocks.filter((b) => b.agents.includes("*"));
  const chosen = specific.length > 0 ? specific : wildcard;

  const merged: RobotsRule = { allow: [], disallow: [], crawlDelaySec: null };
  for (const b of chosen) {
    merged.allow.push(...b.allow);
    merged.disallow.push(...b.disallow);
    if (b.crawlDelay !== null) {
      merged.crawlDelaySec = merged.crawlDelaySec === null ? b.crawlDelay : Math.max(merged.crawlDelaySec, b.crawlDelay);
    }
  }
  return merged;
}

function matchesRobotsPattern(pathWithQuery: string, pattern: string): boolean {
  if (!pattern) return false;
  if (pattern === "/") return true;
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  const anchoredEnd = pattern.endsWith("$") ? escaped.slice(0, -2) + "$" : escaped;
  try {
    return new RegExp(`^${anchoredEnd}`).test(pathWithQuery);
  } catch {
    return pathWithQuery.startsWith(pattern);
  }
}

function isPathAllowedByRobots(pathWithQuery: string, rule: RobotsRule): boolean {
  let bestAllowLen = -1;
  let bestDisallowLen = -1;
  for (const p of rule.allow) {
    if (matchesRobotsPattern(pathWithQuery, p)) {
      bestAllowLen = Math.max(bestAllowLen, p.length);
    }
  }
  for (const p of rule.disallow) {
    if (matchesRobotsPattern(pathWithQuery, p)) {
      bestDisallowLen = Math.max(bestDisallowLen, p.length);
    }
  }
  if (bestDisallowLen === -1) return true;
  return bestAllowLen >= bestDisallowLen;
}

export class RobotsPolicyManager {
  private readonly cache = new Map<string, RobotsRule | null>();
  private readonly inflight = new Map<string, Promise<RobotsRule | null>>();
  private readonly userAgent: string;
  private readonly respectRobotsTxt: boolean;
  private readonly timeoutMs: number;

  constructor(userAgent: string, respectRobotsTxt = true, timeoutMs = 8000) {
    this.userAgent = userAgent;
    this.respectRobotsTxt = respectRobotsTxt;
    this.timeoutMs = timeoutMs;
  }

  private async loadRules(origin: string, timeoutOverrideMs?: number): Promise<RobotsRule | null> {
    if (this.cache.has(origin)) return this.cache.get(origin) ?? null;
    const pending = this.inflight.get(origin);
    if (pending) return pending;

    const task = (async (): Promise<RobotsRule | null> => {
      const controller = new AbortController();
      const effectiveTimeout = Math.min(this.timeoutMs, timeoutOverrideMs ?? this.timeoutMs);
      const timer = setTimeout(() => controller.abort(), effectiveTimeout);
      try {
        const resp = await fetch(`${origin}/robots.txt`, {
          method: "GET",
          signal: controller.signal,
          headers: { "User-Agent": this.userAgent },
        });
        if (resp.status === 200) {
          const text = await resp.text();
          const rule = parseRobotsTxt(text, this.userAgent);
          this.cache.set(origin, rule);
          return rule;
        }
        if (RESTRICTED_STATUSES.has(resp.status)) {
          const denyAll: RobotsRule = { allow: [], disallow: ["/"], crawlDelaySec: null };
          this.cache.set(origin, denyAll);
          return denyAll;
        }
        this.cache.set(origin, null);
        return null;
      } catch {
        this.cache.set(origin, null);
        return null;
      } finally {
        clearTimeout(timer);
        this.inflight.delete(origin);
      }
    })();

    this.inflight.set(origin, task);
    return task;
  }

  public async canFetch(
    url: string,
    timeoutOverrideMs?: number
  ): Promise<{ allowed: boolean; crawlDelayMs: number | null; reason: string }> {
    if (!this.respectRobotsTxt) {
      return { allowed: true, crawlDelayMs: null, reason: "robots_check_disabled" };
    }
    try {
      const u = new URL(url);
      const origin = `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}`;
      const rule = await this.loadRules(origin, timeoutOverrideMs);
      if (!rule) return { allowed: true, crawlDelayMs: null, reason: "no_robots_txt" };
      const pathWithQuery = `${u.pathname}${u.search}`;
      const allowed = isPathAllowedByRobots(pathWithQuery, rule);
      const crawlDelayMs = rule.crawlDelaySec !== null ? Math.min(10_000, rule.crawlDelaySec * 1000) : null;
      return {
        allowed,
        crawlDelayMs,
        reason: allowed ? "robots_allowed" : "disallowed_by_robots_txt",
      };
    } catch {
      return { allowed: false, crawlDelayMs: null, reason: "invalid_url" };
    }
  }
}

export class DomainRateLimiter {
  private readonly minIntervalMs: number;
  private readonly nextAllowedAt = new Map<string, number>();

  constructor(requestsPerSecond: number) {
    this.minIntervalMs = Math.round(1000 / Math.max(0.2, requestsPerSecond));
  }

  public async wait(domain: string, overrideIntervalMs?: number | null, maxWaitMs?: number): Promise<boolean> {
    const interval = Math.max(this.minIntervalMs, overrideIntervalMs ?? 0);
    const now = Date.now();
    const scheduled = Math.max(now, this.nextAllowedAt.get(domain) ?? now);
    const delay = scheduled - now;
    if (maxWaitMs !== undefined && delay > maxWaitMs) {
      return false;
    }
    this.nextAllowedAt.set(domain, scheduled + interval);
    if (delay > 0) {
      await sleep(delay);
    }
    return true;
  }

  public penalize(domain: string, backoffMs: number): void {
    const until = Date.now() + Math.max(0, backoffMs);
    const cur = this.nextAllowedAt.get(domain) ?? 0;
    if (until > cur) {
      this.nextAllowedAt.set(domain, until);
    }
  }
}

export class PoliteHttpClient {
  public readonly robots: RobotsPolicyManager;
  public readonly rateLimiter: DomainRateLimiter;
  private readonly seenUrls = new Set<string>();
  private readonly opts: {
    userAgent: string;
    timeoutMs: number;
    rateLimitPerSecond: number;
    respectRobotsTxt: boolean;
    defaultMaxAttempts?: number;
  };

  constructor(opts: {
    userAgent: string;
    timeoutMs: number;
    rateLimitPerSecond: number;
    respectRobotsTxt: boolean;
    defaultMaxAttempts?: number;
  }) {
    this.opts = opts;
    this.robots = new RobotsPolicyManager(opts.userAgent, opts.respectRobotsTxt, Math.min(8000, opts.timeoutMs));
    this.rateLimiter = new DomainRateLimiter(opts.rateLimitPerSecond);
  }

  public resetDeduplication(): void {
    this.seenUrls.clear();
  }

  public async fetch(url: string, options: FetchOptions = {}): Promise<FetchResult> {
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Unsupported protocol");
      }
    } catch {
      return {
        url,
        status: 0,
        ok: false,
        content: "",
        contentType: "",
        headers: {},
        error: "invalid_url",
        blockedByRobots: false,
        skippedDuplicate: false,
        attempts: 0,
      };
    }

    const canonical = parsed.toString();
    if (options.deduplicate) {
      if (this.seenUrls.has(canonical)) {
        return {
          url: canonical,
          status: 0,
          ok: false,
          content: "",
          contentType: "",
          headers: {},
          error: "duplicate_url",
          blockedByRobots: false,
          skippedDuplicate: true,
          attempts: 0,
        };
      }
      this.seenUrls.add(canonical);
    }

    const domain = parsed.hostname.toLowerCase();
    const timeoutMs = options.timeoutMs ?? this.opts.timeoutMs;
    let crawlDelayMs: number | null = null;
    if (options.checkRobots !== false) {
      const decision = await this.robots.canFetch(canonical, Math.min(4500, timeoutMs));
      if (!decision.allowed) {
        return {
          url: canonical,
          status: 0,
          ok: false,
          content: "",
          contentType: "",
          headers: {},
          error: decision.reason,
          blockedByRobots: true,
          skippedDuplicate: false,
          attempts: 0,
        };
      }
      crawlDelayMs = decision.crawlDelayMs;
      if (
        options.maxCrawlDelayMs !== undefined &&
        crawlDelayMs !== null &&
        crawlDelayMs > options.maxCrawlDelayMs
      ) {
        return {
          url: canonical,
          status: 0,
          ok: false,
          content: "",
          contentType: "",
          headers: {},
          error: "crawl_delay_exceeds_budget",
          blockedByRobots: true,
          skippedDuplicate: false,
          attempts: 0,
        };
      }
    }

    const maxAttempts = Math.max(1, options.maxAttempts ?? this.opts.defaultMaxAttempts ?? 3);
    const ua = options.userAgent || this.opts.userAgent;

    let lastResult: FetchResult | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const slotAcquired = await this.rateLimiter.wait(domain, crawlDelayMs, options.maxCrawlDelayMs);
      if (!slotAcquired) {
        return {
          url: canonical,
          status: 0,
          ok: false,
          content: "",
          contentType: "",
          headers: {},
          error: "rate_budget_exceeded",
          blockedByRobots: false,
          skippedDuplicate: false,
          attempts: attempt - 1,
        };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetch(canonical, {
          method: "GET",
          redirect: "follow",
          signal: controller.signal,
          headers: {
            "User-Agent": ua,
            Accept: "application/json, text/html, application/xml, text/xml;q=0.9, */*;q=0.8",
            ...options.headers,
          },
        });
        clearTimeout(timer);

        const respHeaders: Record<string, string> = {};
        resp.headers.forEach((v, k) => {
          respHeaders[k.toLowerCase()] = v;
        });
        const contentType = respHeaders["content-type"] || "";
        const status = resp.status;

        if (status === 413) {
          return {
            url: resp.url || canonical,
            status,
            ok: false,
            content: "",
            contentType,
            headers: respHeaders,
            error: "payload_too_large_413",
            blockedByRobots: false,
            skippedDuplicate: false,
            attempts: attempt,
          };
        }

        if (RESTRICTED_STATUSES.has(status)) {
          // Strictly do not bypass access controls / auth gates
          return {
            url: resp.url || canonical,
            status,
            ok: false,
            content: "",
            contentType,
            headers: respHeaders,
            error: `access_restricted_http_${status}`,
            blockedByRobots: false,
            skippedDuplicate: false,
            attempts: attempt,
          };
        }

        if (RETRYABLE_STATUSES.has(status) || (status >= 500 && status <= 599)) {
          const retryAfter = parseRetryAfterMs(respHeaders["retry-after"]);
          const baseUnit = options.retryBaseDelayMs ?? 800;
          const baseBackoff = Math.min(12_000, baseUnit * Math.pow(2, attempt - 1));
          const jitter = options.retryBaseDelayMs !== undefined ? 0 : Math.floor(Math.random() * 400);
          const waitMs = retryAfter !== null ? Math.max(retryAfter, baseBackoff) : baseBackoff + jitter;
          if (status === 429) {
            this.rateLimiter.penalize(domain, waitMs);
          }
          lastResult = {
            url: resp.url || canonical,
            status,
            ok: false,
            content: "",
            contentType,
            headers: respHeaders,
            error: status === 429 ? "rate_limited_429" : `http_${status}`,
            blockedByRobots: false,
            skippedDuplicate: false,
            attempts: attempt,
          };
          if (attempt < maxAttempts) {
            await sleep(waitMs);
            continue;
          }
          return lastResult;
        }

        const content = await resp.text();
        if (!resp.ok) {
          return {
            url: resp.url || canonical,
            status,
            ok: false,
            content: content.slice(0, 500),
            contentType,
            headers: respHeaders,
            error: `http_${status}`,
            blockedByRobots: false,
            skippedDuplicate: false,
            attempts: attempt,
          };
        }

        // Respect CAPTCHA / anti-bot gates if encountered on a 200 HTML page
        if (contentType.includes("html") && content.length < 40_000 && CAPTCHA_RE.test(content)) {
          return {
            url: resp.url || canonical,
            status,
            ok: false,
            content: "",
            contentType,
            headers: respHeaders,
            error: "access_restricted_captcha",
            blockedByRobots: false,
            skippedDuplicate: false,
            attempts: attempt,
          };
        }

        return {
          url: resp.url || canonical,
          status,
          ok: true,
          content,
          contentType,
          headers: respHeaders,
          error: null,
          blockedByRobots: false,
          skippedDuplicate: false,
          attempts: attempt,
        };
      } catch (err) {
        clearTimeout(timer);
        const msg = err instanceof Error ? (err.name === "AbortError" ? "timeout" : err.message) : String(err);
        lastResult = {
          url: canonical,
          status: 0,
          ok: false,
          content: "",
          contentType: "",
          headers: {},
          error: msg,
          blockedByRobots: false,
          skippedDuplicate: false,
          attempts: attempt,
        };
        if (attempt < maxAttempts) {
          const baseUnit = options.retryBaseDelayMs ?? 600;
          await sleep(Math.min(8000, baseUnit * Math.pow(2, attempt - 1)));
          continue;
        }
        return lastResult;
      }
    }

    return (
      lastResult ?? {
        url: canonical,
        status: 0,
        ok: false,
        content: "",
        contentType: "",
        headers: {},
        error: "retry_exhausted",
        blockedByRobots: false,
        skippedDuplicate: false,
        attempts: maxAttempts,
      }
    );
  }
}
