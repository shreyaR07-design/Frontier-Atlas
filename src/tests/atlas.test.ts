import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  classifyJobRoleFamily,
  detectJobRemoteEligibility,
  EntityResolver,
  isWithinFreshnessWindow,
  LiveSourceVerifier,
  loadAtlasConfig,
  matchJsonItemText,
  normalizeEntityName,
  parseUtcDatetime,
  parseUtcDatetimeWithMeta,
} from "../server/atlasBackend.ts";
import { AtlasDatabase } from "../server/atlasDb.ts";
import { EXPORT_SPECS, GoogleSheetsService } from "../server/googleSheets.ts";
import { PoliteHttpClient } from "../server/httpClient.ts";
import {
  FatalProviderError,
  LLMRouter,
  OpenAICompatibleLLMProvider,
  PayloadTooLargeError,
  type LLMProvider,
} from "../server/llmRouter.ts";

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
