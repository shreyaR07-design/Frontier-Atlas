import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import express from "express";
import { createServer as createViteServer } from "vite";
import { AtlasBackendService } from "./src/server/atlasBackend.ts";
import { redactSecrets } from "./src/server/llmRouter.ts";

const PORT = 3000;
const ROOT_DIR = process.cwd();
const ATLAS_DIR = path.resolve(ROOT_DIR, "frontier-atlas");

dotenv.config({ path: path.resolve(ROOT_DIR, ".env") });
dotenv.config({ path: path.resolve(ATLAS_DIR, ".env") });

const ALLOWED_DATASETS = new Set([
  "startups",
  "products",
  "research_papers",
  "jobs",
  "news",
  "entity_mapping_log",
  "failure_logs",
  "verification_audit_log",
]);

const ALLOWED_RUN_CATEGORIES = new Set([
  "startups",
  "products",
  "research_papers",
  "jobs",
  "news",
]);

const ALLOWED_AUDIT_CATEGORIES = new Set([
  "startups",
  "products",
  "research_papers",
  "jobs",
  "news",
  "entity_mapping_log",
]);

const ALLOWED_CSV_FILES = new Set([
  "startups.csv",
  "products.csv",
  "research_papers.csv",
  "jobs.csv",
  "news.csv",
  "entity_mapping_log.csv",
]);

