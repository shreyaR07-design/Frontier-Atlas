import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import {
  AtlasBackendService,
  classifyJobRoleFamily,
  computeNextUtcRunIso,
  createLLMRouter,
  detectJobRemoteEligibility,
  EntityResolver,
  isWithinFreshnessWindow,
  LiveSourceVerifier,
  loadAtlasConfig,
  matchJsonItemText,
  normalizeEntityName,
  normalizeUtcTimeHHMM,
  parseUtcDatetime,
  parseUtcDatetimeWithMeta,
  probeGithubApi,
} from "../server/atlasBackend.ts";
import { AtlasDatabase } from "../server/atlasDb.ts";
import { EXPORT_SPECS, GoogleSheetsService } from "../server/googleSheets.ts";
import { PoliteHttpClient } from "../server/httpClient.ts";
import {
  FatalProviderError,
  GeminiLLMProvider,
  LLMRouter,
  OpenAICompatibleLLMProvider,
  PayloadTooLargeError,
  redactSecrets,
  TransientProviderError,
  type LLMProvider,
} from "../server/llmRouter.ts";
import {
  formatGoogleAuthError,
  GOOGLE_WORKSPACE_SCOPES,
  isGoogleOAuthBlockedMessage,
} from "../lib/googleWorkspaceAuth.ts";

async function withHttpServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

test("Multi-tier LLM fallback chain (Gemini -> Groq -> Llama 3 -> DeepSeek) with 429 retry and 413 chunking", async () => {
  let groqAttempts = 0;
  let deepseekCalls = 0;

  const server = await withHttpServer((req, res, body) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/groq") {
      groqAttempts += 1;
      if (groqAttempts === 1) {
        res.writeHead(429, { "Retry-After": "0" });
        res.end(JSON.stringify({ error: "rate limited" }));
        return;
      }
      res.writeHead(500);
      res.end(JSON.stringify({ error: "upstream outage" }));
      return;
    }
    if (req.url === "/llama3") {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "invalid token" }));
      return;
    }
    if (req.url === "/deepseek") {
      deepseekCalls += 1;
      const parsed = JSON.parse(body) as { messages?: Array<{ content?: string }> };
      const userPrompt = parsed.messages?.[1]?.content ?? "";
      if (userPrompt.length > 2400) {
        res.writeHead(413);
        res.end(JSON.stringify({ error: "payload too large" }));
        return;
      }
      const records: Array<Record<string, unknown>> = [];
      if (userPrompt.includes("AlphaForge")) {
        records.push({
          name: "AlphaForge",
          description: "AlphaForge builds verifiable agent sandboxes.",
          evidence_quote: "AlphaForge builds verifiable agent sandboxes.",
        });
      }
      if (userPrompt.includes("BetaGrid")) {
        records.push({
          name: "BetaGrid",
          description: "BetaGrid orchestrates GPU inference clusters.",
          evidence_quote: "BetaGrid orchestrates GPU inference clusters.",
        });
      }
      res.writeHead(200);
      res.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ records }) } }],
        })
      );
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });

  try {
    const failingGemini: LLMProvider = {
      providerName: "gemini",
      isConfigured: () => true,
      generateJson: async () => {
        throw new FatalProviderError("gemini unavailable in test");
      },
    };
    const router = new LLMRouter(
      [
        failingGemini,
        new OpenAICompatibleLLMProvider({
          providerName: "groq",
          apiKey: "test-groq",
          model: "llama-3.3-70b-versatile",
          endpointUrl: `${server.baseUrl}/groq`,
        }),
        new OpenAICompatibleLLMProvider({
          providerName: "llama3",
          apiKey: "test-llama3",
          model: "meta-llama/Llama-3.3-70B-Instruct",
          endpointUrl: `${server.baseUrl}/llama3`,
        }),
        new OpenAICompatibleLLMProvider({
          providerName: "deepseek",
          apiKey: "test-deepseek",
          model: "deepseek-chat",
          endpointUrl: `${server.baseUrl}/deepseek`,
        }),
      ],
      { maxInputTokens: 1200, overlapTokens: 40 }
    );

    const longSource =
      "AlphaForge builds verifiable agent sandboxes. " +
      "Additional background details on execution isolation and telemetry. ".repeat(24) +
      "\n\n" +
      "BetaGrid orchestrates GPU inference clusters. " +
      "Additional background details on cluster scheduling and throughput. ".repeat(24);

    const res = await router.extractStructured({
      category: "startups",
      sourceUrl: "https://news.example/ai-batch",
      sourceName: "test_feed",
      sourceText: longSource,
    });

    assert.equal(res.mode, "live_llm", `Errors: ${res.errors.join(" | ")}`);
    assert.equal(res.llmConnected, true);
    assert.equal(res.providerUsed, "deepseek");
    assert.ok(groqAttempts >= 2, "Expected Groq 429 retry before falling back");
    assert.ok(res.subChunksSplit >= 1, "Expected 413 to trigger recursive sub-chunk splitting");
    assert.ok(deepseekCalls >= 2, "Expected sub-chunks to be processed by DeepSeek");
    const names = res.records.map((r) => String(r.name)).sort();
    assert.deepEqual(names, ["AlphaForge", "BetaGrid"]);
    for (const rec of res.records) {
      assert.equal(rec.verification_status, "Unverified", "LLM extractions must stay Unverified until source check");
    }
  } finally {
    await server.close();
  }
});

test("LLMRouter enters honest heuristic_demo_fallback when zero keys are configured", async () => {
  const unconfigured: LLMProvider = {
    providerName: "gemini",
    isConfigured: () => false,
    generateJson: async () => {
      throw new PayloadTooLargeError("unreachable");
    },
  };
  const router = new LLMRouter([unconfigured]);
  const res = await router.extractStructured({
    category: "startups",
    sourceUrl: "https://example.org/post",
    sourceName: "demo_test",
    sourceText: "Vortex Labs builds real-time silicon compilers in Austin, TX.",
    allowHeuristicFallback: true,
  });

  assert.equal(res.mode, "heuristic_demo_fallback");
  assert.equal(res.llmConnected, false);
  assert.equal(res.providerUsed, null);
  assert.equal(res.records.length, 1);
  assert.equal(res.records[0].verification_status, "Unverified");
});

test("UTC & relative date normalization plus strict 24-hour freshness validation", () => {
  const refNow = new Date("2026-11-21T12:00:00.000Z");

  const rel = parseUtcDatetimeWithMeta("2 hours ago", refNow);
  assert.ok(rel.date);
  assert.equal(rel.precision, "relative_estimated");
  assert.equal(rel.date.toISOString(), "2026-11-21T10:00:00.000Z");
  assert.equal(isWithinFreshnessWindow(rel.date, refNow, 24).ok, true);

  const justNow = parseUtcDatetimeWithMeta("just now", refNow);
  assert.equal(justNow.precision, "relative_estimated");
  assert.equal(isWithinFreshnessWindow(justNow.date, refNow, 24).ok, true);

  const stale = parseUtcDatetime("2026-11-20T10:00:00Z", refNow);
  assert.equal(isWithinFreshnessWindow(stale, refNow, 24).ok, false);
  assert.equal(isWithinFreshnessWindow(stale, refNow, 24).reason, "older_than_freshness_window");

  const future = parseUtcDatetime("2026-11-21T13:00:00Z", refNow);
  assert.equal(isWithinFreshnessWindow(future, refNow, 24).ok, false);
  assert.equal(isWithinFreshnessWindow(future, refNow, 24).reason, "future_publication_date");

  assert.equal(parseUtcDatetime("today", refNow), null);
  assert.equal(parseUtcDatetime("recent", refNow), null);
  assert.equal(isWithinFreshnessWindow(null, refNow, 24).ok, false);
});

test("Deterministic entity resolution merges aliases and guards against false positives & domain conflicts", () => {
  assert.equal(normalizeEntityName("OpenAI Inc."), "openai");
  assert.equal(normalizeEntityName("Open AI"), "open ai");

  const resolver = new EntityResolver([]);
  const id1 = resolver.resolve({
    rawName: "OpenAI",
    entityType: "company",
    website: "https://openai.com",
    sourceUrl: "https://jobs.example/1",
  });
  const id2 = resolver.resolve({
    rawName: "OpenAI Inc.",
    entityType: "company",
    website: "https://www.openai.com/careers",
    sourceUrl: "https://jobs.example/2",
  });
  const id3 = resolver.resolve({
    rawName: "Open AI",
    entityType: "company",
    website: "https://openai.com",
    sourceUrl: "https://jobs.example/3",
  });
  assert.equal(id1, id2);
  assert.equal(id1, id3);

  // Distinct company must not falsely merge
  const idOther = resolver.resolve({
    rawName: "OpenRouter",
    entityType: "company",
    website: "https://openrouter.ai",
    sourceUrl: "https://jobs.example/4",
  });
  assert.notEqual(idOther, id1);

  // Domain conflict guard keeps same-named companies with distinct websites separate for manual review
  const horizonA = resolver.resolve({
    rawName: "Horizon AI",
    entityType: "startup",
    website: "https://horizon-alpha.ai",
    sourceUrl: "https://dir.example/a",
  });
  const horizonB = resolver.resolve({
    rawName: "Horizon AI",
    entityType: "startup",
    website: "https://horizon-beta.ai",
    sourceUrl: "https://dir.example/b",
  });
  assert.notEqual(horizonA, horizonB);

  const logs = resolver.getLogs();
  assert.ok(logs.some((l) => l.decision === "auto_merge" && l.canonical_id === id1));
  assert.ok(logs.some((l) => l.decision === "manual_review" && l.canonical_id === horizonB));
});

test("PoliteHttpClient enforces robots.txt, retries 429, and never bypasses 403 or CAPTCHA gates", async () => {
  let retryCount = 0;
  const server = await withHttpServer((req, res) => {
    if (req.url === "/robots.txt") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("User-agent: *\nDisallow: /private/\n");
      return;
    }
    if (req.url === "/private/secret") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>Should not be fetched</body></html>");
      return;
    }
    if (req.url === "/ratelimited") {
      retryCount += 1;
      if (retryCount === 1) {
        res.writeHead(429, { "Retry-After": "0" });
        res.end("slow down");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }
    if (req.url === "/forbidden") {
      res.writeHead(403, { "Content-Type": "text/html" });
      res.end("Forbidden");
      return;
    }
    if (req.url === "/captcha") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><title>Just a moment...</title><div class='cf-chl-bypass'>Verify</div></html>");
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  try {
    const client = new PoliteHttpClient({
      userAgent: "FrontierAtlasTestBot/1.0",
      timeoutMs: 4000,
      rateLimitPerSecond: 20,
      respectRobotsTxt: true,
    });

    const blocked = await client.fetch(`${server.baseUrl}/private/secret`);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.blockedByRobots, true);
    assert.equal(blocked.error, "disallowed_by_robots_txt");

    const retried = await client.fetch(`${server.baseUrl}/ratelimited`, { checkRobots: false });
    assert.equal(retried.ok, true);
    assert.equal(retried.content, "ok");
    assert.equal(retried.attempts, 2);

    const forbidden = await client.fetch(`${server.baseUrl}/forbidden`, { checkRobots: false });
    assert.equal(forbidden.ok, false);
    assert.equal(forbidden.error, "access_restricted_http_403");

    const captcha = await client.fetch(`${server.baseUrl}/captcha`, { checkRobots: false });
    assert.equal(captcha.ok, false);
    assert.equal(captcha.error, "access_restricted_captcha");
  } finally {
    await server.close();
  }
});

