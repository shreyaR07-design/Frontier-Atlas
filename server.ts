import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { createServer as createViteServer } from "vite";

const PORT = 3000;
const ROOT_DIR = process.cwd();
const ATLAS_DIR = path.resolve(ROOT_DIR, "frontier-atlas");
const VENV_PYTHON = path.resolve(ATLAS_DIR, ".venv/bin/python");

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

function resolvePythonBin(): string {
  if (fs.existsSync(VENV_PYTHON)) {
    return VENV_PYTHON;
  }
  return "python3";
}

function runBridgeCommand(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const pythonBin = resolvePythonBin();
    const child = spawn(pythonBin, ["-m", "src.pipeline.bridge", ...args], {
      cwd: ATLAS_DIR,
      env: {
        ...process.env,
        PYTHONPATH: ATLAS_DIR,
        PYTHONUNBUFFERED: "1",
      },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (err) => {
      resolve({ ok: false, stdout, stderr: err.message, code: 1 });
    });
    child.on("close", (code) => {
      resolve({ ok: code === 0, stdout, stderr, code });
    });
  });
}

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json());

  app.get("/api/atlas/status", async (_req, res) => {
    const exec = await runBridgeCommand(["status"]);
    if (!exec.ok) {
      res.status(500).json({
        error: "Unable to query FrontierAtlas Python backend.",
        details: exec.stderr || exec.stdout,
      });
      return;
    }
    try {
      const parsed = JSON.parse(exec.stdout);
      res.json({
        ...parsed,
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
        error: "Malformed JSON returned from FrontierAtlas status bridge.",
        details: String(err),
      });
    }
  });

  app.get("/api/atlas/datasets/:category", async (req, res) => {
    const { category } = req.params;
    if (!ALLOWED_DATASETS.has(category)) {
      res.status(400).json({ error: `Unsupported dataset category: ${category}` });
      return;
    }
    const rawLimit = Number(req.query.limit ?? 500);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, Math.floor(rawLimit)), 2000) : 500;

    const exec = await runBridgeCommand(["dataset", "--category", category, "--limit", String(limit)]);
    if (!exec.ok) {
      res.status(500).json({
        error: `Failed to query dataset '${category}'.`,
        details: exec.stderr || exec.stdout,
      });
      return;
    }
    try {
      res.json(JSON.parse(exec.stdout));
    } catch (err) {
      res.status(500).json({ error: "Invalid dataset JSON response.", details: String(err) });
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

    const pythonBin = resolvePythonBin();
    const child = spawn(
      pythonBin,
      [
        "-m",
        "src.pipeline.bridge",
        "run",
        "--categories",
        ...categories,
        "--limit",
        String(limit),
        "--page",
        String(page),
      ],
      {
        cwd: ATLAS_DIR,
        env: {
          ...process.env,
          PYTHONPATH: ATLAS_DIR,
          PYTHONUNBUFFERED: "1",
        },
      }
    );

    let stdoutBuffer = "";
    let stderrBuffer = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf-8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      stderrBuffer += text;
      const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.length > 0) {
        currentRun.logs = [...currentRun.logs, ...lines].slice(-80);
      }
    });

    child.on("error", (err) => {
      currentRun.status = "failed";
      currentRun.finishedAt = new Date().toISOString();
      currentRun.error = err.message;
    });

    child.on("close", (code) => {
      currentRun.finishedAt = new Date().toISOString();
      if (code === 0) {
        try {
          currentRun.result = JSON.parse(stdoutBuffer);
          currentRun.status = "completed";
          currentRun.logs = [...currentRun.logs, "Pipeline run completed and persisted to SQLite + CSV."].slice(-80);
        } catch (err) {
          currentRun.status = "failed";
          currentRun.error = `Run exited 0 but failed to parse output: ${String(err)}`;
        }
      } else {
        currentRun.status = "failed";
        currentRun.error = stderrBuffer.trim() || `Pipeline exited with code ${code}`;
      }
    });

    res.status(202).json({ run: currentRun });
  });

  app.get("/api/atlas/run-status", (_req, res) => {
    res.json({ run: currentRun });
  });

  app.get("/api/atlas/audit-trail", async (req, res) => {
    const rawCat = typeof req.query.category === "string" ? req.query.category : "";
    const rawRecordId = typeof req.query.recordId === "string" ? req.query.recordId : "";
    const rawLimit = Number(req.query.limit ?? 100);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, Math.floor(rawLimit)), 500) : 100;

    const args = ["audit-trail", "--limit", String(limit)];
    if (rawCat && ALLOWED_RUN_CATEGORIES.has(rawCat)) {
      args.push("--category", rawCat);
    }
    if (rawRecordId.trim()) {
      args.push("--record-id", rawRecordId.trim());
    }

    const exec = await runBridgeCommand(args);
    if (!exec.ok) {
      res.status(500).json({
        error: "Failed to query verification audit trail.",
        details: exec.stderr || exec.stdout,
      });
      return;
    }
    try {
      res.json(JSON.parse(exec.stdout));
    } catch (err) {
      res.status(500).json({ error: "Invalid audit trail JSON response.", details: String(err) });
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

    const args = categories.length > 0 ? ["audit", "--categories", ...categories] : ["audit"];
    if (req.body?.offline === true) {
      args.push("--offline");
    }
    const exec = await runBridgeCommand(args);
    if (!exec.ok) {
      res.status(500).json({
        error: exec.stderr || "Source verification audit failed.",
      });
      return;
    }
    try {
      res.json(JSON.parse(exec.stdout));
    } catch (err) {
      res.status(500).json({ error: "Invalid audit JSON response.", details: String(err) });
    }
  });

  app.post("/api/atlas/export/sheets", async (_req, res) => {
    const exec = await runBridgeCommand(["export-sheets"]);
    if (!exec.ok && !exec.stdout) {
      res.status(500).json({
        success: false,
        error: exec.stderr || "Google Sheets export command failed.",
      });
      return;
    }
    try {
      res.json(JSON.parse(exec.stdout));
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  app.post("/api/atlas/export/csv", async (_req, res) => {
    const exec = await runBridgeCommand(["export-csv"]);
    if (!exec.ok) {
      res.status(500).json({ error: exec.stderr || "CSV export failed." });
      return;
    }
    try {
      res.json(JSON.parse(exec.stdout));
    } catch (err) {
      res.status(500).json({ error: String(err) });
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

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`FrontierAtlas dashboard server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start FrontierAtlas server:", err);
  process.exit(1);
});