async function startServer(): Promise<void> {
  const atlas = new AtlasBackendService(ATLAS_DIR);
  const app = express();
  app.use(express.json());

  // Kick off non-blocking initial live health probes on startup and start configurable daily UTC scheduler
  void atlas.ensureInitialHealthChecked().catch(() => {});
  atlas.startScheduler();

  const extractBearerToken = (req: express.Request): string | null => {
    const authHeader = req.headers.authorization;
    return typeof authHeader === "string" && authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim() || null
      : null;
  };

  app.get("/api/atlas/status", async (_req, res) => {
    try {
      if (!atlas.getIntegrationHealthSummary().checkedAt) {
        await atlas.ensureInitialHealthChecked();
      }
      const statusPayload = atlas.getStatus();
      res.json(statusPayload);
    } catch (err) {
      res.status(500).json({
        error: "Unable to query FrontierAtlas backend.",
        details: redactSecrets(err instanceof Error ? err.message : String(err)),
      });
    }
  });

  app.get("/api/atlas/integrations/health", async (req, res) => {
    try {
      const refresh = req.query.refresh === "true" || req.query.refresh === "1";
      const oauthAccessToken = extractBearerToken(req);
      const spreadsheetId =
        typeof req.query.spreadsheetId === "string" ? req.query.spreadsheetId.trim() || null : null;
      const summary = refresh
        ? await atlas.runIntegrationHealthChecks({ oauthAccessToken, spreadsheetId })
        : await atlas.ensureInitialHealthChecked();
      res.json(summary);
    } catch (err) {
      res.status(500).json({
        error: "Integration health check failed.",
        details: redactSecrets(err instanceof Error ? err.message : String(err)),
      });
    }
  });

  app.post("/api/atlas/integrations/test", async (req, res) => {
    try {
      const oauthAccessToken = extractBearerToken(req);
      const rawSheetId =
        typeof req.body?.spreadsheetId === "string" ? req.body.spreadsheetId.trim() : "";
      const summary = await atlas.runIntegrationHealthChecks({
        oauthAccessToken,
        spreadsheetId: rawSheetId || null,
      });
      res.json(summary);
    } catch (err) {
      res.status(500).json({
        error: "Integration connection test failed.",
        details: redactSecrets(err instanceof Error ? err.message : String(err)),
      });
    }
  });

  app.get("/api/atlas/datasets/:category", (req, res) => {
    const { category } = req.params;
    if (!ALLOWED_DATASETS.has(category)) {
      res.status(400).json({ error: `Unsupported dataset category: ${category}` });
      return;
    }
    const rawLimit = Number(req.query.limit ?? 500);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, Math.floor(rawLimit)), 10000) : 500;
    const rawOffset = Number(req.query.offset ?? 0);
    const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;
    const rawWindow = String(req.query.window ?? "all").trim().toLowerCase();
    const windowMode: "all" | "24h" = rawWindow === "24h" ? "24h" : "all";

    try {
      res.json(atlas.getDataset(category, limit, windowMode, offset));
    } catch (err) {
      res.status(500).json({
        error: `Failed to query dataset '${category}'.`,
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post("/api/atlas/run", (req, res) => {
    if (atlas.isRunInProgress()) {
      res.status(409).json({
        error: "A pipeline collection run is already in progress.",
        run: atlas.getActiveRunState(),
      });
      return;
    }

    const reqCats: unknown = req.body?.categories;
    const categories = Array.isArray(reqCats)
      ? reqCats.filter((c): c is string => typeof c === "string" && ALLOWED_RUN_CATEGORIES.has(c))
      : Array.from(ALLOWED_RUN_CATEGORIES);

    if (categories.length === 0) {
      res.status(400).json({ error: "Select at least one valid collection category." });
      return;
    }

    const rawLimit = Number(req.body?.limit ?? 20);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, Math.floor(rawLimit)), 1500) : 20;
    const rawPage = Number(req.body?.page ?? 1);
    const page = Number.isFinite(rawPage) ? Math.min(Math.max(1, Math.floor(rawPage)), 100) : 1;

    const launch = atlas.startBackgroundRun({
      triggerType: "manual",
      mode: "full",
      categories,
      limit,
      page,
      includeAllFresh24h: Boolean(req.body?.includeAllFresh24h),
    });
    if (launch.conflict) {
      res.status(409).json({
        error: "A pipeline collection run is already in progress.",
        run: launch.run,
      });
      return;
    }
    res.status(202).json({ run: launch.run });
  });

  app.post("/api/atlas/refresh-24h", (_req, res) => {
    const launch = atlas.startBackgroundRun({
      triggerType: "daily_24h",
      mode: "daily_24h",
      categories: ["jobs", "news", "research_papers"],
      limit: 1000,
      page: 1,
      includeAllFresh24h: true,
    });
    if (launch.conflict) {
      res.status(409).json({
        error: "A pipeline collection run is already in progress.",
        run: launch.run,
      });
      return;
    }
    res.status(202).json({ run: launch.run });
  });

  app.get("/api/atlas/run-status", (_req, res) => {
    res.json({ run: atlas.getActiveRunState() });
  });

  app.get("/api/atlas/runs", (_req, res) => {
    const st = atlas.getStatus();
    res.json({
      runs: st.pipelineRuns ?? [],
      activeRun: atlas.getActiveRunState(),
      lastSuccessfulRunAt: st.lastSuccessfulRunAt ?? null,
      lastCollectionAt: st.lastCollectionAt ?? null,
    });
  });

  app.get("/api/atlas/scheduler", (_req, res) => {
    res.json({ scheduler: atlas.getSchedulerStatus() });
  });

  app.put("/api/atlas/scheduler", (req, res) => {
    const rawUtc = req.body?.utcTime;
    if (rawUtc !== undefined) {
      if (typeof rawUtc !== "string" || !/^\d{1,2}:\d{2}$/.test(rawUtc.trim())) {
        res.status(400).json({ error: "utcTime must be formatted as HH:MM (UTC 24-hour)." });
        return;
      }
      const [hh, mm] = rawUtc.trim().split(":").map(Number);
      if (hh < 0 || hh > 23 || mm < 0 || mm > 59) {
        res.status(400).json({ error: "utcTime hours must be 00-23 and minutes 00-59." });
        return;
      }
    }
    const scheduler = atlas.updateSchedulerConfig({
      enabled: typeof req.body?.enabled === "boolean" ? req.body.enabled : undefined,
      utcTime: typeof rawUtc === "string" ? rawUtc : undefined,
    });
    res.json({ scheduler });
  });

  app.get("/api/atlas/audit-trail", (req, res) => {
    const rawCat = typeof req.query.category === "string" ? req.query.category : "";
    const rawRecordId = typeof req.query.recordId === "string" ? req.query.recordId : "";
    const rawLimit = Number(req.query.limit ?? 100);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, Math.floor(rawLimit)), 500) : 100;

    try {
      res.json(
        atlas.getAuditTrail({
          category: rawCat && ALLOWED_RUN_CATEGORIES.has(rawCat) ? rawCat : null,
          recordId: rawRecordId.trim() || null,
          limit,
        })
      );
    } catch (err) {
      res.status(500).json({
        error: "Failed to query verification audit trail.",
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post("/api/atlas/audit", async (req, res) => {
    if (atlas.isRunInProgress()) {
      res.status(409).json({
        error: "Cannot audit records while a pipeline collection run is in progress.",
      });
      return;
    }
    const reqCats: unknown = req.body?.categories;
    const categories = Array.isArray(reqCats)
      ? reqCats.filter((c): c is string => typeof c === "string" && ALLOWED_AUDIT_CATEGORIES.has(c))
      : Array.from(ALLOWED_AUDIT_CATEGORIES);

    try {
      const result = await atlas.auditExisting({
        categories: categories.length > 0 ? categories : Array.from(ALLOWED_AUDIT_CATEGORIES),
        liveCheck: req.body?.offline !== true,
        removeDuplicates: req.body?.keepDuplicates !== true,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : "Source verification audit failed.",
      });
    }
  });

  const extractSheetsOpts = (req: express.Request) => {
    const authHeader = req.headers.authorization;
    const oauthAccessToken =
      typeof authHeader === "string" && authHeader.toLowerCase().startsWith("bearer ")
        ? authHeader.slice(7).trim() || null
        : null;
    const rawSheetId = typeof req.body?.spreadsheetId === "string" ? req.body.spreadsheetId.trim() : "";
    return {
      oauthAccessToken,
      spreadsheetId: rawSheetId || null,
      createNew: req.body?.createNew === true,
    };
  };

  app.post("/api/atlas/export/sheets", async (req, res) => {
    try {
      const result = await atlas.exportGoogleSheets(extractSheetsOpts(req));
      res.status(result.authRequired ? 401 : 200).json(result);
    } catch (err) {
      res.status(500).json({
        success: false,
        error: redactSecrets(err instanceof Error ? err.message : String(err)),
      });
    }
  });

  app.post("/api/atlas/sync/sheets", async (req, res) => {
    try {
      const result = await atlas.syncGoogleSheets(extractSheetsOpts(req));
      res.status(result.authRequired ? 401 : 200).json(result);
    } catch (err) {
      res.status(500).json({
        success: false,
        error: redactSecrets(err instanceof Error ? err.message : String(err)),
      });
    }
  });

  app.post("/api/atlas/sheets/verify", async (req, res) => {
    try {
      const result = await atlas.verifyGoogleSheetsConnection(extractSheetsOpts(req));
      res.status(result.authRequired ? 401 : 200).json(result);
    } catch (err) {
      res.status(500).json({
        status: "Sync Failed",
        authRequired: false,
        lastError: redactSecrets(err instanceof Error ? err.message : String(err)),
      });
    }
  });

  app.post("/api/atlas/export/csv", (_req, res) => {
    try {
      res.json(atlas.exportAllCsv());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "CSV export failed." });
    }
  });

  app.get("/api/atlas/download/csv/:filename", (req, res) => {
    const rawName = String(req.params.filename ?? "");
    const safeName = path.basename(rawName);
    if (safeName !== rawName || !ALLOWED_CSV_FILES.has(safeName)) {
      res.status(400).json({ error: "Invalid CSV filename." });
      return;
    }
    const exportsDir = path.resolve(ATLAS_DIR, "data/exports");
    const target = path.resolve(exportsDir, safeName);
    if (!target.startsWith(exportsDir + path.sep)) {
      res.status(400).json({ error: "Invalid CSV export path." });
      return;
    }
    if (!fs.existsSync(target)) {
      res.status(404).json({ error: `CSV export '${safeName}' has not been generated yet.` });
      return;
    }
    res.download(target, safeName);
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(ROOT_DIR, "dist");
    app.use(express.static(distDir));
    app.get("*", (_req, res) => {
      res.sendFile(path.resolve(distDir, "index.html"));
    });
  }

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`FrontierAtlas dashboard server listening on http://0.0.0.0:${PORT}`);
  });

  const shutdown = () => {
    try {
      atlas.close();
    } catch {
      // Ignore shutdown close errors
    }
    server.close(() => {
      process.exit(0);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

startServer().catch((err) => {
  console.error("Failed to start FrontierAtlas server:", err);
  process.exit(1);
});