test("SQLite storage + 6-tab Google Sheets full export, incremental sync, and read-back verification", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-test-"));
  const dbPath = path.join(tmpDir, "atlas.db");
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const sheetValues = new Map<string, string[][]>();
  const sheetProps = EXPORT_SPECS.map((s, idx) => ({
    properties: {
      sheetId: idx + 1,
      title: s.tabName,
      gridProperties: { rowCount: 1000, columnCount: s.columns.length },
    },
  }));

  const mockServer = await withHttpServer((req, res, body) => {
    res.setHeader("Content-Type", "application/json");
    const urlPath = (req.url ?? "").split("?")[0];

    if (urlPath === "/oauth/token" && req.method === "POST") {
      res.writeHead(200);
      res.end(JSON.stringify({ access_token: "mock-token-123", expires_in: 3600 }));
      return;
    }

    if (urlPath === "/v4/spreadsheets" && req.method === "POST") {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          spreadsheetId: "mock-spreadsheet-001",
          spreadsheetUrl: "https://docs.google.com/spreadsheets/d/mock-spreadsheet-001",
          sheets: sheetProps,
        })
      );
      return;
    }

    if (urlPath === "/v4/spreadsheets/mock-spreadsheet-001" && req.method === "GET") {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          spreadsheetId: "mock-spreadsheet-001",
          spreadsheetUrl: "https://docs.google.com/spreadsheets/d/mock-spreadsheet-001",
          sheets: sheetProps,
        })
      );
      return;
    }

    if (urlPath === "/v4/spreadsheets/mock-spreadsheet-001:batchUpdate" && req.method === "POST") {
      res.writeHead(200);
      res.end(JSON.stringify({ replies: [] }));
      return;
    }

    if (urlPath === "/v4/spreadsheets/mock-spreadsheet-001/values:batchClear" && req.method === "POST") {
      sheetValues.clear();
      res.writeHead(200);
      res.end(JSON.stringify({ clearedRanges: [] }));
      return;
    }

    if (urlPath === "/v4/spreadsheets/mock-spreadsheet-001/values:batchUpdate" && req.method === "POST") {
      const payload = JSON.parse(body) as { data?: Array<{ range: string; values: unknown[][] }> };
      for (const entry of payload.data ?? []) {
        const tabMatch = entry.range.match(/^'([^']+)'!A(\d+)/);
        if (!tabMatch) continue;
        const tabName = tabMatch[1];
        const startRow = Number(tabMatch[2]);
        const existing = sheetValues.get(tabName) ?? [];
        for (let i = 0; i < entry.values.length; i++) {
          existing[startRow - 1 + i] = entry.values[i].map((v) => String(v ?? ""));
        }
        sheetValues.set(tabName, existing);
      }
      res.writeHead(200);
      res.end(JSON.stringify({ responses: [] }));
      return;
    }

    const readMatch = urlPath.match(/^\/v4\/spreadsheets\/mock-spreadsheet-001\/values\/([^/]+)$/);
    if (readMatch && req.method === "GET") {
      const rangeDecoded = decodeURIComponent(readMatch[1]);
      const tabMatch = rangeDecoded.match(/^'([^']+)'!/);
      const tabName = tabMatch?.[1] ?? "";
      const rows = sheetValues.get(tabName) ?? [];
      if (rangeDecoded.endsWith("!A:A")) {
        res.writeHead(200);
        res.end(JSON.stringify({ values: rows.map((r) => [r[0] ?? ""]) }));
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify({ values: rows }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: { message: `Unhandled mock route: ${req.method} ${req.url}` } }));
  });

  try {
    const db = new AtlasDatabase(dbPath);
    db.initializeSchema();
    const nowIso = "2026-11-21T11:00:00.000Z";

    db.upsertStartups([
      {
        startup_id: "stp_01",
        name: "Orbital Foundry",
        description: "Autonomous spacecraft.",
        website: "https://orbital.example",
        official_website: "https://orbital.example",
        industry: "Aerospace",
        location: "Pasadena, CA",
        founding_date: "2025-01-01",
        source_name: "yc_oss",
        source_url: "https://yc.example/orbital",
        source_title: "Orbital Foundry",
        collected_at: nowIso,
        last_checked_at: nowIso,
        supported_fields: ["name", "website"],
        verification_status: "Verified",
        rejection_reason: null,
        canonical_entity_id: "ent_01",
        source_metadata: {},
      },
    ]);
    db.upsertProducts([
      {
        product_id: "prd_01",
        name: "Orbital OS",
        description: "Flight software",
        website: "https://orbital.example/os",
        official_website: "https://orbital.example/os",
        category: "Robotics",
        company_name: "Orbital Foundry",
        source_name: "github",
        source_url: "https://github.com/orbital/os",
        source_title: "Orbital OS",
        collected_at: nowIso,
        last_checked_at: nowIso,
        supported_fields: ["name"],
        verification_status: "Verified",
        rejection_reason: null,
        canonical_entity_id: "ent_02",
        source_metadata: {},
      },
    ]);
    db.upsertResearchPapers([
      {
        paper_id: "pap_01",
        title: "Autonomous Docking",
        abstract: "Code at github.com/orbital/docking",
        authors: ["Ada Lovelace"],
        publication_date: "2026-11-20",
        doi: null,
        arxiv_id: "2611.00001",
        github_repository: "https://github.com/orbital/docking",
        github_stars: 42,
        official_website: null,
        source_name: "arxiv",
        source_url: "https://arxiv.org/abs/2611.00001",
        source_title: "Autonomous Docking",
        collected_at: nowIso,
        last_checked_at: nowIso,
        supported_fields: ["title"],
        verification_status: "Verified",
        rejection_reason: null,
        source_metadata: { github_metrics: { stars: 42, metrics_updated_at: nowIso } },
      },
    ]);
    db.upsertJobs([
      {
        job_id: "job_01",
        title: "ML Systems Engineer",
        company: "Orbital Foundry",
        location: "Remote",
        employment_type: "Full-Time",
        description: "Build inference kernels.",
        posted_at: nowIso,
        application_url: "https://orbital.example/jobs/1",
        official_website: null,
        source_name: "ashby:orbital",
        source_url: "https://orbital.example/jobs/1",
        source_title: "ML Systems Engineer",
        collected_at: nowIso,
        last_checked_at: nowIso,
        supported_fields: ["title", "company"],
        verification_status: "Verified",
        rejection_reason: null,
        canonical_company_id: "ent_01",
        source_metadata: {},
      },
    ]);
    db.upsertNews([
      {
        news_id: "nws_01",
        headline: "Orbital Foundry Raises Seed",
        summary: "Seed funding announced.",
        publisher: "Tech Wire",
        published_at: nowIso,
        article_url: "https://wire.example/orbital-seed",
        official_website: null,
        category: "AI",
        source_name: "tech_wire",
        source_url: "https://wire.example/rss",
        source_title: "Orbital Foundry Raises Seed",
        collected_at: nowIso,
        last_checked_at: nowIso,
        supported_fields: ["headline"],
        verification_status: "Verified",
        rejection_reason: null,
        source_metadata: {},
      },
    ]);
    db.upsertEntityMappingLogs([
      {
        mapping_id: "map_01",
        raw_name: "Orbital Foundry",
        normalized_name: "orbital foundry",
        canonical_name: "Orbital Foundry",
        canonical_id: "ent_01",
        source_url: "https://yc.example/orbital",
        match_method: "new_canonical",
        confidence: 1.0,
        decision: "new_entity",
        timestamp: nowIso,
        entity_type: "startup",
        match_reason: "Initial entity registration",
      },
    ]);
    db.saveCheckpoint("pipeline:startups", "startups", "page:2", 1);

    const unconfigured = new GoogleSheetsService(
      {
        atlasDir: tmpDir,
        rootDir: tmpDir,
        credentialsPath: null,
        credentialsJson: null,
        spreadsheetId: null,
        spreadsheetName: "Test Workbook",
      },
      db
    );
    const unconfRes = await unconfigured.exportOrSync("full");
    assert.equal(unconfRes.success, false);
    assert.equal(unconfRes.status, "Not Connected");

    const sheets = new GoogleSheetsService(
      {
        atlasDir: tmpDir,
        rootDir: tmpDir,
        credentialsPath: null,
        credentialsJson: JSON.stringify({
          client_email: "atlas-test@example.iam.gserviceaccount.com",
          private_key: pem,
        }),
        spreadsheetId: null,
        spreadsheetName: "FrontierAtlas Intelligence Test",
        apiBaseUrl: `${mockServer.baseUrl}/v4`,
        oauthTokenUrl: `${mockServer.baseUrl}/oauth/token`,
      },
      db
    );

    const fullRes = await sheets.exportOrSync("full");
    assert.equal(fullRes.success, true, fullRes.error ?? undefined);
    assert.equal(fullRes.status, "Connected");
    assert.deepEqual(Object.keys(fullRes.verifiedTabRowCounts), [
      "Startups",
      "Products",
      "Research Papers",
      "Jobs",
      "News",
      "Entity Mapping Log",
    ]);
    for (const spec of EXPORT_SPECS) {
      assert.equal(fullRes.verifiedTabRowCounts[spec.tabName], 1);
    }

    const incRes = await sheets.exportOrSync("incremental");
    assert.equal(incRes.success, true, incRes.error ?? undefined);
    assert.equal(incRes.rowsAdded, 0);
    assert.equal(incRes.rowsUpdated, 0);
    assert.equal(incRes.rowsUnchanged, 6);
  } finally {
    await mockServer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("matchJsonItemText unwraps Crossref message/items, array titles, HN objectID, and Show HN prefixes", () => {
  const crossrefList = {
    status: "ok",
    message: {
      items: [
        {
          DOI: "10.1234/llm.2026.01",
          title: ["Scalable Sparse Attention for Frontier Models"],
          author: [{ given: "Grace", family: "Hopper" }],
        },
      ],
    },
  };
  const crMatch = matchJsonItemText(
    crossrefList,
    "Scalable Sparse Attention for Frontier Models",
    null,
    "https://doi.org/10.1234/llm.2026.01"
  );
  assert.ok(crMatch);
  assert.ok(crMatch.includes("Hopper"));

  const crossrefSingle = {
    status: "ok",
    message: {
      DOI: "10.1234/single.99",
      title: ["Verifiable Agents in Practice"],
    },
  };
  assert.ok(matchJsonItemText(crossrefSingle, "Verifiable Agents in Practice"));

  const hnList = {
    hits: [
      {
        objectID: "42991234",
        title: "Show HN: TensorLint – Static Analyzer for CUDA Kernels",
        url: "https://tensorlint.example",
      },
    ],
  };
  const hnMatch = matchJsonItemText(
    hnList,
    "TensorLint – Static Analyzer for CUDA Kernels",
    null,
    "https://news.ycombinator.com/item?id=42991234"
  );
  assert.ok(hnMatch);
  assert.ok(hnMatch.includes("42991234"));
});

test("classifyJobRoleFamily and detectJobRemoteEligibility extract accurate job metadata", () => {
  assert.equal(
    classifyJobRoleFamily("Senior ML Research Scientist", "LLM Pretraining", "Train transformer architectures"),
    "Research & Science"
  );
  assert.equal(
    classifyJobRoleFamily("Staff LLM Agent Engineer", "AI", "Build RAG pipelines with tool use"),
    "ML & AI Engineering"
  );
  assert.equal(
    classifyJobRoleFamily("MLOps Platform Engineer", "Infrastructure", "Manage GPU Kubernetes clusters"),
    "Infrastructure & MLOps"
  );

  const remoteYes = detectJobRemoteEligibility("Remote (US)", "Full-Time", "Work from anywhere in North America");
  assert.equal(remoteYes.remote_eligible, true);
  assert.ok(remoteYes.evidence);

  const remoteNo = detectJobRemoteEligibility("San Francisco, CA", "Full-Time", "In-office 5 days a week on-site role");
  assert.equal(remoteNo.remote_eligible, false);
});

test("LiveSourceVerifier assigns field-level verified_fields, unverified_fields, confidence_score, and enforces strict statuses", async () => {
  const cfg = loadAtlasConfig("frontier-atlas");
  const mockRoutes: Record<string, { status: number; contentType: string; content: string; error?: string | null }> = {
    "https://vectorpulse.ai/products/launch": {
      status: 200,
      contentType: "text/html",
      content:
        "<html><head><title>VectorPulse - Fast Vector Index</title><meta name='description' content='VectorPulse provides sub-millisecond vector indexing for AI retrieval pipelines.'></head><body><h1>VectorPulse</h1><p>Built by pulse_dev.</p></body></html>",
    },
    "https://news.ycombinator.com/item?id=9001": {
      status: 200,
      contentType: "text/html",
      content: "<html><title>Show HN: VectorPulse | Hacker News</title><body>Show HN: VectorPulse by pulse_dev https://vectorpulse.ai/products/launch</body></html>",
    },
    "https://hn.algolia.com/api/v1/items/9001": {
      status: 200,
      contentType: "application/json",
      content: JSON.stringify({
        id: 9001,
        author: "pulse_dev",
        title: "Show HN: VectorPulse",
        url: "https://vectorpulse.ai/products/launch",
      }),
    },
    "https://novacompute.ai/jobs/ml": {
      status: 200,
      contentType: "text/html",
      content:
        "<html><head><title>Senior Machine Learning Engineer at NovaCompute</title></head><body><h1>Senior Machine Learning Engineer</h1><p>Company: NovaCompute. Location: Remote (US). Employment: Full-Time.</p></body></html>",
    },
    "https://openweights.ai/rss.xml": {
      status: 404,
      contentType: "text/plain",
      content: "Not Found",
      error: "http_404",
    },
    "https://openweights.ai/blog/32b": {
      status: 200,
      contentType: "text/html",
      content:
        "<html><head><title>OpenWeights Releases 32B Reasoning Model</title></head><body><article>OpenWeights Releases 32B Reasoning Model with Apache 2.0 weights and verifiable benchmark evaluations across code generation and math suites.</article></body></html>",
    },
    "https://broken-startup.ai/fail": {
      status: 500,
      contentType: "text/plain",
      content: "Internal Server Error",
      error: "http_500",
    },
  };

  const mockHttp = {
    fetch: async (url: string) => {
      const hit = mockRoutes[url];
      if (!hit) {
        return { url, status: 404, ok: false, content: "", contentType: "text/plain", headers: {}, blockedByRobots: false, error: "http_404", attempts: 1 };
      }
      return {
        url,
        status: hit.status,
        ok: hit.status >= 200 && hit.status < 300,
        content: hit.content,
        contentType: hit.contentType,
        headers: {},
        blockedByRobots: false,
        error: hit.error ?? null,
        attempts: 1,
      };
    },
  } as unknown as PoliteHttpClient;

  const verifier = new LiveSourceVerifier(cfg, mockHttp);
  const checkedAtIso = "2026-11-22T04:00:00.000Z";

  // 1. Product verified with meta description enrichment from accessible official site
  const verifiedProd = await verifier.verifyRecord(
    "products",
    {
      name: "VectorPulse",
      description: null,
      website: "https://vectorpulse.ai/products/launch",
      category: "Show HN Launch",
      company_name: "pulse_dev",
      source_name: "show_hn",
      source_url: "https://news.ycombinator.com/item?id=9001",
      collected_at: checkedAtIso,
      source_metadata: {},
    },
    { liveCheck: true, checkedAtIso }
  );
  assert.equal(verifiedProd.verification_status, "Verified");
  assert.ok(String(verifiedProd.description).includes("sub-millisecond vector indexing"));
  const prodMeta = verifiedProd.source_metadata as Record<string, unknown>;
  assert.ok((prodMeta.confidence_score as number) > 0.85);
  assert.ok((prodMeta.verified_fields as string[]).includes("description"));
  assert.deepEqual(prodMeta.unverified_fields, []);

  // 2. Non-AI job must be Rejected cleanly with non_ai_role_scope preserved
  const rejectedJob = await verifier.verifyRecord(
    "jobs",
    {
      title: "Senior Counsel, Litigation",
      company: "NovaCompute",
      location: "Remote",
      employment_type: "Full-Time",
      description: "Manage corporate litigation dockets.",
      posted_at: "2026-11-22T02:00:00.000Z",
      application_url: "https://novacompute.ai/jobs/ml",
      source_name: "arbeitnow",
      source_url: "https://novacompute.ai/jobs/ml",
      collected_at: checkedAtIso,
      source_metadata: {},
    },
    { liveCheck: true, checkedAtIso }
  );
  assert.equal(rejectedJob.verification_status, "Rejected");
  assert.ok(String(rejectedJob.rejection_reason).includes("non_ai_role_scope"));

  // 3. News item whose RSS feed returns 404 still corroborates via accessible primary article_url and captures full_text_excerpt
  const corroboratedNews = await verifier.verifyRecord(
    "news",
    {
      headline: "OpenWeights Releases 32B Reasoning Model",
      summary: null,
      publisher: "OpenWeights",
      published_at: "2026-11-22T01:00:00.000Z",
      article_url: "https://openweights.ai/blog/32b",
      category: "AI",
      source_name: "openweights_rss",
      source_url: "https://openweights.ai/rss.xml",
      collected_at: checkedAtIso,
      source_metadata: {},
    },
    { liveCheck: true, checkedAtIso }
  );
  assert.equal(corroboratedNews.verification_status, "Verified");
  const newsMeta = corroboratedNews.source_metadata as Record<string, unknown>;
  assert.equal(newsMeta.verification_mode, "live_article_corroboration");
  assert.ok(String(newsMeta.full_text_excerpt).includes("Apache 2.0 weights"));

  // 4. Failing primary source URL yields Source Unavailable with 0 confidence
  const unavailableStartup = await verifier.verifyRecord(
    "startups",
    {
      name: "BrokenCorp",
      description: "Missing upstream.",
      website: "https://broken-startup.ai/fail",
      industry: "AI",
      location: "Remote",
      source_name: "directory",
      source_url: "https://broken-startup.ai/fail",
      collected_at: checkedAtIso,
      source_metadata: {},
    },
    { liveCheck: true, checkedAtIso }
  );
  assert.equal(unavailableStartup.verification_status, "Source Unavailable");
  assert.equal((unavailableStartup.source_metadata as Record<string, unknown>).confidence_score, 0);

  // 5. Placeholder/loopback domains (127.0.0.1, example.com) must be Rejected
  const placeholderProd = await verifier.verifyRecord(
    "products",
    {
      name: "DummyApp",
      description: "Test",
      website: "https://example.com/app",
      category: "AI",
      company_name: "Dummy",
      source_name: "show_hn",
      source_url: "http://127.0.0.1:9000/item",
      collected_at: checkedAtIso,
      source_metadata: {},
    },
    { liveCheck: false, checkedAtIso }
  );
  assert.equal(placeholderProd.verification_status, "Rejected");
});

test("Task 1: Llama 3 routes through Groq when GROQ_API_KEY is set, fallback logs record reasons, and secrets are redacted", async () => {
  const cfg = loadAtlasConfig("frontier-atlas");
  cfg.geminiApiKey = null;
  cfg.groqApiKey = "gsk_secret_test_groq_1234567890";
  cfg.llama3ApiKey = null;
  cfg.llama3EndpointUrl = "https://api.groq.com/openai/v1/chat/completions";
  cfg.deepseekApiKey = null;

  const autoRouter = createLLMRouter(cfg);
  assert.deepEqual(autoRouter.configuredProviderNames(), ["groq", "llama3"]);

  const leaked = "Failed auth Bearer gsk_secret_test_groq_1234567890 key=AIzaSyDummyKey123456789012345";
  const redacted = redactSecrets(leaked);
  assert.ok(!redacted.includes("gsk_secret_test_groq"));
  assert.ok(!redacted.includes("AIzaSyDummyKey"));

  const logs: string[] = [];
  const server = await withHttpServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/groq-timeout") {
      // Delay longer than provider timeout to simulate real timeout
      setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(200);
          res.end("{}");
        }
      }, 400);
      return;
    }
    if (req.url === "/llama3-via-groq") {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  records: [
                    {
                      name: "QuarkMesh",
                      description: "QuarkMesh compiles tensor graphs.",
                      evidence_quote: "QuarkMesh compiles tensor graphs.",
                    },
                  ],
                }),
              },
            },
          ],
        })
      );
      return;
    }
    res.writeHead(401);
    res.end(JSON.stringify({ error: { message: "bad key sk-secret-abc1234567890123" } }));
  });

  try {
    const router = new LLMRouter([
      new OpenAICompatibleLLMProvider({
        providerName: "gemini",
        apiKey: "AIzaSyTestFakeKey123456789012345",
        model: "gemini-4-hydrogen",
        endpointUrl: `${server.baseUrl}/bad-gemini`,
        timeoutMs: 120,
      }),
      new OpenAICompatibleLLMProvider({
        providerName: "groq",
        apiKey: "gsk_TestFakeKey1234567890",
        model: "llama-3.3-70b-versatile",
        endpointUrl: `${server.baseUrl}/groq-timeout`,
        timeoutMs: 80,
      }),
      new OpenAICompatibleLLMProvider({
        providerName: "llama3",
        apiKey: "gsk_TestFakeKey1234567890",
        model: "llama-3.1-8b-instant",
        endpointUrl: `${server.baseUrl}/llama3-via-groq`,
        via: "groq",
        timeoutMs: 500,
      }),
    ]);

    const res = await router.extractStructured({
      category: "startups",
      sourceUrl: "https://example.ai/news",
      sourceName: "test",
      sourceText: "QuarkMesh compiles tensor graphs for multi-node inference.",
      onLog: (line) => logs.push(line),
    });

    assert.equal(res.mode, "live_llm");
    assert.equal(res.providerUsed, "llama3");
    assert.ok(res.fallbackLog.some((l) => l.includes("gemini") && l.includes("falling back to 'groq'")));
    assert.ok(res.fallbackLog.some((l) => l.includes("groq") && l.includes("timeout") && l.includes("falling back to 'llama3'")));
    assert.ok(res.fallbackLog.some((l) => l.includes("Fallback provider 'llama3' succeeded")));
    assert.ok(logs.every((l) => !l.includes("AIzaSyTestFake") && !l.includes("gsk_TestFake") && !l.includes("sk-secret")));

    const probes = await router.probeProviders({ timeoutMs: 300 });
    const byName = new Map(probes.map((p) => [p.provider, p]));
    assert.equal(byName.get("gemini")?.status, "Connection Failed");
    assert.ok(!String(byName.get("gemini")?.error).includes("sk-secret"));
    assert.equal(byName.get("groq")?.status, "Connection Failed");
    assert.equal(byName.get("llama3")?.status, "Configured");
  } finally {
    await server.close();
  }
});

