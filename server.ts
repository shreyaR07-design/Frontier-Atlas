import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import express from "express";
import { createServer as createViteServer } from "vite";
import { AtlasBackendService } from "./src/server/atlasBackend.ts";

const ROOT_DIR = process.cwd();
const ATLAS_DIR = path.resolve(ROOT_DIR, "frontier-atlas");

dotenv.config({ path: path.resolve(ROOT_DIR, ".env") });
dotenv.config({ path: path.resolve(ATLAS_DIR, ".env") });

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error(`Invalid PORT '${process.env.PORT}'. PORT must be an integer from 1 to 65535.`);
}

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

interface RunJobState {
  id: string;
  status: "idle" | "running" | "completed" | "failed";
  categories: string[];
  limit: number;
  page: number;
  startedAt: string | null;
  finishedAt: string | null;
  logs: string[];
  result: unknown | null;
  error: string | null;
}

let currentRun: RunJobState = {
  id: "none",
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

async function startServer(): Promise<void> {
  const atlas = new AtlasBackendService(ATLAS_DIR);
  const app = express();
  // Avoid accepting arbitrarily large API payloads from clients.
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, service: "frontier-atlas", timestamp: new Date().toISOString() });
  });

  app.get("/api/atlas/status", (_req, res) => {
    try {
      const statusPayload = atlas.getStatus();
      res.json({
        ...statusPayload,
        activeRun: {
          id: currentRun.id,
          status: currentRun.status,
          startedAt: currentRun.startedAt,
          finishedAt: currentRun.finishedAt,
          categories: currentRun.categories,
          limit: currentRun.limit,
          page: currentRun.page,
        },
      });
    } catch (err) {
      res.status(500).json({
        error: "Unable to query FrontierAtlas backend.",
        details: err instanceof Error ? err.message : String(err),
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
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, Math.floor(rawLimit)), 2000) : 500;

    try {
      res.json(atlas.getDataset(category, limit));
    } catch (err) {
      res.status(500).json({
        error: `Failed to query dataset '${category}'.`,
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post("/api/atlas/run", (req, res) => {
    if (currentRun.status === "running") {
      res.status(409).json({
        error: "A pipeline collection run is already in progress.",
        run: currentRun,
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
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, Math.floor(rawLimit)), 1000) : 20;
    const rawPage = Number(req.body?.page ?? 1);
    const page = Number.isFinite(rawPage) ? Math.min(Math.max(1, Math.floor(rawPage)), 100) : 1;

    const runId = `run_${Date.now()}`;
    currentRun = {
      id: runId,
      status: "running",
      categories,
      limit,
      page,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      logs: [`Starting collection for: ${categories.join(", ")} (limit=${limit} per category, page=${page})`],
      result: null,
      error: null,
    };

    void atlas
      .runPipeline({
        categories,
        limit,
        page,
        onLog: (line) => {
          currentRun.logs = [...currentRun.logs, line].slice(-80);
        },
      })
      .then((result) => {
        currentRun.finishedAt = new Date().toISOString();
        currentRun.result = result;
        currentRun.status = "completed";
        currentRun.logs = [
          ...currentRun.logs,
          "Pipeline run completed and persisted to SQLite + CSV.",
        ].slice(-80);
      })
      .catch((err) => {
        currentRun.finishedAt = new Date().toISOString();
        currentRun.status = "failed";
        currentRun.error = err instanceof Error ? err.message : String(err);
      });

    res.status(202).json({ run: currentRun });
  });

  app.get("/api/atlas/run-status", (_req, res) => {
    res.json({ run: currentRun });
  });

  app.get("/api/atlas/audit-trail", (req, res) => {
    const rawCat = typeof req.query.category === "string" ? req.query.category : "";
    const rawRecordId = typeof req.query.recordId === "string" ? req.query.recordId : "";
    const rawLimit = Number(req.query.limit ?? 100);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, Math.floor(rawLimit)), 500) : 100;

    try {
      res.json(
        atlas.getAuditTrail({
          category: rawCat && ALLOWED_AUDIT_CATEGORIES.has(rawCat) ? rawCat : null,
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
    if (currentRun.status === "running") {
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

  app.post("/api/atlas/export/sheets", async (_req, res) => {
    try {
      const result = await atlas.exportGoogleSheets();
      res.json(result);
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
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
    const safeName = path.basename(req.params.filename);
    if (!safeName.endsWith(".csv")) {
      res.status(400).json({ error: "Invalid CSV filename." });
      return;
    }
    const target = path.resolve(ATLAS_DIR, "data/exports", safeName);
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

  app.listen(PORT, HOST, () => {
    console.log(`FrontierAtlas dashboard server listening on http://${HOST}:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start FrontierAtlas server:", err);
  process.exit(1);
});