test("Task 2 & Task 3: Minimal Google OAuth scopes, Google Drive/Sheets probeHealth, and GitHub REST API rate-limit probe", async () => {
  assert.deepEqual(GOOGLE_WORKSPACE_SCOPES, [
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/spreadsheets",
  ]);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-health-test-"));
  const db = new AtlasDatabase(path.join(tmpDir, "health.db"));
  db.initializeSchema();

  let sawGithubAuthHeader = "";
  const mockServer = await withHttpServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/rate_limit") {
      sawGithubAuthHeader = String(req.headers.authorization || "");
      if (sawGithubAuthHeader === "Bearer ghp_validtoken1234567890123456") {
        res.writeHead(200);
        res.end(JSON.stringify({ resources: { core: { limit: 5000, remaining: 4992, reset: 1900000000 } } }));
        return;
      }
      res.writeHead(401);
      res.end(JSON.stringify({ message: "Bad credentials" }));
      return;
    }
    if (req.url?.startsWith("/drive/files")) {
      if (req.headers.authorization === "Bearer ya29.valid_oauth_token_12345") {
        res.writeHead(200);
        res.end(JSON.stringify({ files: [{ id: "sheet_1", name: "FrontierAtlas Intelligence" }] }));
        return;
      }
      res.writeHead(401);
      res.end(JSON.stringify({ error: { message: "Invalid Credentials" } }));
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });

  try {
    const httpClient = new PoliteHttpClient({
      userAgent: "FrontierAtlasTest/1.0",
      timeoutMs: 3000,
      rateLimitPerSecond: 20,
      respectRobotsTxt: false,
    });

    const ghUnset = await probeGithubApi(httpClient, null, mockServer.baseUrl);
    assert.equal(ghUnset.status, "Not Configured");

    const ghValid = await probeGithubApi(httpClient, "ghp_validtoken1234567890123456", mockServer.baseUrl);
    assert.equal(ghValid.status, "Configured");
    assert.equal(sawGithubAuthHeader, "Bearer ghp_validtoken1234567890123456");
    assert.ok(ghValid.detail.includes("4,992/5,000"));

    const ghInvalid = await probeGithubApi(httpClient, "ghp_badtoken123456789012345678", mockServer.baseUrl);
    assert.equal(ghInvalid.status, "Connection Failed");
    assert.ok(ghInvalid.error?.includes("401"));
    assert.ok(!ghInvalid.error?.includes("ghp_badtoken"));

    const sheetsSvc = new GoogleSheetsService(
      {
        atlasDir: tmpDir,
        rootDir: tmpDir,
        credentialsPath: null,
        credentialsJson: null,
        spreadsheetId: null,
        spreadsheetName: "Test Workbook",
        apiBaseUrl: `${mockServer.baseUrl}/v4`,
        driveApiBaseUrl: `${mockServer.baseUrl}/drive`,
      },
      db
    );

    const noTokenProbe = await sheetsSvc.probeHealth();
    assert.equal(noTokenProbe.status, "Not Configured");

    const badOauthProbe = await sheetsSvc.probeHealth({ oauthAccessToken: "ya29.expired_token_999" });
    assert.equal(badOauthProbe.status, "Connection Failed");
    assert.ok(!String(badOauthProbe.error).includes("ya29.expired_token"));

    const goodOauthProbe = await sheetsSvc.probeHealth({ oauthAccessToken: "ya29.valid_oauth_token_12345" });
    assert.equal(goodOauthProbe.status, "Configured");
  } finally {
    db.close();
    await mockServer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Task 4: SQLite persistence survives close/reopen, checkpoints WAL, prevents duplicates, and handles CRUD", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-db-persist-"));
  const dbPath = path.join(tmpDir, "persist.db");
  const nowIso = "2026-11-21T12:00:00.000Z";

  try {
    const db1 = new AtlasDatabase(dbPath);
    db1.initializeSchema();

    // Insert duplicate URLs with different IDs for jobs & news to verify safe ID preservation
    db1.upsertJobs([
      {
        job_id: "job_a",
        title: "AI Engineer",
        company: "Acme AI",
        location: "Remote",
        employment_type: "Full-Time",
        description: "Build models",
        posted_at: nowIso,
        application_url: "https://acme.example/jobs/1",
        official_website: null,
        source_name: "ashby",
        source_url: "https://acme.example/jobs/1",
        source_title: "AI Engineer",
        collected_at: nowIso,
        last_checked_at: nowIso,
        supported_fields: ["title"],
        verification_status: "Verified",
        rejection_reason: null,
        canonical_company_id: null,
        source_metadata: {},
      },
      {
        job_id: "job_b_dup",
        title: "AI Engineer Updated",
        company: "Acme AI",
        location: "Remote",
        employment_type: "Full-Time",
        description: "Build models updated",
        posted_at: nowIso,
        application_url: "https://acme.example/jobs/1",
        official_website: null,
        source_name: "ashby",
        source_url: "https://acme.example/jobs/1",
        source_title: "AI Engineer",
        collected_at: nowIso,
        last_checked_at: nowIso,
        supported_fields: ["title"],
        verification_status: "Verified",
        rejection_reason: null,
        canonical_company_id: null,
        source_metadata: {},
      },
    ]);
    db1.upsertNews([
      {
        news_id: "news_a",
        headline: "Launch",
        summary: "Summary 1",
        publisher: "Wire",
        published_at: nowIso,
        article_url: "https://wire.example/launch",
        official_website: null,
        category: "AI",
        source_name: "wire",
        source_url: "https://wire.example/rss",
        source_title: "Launch",
        collected_at: nowIso,
        last_checked_at: nowIso,
        supported_fields: ["headline"],
        verification_status: "Verified",
        rejection_reason: null,
        source_metadata: {},
      },
    ]);
    db1.recordFailure({ stage: "collect", category: "news", reason: "timeout" });
    db1.recordAuditEntries([
      {
        category: "jobs",
        record_id: "job_a",
        record_name: "AI Engineer",
        previous_status: null,
        new_status: "Verified",
        issues: [],
        source_url: "https://acme.example/jobs/1",
        source_title: "AI Engineer",
        evidence_excerpt: null,
        reason: "Verified",
      },
    ]);
    db1.checkpointWal("TRUNCATE");
    db1.close();

    // Reopen fresh instance and verify all rows & CRUD survived restart
    const db2 = new AtlasDatabase(dbPath);
    const health = db2.checkHealth();
    assert.equal(health.ok, true);
    assert.equal(health.tableCounts.jobs, 1);
    assert.equal(health.tableCounts.news, 1);
    assert.equal(db2.getFailureCount(), 1);
    assert.equal(db2.fetchAuditTrail({ category: "jobs" }).length, 1);
    const jobRow = db2.fetchDataset("jobs")[0];
    assert.equal(jobRow.job_id, "job_a");
    assert.equal(jobRow.title, "AI Engineer Updated");

    const deleted = db2.deleteRecords("jobs", ["job_a"]);
    assert.equal(deleted, 1);
    assert.equal(db2.countRecords().jobs, 0);
    db2.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Task 4: Per-table CSV hydration restores missing datasets without overwriting existing SQLite tables", () => {
  const tmpAtlasDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-hydrate-test-"));
  const dataDir = path.join(tmpAtlasDir, "data");
  const exportsDir = path.join(dataDir, "exports");
  fs.mkdirSync(exportsDir, { recursive: true });
  const dbPath = path.join(dataDir, "frontier_atlas_recovered.db");
  const nowIso = "2026-11-21T12:00:00.000Z";

  const prevDbUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;

  try {
    // Seed startups table with 1 existing record BEFORE backend startup
    const seedDb = new AtlasDatabase(dbPath);
    seedDb.initializeSchema();
    seedDb.upsertStartups([
      {
        startup_id: "stp_existing",
        name: "Preserved Labs",
        description: "Must not be overwritten",
        website: "https://preserved.example",
        official_website: "https://preserved.example",
        industry: "AI",
        location: "NYC",
        founding_date: "2025-01-01",
        source_name: "manual",
        source_url: "https://preserved.example",
        source_title: "Preserved Labs",
        collected_at: nowIso,
        last_checked_at: nowIso,
        supported_fields: ["name"],
        verification_status: "Verified",
        rejection_reason: null,
        canonical_entity_id: "ent_preserved",
        source_metadata: {},
      },
    ]);
    seedDb.checkpointWal("TRUNCATE");
    seedDb.close();

    // Provide startups.csv (should be ignored since startups count > 0) AND jobs.csv + news.csv + entity_mapping_log.csv (should hydrate)
    fs.writeFileSync(
      path.join(exportsDir, "startups.csv"),
      `startup_id,name,description,website,official_website,industry,location,founding_date,source_name,source_url,source_title,collected_at,last_checked_at,supported_fields,verification_status,rejection_reason,canonical_entity_id,source_metadata_json\n` +
        `stp_csv_only,CSV Startup,Should not load,https://csv.example,https://csv.example,AI,SF,2025-01-01,csv,https://csv.example,CSV Startup,${nowIso},${nowIso},name,Verified,,ent_csv,{}\n`,
      "utf-8"
    );
    fs.writeFileSync(
      path.join(exportsDir, "jobs.csv"),
      `job_id,title,company,location,employment_type,description,posted_at,application_url,official_website,source_name,source_url,source_title,collected_at,last_checked_at,supported_fields,verification_status,rejection_reason,canonical_company_id,source_metadata_json\n` +
        `job_csv_1,ML Engineer,Preserved Labs,Remote,Full-Time,Build systems,${nowIso},https://preserved.example/jobs/1,https://preserved.example,ashby,https://preserved.example/jobs/1,ML Engineer,${nowIso},${nowIso},title;company,Verified,,ent_preserved,{}\n`,
      "utf-8"
    );
    fs.writeFileSync(
      path.join(exportsDir, "news.csv"),
      `news_id,headline,summary,publisher,published_at,article_url,official_website,category,source_name,source_url,source_title,collected_at,last_checked_at,supported_fields,verification_status,rejection_reason,source_metadata_json\n` +
        `news_csv_1,Preserved Launch,Launched today,Wire,${nowIso},https://wire.example/1,https://preserved.example,AI,wire,https://wire.example/rss,Preserved Launch,${nowIso},${nowIso},headline,Verified,,{}\n`,
      "utf-8"
    );
    fs.writeFileSync(
      path.join(exportsDir, "entity_mapping_log.csv"),
      `mapping_id,raw_name,normalized_name,canonical_name,canonical_id,source_url,match_method,confidence,decision,timestamp,entity_type,match_reason\n` +
        `map_csv_1,Preserved Labs,preserved labs,Preserved Labs,ent_preserved,https://preserved.example,exact,1,new_entity,${nowIso},startup,Initial\n`,
      "utf-8"
    );

    const svc = new AtlasBackendService(tmpAtlasDir);
    const status = svc.getStatus() as { counts: Record<string, number> };
    assert.equal(status.counts.startups, 1, "Existing startups table must remain untouched");
    assert.equal(status.counts.jobs, 1, "Empty jobs table must hydrate from jobs.csv");
    assert.equal(status.counts.news, 1, "Empty news table must hydrate from news.csv");
    assert.equal(status.counts.entity_mapping_log, 1, "Empty entity_mapping_log must hydrate from CSV");
    const startupsRows = (svc.getDataset("startups", 10) as { rows: Array<{ startup_id: string }> }).rows;
    assert.equal(startupsRows[0].startup_id, "stp_existing");
    svc.close();
  } finally {
    if (prevDbUrl !== undefined) process.env.DATABASE_URL = prevDbUrl;
    fs.rmSync(tmpAtlasDir, { recursive: true, force: true });
  }
});

test("Priority 1 & 2: Recovered production SQLite database passes PRAGMA integrity_check and preserves all 6 datasets", () => {
  const recoveredPath = path.resolve(process.cwd(), "frontier-atlas/data/frontier_atlas_recovered.db");
  if (!fs.existsSync(recoveredPath)) {
    return;
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-recovered-verify-"));
  const copyPath = path.join(tmpDir, "recovered_copy.db");
  try {
    fs.copyFileSync(recoveredPath, copyPath);
    const db = new AtlasDatabase(copyPath);
    const health = db.checkHealth();
    assert.equal(health.ok, true);
    assert.equal(health.integrityCheck, "ok");
    const counts = db.countRecords();
    assert.ok(counts.startups >= 1158, `Expected startups >= 1158, got ${counts.startups}`);
    assert.ok(counts.products >= 1149, `Expected products >= 1149, got ${counts.products}`);
    assert.ok(counts.research_papers >= 1208, `Expected research_papers >= 1208, got ${counts.research_papers}`);
    assert.ok(counts.jobs >= 94, `Expected jobs >= 94, got ${counts.jobs}`);
    assert.ok(counts.news >= 33, `Expected news >= 33, got ${counts.news}`);
    assert.ok(counts.entity_mapping_log >= 3511, `Expected entity_mapping_log >= 3511, got ${counts.entity_mapping_log}`);
    db.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Priority 3: Rolling 24h UTC window separates fresh Jobs/News/Research Papers while preserving historical archive", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-fresh24h-test-"));
  const prevDbUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;

  try {
    const db = new AtlasDatabase(path.join(tmpDir, "data", "frontier_atlas_recovered.db"));
    db.initializeSchema();

    const refNow = new Date("2026-11-22T12:00:00.000Z");
    const freshIso = "2026-11-22T06:30:00.000Z";
    const staleIso = "2026-11-19T06:30:00.000Z";

    // Seed historical archive records older than 24h alongside fresh 24h records
    db.upsertResearchPapers([
      {
        paper_id: "paper_hist_1",
        title: "Historical Transformer Scaling Archive Paper",
        abstract: "Published days ago.",
        authors: ["Alice Researcher"],
        publication_date: "2026-11-19",
        published_at: staleIso,
        doi: "10.1000/hist1",
        arxiv_id: "2611.00001",
        github_repository: "https://github.com/org/hist-repo",
        github_stars: 420,
        official_website: "https://arxiv.org/abs/2611.00001",
        source_name: "arxiv",
        source_url: "https://arxiv.org/abs/2611.00001",
        source_title: "Historical Transformer Scaling Archive Paper",
        collected_at: staleIso,
        last_checked_at: staleIso,
        supported_fields: ["title"],
        verification_status: "Verified",
        rejection_reason: null,
        source_metadata: {},
      },
      {
        paper_id: "paper_date_only",
        title: "Date Only Archive Paper Without Fabricated Time",
        abstract: "Date-only OpenAlex record.",
        authors: ["Bob Author"],
        publication_date: "2026-11-22",
        published_at: null,
        doi: "10.1000/dateonly",
        arxiv_id: null,
        github_repository: null,
        github_stars: null,
        official_website: "https://doi.org/10.1000/dateonly",
        source_name: "openalex",
        source_url: "https://doi.org/10.1000/dateonly",
        source_title: "Date Only Archive Paper",
        collected_at: freshIso,
        last_checked_at: freshIso,
        supported_fields: ["title"],
        verification_status: "Verified",
        rejection_reason: null,
        source_metadata: {},
      },
      {
        paper_id: "paper_fresh_1",
        title: "Fresh 24h Multimodal Agent Preprint",
        abstract: "Published 5.5 hours ago.",
        authors: ["Carol Scientist"],
        publication_date: "2026-11-22",
        published_at: freshIso,
        doi: null,
        arxiv_id: "2611.09999",
        github_repository: "https://github.com/org/fresh-repo",
        github_stars: 85,
        official_website: "https://arxiv.org/abs/2611.09999",
        source_name: "huggingface_daily_papers",
        source_url: "https://huggingface.co/papers/2611.09999",
        source_title: "Fresh 24h Multimodal Agent Preprint",
        collected_at: freshIso,
        last_checked_at: freshIso,
        supported_fields: ["title", "published_at"],
        verification_status: "Verified",
        rejection_reason: null,
        source_metadata: {},
      },
    ]);

    db.upsertJobs([
      {
        job_id: "job_old",
        title: "Old AI Systems Engineer",
        company: "Archive AI",
        location: "Remote",
        employment_type: "Full-Time",
        description: "Old role",
        posted_at: staleIso,
        application_url: "https://archive.example/jobs/old",
        official_website: "https://archive.example",
        source_name: "remotive",
        source_url: "https://archive.example/jobs/old",
        source_title: "Old AI Systems Engineer",
        collected_at: staleIso,
        last_checked_at: staleIso,
        supported_fields: ["title"],
        verification_status: "Verified",
        rejection_reason: null,
        canonical_company_id: null,
        source_metadata: {},
      },
      {
        job_id: "job_fresh",
        title: "Staff LLM Inference Engineer",
        company: "FreshCompute Labs",
        location: "Remote",
        employment_type: "Full-Time",
        description: "Fresh 24h AI role",
        posted_at: freshIso,
        application_url: "https://freshcompute.example/jobs/1",
        official_website: "https://freshcompute.example",
        source_name: "greenhouse",
        source_url: "https://freshcompute.example/jobs/1",
        source_title: "Staff LLM Inference Engineer",
        collected_at: freshIso,
        last_checked_at: freshIso,
        supported_fields: ["title", "posted_at"],
        verification_status: "Verified",
        rejection_reason: null,
        canonical_company_id: null,
        source_metadata: {},
      },
    ]);

    db.upsertNews([
      {
        news_id: "news_old",
        headline: "Old AI Digest",
        summary: "From 3 days ago",
        publisher: "AI Wire",
        published_at: staleIso,
        article_url: "https://wire.example/old",
        official_website: "https://wire.example",
        category: "AI News",
        source_name: "ai_wire",
        source_url: "https://wire.example/rss",
        source_title: "Old AI Digest",
        collected_at: staleIso,
        last_checked_at: staleIso,
        supported_fields: ["headline"],
        verification_status: "Verified",
        rejection_reason: null,
        source_metadata: {},
      },
      {
        news_id: "news_fresh",
        headline: "FreshCompute Releases Open Reasoning Kernel",
        summary: "Published today",
        publisher: "AI Wire",
        published_at: freshIso,
        article_url: "https://wire.example/fresh",
        official_website: "https://wire.example",
        category: "AI News",
        source_name: "hn_algolia",
        source_url: "https://hn.algolia.com/api/v1/search_by_date",
        source_title: "FreshCompute Releases Open Reasoning Kernel",
        collected_at: freshIso,
        last_checked_at: freshIso,
        supported_fields: ["headline", "published_at"],
        verification_status: "Verified",
        rejection_reason: null,
        source_metadata: {},
      },
    ]);

    const freshCounts = db.countFresh24h(24, refNow);
    assert.equal(freshCounts.research_papers, 1, "Only exact-timestamp 24h paper counts as 24h fresh");
    assert.equal(freshCounts.jobs, 1);
    assert.equal(freshCounts.news, 1);

    const allPapers = db.fetchDatasetWindow("research_papers", { limit: 100, windowHours: null, refNow });
    const freshPapers = db.fetchDatasetWindow("research_papers", { limit: 100, windowHours: 24, refNow });
    assert.equal(allPapers.length, 3, "Historical paper archive remains fully intact");
    assert.equal(freshPapers.length, 1);
    assert.equal(freshPapers[0].paper_id, "paper_fresh_1");
    const dateOnlyPaper = allPapers.find((p) => p.paper_id === "paper_date_only");
    assert.equal(dateOnlyPaper?.published_at ?? null, null, "Date-only paper must not fabricate published_at");

    const allJobs = db.fetchDatasetWindow("jobs", { limit: 100, windowHours: null, refNow });
    const freshJobs = db.fetchDatasetWindow("jobs", { limit: 100, windowHours: 24, refNow });
    assert.equal(allJobs.length, 2);
    assert.equal(freshJobs.length, 1);
    assert.equal(freshJobs[0].job_id, "job_fresh");

    const allNews = db.fetchDatasetWindow("news", { limit: 100, windowHours: null, refNow });
    const freshNews = db.fetchDatasetWindow("news", { limit: 100, windowHours: 24, refNow });
    assert.equal(allNews.length, 2);
    assert.equal(freshNews.length, 1);
    assert.equal(freshNews[0].news_id, "news_fresh");

    db.close();
  } finally {
    if (prevDbUrl !== undefined) process.env.DATABASE_URL = prevDbUrl;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Priority 3-5: Empty vs Failed source distinction, partial run status, historical preservation, entity mapping, and overlap lock", async () => {
  const tmpAtlasDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-pipeline-repair-"));
  const dataDir = path.join(tmpAtlasDir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "frontier_atlas_recovered.db");
  const prevDbUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;

  try {
    // Seed pre-existing historical paper so we prove failures never wipe existing records
    const seedDb = new AtlasDatabase(dbPath);
    seedDb.initializeSchema();
    seedDb.upsertResearchPapers([
      {
        paper_id: "paper_seed_hist",
        title: "Existing Historical Archive Paper",
        abstract: "Must never be deleted on refresh failure.",
        authors: ["Archive Author"],
        publication_date: "2026-10-01",
        published_at: "2026-10-01T00:00:00.000Z",
        doi: "10.1000/seed",
        arxiv_id: null,
        github_repository: null,
        github_stars: null,
        official_website: "https://doi.org/10.1000/seed",
        source_name: "crossref",
        source_url: "https://doi.org/10.1000/seed",
        source_title: "Existing Historical Archive Paper",
        collected_at: "2026-10-01T00:00:00.000Z",
        last_checked_at: "2026-10-01T00:00:00.000Z",
        supported_fields: ["title"],
        verification_status: "Verified",
        rejection_reason: null,
        source_metadata: {},
      },
    ]);
    seedDb.close();

    const svc = new AtlasBackendService(tmpAtlasDir);
    const nowIso = new Date().toISOString();

    // 1. Run with mixed outcomes: jobs has an empty source + a valid fresh job; news fails completely; overlap guard verified
    let holdResolve!: () => void;
    const holdPromise = new Promise<void>((resolve) => {
      holdResolve = resolve;
    });

    const partialResult = await svc.runPipeline({
      triggerType: "daily_24h",
      mode: "daily_24h",
      categories: ["jobs", "news"],
      limit: 50,
      page: 1,
      includeAllFresh24h: true,
      skipAutoSheetsSync: true,
      collectorsOverride: {
        jobs: async () => {
          // While runPipeline is actively in flight, starting a background run must conflict (HTTP 409 behavior)
          const conflictCheck = svc.startBackgroundRun({
            categories: ["jobs"],
            limit: 10,
            page: 1,
            skipAutoSheetsSync: true,
          });
          assert.equal(conflictCheck.conflict, true);
          assert.equal(conflictCheck.started, false);
          await assert.rejects(
            () =>
              svc.runPipeline({
                categories: ["jobs"],
                limit: 10,
                page: 1,
                skipAutoSheetsSync: true,
              }),
            /already in progress/i
          );
          holdResolve();
          return {
            records: [
              {
                job_id: "job_live_1",
                title: "Applied AI Engineer",
                company: "VectorFlow AI",
                location: "Remote",
                employment_type: "Full-Time",
                description: "Build LLM pipelines.",
                posted_at: nowIso,
                application_url: "https://vectorflow.example/jobs/1",
                official_website: "https://vectorflow.example",
                source_name: "greenhouse",
                source_url: "https://vectorflow.example/jobs/1",
                source_title: "Applied AI Engineer",
                collected_at: nowIso,
                last_checked_at: nowIso,
                supported_fields: ["title", "company", "posted_at"],
                verification_status: "Verified",
                rejection_reason: null,
                source_metadata: {},
              },
            ],
            errors: [],
            sourceOutcomes: [
              {
                category: "jobs",
                source: "greenhouse",
                url: "https://boards-api.greenhouse.io",
                status: "ok",
                discoveredCount: 1,
                freshCount: 1,
                retried: false,
                attempts: 1,
                httpStatus: 200,
                error: null,
              },
              {
                category: "jobs",
                source: "lever",
                url: "https://api.lever.co",
                status: "empty",
                discoveredCount: 0,
                freshCount: 0,
                retried: false,
                attempts: 1,
                httpStatus: 200,
                error: null,
              },
            ],
            hasMore: false,
          };
        },
        news: async () => ({
          records: [],
          errors: [
            {
              source: "openai_news",
              url: "https://openai.com/news/rss.xml",
              error: "HTTP 503 Service Unavailable",
            },
          ],
          sourceOutcomes: [
            {
              category: "news",
              source: "openai_news",
              url: "https://openai.com/news/rss.xml",
              status: "failed",
              discoveredCount: 0,
              freshCount: 0,
              retried: true,
              attempts: 2,
              httpStatus: 503,
              error: "HTTP 503 Service Unavailable",
            },
          ],
          hasMore: false,
        }),
      },
    });
    await holdPromise;

    assert.equal(partialResult.runStatus, "partial");

    const status = svc.getStatus() as {
      counts: Record<string, number>;
      freshCounts24h: { jobs: number; news: number; research_papers: number };
      latestRunStatus: string;
      lastSourceOutcomes: Array<{ source: string; status: string }>;
      pipelineRuns: Array<{ run_id: string; status: string; trigger_type: string }>;
    };

    // Historical research_papers seed must still be intact
    assert.equal(status.counts.research_papers, 1);
    assert.equal(status.counts.jobs, 1);
    assert.equal(status.freshCounts24h.jobs, 1);
    assert.equal(status.latestRunStatus, "partial");
    assert.equal(status.pipelineRuns.length, 1);
    assert.equal(status.pipelineRuns[0].trigger_type, "daily_24h");
    assert.equal(
      status.lastSourceOutcomes.find((s) => s.source === "lever")?.status,
      "empty",
      "Healthy 200 feed with 0 items must be recorded as empty, not failed"
    );
    assert.equal(
      status.lastSourceOutcomes.find((s) => s.source === "openai_news")?.status,
      "failed"
    );

    // Priority 4: Entity mapping log persisted for job company
    assert.ok(status.counts.entity_mapping_log >= 1, "Entity mapping log must persist job company resolution");
    const mappings = svc.getDataset("entity_mapping_log", 20) as {
      rows: Array<{ raw_name: string; canonical_name: string; match_method: string; confidence: number }>;
    };
    assert.equal(mappings.rows[0].raw_name, "VectorFlow AI");
    assert.ok(mappings.rows[0].canonical_name);
    assert.ok(typeof mappings.rows[0].confidence === "number");

    // 2. Test scheduler configuration & UTC next-run calculation & restart recovery
    assert.equal(normalizeUtcTimeHHMM("2:05"), "02:05");
    assert.equal(
      computeNextUtcRunIso("02:00", new Date("2026-11-22T01:30:00.000Z"), null),
      "2026-11-22T02:00:00.000Z"
    );
    assert.equal(
      computeNextUtcRunIso("02:00", new Date("2026-11-22T03:00:00.000Z"), null),
      "2026-11-23T02:00:00.000Z"
    );
    const updatedSched = svc.updateSchedulerConfig({ enabled: true, utcTime: "04:15" });
    assert.equal(updatedSched.utc_time, "04:15");
    assert.equal(updatedSched.enabled, true);

    // Test interrupted run recovery on restart
    const restartDb = new AtlasDatabase(dbPath);
    restartDb.createPipelineRun({
      runId: "run_interrupted_sim",
      triggerType: "scheduled",
      mode: "daily_24h",
      categories: ["jobs"],
      startedAt: nowIso,
      historicalCounts: {},
      fresh24hCounts: {},
    });
    const fixedCount = restartDb.markInterruptedRunsFailed("Server restarted");
    assert.equal(fixedCount, 1);
    const runsAfterRestart = restartDb.fetchPipelineRuns(10);
    const interruptedRow = runsAfterRestart.find((r) => r.run_id === "run_interrupted_sim");
    assert.equal(interruptedRow?.status, "failed");
    restartDb.close();

    svc.close();
  } finally {
    if (prevDbUrl !== undefined) process.env.DATABASE_URL = prevDbUrl;
    fs.rmSync(tmpAtlasDir, { recursive: true, force: true });
  }
});

test("Google Workspace OAuth 401/scope validation, honest Not Connected status, batched 6-tab export, and duplicate-free re-export", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-oauth-sheets-test-"));
  const dbPath = path.join(tmpDir, "oauth_sheets.db");
  const nowIso = "2026-11-22T06:00:00.000Z";

  const sheetValues = new Map<string, string[][]>();
  const sheetProps = EXPORT_SPECS.map((s, idx) => ({
    properties: {
      sheetId: idx + 1,
      title: s.tabName,
      gridProperties: { rowCount: 1000, columnCount: s.columns.length },
    },
  }));

  let batchUpdateCallCount = 0;
  let forceJobsVerifyMismatch = false;
  let lastAuthSeen = "";

  const mockServer = await withHttpServer((req, res, body) => {
    res.setHeader("Content-Type", "application/json");
    const urlPath = (req.url ?? "").split("?")[0];

    if (urlPath === "/tokeninfo" && req.method === "POST") {
      const params = new URLSearchParams(body);
      const token = params.get("access_token") ?? "";
      if (token === "ya29.valid_full_scopes_token_0001") {
        res.writeHead(200);
        res.end(
          JSON.stringify({
            email: "tester@example.com",
            expires_in: "3550",
            scope: "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets",
          })
        );
        return;
      }
      if (token === "ya29.missing_sheets_scope_token_0002") {
        res.writeHead(200);
        res.end(
          JSON.stringify({
            email: "tester@example.com",
            expires_in: "3550",
            scope: "https://www.googleapis.com/auth/drive.file",
          })
        );
        return;
      }
      res.writeHead(400);
      res.end(JSON.stringify({ error: "invalid_token", error_description: "Token expired or revoked" }));
      return;
    }

    lastAuthSeen = String(req.headers.authorization || "");
    if (lastAuthSeen !== "Bearer ya29.valid_full_scopes_token_0001") {
      res.writeHead(401);
      res.end(JSON.stringify({ error: { message: "Request had invalid authentication credentials." } }));
      return;
    }

    if (urlPath === "/drive/files" && req.method === "GET") {
      res.writeHead(200);
      res.end(JSON.stringify({ files: [] }));
      return;
    }

    if (urlPath === "/v4/spreadsheets" && req.method === "POST") {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          spreadsheetId: "oauth-sheet-001",
          spreadsheetUrl: "https://docs.google.com/spreadsheets/d/oauth-sheet-001",
          sheets: sheetProps,
        })
      );
      return;
    }

    if (urlPath === "/v4/spreadsheets/oauth-sheet-001" && req.method === "GET") {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          spreadsheetId: "oauth-sheet-001",
          spreadsheetUrl: "https://docs.google.com/spreadsheets/d/oauth-sheet-001",
          sheets: sheetProps,
        })
      );
      return;
    }

    if (urlPath === "/v4/spreadsheets/oauth-sheet-001:batchUpdate" && req.method === "POST") {
      res.writeHead(200);
      res.end(JSON.stringify({ replies: [] }));
      return;
    }

    if (urlPath === "/v4/spreadsheets/oauth-sheet-001/values:batchClear" && req.method === "POST") {
      sheetValues.clear();
      res.writeHead(200);
      res.end(JSON.stringify({ clearedRanges: [] }));
      return;
    }

    if (urlPath === "/v4/spreadsheets/oauth-sheet-001/values:batchUpdate" && req.method === "POST") {
      batchUpdateCallCount += 1;
      const payload = JSON.parse(body) as { data?: Array<{ range: string; values: unknown[][] }> };
      for (const entry of payload.data ?? []) {
        const tabMatch = entry.range.match(/^'([^']+)'!A(\d+)/);
        if (!tabMatch) continue;
        const tabName = tabMatch[1];
        const startRow = Number(tabMatch[2]);
        const existing = sheetValues.get(tabName) ?? [];
        for (let i = 0; i < entry.values.length; i++) {
          existing[startRow - 1 + i] = entry.values[i].map((v) => String(v ?? ""));
        }
        sheetValues.set(tabName, existing);
      }
      res.writeHead(200);
      res.end(JSON.stringify({ responses: [] }));
      return;
    }

    const readMatch = urlPath.match(/^\/v4\/spreadsheets\/oauth-sheet-001\/values\/([^/]+)$/);
    if (readMatch && req.method === "GET") {
      const rangeDecoded = decodeURIComponent(readMatch[1]);
      const tabMatch = rangeDecoded.match(/^'([^']+)'!/);
      const tabName = tabMatch?.[1] ?? "";
      const rows = sheetValues.get(tabName) ?? [];
      if (forceJobsVerifyMismatch && tabName === "Jobs") {
        res.writeHead(200);
        res.end(JSON.stringify({ values: rows.slice(0, 1) }));
        return;
      }
      if (rangeDecoded.endsWith("!A:A")) {
        res.writeHead(200);
        res.end(JSON.stringify({ values: rows.map((r) => [r[0] ?? ""]) }));
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify({ values: rows }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: { message: "Not found" } }));
  });

  try {
    const db = new AtlasDatabase(dbPath);
    db.initializeSchema();

    // Seed 300 startups to exercise multi-batch pagination (batchSize = 250) + 1 record in each remaining tab
    const bulkStartups = Array.from({ length: 300 }, (_, i) => ({
      startup_id: `stp_${String(i).padStart(3, "0")}`,
      name: `Startup ${i}`,
      description: `AI startup ${i}`,
      website: `https://startup${i}.example`,
      official_website: `https://startup${i}.example`,
      industry: "AI",
      location: "San Francisco, CA",
      founding_date: "2025-01-01",
      source_name: "yc_oss",
      source_url: `https://yc.example/startup-${i}`,
      source_title: `Startup ${i}`,
      collected_at: nowIso,
      last_checked_at: nowIso,
      supported_fields: ["name"],
      verification_status: "Verified" as const,
      rejection_reason: null,
      canonical_entity_id: `ent_${i}`,
      source_metadata: {},
    }));
    db.upsertStartups(bulkStartups);
    db.upsertProducts([
      {
        product_id: "prd_oauth_1",
        name: "Atlas Studio",
        description: "Vector product",
        website: "https://atlas.example/studio",
        official_website: "https://atlas.example/studio",
        category: "AI Tools",
        company_name: "Startup 0",
        source_name: "github",
        source_url: "https://github.com/atlas/studio",
        source_title: "Atlas Studio",
        collected_at: nowIso,
        last_checked_at: nowIso,
        supported_fields: ["name"],
        verification_status: "Verified",
        rejection_reason: null,
        canonical_entity_id: "ent_0",
        source_metadata: {},
      },
    ]);
    db.upsertResearchPapers([
      {
        paper_id: "pap_oauth_1",
        title: "Reliable OAuth Pipelines",
        abstract: "Paper abstract",
        authors: ["Grace Hopper"],
        publication_date: "2026-11-22",
        doi: null,
        arxiv_id: "2611.12345",
        github_repository: null,
        github_stars: null,
        official_website: null,
        source_name: "arxiv",
        source_url: "https://arxiv.org/abs/2611.12345",
        source_title: "Reliable OAuth Pipelines",
        collected_at: nowIso,
        last_checked_at: nowIso,
        supported_fields: ["title"],
        verification_status: "Verified",
        rejection_reason: null,
        source_metadata: {},
      },
    ]);
    db.upsertJobs([
      {
        job_id: "job_oauth_1",
        title: "Senior AI Platform Engineer",
        company: "Startup 0",
        location: "Remote",
        employment_type: "Full-Time",
        description: "Build pipelines",
        posted_at: nowIso,
        application_url: "https://startup0.example/jobs/1",
        official_website: null,
        source_name: "greenhouse",
        source_url: "https://startup0.example/jobs/1",
        source_title: "Senior AI Platform Engineer",
        collected_at: nowIso,
        last_checked_at: nowIso,
        supported_fields: ["title"],
        verification_status: "Verified",
        rejection_reason: null,
        canonical_company_id: "ent_0",
        source_metadata: {},
      },
    ]);
    db.upsertNews([
      {
        news_id: "nws_oauth_1",
        headline: "Frontier AI Open Release",
        summary: "Summary",
        publisher: "AI Wire",
        published_at: nowIso,
        article_url: "https://wire.example/release",
        official_website: null,
        category: "AI",
        source_name: "ai_wire",
        source_url: "https://wire.example/rss",
        source_title: "Frontier AI Open Release",
        collected_at: nowIso,
        last_checked_at: nowIso,
        supported_fields: ["headline"],
        verification_status: "Verified",
        rejection_reason: null,
        source_metadata: {},
      },
    ]);
    db.upsertEntityMappingLogs([
      {
        mapping_id: "map_oauth_1",
        raw_name: "Startup 0",
        normalized_name: "startup 0",
        canonical_name: "Startup 0",
        canonical_id: "ent_0",
        source_url: "https://yc.example/startup-0",
        match_method: "exact",
        confidence: 1.0,
        decision: "exact_match",
        timestamp: nowIso,
        entity_type: "startup",
        match_reason: "Exact domain match",
      },
    ]);

    const svc = new GoogleSheetsService(
      {
        atlasDir: tmpDir,
        rootDir: tmpDir,
        credentialsPath: null,
        credentialsJson: null,
        spreadsheetId: null,
        spreadsheetName: "FrontierAtlas OAuth Test",
        apiBaseUrl: `${mockServer.baseUrl}/v4`,
        driveApiBaseUrl: `${mockServer.baseUrl}/drive`,
        tokenInfoUrl: `${mockServer.baseUrl}/tokeninfo`,
      },
      db
    );

    // 1. Missing token => Not Connected + authRequired
    const missingVerify = await svc.verifyConnection();
    assert.equal(missingVerify.status, "Not Connected");
    assert.equal(missingVerify.authRequired, true);

    // 2. Expired/invalid token => Sync Failed + authRequired=true + secrets redacted
    const expiredVerify = await svc.verifyConnection({ oauthAccessToken: "ya29.expired_invalid_0000" });
    assert.equal(expiredVerify.status, "Sync Failed");
    assert.equal(expiredVerify.authRequired, true);
    assert.ok(!String(expiredVerify.lastError).includes("ya29.expired_invalid"));

    // 3. Missing required Sheets scope => Sync Failed with scope error
    const missingScopeVerify = await svc.verifyConnection({ oauthAccessToken: "ya29.missing_sheets_scope_token_0002" });
    assert.equal(missingScopeVerify.status, "Sync Failed");
    assert.ok(String(missingScopeVerify.lastError).includes("missing required permissions"));

    // 4. Valid OAuth token => Connected after live Drive API succeeds
    const validVerify = await svc.verifyConnection({ oauthAccessToken: "ya29.valid_full_scopes_token_0001" });
    assert.equal(validVerify.status, "Connected");
    assert.equal(validVerify.authRequired, false);
    assert.equal(validVerify.verifiedAccountEmail, "tester@example.com");

    // 5. Partial verification failure => success=false and spreadsheetUrl is null (never shown before full verification)
    forceJobsVerifyMismatch = true;
    const partialFail = await svc.exportOrSync("full", { oauthAccessToken: "ya29.valid_full_scopes_token_0001" });
    assert.equal(partialFail.success, false);
    assert.equal(partialFail.spreadsheetUrl, null);
    assert.equal(partialFail.tabStatuses["Jobs"].status, "failed");
    assert.equal(svc.getStatus().status, "Sync Failed");
    forceJobsVerifyMismatch = false;

    // 6. Full export with valid OAuth token => creates spreadsheet, batches 300 rows, verifies all 6 tabs
    const fullExport = await svc.exportOrSync("full", { oauthAccessToken: "ya29.valid_full_scopes_token_0001" });
    assert.equal(fullExport.success, true, fullExport.error ?? undefined);
    assert.equal(fullExport.status, "Connected");
    assert.equal(fullExport.spreadsheetId, "oauth-sheet-001");
    assert.equal(fullExport.spreadsheetUrl, "https://docs.google.com/spreadsheets/d/oauth-sheet-001");
    assert.equal(fullExport.verifiedTabRowCounts["Startups"], 300);
    assert.equal(fullExport.verifiedTabRowCounts["Products"], 1);
    assert.equal(fullExport.verifiedTabRowCounts["Research Papers"], 1);
    assert.equal(fullExport.verifiedTabRowCounts["Jobs"], 1);
    assert.equal(fullExport.verifiedTabRowCounts["News"], 1);
    assert.equal(fullExport.verifiedTabRowCounts["Entity Mapping Log"], 1);
    assert.ok(batchUpdateCallCount >= 2, "Batched writes should split >250 rows across ranges cleanly");

    // 7. Re-export & incremental sync preserve existing records with zero duplicates
    const secondExport = await svc.exportOrSync("full", { oauthAccessToken: "ya29.valid_full_scopes_token_0001" });
    assert.equal(secondExport.success, true);
    assert.equal(secondExport.verifiedTabRowCounts["Startups"], 300);
    const incSync = await svc.exportOrSync("incremental", { oauthAccessToken: "ya29.valid_full_scopes_token_0001" });
    assert.equal(incSync.success, true);
    assert.equal(incSync.rowsAdded, 0);
    assert.equal(incSync.rowsUnchanged, 305);

    // 8. Fresh server restart instance must NOT report stale Connected from SQLite until a real API request succeeds
    const restartedSvc = new GoogleSheetsService(
      {
        atlasDir: tmpDir,
        rootDir: tmpDir,
        credentialsPath: null,
        credentialsJson: null,
        spreadsheetId: null,
        spreadsheetName: "FrontierAtlas OAuth Test",
        apiBaseUrl: `${mockServer.baseUrl}/v4`,
        driveApiBaseUrl: `${mockServer.baseUrl}/drive`,
        tokenInfoUrl: `${mockServer.baseUrl}/tokeninfo`,
      },
      db
    );
    const coldStatus = restartedSvc.getStatus();
    assert.equal(coldStatus.status, "Not Connected");
    assert.equal(coldStatus.authRequired, true);
    assert.equal(coldStatus.spreadsheetId, "oauth-sheet-001");

    // 9. Explicit missing spreadsheetId fails with 404, while stale implicit saved spreadsheetId clears gracefully
    const explicitMissing = await restartedSvc.verifyConnection({
      oauthAccessToken: "ya29.valid_full_scopes_token_0001",
      spreadsheetId: "nonexistent-sheet-999",
    });
    assert.equal(explicitMissing.status, "Sync Failed");
    assert.ok(String(explicitMissing.lastError).includes("404"));

    db.saveSheetsSyncState({
      status: "Connected",
      spreadsheetId: "deleted-implicit-sheet-000",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/deleted-implicit-sheet-000",
      lastSyncMode: "full",
      lastAttemptAt: nowIso,
      lastSuccessAt: nowIso,
      tabRowCounts: {},
      rowsAdded: 0,
      rowsUpdated: 0,
      rowsUnchanged: 0,
      lastError: null,
    });
    const staleClearedVerify = await restartedSvc.verifyConnection({
      oauthAccessToken: "ya29.valid_full_scopes_token_0001",
    });
    assert.equal(staleClearedVerify.status, "Connected");
    assert.equal(staleClearedVerify.spreadsheetId, null);

    db.close();
  } finally {
    await mockServer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("PoliteHttpClient handles HTTP 413 immediately without wasted retries and retries HTTP 429 cleanly", async () => {
  let req413Count = 0;
  let req429Count = 0;

  const server = await withHttpServer((req, res) => {
    if (req.url === "/too-large") {
      req413Count += 1;
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Payload too large" }));
      return;
    }
    if (req.url === "/rate-limited") {
      req429Count += 1;
      if (req429Count === 1) {
        res.writeHead(429, { "Retry-After": "0", "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Too many requests" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  try {
    const client = new PoliteHttpClient({
      userAgent: "FrontierAtlasTest/1.0",
      timeoutMs: 4000,
      rateLimitPerSecond: 100,
      respectRobotsTxt: false,
      defaultMaxAttempts: 3,
    });

    const res413 = await client.fetch(`${server.baseUrl}/too-large`, { checkRobots: false });
    assert.equal(res413.ok, false);
    assert.equal(res413.status, 413);
    assert.equal(res413.error, "payload_too_large_413");
    assert.equal(req413Count, 1, "HTTP 413 must not waste retry attempts");

    const res429 = await client.fetch(`${server.baseUrl}/rate-limited`, { checkRobots: false });
    assert.equal(res429.ok, true);
    assert.equal(res429.status, 200);
    assert.equal(req429Count, 2, "HTTP 429 should retry and succeed");
  } finally {
    await server.close();
  }
});

test("Gemini 503 failover to fallbackModel & LLMRouter skipping unconfigured providers", async () => {
  const calls: string[] = [];
  const server = await withHttpServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/groq") {
      calls.push("groq");
      res.writeHead(503);
      res.end(JSON.stringify({ error: "503 Service Unavailable - high demand" }));
      return;
    }
    if (req.url === "/deepseek") {
      calls.push("deepseek");
      res.writeHead(200);
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  records: [
                    {
                      name: "VectorGuard",
                      description: "VectorGuard builds verified AI guardrails.",
                      evidence_quote: "VectorGuard builds verified AI guardrails.",
                    },
                  ],
                }),
              },
            },
          ],
        })
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  try {
    // 1. Verify GeminiLLMProvider handles 503 UNAVAILABLE error via fallbackModel when primary throws 503
    const gemini = new GeminiLLMProvider("fake-test-key", "gemini-4-hydrogen", 5000, "gemini-3.1-flash-lite");
    const geminiModelsTried: string[] = [];
    (gemini as unknown as {
      generateWithModel: (
        modelName: string,
        prompt: string,
        systemInstruction: string,
        timeoutMs: number
      ) => Promise<Record<string, unknown>>;
    }).generateWithModel = async (modelName: string) => {
      geminiModelsTried.push(modelName);
      if (modelName === "gemini-4-hydrogen") {
        throw new TransientProviderError(
          "gemini service unavailable (503) on gemini-4-hydrogen: 503 UNAVAILABLE high demand"
        );
      }
      return { ok: true, modelUsed: modelName };
    };
    const geminiRes = await gemini.generateJson('Return {"ok": true}');
    assert.deepEqual(geminiModelsTried, ["gemini-4-hydrogen", "gemini-3.1-flash-lite"]);
    assert.equal(geminiRes.modelUsed, "gemini-3.1-flash-lite");

    // 2. Verify LLMRouter skips unconfigured Llama 3 and falls back Gemini (503) -> Groq (503) -> DeepSeek (200)
    const failingGemini503: LLMProvider = {
      providerName: "gemini",
      model: "gemini-4-hydrogen",
      isConfigured: () => true,
      generateJson: async () => {
        calls.push("gemini");
        throw new TransientProviderError("gemini service unavailable (503): UNAVAILABLE");
      },
    };
    const groqProvider = new OpenAICompatibleLLMProvider({
      providerName: "groq",
      apiKey: "gsk_test_0001",
      model: "llama-3.3-70b-versatile",
      endpointUrl: `${server.baseUrl}/groq`,
    });
    const unconfiguredLlama3 = new OpenAICompatibleLLMProvider({
      providerName: "llama3",
      apiKey: null,
      model: "llama-3.1-70b-instruct",
      endpointUrl: `${server.baseUrl}/llama3-should-not-be-called`,
    });
    const deepseekProvider = new OpenAICompatibleLLMProvider({
      providerName: "deepseek",
      apiKey: "sk-deepseek-test-0001",
      model: "deepseek-chat",
      endpointUrl: `${server.baseUrl}/deepseek`,
    });

    const router = new LLMRouter([failingGemini503, groqProvider, unconfiguredLlama3, deepseekProvider]);
    assert.deepEqual(router.configuredProviderNames(), ["gemini", "groq", "deepseek"]);

    const extraction = await router.extractStructured({
      category: "startups",
      sourceUrl: "https://example.com/startups",
      sourceName: "example",
      sourceText: "VectorGuard builds verified AI guardrails for production deployments.",
    });

    assert.equal(extraction.mode, "live_llm");
    assert.equal(extraction.providerUsed, "deepseek");
    assert.ok(calls.includes("gemini"));
    assert.ok(calls.includes("groq"));
    assert.ok(calls.includes("deepseek"));
    assert.equal(extraction.records.length, 1);
    assert.equal(extraction.records[0].name, "VectorGuard");
  } finally {
    await server.close();
  }
});

test("Pipeline tracks newRecordsCounts accurately across duplicate re-runs and preserves historical counts on failure", async () => {
  const tmpAtlasDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-new-counts-"));
  const dataDir = path.join(tmpAtlasDir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const prevDbUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;

  try {
    const svc = new AtlasBackendService(tmpAtlasDir);
    const nowIso = new Date().toISOString();

    const makeJobCollector = () => async () => ({
      records: [
        {
          job_id: "job_dedup_run_1",
          title: "Principal AI Reliability Engineer",
          company: "Apex Systems AI",
          location: "Remote",
          employment_type: "Full-Time",
          description: "Maintain resilient AI pipelines.",
          posted_at: nowIso,
          application_url: "https://apex.example/jobs/1",
          official_website: "https://apex.example",
          source_name: "greenhouse",
          source_url: "https://apex.example/jobs/1",
          source_title: "Principal AI Reliability Engineer",
          collected_at: nowIso,
          last_checked_at: nowIso,
          supported_fields: ["title", "company", "posted_at"],
          verification_status: "Verified" as const,
          rejection_reason: null,
          source_metadata: {},
        },
      ],
      errors: [],
      sourceOutcomes: [
        {
          category: "jobs" as const,
          source: "greenhouse",
          url: "https://boards-api.greenhouse.io",
          status: "ok" as const,
          discoveredCount: 1,
          freshCount: 1,
          retried: false,
          attempts: 1,
          httpStatus: 200,
          error: null,
        },
      ],
      hasMore: false,
    });

    type RunShape = {
      runStatus: string;
      newRecordsCounts: Record<string, number>;
      databaseCounts: Record<string, number>;
    };
    const r1 = (await svc.runPipeline({
      triggerType: "manual",
      mode: "full",
      categories: ["jobs"],
      limit: 10,
      page: 1,
      skipAutoSheetsSync: true,
      collectorsOverride: { jobs: makeJobCollector() },
    })) as RunShape;
    assert.equal(r1.newRecordsCounts.jobs, 1);
    assert.equal(r1.databaseCounts.jobs, 1);

    // Run 2: same job collected again -> 0 newly inserted rows, historical count remains 1
    const r2 = (await svc.runPipeline({
      triggerType: "manual",
      mode: "full",
      categories: ["jobs"],
      limit: 10,
      page: 1,
      skipAutoSheetsSync: true,
      collectorsOverride: { jobs: makeJobCollector() },
    })) as RunShape;
    assert.equal(r2.newRecordsCounts.jobs, 0);
    assert.equal(r2.databaseCounts.jobs, 1);

    // Run 3: failing collector -> 0 new rows, historical count stays 1 (never overwritten with 0)
    const r3 = (await svc.runPipeline({
      triggerType: "daily_24h",
      mode: "daily_24h",
      categories: ["jobs"],
      limit: 10,
      page: 1,
      skipAutoSheetsSync: true,
      collectorsOverride: {
        jobs: async () => ({
          records: [],
          errors: [{ source: "greenhouse", url: "https://boards-api.greenhouse.io", error: "HTTP 503" }],
          sourceOutcomes: [
            {
              category: "jobs",
              source: "greenhouse",
              url: "https://boards-api.greenhouse.io",
              status: "failed",
              discoveredCount: 0,
              freshCount: 0,
              retried: true,
              attempts: 2,
              httpStatus: 503,
              error: "HTTP 503",
            },
          ],
          hasMore: false,
        }),
      },
    })) as RunShape;
    assert.equal(r3.runStatus, "failed");
    assert.equal(r3.newRecordsCounts.jobs, 0);
    assert.equal(r3.databaseCounts.jobs, 1);

    const status = svc.getStatus() as {
      counts: Record<string, number>;
      latestRunNewCounts: Record<string, number>;
      pipelineRuns: Array<{ new_records_counts?: Record<string, number> }>;
    };
    assert.equal(status.counts.jobs, 1);
    assert.equal(status.latestRunNewCounts.jobs, 0);
    assert.equal(status.pipelineRuns.length, 3);
    assert.equal(status.pipelineRuns[2].new_records_counts?.jobs, 1);
    assert.equal(status.pipelineRuns[1].new_records_counts?.jobs, 0);

    svc.close();
  } finally {
    if (prevDbUrl !== undefined) process.env.DATABASE_URL = prevDbUrl;
    fs.rmSync(tmpAtlasDir, { recursive: true, force: true });
  }
});

test("Unique qualified record counting excludes Rejected rows and deduplicates canonical entities and papers", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-unique-cnt-"));
  const db = new AtlasDatabase(path.join(tmpDir, "unique.db"));
  const nowIso = "2026-11-22T06:00:00.000Z";
  try {
    db.initializeSchema();
    db.upsertStartups([
      {
        startup_id: "stp_u1",
        name: "Orbital AI",
        description: "Desc",
        website: "https://orbital.ai",
        official_website: "https://orbital.ai",
        industry: "AI",
        location: "SF",
        founding_date: "2025-01-01",
        source_name: "yc",
        source_url: "https://yc.example/orbital-1",
        source_title: "Orbital AI",
        collected_at: nowIso,
        last_checked_at: nowIso,
        supported_fields: ["name"],
        verification_status: "Verified",
        rejection_reason: null,
        canonical_entity_id: "ent_orbital",
        source_metadata: {},
      },
      {
        // Same canonical_entity_id via another directory URL -> counts as 1 unique startup
        startup_id: "stp_u2",
        name: "Orbital AI Inc.",
        description: "Desc",
        website: "https://orbital.ai",
        official_website: "https://orbital.ai",
        industry: "AI",
        location: "SF",
        founding_date: "2025-01-01",
        source_name: "hn",
        source_url: "https://hn.example/orbital-2",
        source_title: "Orbital AI",
        collected_at: nowIso,
        last_checked_at: nowIso,
        supported_fields: ["name"],
        verification_status: "Verified",
        rejection_reason: null,
        canonical_entity_id: "ent_orbital",
        source_metadata: {},
      },
      {
        // Rejected row must be excluded from qualified unique count
        startup_id: "stp_u3",
        name: "Fake Co",
        description: null,
        website: null,
        official_website: null,
        industry: "Unknown",
        location: "Unknown",
        founding_date: null,
        source_name: "bad",
        source_url: "https://bad.example/fake",
        source_title: null,
        collected_at: nowIso,
        last_checked_at: nowIso,
        supported_fields: [],
        verification_status: "Rejected",
        rejection_reason: "fabricated",
        canonical_entity_id: "ent_fake",
        source_metadata: {},
      },
    ]);

    db.upsertProducts([
      {
        product_id: "prd_u1",
        name: "TensorBench",
        description: "Benchmarks",
        website: "https://tensorbench.dev",
        official_website: "https://tensorbench.dev",
        category: "Benchmarks",
        company_name: "Orbital AI",
        source_name: "github",
        source_url: "https://github.com/orbital/tensorbench",
        source_title: "TensorBench",
        collected_at: nowIso,
        last_checked_at: nowIso,
        supported_fields: ["name"],
        verification_status: "Verified",
        rejection_reason: null,
        canonical_entity_id: "ent_tb",
        source_metadata: {},
      },
      {
        product_id: "prd_u2",
        name: "Rejected Tool",
        description: null,
        website: null,
        official_website: null,
        category: "Unknown",
        company_name: "Unknown",
        source_name: "bad",
        source_url: "https://bad.example/prd",
        source_title: null,
        collected_at: nowIso,
        last_checked_at: nowIso,
        supported_fields: [],
        verification_status: "Rejected",
        rejection_reason: "spam",
        canonical_entity_id: "ent_bad_prd",
        source_metadata: {},
      },
    ]);

    db.upsertResearchPapers([
      {
        paper_id: "pap_u1",
        title: "Sparse Kernels",
        abstract: "Fast GPU kernels.",
        authors: ["Alice"],
        publication_date: "2026-11-21",
        published_at: nowIso,
        doi: "10.1000/sparse",
        arxiv_id: "2611.99999",
        github_repository: null,
        github_stars: null,
        official_website: null,
        source_name: "arxiv",
        source_url: "https://arxiv.org/abs/2611.99999",
        source_title: "Sparse Kernels",
        collected_at: nowIso,
        last_checked_at: nowIso,
        supported_fields: ["title"],
        verification_status: "Verified",
        rejection_reason: null,
        source_metadata: {},
      },
      {
        // Same DOI from Crossref -> counts as 1 unique paper
        paper_id: "pap_u2",
        title: "Sparse Kernels",
        abstract: "Fast GPU kernels.",
        authors: ["Alice"],
        publication_date: "2026-11-21",
        published_at: nowIso,
        doi: "10.1000/sparse",
        arxiv_id: null,
        github_repository: null,
        github_stars: null,
        official_website: null,
        source_name: "crossref",
        source_url: "https://doi.org/10.1000/sparse",
        source_title: "Sparse Kernels",
        collected_at: nowIso,
        last_checked_at: nowIso,
        supported_fields: ["title"],
        verification_status: "Verified",
        rejection_reason: null,
        source_metadata: {},
      },
    ]);

    const rawCounts = db.countRecords();
    assert.equal(rawCounts.startups, 3);
    assert.equal(rawCounts.products, 2);
    assert.equal(rawCounts.research_papers, 2);

    const unique = db.countUniqueQualifiedRecords();
    assert.equal(unique.startups, 1);
    assert.equal(unique.products, 1);
    assert.equal(unique.research_papers, 1);

    db.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("AtlasBackendService exposes targetChecks, accurate dataset totalCount/offset, and fast isolated SQLite health latency", async () => {
  const tmpAtlasDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-service-check-"));
  const dataDir = path.join(tmpAtlasDir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const prevDbUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;

  try {
    const svc = new AtlasBackendService(tmpAtlasDir);
    const db = (svc as unknown as { db: AtlasDatabase }).db;
    const nowIso = new Date().toISOString();
    db.upsertJobs([
      {
        job_id: "job_p1",
        title: "AI Engineer 1",
        company: "Corp A",
        location: "Remote",
        employment_type: "Full-Time",
        description: "ML",
        posted_at: nowIso,
        application_url: "https://example.com/jobs/1",
        official_website: null,
        source_name: "ashby:openai",
        source_url: "https://example.com/jobs/1",
        source_title: "AI Engineer 1",
        collected_at: nowIso,
        last_checked_at: nowIso,
        supported_fields: ["title"],
        verification_status: "Verified",
        rejection_reason: null,
        canonical_company_id: null,
        source_metadata: {},
      },
      {
        job_id: "job_p2",
        title: "AI Engineer 2",
        company: "Corp B",
        location: "Remote",
        employment_type: "Full-Time",
        description: "ML",
        posted_at: nowIso,
        application_url: "https://example.com/jobs/2",
        official_website: null,
        source_name: "ashby:openai",
        source_url: "https://example.com/jobs/2",
        source_title: "AI Engineer 2",
        collected_at: nowIso,
        last_checked_at: nowIso,
        supported_fields: ["title"],
        verification_status: "Verified",
        rejection_reason: null,
        canonical_company_id: null,
        source_metadata: {},
      },
    ]);

    const page1 = svc.getDataset("jobs", 1, "all", 0) as {
      rows: unknown[];
      count: number;
      totalCount: number;
      truncated: boolean;
    };
    assert.equal(page1.count, 1);
    assert.equal(page1.totalCount, 2);
    assert.equal(page1.truncated, true);

    const page2 = svc.getDataset("jobs", 1, "all", 1) as {
      rows: Array<{ job_id: string }>;
      count: number;
      totalCount: number;
      truncated: boolean;
    };
    assert.equal(page2.count, 1);
    assert.equal(page2.totalCount, 2);
    assert.equal(page2.truncated, false);
    assert.equal(page2.rows[0].job_id, "job_p2");

    const health = await svc.runIntegrationHealthChecks();
    assert.equal(health.byId.sqlite.status, "Configured");
    assert.ok(
      typeof health.byId.sqlite.latencyMs === "number" && health.byId.sqlite.latencyMs < 500,
      `Expected SQLite latency < 500ms, got ${health.byId.sqlite.latencyMs}`
    );

    const st = svc.getStatus() as {
      targetChecks: { startups: { uniqueCount: number; target: number; met: boolean } };
    };
    assert.equal(st.targetChecks.startups.uniqueCount, 0);
    assert.equal(st.targetChecks.startups.met, false);

    svc.close();
  } finally {
    if (prevDbUrl !== undefined) process.env.DATABASE_URL = prevDbUrl;
    fs.rmSync(tmpAtlasDir, { recursive: true, force: true });
  }
});

test("GoogleSheetsService honors createNew=true by ignoring persisted spreadsheet_id and creating a fresh workbook", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-createnew-test-"));
  const db = new AtlasDatabase(path.join(tmpDir, "createnew.db"));
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const sheetValues = new Map<string, string[][]>();
  const sheetProps = EXPORT_SPECS.map((s, idx) => ({
    properties: {
      sheetId: idx + 1,
      title: s.tabName,
      gridProperties: { rowCount: 1000, columnCount: s.columns.length },
    },
  }));
  let createCalls = 0;

  const mockServer = await withHttpServer((req, res, body) => {
    res.setHeader("Content-Type", "application/json");
    const urlPath = (req.url ?? "").split("?")[0];

    if (urlPath === "/oauth/token" && req.method === "POST") {
      res.writeHead(200);
      res.end(JSON.stringify({ access_token: "mock-token-cn", expires_in: 3600 }));
      return;
    }

    if (urlPath === "/v4/spreadsheets" && req.method === "POST") {
      createCalls += 1;
      const newId = `fresh-sheet-00${createCalls}`;
      res.writeHead(200);
      res.end(
        JSON.stringify({
          spreadsheetId: newId,
          spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${newId}`,
          sheets: sheetProps,
        })
      );
      return;
    }

    if (urlPath === "/v4/spreadsheets/stale-deleted-sheet-999") {
      res.writeHead(404);
      res.end(JSON.stringify({ error: { message: "Requested entity was not found." } }));
      return;
    }

    const match = urlPath.match(/^\/v4\/spreadsheets\/(fresh-sheet-00\d+)(.*)$/);
    if (match) {
      const subPath = match[2];
      if (!subPath && req.method === "GET") {
        res.writeHead(200);
        res.end(
          JSON.stringify({
            spreadsheetId: match[1],
            spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${match[1]}`,
            sheets: sheetProps,
          })
        );
        return;
      }
      if (subPath === ":batchUpdate" && req.method === "POST") {
        res.writeHead(200);
        res.end(JSON.stringify({ replies: [] }));
        return;
      }
      if (subPath === "/values:batchClear" && req.method === "POST") {
        sheetValues.clear();
        res.writeHead(200);
        res.end(JSON.stringify({ clearedRanges: [] }));
        return;
      }
      if (subPath === "/values:batchUpdate" && req.method === "POST") {
        const payload = JSON.parse(body) as { data?: Array<{ range: string; values: unknown[][] }> };
        for (const entry of payload.data ?? []) {
          const tabMatch = entry.range.match(/^'([^']+)'!A(\d+)/);
          if (!tabMatch) continue;
          const tabName = tabMatch[1];
          const startRow = Number(tabMatch[2]);
          const existing = sheetValues.get(tabName) ?? [];
          for (let i = 0; i < entry.values.length; i++) {
            existing[startRow - 1 + i] = entry.values[i].map((v) => String(v ?? ""));
          }
          sheetValues.set(tabName, existing);
        }
        res.writeHead(200);
        res.end(JSON.stringify({ responses: [] }));
        return;
      }
      const readMatch = subPath.match(/^\/values\/([^/]+)$/);
      if (readMatch && req.method === "GET") {
        const rangeDecoded = decodeURIComponent(readMatch[1]);
        const tabMatch = rangeDecoded.match(/^'([^']+)'!/);
        const tabName = tabMatch?.[1] ?? "";
        const rows = sheetValues.get(tabName) ?? [];
        res.writeHead(200);
        res.end(JSON.stringify({ values: rows.map((r) => [r[0] ?? ""]) }));
        return;
      }
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: { message: `Unhandled mock route: ${req.method} ${req.url}` } }));
  });

  try {
    db.initializeSchema();
    db.saveSheetsSyncState({
      status: "Sync Failed",
      spreadsheetId: "stale-deleted-sheet-999",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/stale-deleted-sheet-999",
      lastSyncMode: "full",
      lastAttemptAt: "2026-11-22T06:00:00.000Z",
      lastSuccessAt: null,
      tabRowCounts: {},
      rowsAdded: 0,
      rowsUpdated: 0,
      rowsUnchanged: 0,
      lastError: "404 Not Found",
    });

    const sheets = new GoogleSheetsService(
      {
        atlasDir: tmpDir,
        rootDir: tmpDir,
        credentialsPath: null,
        credentialsJson: JSON.stringify({
          client_email: "atlas-test@example.iam.gserviceaccount.com",
          private_key: pem,
        }),
        spreadsheetId: null,
        spreadsheetName: "FrontierAtlas CreateNew Test",
        apiBaseUrl: `${mockServer.baseUrl}/v4`,
        oauthTokenUrl: `${mockServer.baseUrl}/oauth/token`,
      },
      db
    );

    const verified = await sheets.verifyConnection({ createNew: true });
    assert.equal(verified.status, "Connected");
    assert.equal(verified.spreadsheetId, null);

    const exported = await sheets.exportOrSync("full", { createNew: true });
    assert.equal(exported.success, true, exported.error ?? undefined);
    assert.equal(createCalls, 1);
    assert.equal(exported.spreadsheetId, "fresh-sheet-001");
    assert.equal(sheets.getStatus().spreadsheetId, "fresh-sheet-001");

    db.close();
  } finally {
    await mockServer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function readZipEntriesForTest(zipBuf: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  let offset = 0;
  while (offset + 30 <= zipBuf.length) {
    const sig = zipBuf.readUInt32LE(offset);
    if (sig !== 0x04034b50) break;
    const method = zipBuf.readUInt16LE(offset + 8);
    const expectedCrc = zipBuf.readUInt32LE(offset + 14);
    const compSize = zipBuf.readUInt32LE(offset + 18);
    const uncompSize = zipBuf.readUInt32LE(offset + 22);
    const nameLen = zipBuf.readUInt16LE(offset + 26);
    const extraLen = zipBuf.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const filename = zipBuf.subarray(nameStart, nameStart + nameLen).toString("utf-8");
    const dataStart = nameStart + nameLen + extraLen;
    const compBuf = zipBuf.subarray(dataStart, dataStart + compSize);
    const rawBuf = method === 8 ? zlib.inflateRawSync(compBuf) : compBuf;
    assert.equal(rawBuf.length, uncompSize, `Size mismatch for ${filename}`);
    assert.equal(zlib.crc32(rawBuf) >>> 0, expectedCrc, `CRC32 mismatch for ${filename}`);
    files.set(filename, rawBuf.toString("utf-8"));
    offset = dataStart + compSize;
  }
  return files;
}

test("All 6 SQLite CSV exports and ZIP bundle preserve canonical names, timestamps, GitHub metrics, URLs, and verification statuses", () => {
  const tmpAtlasDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-csv-zip-test-"));
  const dataDir = path.join(tmpAtlasDir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const prevDbUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;

  try {
    const svc = new AtlasBackendService(tmpAtlasDir);
    const db = (svc as unknown as { db: AtlasDatabase }).db;
    const nowIso = "2026-11-22T07:00:00.000Z";

    db.upsertCanonicalEntities([
      {
        canonical_id: "ent_test_acme",
        canonical_name: "Acme AI Labs",
        normalized_name: "acme ai labs",
        entity_type: "startup",
        primary_domain: "acme.ai",
        aliases_json: JSON.stringify(["Acme AI", "Acme AI Labs"]),
        created_at: nowIso,
      },
    ]);
    db.upsertStartups([
      {
        startup_id: "stp_zip_1",
        name: "Acme AI",
        description: "Foundation safety tools",
        website: "https://acme.ai",
        official_website: "https://acme.ai",
        industry: "AI Safety",
        location: "San Francisco, CA",
        founding_date: "2024-05-01",
        source_name: "yc_oss",
        source_url: "https://www.ycombinator.com/companies/acme-ai",
        source_title: "Acme AI | YC",
        collected_at: nowIso,
        last_checked_at: nowIso,
        supported_fields: ["name", "website", "location"],
        verification_status: "Verified",
        rejection_reason: null,
        canonical_entity_id: "ent_test_acme",
        source_metadata: { confidence_score: 0.96 },
      },
    ]);
    db.upsertProducts([
      {
        product_id: "prd_zip_1",
        name: "Acme Guard",
        description: "Runtime guardrail proxy",
        website: "https://acme.ai/guard",
        official_website: "https://acme.ai/guard",
        category: "Security",
        company_name: "Acme AI Labs",
        source_name: "github",
        source_url: "https://github.com/acme/guard",
        source_title: "acme/guard",
        collected_at: nowIso,
        last_checked_at: nowIso,
        supported_fields: ["name", "website"],
        verification_status: "Verified",
        rejection_reason: null,
        canonical_entity_id: "ent_test_acme",
        source_metadata: { github_stars: 512 },
      },
    ]);
    db.upsertResearchPapers([
      {
        paper_id: "pap_zip_1",
        title: "Verifiable Runtime Guardrails",
        abstract: "Open implementation on GitHub.",
        authors: ["Ada Lovelace", "Grace Hopper"],
        publication_date: "2026-11-22",
        published_at: nowIso,
        doi: "10.1000/guard.2026",
        arxiv_id: "2611.09999",
        github_repository: "https://github.com/acme/guard-paper",
        github_stars: 345,
        official_website: null,
        source_name: "arxiv",
        source_url: "https://arxiv.org/abs/2611.09999",
        source_title: "Verifiable Runtime Guardrails",
        collected_at: nowIso,
        last_checked_at: nowIso,
        supported_fields: ["title", "github_repository"],
        verification_status: "Verified",
        rejection_reason: null,
        source_metadata: { github_metrics: { stars: 345 } },
      },
    ]);
    db.upsertJobs([
      {
        job_id: "job_zip_1",
        title: "Staff AI Safety Engineer",
        company: "Acme AI",
        location: "Remote",
        employment_type: "Full-Time",
        description: "Build deterministic safety checks.",
        posted_at: nowIso,
        application_url: "https://acme.ai/careers/1",
        official_website: "https://acme.ai",
        source_name: "ashby:acme",
        source_url: "https://acme.ai/careers/1",
        source_title: "Staff AI Safety Engineer",
        collected_at: nowIso,
        last_checked_at: nowIso,
        supported_fields: ["title", "company"],
        verification_status: "Verified",
        rejection_reason: null,
        canonical_company_id: "ent_test_acme",
        source_metadata: {},
      },
    ]);
    db.upsertNews([
      {
        news_id: "nws_zip_1",
        headline: "Acme AI Labs Launches Guard v2",
        summary: "Guard v2 adds zero-latency verification.",
        publisher: "AI Chronicle",
        published_at: nowIso,
        article_url: "https://aichronicle.example/acme-guard-v2",
        official_website: "https://acme.ai",
        category: "AI",
        source_name: "ai_chronicle",
        source_url: "https://aichronicle.example/rss",
        source_title: "Acme AI Labs Launches Guard v2",
        collected_at: nowIso,
        last_checked_at: nowIso,
        supported_fields: ["headline", "published_at"],
        verification_status: "Verified",
        rejection_reason: null,
        source_metadata: {},
      },
    ]);
    db.upsertEntityMappingLogs([
      {
        mapping_id: "map_zip_1",
        raw_name: "Acme AI",
        normalized_name: "acme ai",
        canonical_name: "Acme AI Labs",
        canonical_id: "ent_test_acme",
        source_url: "https://www.ycombinator.com/companies/acme-ai",
        match_method: "exact_alias",
        confidence: 0.99,
        decision: "auto_merge",
        timestamp: nowIso,
        entity_type: "startup",
        match_reason: "Exact domain and alias match",
      },
    ]);

    const csvRes = svc.exportAllCsv();
    assert.equal(csvRes.totalRows, 6);
    assert.equal(csvRes.datasets.length, 6);

    const zipBundle = svc.buildCsvZipBundle();
    assert.equal(zipBundle.filename, "frontier-atlas-datasets.zip");
    assert.equal(zipBundle.totalRows, 6);
    const extracted = readZipEntriesForTest(zipBundle.buffer);
    assert.deepEqual(
      Array.from(extracted.keys()),
      [
        "startups.csv",
        "products.csv",
        "research_papers.csv",
        "jobs.csv",
        "news.csv",
        "entity_mapping_log.csv",
      ]
    );

    const startupsCsv = extracted.get("startups.csv")!;
    assert.ok(startupsCsv.includes("canonical_entity_name"));
    assert.ok(startupsCsv.includes("Acme AI Labs"));
    assert.ok(startupsCsv.includes("https://www.ycombinator.com/companies/acme-ai"));
    assert.ok(startupsCsv.includes("Verified"));

    const productsCsv = extracted.get("products.csv")!;
    assert.ok(productsCsv.includes("canonical_entity_name"));
    assert.ok(productsCsv.includes("Acme AI Labs"));

    const papersCsv = extracted.get("research_papers.csv")!;
    assert.ok(papersCsv.includes("published_at"));
    assert.ok(papersCsv.includes(nowIso));
    assert.ok(papersCsv.includes("https://github.com/acme/guard-paper"));
    assert.ok(papersCsv.includes("345"));

    const jobsCsv = extracted.get("jobs.csv")!;
    assert.ok(jobsCsv.includes("canonical_company_name"));
    assert.ok(jobsCsv.includes("Acme AI Labs"));
    assert.ok(jobsCsv.includes("https://acme.ai/careers/1"));

    const newsCsv = extracted.get("news.csv")!;
    assert.ok(newsCsv.includes("Acme AI Labs Launches Guard v2"));
    assert.ok(newsCsv.includes(nowIso));

    const mappingCsv = extracted.get("entity_mapping_log.csv")!;
    assert.ok(mappingCsv.includes("Acme AI Labs"));
    assert.ok(mappingCsv.includes("0.9900"));

    // Single CSV export matches exact ZIP entry content
    const single = svc.exportSingleCsv("research_papers.csv");
    assert.equal(single.rowCount, 1);
    assert.equal(single.content, papersCsv);

    svc.close();
  } finally {
    if (prevDbUrl !== undefined) process.env.DATABASE_URL = prevDbUrl;
    fs.rmSync(tmpAtlasDir, { recursive: true, force: true });
  }
});

test("Google OAuth error formatter explicitly detects Error 403 access_denied blocks", () => {
  const err403 = Object.assign(new Error("Firebase: Error 403 (access_denied) app has not completed Google verification"), {
    code: "auth/oauth-error",
  });
  const msg = formatGoogleAuthError(err403);
  assert.ok(msg.includes("Error 403: access_denied"));
  assert.ok(msg.includes("verification"));
  assert.equal(isGoogleOAuthBlockedMessage(msg), true);
  assert.equal(isGoogleOAuthBlockedMessage(err403), true);
  assert.equal(isGoogleOAuthBlockedMessage("Export Successful"), false);
});


