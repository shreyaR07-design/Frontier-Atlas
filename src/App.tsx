/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Menu, Play, RefreshCw } from "lucide-react";
import { AppsScriptSetupModal } from "./components/AppsScriptSetupModal";
import { DatasetView } from "./components/DatasetView";
import { GmailPanel } from "./components/GmailPanel";
import { OverviewPanel } from "./components/OverviewPanel";
import { RunCollectionModal } from "./components/RunCollectionModal";
import { SheetsConfirmModal } from "./components/SheetsConfirmModal";
import { Sidebar } from "./components/Sidebar";
import type {
  AnyDatasetRow,
  AtlasStatusResponse,
  DatasetCategory,
  ExportScope,
  ExportStepStatus,
  FailureLogRow,
  PublicAccessStatus,
  RunJobState,
  SectionId,
  SheetsFallbackExportSummary,
  SheetsFeedbackState,
} from "./types/atlas";

const SECTION_LABELS: Record<SectionId, string> = {
  overview: "Overview",
  gmail: "Gmail",
  startups: "Startups",
  products: "Products",
  research_papers: "Research Papers",
  jobs: "Jobs",
  news: "News",
  entity_mapping_log: "Entity Mapping Log",
};

const DATASET_CSV_NAMES: Record<DatasetCategory, string> = {
  startups: "startups.csv",
  products: "products.csv",
  research_papers: "research_papers.csv",
  jobs: "jobs.csv",
  news: "news.csv",
  entity_mapping_log: "entity_mapping_log.csv",
};

async function readJsonSafe<T extends object>(resp: Response): Promise<T & { error?: string }> {
  const contentType = (resp.headers.get("content-type") || "").toLowerCase();
  const raw = await resp.text();
  const trimmed = raw.trim();

  const looksLikeHtml =
    contentType.includes("text/html") ||
    contentType.includes("application/xhtml") ||
    /^<(?:!doctype|html|head|body)\b/i.test(trimmed);

  if (looksLikeHtml) {
    const titleMatch = trimmed.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const htmlTitle = titleMatch?.[1]?.replace(/\s+/g, " ").trim();
    const isGoogleAuth = /accounts\.google\.com|Sign in - Google Accounts|You need permission/i.test(
      trimmed
    );
    return {
      error: isGoogleAuth
        ? `Received Google Sign-In/permission HTML page (HTTP ${resp.status}). Ensure your Apps Script Web App (/exec) is deployed with Execute as: 'Me' and Who has access: 'Anyone'.`
        : !resp.ok
          ? `Request failed (HTTP ${resp.status}, Content-Type: ${contentType || "text/html"}${htmlTitle ? ` — "${htmlTitle}"` : ""}). Check backend server logs or endpoint routing.`
          : `Expected JSON response but received HTML (${contentType || "text/html"}${htmlTitle ? ` — "${htmlTitle}"` : ""}). Verify the endpoint URL and deployment settings.`,
    } as T & { error?: string };
  }

  if (!trimmed) {
    if (!resp.ok) {
      return {
        error: `Request failed with empty response body (HTTP ${resp.status}${resp.statusText ? ` ${resp.statusText}` : ""}).`,
      } as T & { error?: string };
    }
    return {} as T & { error?: string };
  }

  const looksLikeJson =
    contentType.includes("json") ||
    contentType.includes("text/javascript") ||
    trimmed.startsWith("{") ||
    trimmed.startsWith("[");

  if (!looksLikeJson) {
    return {
      error: `Expected JSON but received ${contentType || "text/plain"} (HTTP ${resp.status}): ${trimmed.slice(0, 140)}`,
    } as T & { error?: string };
  }

  try {
    return JSON.parse(trimmed) as T & { error?: string };
  } catch {
    return {
      error: `Invalid JSON response (HTTP ${resp.status}, Content-Type: ${contentType || "unknown"}): ${trimmed.slice(0, 140)}`,
    } as T & { error?: string };
  }
}

export default function App() {
  const [activeSection, setActiveSection] = useState<SectionId>("overview");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const [status, setStatus] = useState<AtlasStatusResponse | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [datasetRows, setDatasetRows] = useState<AnyDatasetRow[]>([]);
  const [datasetTotalCount, setDatasetTotalCount] = useState<number>(0);
  const [datasetWindow, setDatasetWindow] = useState<"all" | "24h">("all");
  const [datasetLoading, setDatasetLoading] = useState(false);
  const [datasetError, setDatasetError] = useState<string | null>(null);
  const datasetRequestSeqRef = useRef(0);

  const [failures, setFailures] = useState<FailureLogRow[]>([]);
  const [runState, setRunState] = useState<RunJobState>({
    id: "none",
    status: "idle",
    categories: [],
    limit: 20,
    page: 1,
    startedAt: null,
    finishedAt: null,
  });

  const [runModalOpen, setRunModalOpen] = useState(false);
  const [auditing, setAuditing] = useState(false);
  const [csvExporting, setCsvExporting] = useState(false);
  const [schedulerUpdating, setSchedulerUpdating] = useState(false);
  const [sheetsExporting, setSheetsExporting] = useState(false);
  const [sheetsSyncing, setSheetsSyncing] = useState(false);
  const [sheetsConfirmMode, setSheetsConfirmMode] = useState<"full" | "incremental" | null>(null);
  const [sheetsExportScope, setSheetsExportScope] = useState<ExportScope>("all");
  const [targetSpreadsheetId, setTargetSpreadsheetId] = useState("");
  const hasInitializedSheetIdRef = useRef(false);
  const [webhookUrlInput, setWebhookUrlInput] = useState("");
  const hasInitializedWebhookRef = useRef(false);
  const [savingWebhookUrl, setSavingWebhookUrl] = useState(false);
  const [appsScriptModalOpen, setAppsScriptModalOpen] = useState(false);
  const [appsScriptModalError, setAppsScriptModalError] = useState<string | null>(null);
  const [savingServiceAccount, setSavingServiceAccount] = useState(false);
  const [testingIntegrations, setTestingIntegrations] = useState(false);
  const [testingGoogleConnection, setTestingGoogleConnection] = useState(false);
  const [sheetsFeedback, setSheetsFeedback] = useState<SheetsFeedbackState | null>(null);

  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      const resp = await fetch("/api/atlas/status");
      const data = await readJsonSafe<AtlasStatusResponse & { error?: string }>(resp);
      if (!resp.ok) {
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      setStatus(data);
      if (data.activeRun) {
        setRunState((prev) =>
          prev.status === "running" ? prev : { ...prev, ...data.activeRun }
        );
      }
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err));
    } finally {
      setStatusLoading(false);
    }
  }, []);

  const loadFailures = useCallback(async () => {
    try {
      const resp = await fetch("/api/atlas/datasets/failure_logs?limit=200");
      if (!resp.ok) return;
      const data = await resp.json();
      setFailures(Array.isArray(data.rows) ? data.rows : []);
    } catch {
      // Non-blocking audit load
    }
  }, []);

  const loadDataset = useCallback(async (category: DatasetCategory, win: "all" | "24h" = "all") => {
    const seq = ++datasetRequestSeqRef.current;
    setDatasetLoading(true);
    setDatasetError(null);
    try {
      const supportsWin = category === "jobs" || category === "news" || category === "research_papers";
      const fetchLimit = 10000;
      const query = supportsWin ? `?limit=${fetchLimit}&window=${win}` : `?limit=${fetchLimit}`;
      const resp = await fetch(`/api/atlas/datasets/${category}${query}`);
      const data = await readJsonSafe<{ rows?: AnyDatasetRow[]; totalCount?: number; error?: string }>(resp);
      if (seq !== datasetRequestSeqRef.current) return;
      if (!resp.ok) {
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      const nextRows = Array.isArray(data.rows) ? data.rows : [];
      setDatasetRows(nextRows);
      setDatasetTotalCount(
        typeof data.totalCount === "number" ? data.totalCount : nextRows.length
      );
    } catch (err) {
      if (seq !== datasetRequestSeqRef.current) return;
      setDatasetError(err instanceof Error ? err.message : String(err));
      setDatasetRows([]);
      setDatasetTotalCount(0);
    } finally {
      if (seq === datasetRequestSeqRef.current) {
        setDatasetLoading(false);
      }
    }
  }, []);

  const handleSelectSection = useCallback((nextSection: SectionId) => {
    if (nextSection !== activeSection) {
      const isDataset = nextSection !== "overview" && nextSection !== "gmail";
      datasetRequestSeqRef.current += 1;
      setDatasetRows([]);
      setDatasetTotalCount(0);
      setDatasetError(null);
      setDatasetWindow("all");
      setDatasetLoading(isDataset);
      setActiveSection(nextSection);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [activeSection]);

  useEffect(() => {
    void loadStatus();
    void loadFailures();
  }, [loadStatus, loadFailures]);

  useEffect(() => {
    if (!hasInitializedSheetIdRef.current && status?.sheetsStatus?.spreadsheetId) {
      hasInitializedSheetIdRef.current = true;
      setTargetSpreadsheetId(status.sheetsStatus.spreadsheetId);
    }
  }, [status?.sheetsStatus?.spreadsheetId]);

  useEffect(() => {
    if (!hasInitializedWebhookRef.current && status?.sheetsStatus?.webhookUrl) {
      hasInitializedWebhookRef.current = true;
      setWebhookUrlInput(status.sheetsStatus.webhookUrl);
    }
  }, [status?.sheetsStatus?.webhookUrl]);

  useEffect(() => {
    if (activeSection !== "overview" && activeSection !== "gmail") {
      void loadDataset(activeSection, datasetWindow);
    }
  }, [activeSection, datasetWindow, loadDataset]);

  useEffect(() => {
    if (runState.status !== "running") return;
    const timer = window.setInterval(async () => {
      try {
        const resp = await fetch("/api/atlas/run-status");
        if (!resp.ok) return;
        const data = await resp.json();
        if (data.run) {
          setRunState(data.run);
          if (data.run.status !== "running") {
            void loadStatus();
            void loadFailures();
            if (activeSection !== "overview" && activeSection !== "gmail") {
              void loadDataset(activeSection, datasetWindow);
            }
          }
        }
      } catch {
        // Ignore transient poll errors
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [runState.status, activeSection, datasetWindow, loadStatus, loadFailures, loadDataset]);

  const handleStartRun = async (categories: string[], limit: number, page = 1) => {
    setRunModalOpen(false);
    try {
      const resp = await fetch("/api/atlas/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categories, limit, page }),
      });
      const data = await readJsonSafe<{ run?: RunJobState; error?: string }>(resp);
      if (!resp.ok) {
        setRunState((prev) => ({
          ...prev,
          status: resp.status === 409 ? prev.status : "failed",
          error: data.error || `HTTP ${resp.status}`,
        }));
        return;
      }
      if (data.run) {
        setRunState(data.run);
      }
    } catch (err) {
      setRunState((prev) => ({
        ...prev,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  };

  const handleRefresh24h = async () => {
    setSheetsFeedback(null);
    try {
      const resp = await fetch("/api/atlas/refresh-24h", { method: "POST" });
      const data = await readJsonSafe<{ run?: RunJobState; error?: string }>(resp);
      if (!resp.ok) {
        setSheetsFeedback({
          success: false,
          message: data.error || `HTTP ${resp.status}`,
        });
        return;
      }
      if (data.run) {
        setRunState(data.run);
      }
    } catch (err) {
      setSheetsFeedback({
        success: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleUpdateScheduler = async (opts: { enabled?: boolean; utcTime?: string }) => {
    setSchedulerUpdating(true);
    setSheetsFeedback(null);
    try {
      const resp = await fetch("/api/atlas/scheduler", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(opts),
      });
      const data = await readJsonSafe<{
        scheduler?: { enabled?: boolean; utc_time?: string };
        error?: string;
      }>(resp);
      if (!resp.ok) {
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      await loadStatus();
      setSheetsFeedback({
        success: true,
        message: `Daily UTC collection schedule updated (${data.scheduler?.enabled ? `Enabled at ${data.scheduler?.utc_time} UTC` : "Paused"}).`,
      });
    } catch (err) {
      setSheetsFeedback({
        success: false,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSchedulerUpdating(false);
    }
  };

  const handleAuditRecords = async () => {
    setAuditing(true);
    setSheetsFeedback(null);
    try {
      const resp = await fetch("/api/atlas/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await readJsonSafe<{
        verificationCounts?: { totals?: Record<string, number> };
        auditEntriesLogged?: number;
        duplicatesRemoved?: number;
        error?: string;
      }>(resp);
      if (!resp.ok) {
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      await loadStatus();
      await loadFailures();
      if (activeSection !== "overview" && activeSection !== "gmail") {
        void loadDataset(activeSection, datasetWindow);
      }
      const totals = data.verificationCounts?.totals;
      const logged = Number(data.auditEntriesLogged ?? 0);
      const removed = Number(data.duplicatesRemoved ?? 0);
      const dupText = removed > 0 ? `, ${removed} duplicate${removed === 1 ? "" : "s"} removed` : "";
      setSheetsFeedback({
        success: true,
        message: totals
          ? `Audit complete (${logged} trail entries${dupText}): ${totals.Verified ?? 0} Verified, ${totals["Partially Verified"] ?? 0} Partially Verified, ${totals.Unverified ?? 0} Unverified, ${totals["Source Unavailable"] ?? 0} Source Unavailable, ${totals.Rejected ?? 0} Rejected.`
          : "Source verification audit completed across existing database records.",
      });
    } catch (err) {
      setSheetsFeedback({
        success: false,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setAuditing(false);
    }
  };

  const handleTestIntegrations = useCallback(async () => {
    setTestingIntegrations(true);
    try {
      const resp = await fetch("/api/atlas/integrations/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          spreadsheetId: targetSpreadsheetId.trim() || undefined,
        }),
      });
      if (resp.ok) {
        await loadStatus();
      }
    } finally {
      setTestingIntegrations(false);
    }
  }, [loadStatus, targetSpreadsheetId]);

  const handleTestGoogleConnection = useCallback(async (): Promise<boolean> => {
    setTestingGoogleConnection(true);
    setSheetsFeedback(null);
    try {
      const resp = await fetch("/api/atlas/sheets/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          webhookUrl: webhookUrlInput.trim() || undefined,
          spreadsheetId: targetSpreadsheetId.trim() || undefined,
          createNew: targetSpreadsheetId.trim() === "",
        }),
      });
      const data = await readJsonSafe<Record<string, unknown>>(resp);
      await loadStatus();

      if (data.status === "Connected") {
        const verifiedUrl =
          typeof data.spreadsheetUrl === "string" && data.spreadsheetUrl
            ? data.spreadsheetUrl
            : null;
        const isWebhook = data.credentialSource === "apps_script_webhook";
        setSheetsFeedback({
          success: true,
          message: isWebhook
            ? verifiedUrl
              ? `Google Apps Script Web App verified and linked to ${verifiedUrl}.`
              : "Google Apps Script Web App URL verified and ready to export all 6 datasets."
            : data.spreadsheetId
            ? `Google Sheets verified (${String(data.verifiedAccountEmail || "Service Account")} — Spreadsheet ${String(data.spreadsheetId)} accessible).`
            : `Google Sheets verified (${String(data.verifiedAccountEmail || "Service Account")} — Drive & Sheets APIs ready).`,
          url: verifiedUrl,
        });
        return true;
      }

      const needsReauth = Boolean(data.authRequired) || resp.status === 401;
      setSheetsFeedback({
        success: false,
        message: String(
          data.lastError ||
            data.error ||
            "Google Apps Script Webhook URL is not configured yet. Paste your Web App URL in Google Sheets Setup below."
        ),
        url: null,
        needsReauth,
      });
      return false;
    } catch (err) {
      setSheetsFeedback({
        success: false,
        message: err instanceof Error ? err.message : String(err),
        url: null,
      });
      return false;
    } finally {
      setTestingGoogleConnection(false);
    }
  }, [loadStatus, targetSpreadsheetId, webhookUrlInput]);

  const prepareFallbackSummary = useCallback(
    async (reason: string, scope: ExportScope): Promise<SheetsFallbackExportSummary | null> => {
      try {
        const resp = await fetch("/api/atlas/export/csv", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope }),
        });
        const data = await readJsonSafe<{
          rowCounts?: Record<string, number>;
          totalRows?: number;
          datasets?: Array<{
            tabName: string;
            filename: string;
            rowCount: number;
            downloadUrl: string;
          }>;
        }>(resp);
        if (!resp.ok || !Array.isArray(data.datasets)) return null;
        const scopeQuery = scope === "qualified_24h" ? "?scope=qualified" : "";
        return {
          ready: true,
          reason,
          zipFilename:
            scope === "qualified_24h"
              ? "frontier-atlas-qualified-24h.zip"
              : "frontier-atlas-datasets.zip",
          zipUrl: `/api/atlas/download/csv-bundle.zip${scopeQuery}`,
          zipByteSize: 0,
          rowCounts: data.rowCounts ?? {},
          totalRows: Number(data.totalRows ?? 0),
          datasets: data.datasets.map((d) => ({
            tabName: d.tabName,
            filename: d.filename,
            rowCount: d.rowCount,
            downloadUrl: d.downloadUrl,
          })),
        };
      } catch {
        return null;
      }
    },
    []
  );

  const saveWebhookUrlInternal = async (opts?: {
    skipVerify?: boolean;
  }): Promise<{ ok: boolean; webhookUrl: string | null; error: string | null }> => {
    const trimmed = webhookUrlInput.trim();
    if (!trimmed) {
      return { ok: false, webhookUrl: null, error: "Paste your Google Apps Script Web App URL first." };
    }
    setSavingWebhookUrl(true);
    setAppsScriptModalError(null);
    setSheetsFeedback(null);
    try {
      const resp = await fetch("/api/atlas/sheets/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          webhookUrl: trimmed,
          skipVerify: opts?.skipVerify === true,
        }),
      });
      const data = await readJsonSafe<{
        saved?: boolean;
        verified?: boolean;
        webhookUrl?: string | null;
        sheetsStatus?: { spreadsheetId?: string | null; spreadsheetUrl?: string | null; lastError?: string | null };
        error?: string;
      }>(resp);
      await loadStatus();

      if (!resp.ok || !data.saved) {
        const errText =
          data.error || `Failed to save Google Apps Script Webhook URL (HTTP ${resp.status}).`;
        setAppsScriptModalError(errText);
        setSheetsFeedback({
          success: false,
          message: errText,
          url: null,
          needsReauth: true,
        });
        return { ok: false, webhookUrl: null, error: errText };
      }

      hasInitializedWebhookRef.current = true;
      const savedUrl = data.webhookUrl ?? trimmed;
      setWebhookUrlInput(savedUrl);
      if (data.sheetsStatus?.spreadsheetId) {
        hasInitializedSheetIdRef.current = true;
        setTargetSpreadsheetId(data.sheetsStatus.spreadsheetId);
      }

      if (opts?.skipVerify) {
        return { ok: true, webhookUrl: savedUrl, error: null };
      }

      if (data.verified) {
        setSheetsFeedback({
          success: true,
          message:
            "Google Apps Script Webhook URL saved and verified. Click Export Google Sheets or Sync Google Sheets to publish all 6 SQLite datasets.",
          url: data.sheetsStatus?.spreadsheetUrl ?? null,
        });
        return { ok: true, webhookUrl: savedUrl, error: null };
      }

      const verifyErr =
        data.error ||
        data.sheetsStatus?.lastError ||
        "Webhook URL saved, but verification failed. Ensure your Apps Script Web App is deployed with 'Who has access: Anyone'.";
      setAppsScriptModalError(verifyErr);
      setSheetsFeedback({
        success: false,
        message: verifyErr,
        url: null,
      });
      return { ok: false, webhookUrl: savedUrl, error: verifyErr };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setAppsScriptModalError(msg);
      setSheetsFeedback({
        success: false,
        message: msg,
        url: null,
      });
      return { ok: false, webhookUrl: null, error: msg };
    } finally {
      setSavingWebhookUrl(false);
    }
  };

  const handleSaveWebhookUrl = async (): Promise<boolean> => {
    const res = await saveWebhookUrlInternal({ skipVerify: false });
    return res.ok;
  };

  const handleRemoveWebhookUrl = async () => {
    setSavingWebhookUrl(true);
    setAppsScriptModalError(null);
    setSheetsFeedback(null);
    try {
      const resp = await fetch("/api/atlas/sheets/webhook", { method: "DELETE" });
      const data = await readJsonSafe<{ error?: string }>(resp);
      await loadStatus();
      if (!resp.ok) {
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      hasInitializedWebhookRef.current = true;
      setWebhookUrlInput("");
      setSheetsFeedback({
        success: true,
        message: "Cleared Google Apps Script Webhook URL.",
        url: null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setAppsScriptModalError(msg);
      setSheetsFeedback({
        success: false,
        message: msg,
        url: null,
      });
    } finally {
      setSavingWebhookUrl(false);
    }
  };

  const handleSaveServiceAccount = async (rawJson: string): Promise<boolean> => {
    setSavingServiceAccount(true);
    setSheetsFeedback(null);
    try {
      const resp = await fetch("/api/atlas/sheets/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credentialsJson: rawJson }),
      });
      const data = await readJsonSafe<{
        saved?: boolean;
        verified?: boolean;
        clientEmail?: string;
        sheetsStatus?: { spreadsheetUrl?: string | null; lastError?: string | null };
        error?: string;
      }>(resp);
      await loadStatus();

      if (!resp.ok || !data.saved) {
        setSheetsFeedback({
          success: false,
          message: data.error || `Failed to save Service Account credentials (HTTP ${resp.status}).`,
          url: null,
          needsReauth: true,
        });
        return false;
      }

      if (data.verified) {
        setSheetsFeedback({
          success: true,
          message: `Google Service Account saved and verified (${data.clientEmail || "Service Account"}). Click Export Google Sheets or Sync Google Sheets to publish all 6 tabs.`,
          url: data.sheetsStatus?.spreadsheetUrl ?? null,
        });
        return true;
      }

      setSheetsFeedback({
        success: false,
        message:
          data.error ||
          data.sheetsStatus?.lastError ||
          "Service Account JSON saved on server, but Google API verification failed. Confirm Sheets & Drive APIs are enabled.",
        url: null,
      });
      return false;
    } catch (err) {
      setSheetsFeedback({
        success: false,
        message: err instanceof Error ? err.message : String(err),
        url: null,
      });
      return false;
    } finally {
      setSavingServiceAccount(false);
    }
  };

  const handleRemoveServiceAccount = async () => {
    setSavingServiceAccount(true);
    setSheetsFeedback(null);
    try {
      const resp = await fetch("/api/atlas/sheets/credentials", { method: "DELETE" });
      const data = await readJsonSafe<{ error?: string }>(resp);
      await loadStatus();
      if (!resp.ok) {
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      setSheetsFeedback({
        success: true,
        message: "Removed saved Service Account key from server config.",
        url: null,
      });
    } catch (err) {
      setSheetsFeedback({
        success: false,
        message: err instanceof Error ? err.message : String(err),
        url: null,
      });
    } finally {
      setSavingServiceAccount(false);
    }
  };

  const executeSheetsAction = async (
    mode: "full" | "incremental",
    opts?: { webhookUrl?: string | null }
  ): Promise<boolean> => {
    setSheetsConfirmMode(null);
    const isFull = mode === "full";
    if (isFull) setSheetsExporting(true);
    else setSheetsSyncing(true);
    setSheetsFeedback(null);

    try {
      const effectiveWebhookUrl =
        (opts?.webhookUrl !== undefined ? opts.webhookUrl : webhookUrlInput)?.trim() || undefined;
      const resp = await fetch(isFull ? "/api/atlas/export/sheets" : "/api/atlas/sync/sheets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          webhookUrl: effectiveWebhookUrl,
          spreadsheetId: targetSpreadsheetId.trim() || undefined,
          createNew: targetSpreadsheetId.trim() === "",
          exportScope: sheetsExportScope,
        }),
      });
      const data = await readJsonSafe<Record<string, unknown>>(resp);
      await loadStatus();

      const requiredTabs = [
        "Startups",
        "Products",
        "Research Papers",
        "Jobs",
        "News",
        "Entity Mapping Log",
      ];
      const tabStatuses = (data.tabStatuses ?? {}) as Record<string, { status?: string }>;
      const allTabsVerified = requiredTabs.every(
        (tab) => tabStatuses?.[tab]?.status === "success"
      );
      const steps = Array.isArray(data.steps) ? (data.steps as ExportStepStatus[]) : undefined;
      const fallbackExport =
        (data.fallbackExport as SheetsFallbackExportSummary | null | undefined) ?? null;
      const publicAccessStatus = (data.publicAccessStatus as PublicAccessStatus | undefined) ?? "unknown";
      const publicViewerVerified = Boolean(data.publicViewerVerified);
      const publicAccessError =
        typeof data.publicAccessError === "string" ? data.publicAccessError : null;
      const countsSummary = {
        inserted: Number(data.rowsAdded ?? 0),
        updated: Number(data.rowsUpdated ?? 0),
        skipped: Number(data.rowsSkipped ?? 0),
        failed: Number(data.rowsFailed ?? 0),
      };

      if (data.success && allTabsVerified && typeof data.spreadsheetUrl === "string" && data.spreadsheetUrl) {
        if (data.spreadsheetId) {
          hasInitializedSheetIdRef.current = true;
          setTargetSpreadsheetId(String(data.spreadsheetId));
        }
        const verifiedMap = (data.verifiedTabRowCounts || data.tabRowCounts || {}) as Record<string, number>;
        const perTabText = requiredTabs
          .map((t) => `${t}: ${Number(verifiedMap[t] ?? 0).toLocaleString()}`)
          .join(" · ");
        const sharingNote = publicViewerVerified
          ? " Public link verified ('Anyone with the link — Viewer')."
          : publicAccessStatus === "policy_blocked"
          ? " Spreadsheet saved, but public link sharing is blocked by Drive policy (download CSV/ZIP fallback below if needed for external reviewers)."
          : " Public sharing not confirmed.";
        if (isFull) {
          const verifiedTotal = Object.values(verifiedMap).reduce(
            (a: number, b: unknown) => a + Number(b || 0),
            0
          );
          setSheetsFeedback({
            success: true,
            message: `Export Successful — verified across all 6 worksheets (${verifiedTotal.toLocaleString()} rows — ${perTabText}).${sharingNote}`,
            url: data.spreadsheetUrl,
            publicAccessStatus,
            publicViewerVerified,
            publicAccessError,
            steps,
            countsSummary,
          });
        } else {
          setSheetsFeedback({
            success: true,
            message: `Google Sheets incremental sync verified across all 6 worksheets (+${countsSummary.inserted.toLocaleString()} inserted, ~${countsSummary.updated.toLocaleString()} updated, ${countsSummary.skipped.toLocaleString()} skipped — ${perTabText}).${sharingNote}`,
            url: data.spreadsheetUrl,
            publicAccessStatus,
            publicViewerVerified,
            publicAccessError,
            steps,
            countsSummary,
          });
        }
        setAppsScriptModalError(null);
        return true;
      } else {
        if (data.spreadsheetId) {
          hasInitializedSheetIdRef.current = true;
          setTargetSpreadsheetId(String(data.spreadsheetId));
        }
        const errMsg = String(
          data.error ||
            (!allTabsVerified
              ? "Export failed: not all 6 required worksheets could be verified."
              : "Google Sheets operation failed.")
        );
        const needsReauth = Boolean(data.authRequired) || resp.status === 401 || errMsg.includes("401");
        const resolvedFallback =
          fallbackExport ?? (await prepareFallbackSummary(errMsg, sheetsExportScope));
        setAppsScriptModalError(errMsg);
        setSheetsFeedback({
          success: false,
          message: errMsg,
          url: null,
          needsReauth,
          publicAccessStatus,
          publicViewerVerified: false,
          publicAccessError,
          steps,
          fallbackExport: resolvedFallback,
          countsSummary,
        });
        return false;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const fallbackExport = await prepareFallbackSummary(msg, sheetsExportScope);
      setAppsScriptModalError(msg);
      setSheetsFeedback({
        success: false,
        message: msg,
        url: null,
        fallbackExport,
      });
      return false;
    } finally {
      if (isFull) setSheetsExporting(false);
      else setSheetsSyncing(false);
    }
  };

  const handleSaveAndSyncWebhook = async (): Promise<boolean> => {
    const saveRes = await saveWebhookUrlInternal({ skipVerify: true });
    if (!saveRes.ok || !saveRes.webhookUrl) {
      return false;
    }
    const syncOk = await executeSheetsAction("full", { webhookUrl: saveRes.webhookUrl });
    if (syncOk) {
      setAppsScriptModalOpen(false);
    }
    return syncOk;
  };

  const startSheetsFlow = async (mode: "full" | "incremental") => {
    setSheetsFeedback(null);
    // Protect already-saved permanent spreadsheets from full batchClear overwrites:
    // use non-destructive incremental merge whenever updating an existing spreadsheetId.
    const effectiveMode: "full" | "incremental" =
      mode === "full" && targetSpreadsheetId.trim() !== "" ? "incremental" : mode;
    const syncTargetReady = Boolean(
      webhookUrlInput.trim() ||
        status?.sheetsStatus?.webhookUrl ||
        status?.sheetsStatus?.configured ||
        status?.credentials.googleSheetsConfigured
    );
    if (!syncTargetReady) {
      setAppsScriptModalError(null);
      setAppsScriptModalOpen(true);
      const msg =
        "Paste your Google Apps Script Webhook URL in the Setup modal to export all 6 tabs directly to a public Google Sheet.";
      const fallbackExport = await prepareFallbackSummary(msg, sheetsExportScope);
      setSheetsFeedback({
        success: false,
        message: msg,
        url: null,
        needsReauth: true,
        fallbackExport,
        steps: [
          {
            step: 1,
            key: "auth",
            label: "Save Google Apps Script Webhook URL",
            status: "failed",
            detail: msg,
          },
        ],
      });
      return;
    }
    setSheetsConfirmMode(effectiveMode);
  };

  const handleExportSheets = () => {
    void startSheetsFlow("full");
  };

  const handleSyncSheets = () => {
    void startSheetsFlow("incremental");
  };

  const triggerBrowserFileDownload = (url: string, filename: string) => {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleExportCsv = async (downloadSeparateFiles = false) => {
    setCsvExporting(true);
    setSheetsFeedback(null);
    try {
      const resp = await fetch("/api/atlas/export/csv", { method: "POST" });
      const data = await readJsonSafe<{
        rowCounts?: Record<string, number>;
        totalRows?: number;
        datasets?: Array<{ filename: string; tabName: string; rowCount: number; downloadUrl: string }>;
        error?: string;
      }>(resp);
      if (!resp.ok) {
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      void loadStatus();
      const totalExported =
        typeof data.totalRows === "number"
          ? data.totalRows
          : Object.values(data.rowCounts || {}).reduce((a: number, b: unknown) => a + Number(b || 0), 0);

      if (downloadSeparateFiles) {
        const files =
          Array.isArray(data.datasets) && data.datasets.length > 0
            ? data.datasets.map((d) => ({ filename: d.filename, downloadUrl: d.downloadUrl }))
            : Object.values(DATASET_CSV_NAMES).map((filename) => ({
                filename,
                downloadUrl: `/api/atlas/download/csv/${filename}`,
              }));
        files.forEach((f, idx) => {
          window.setTimeout(() => {
            triggerBrowserFileDownload(f.downloadUrl, f.filename);
          }, idx * 320);
        });
      }

      setSheetsFeedback({
        success: true,
        message: downloadSeparateFiles
          ? `Prepared and started download for all 6 live SQLite CSV datasets (${totalExported.toLocaleString()} total rows). If your browser pauses multiple downloads, use the ZIP bundle or individual file links in the Delivery panel below.`
          : `All 6 live SQLite CSV exports refreshed (${totalExported.toLocaleString()} total rows). Download individual CSVs or the single ZIP bundle below.`,
      });
    } catch (err) {
      setSheetsFeedback({
        success: false,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setCsvExporting(false);
    }
  };

  const handleRefresh = () => {
    void loadStatus();
    void loadFailures();
    if (activeSection !== "overview" && activeSection !== "gmail") {
      void loadDataset(activeSection, datasetWindow);
    }
  };

  return (
    <div className="min-h-screen bg-[#070D1A] text-slate-100 flex">
      <Sidebar
        activeSection={activeSection}
        onSelect={handleSelectSection}
        counts={status?.counts ?? null}
        storageBackend={status?.storage.backend ?? "sqlite"}
        freshnessHours={status?.freshnessWindowHours ?? 24}
        mobileOpen={mobileNavOpen}
        onCloseMobile={() => setMobileNavOpen(false)}
      />

      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top Workspace Bar */}
        <header className="sticky top-0 z-30 h-16 bg-[#070D1A]/90 backdrop-blur-md border-b border-slate-800/80 px-4 sm:px-6 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              aria-label="Open navigation"
              className="lg:hidden p-2 rounded-lg text-slate-300 hover:bg-slate-800/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-sm min-w-0">
              <span className="text-slate-400 hidden sm:inline">FrontierAtlas</span>
              <span className="text-slate-600 hidden sm:inline" aria-hidden="true">
                /
              </span>
              <span className="font-display font-semibold text-slate-100 truncate">
                {SECTION_LABELS[activeSection]}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={handleRefresh}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-200 text-xs font-medium transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Refresh</span>
            </button>
            <button
              type="button"
              onClick={() => setRunModalOpen(true)}
              disabled={runState.status === "running"}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-60 text-white text-xs font-medium transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              <Play className="w-3.5 h-3.5" />
              <span>{runState.status === "running" ? "Running..." : "Run Collection"}</span>
            </button>
          </div>
        </header>

        {/* Main Content Viewport */}
        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-[1440px] w-full mx-auto">
          {activeSection === "overview" ? (
            <OverviewPanel
              status={status}
              loading={statusLoading}
              error={statusError}
              failures={failures}
              runState={runState}
              auditing={auditing}
              csvExporting={csvExporting}
              schedulerUpdating={schedulerUpdating}
              sheetsExporting={sheetsExporting}
              sheetsSyncing={sheetsSyncing}
              sheetsExportScope={sheetsExportScope}
              onSheetsExportScopeChange={setSheetsExportScope}
              sheetsFeedback={sheetsFeedback}
              savingServiceAccount={savingServiceAccount}
              webhookUrlInput={webhookUrlInput}
              onWebhookUrlInputChange={(val) => {
                hasInitializedWebhookRef.current = true;
                setWebhookUrlInput(val);
              }}
              savingWebhookUrl={savingWebhookUrl}
              onSaveWebhookUrl={handleSaveWebhookUrl}
              onSaveAndSyncWebhook={handleSaveAndSyncWebhook}
              onRemoveWebhookUrl={() => {
                void handleRemoveWebhookUrl();
              }}
              onOpenAppsScriptModal={() => {
                setAppsScriptModalError(null);
                setAppsScriptModalOpen(true);
              }}
              targetSpreadsheetId={targetSpreadsheetId}
              onTargetSpreadsheetIdChange={(val) => {
                hasInitializedSheetIdRef.current = true;
                setTargetSpreadsheetId(val);
              }}
              onClearTargetSpreadsheetId={() => {
                hasInitializedSheetIdRef.current = true;
                setTargetSpreadsheetId("");
                setSheetsFeedback(null);
              }}
              onSaveServiceAccount={handleSaveServiceAccount}
              onRemoveServiceAccount={() => {
                void handleRemoveServiceAccount();
              }}
              testingIntegrations={testingIntegrations}
              testingGoogleConnection={testingGoogleConnection}
              onTestIntegrations={() => {
                void handleTestIntegrations();
              }}
              onTestGoogleConnection={() => {
                void handleTestGoogleConnection();
              }}
              onSelectSection={handleSelectSection}
              onOpenRunModal={() => setRunModalOpen(true)}
              onRefresh24h={handleRefresh24h}
              onUpdateScheduler={handleUpdateScheduler}
              onAuditRecords={handleAuditRecords}
              onExportSheets={handleExportSheets}
              onSyncSheets={handleSyncSheets}
              onExportCsv={() => void handleExportCsv(false)}
              onDownloadAllDatasets={() => void handleExportCsv(true)}
              onRetryStatus={loadStatus}
            />
          ) : activeSection === "gmail" ? (
            <GmailPanel status={status} />
          ) : (
            <DatasetView
              key={activeSection}
              category={activeSection}
              rows={datasetRows}
              totalCount={datasetTotalCount}
              categoryFailures={failures.filter((f) => f.category === activeSection)}
              loading={datasetLoading}
              error={datasetError}
              hasCsvExport={Boolean(
                status || datasetRows.length > 0 || datasetTotalCount > 0 || DATASET_CSV_NAMES[activeSection]
              )}
              windowMode={datasetWindow}
              onWindowModeChange={setDatasetWindow}
              onSelectCategory={handleSelectSection}
              onRetry={() => loadDataset(activeSection, datasetWindow)}
              onOpenRunModal={() => setRunModalOpen(true)}
            />
          )}
        </main>
      </div>

      <RunCollectionModal
        open={runModalOpen}
        running={runState.status === "running"}
        credentials={status?.credentials ?? null}
        integrationHealth={status?.integrationHealth ?? null}
        onClose={() => setRunModalOpen(false)}
        onStartRun={handleStartRun}
      />

      <AppsScriptSetupModal
        open={appsScriptModalOpen}
        webhookUrlInput={webhookUrlInput}
        onWebhookUrlInputChange={(val) => {
          hasInitializedWebhookRef.current = true;
          setAppsScriptModalError(null);
          setWebhookUrlInput(val);
        }}
        savedWebhookUrl={status?.sheetsStatus?.webhookUrl}
        spreadsheetUrl={
          (sheetsFeedback?.success && sheetsFeedback.url) ||
          status?.sheetsStatus?.spreadsheetUrl
        }
        totalRowsCount={
          status
            ? Object.values(status.counts).reduce((sum, n) => sum + n, 0)
            : 0
        }
        savingWebhookUrl={savingWebhookUrl}
        syncingNow={sheetsExporting || sheetsSyncing}
        errorMessage={appsScriptModalError}
        onClose={() => setAppsScriptModalOpen(false)}
        onSaveOnly={handleSaveWebhookUrl}
        onSaveAndSyncNow={handleSaveAndSyncWebhook}
        onRemoveWebhookUrl={() => {
          void handleRemoveWebhookUrl();
        }}
      />

      <SheetsConfirmModal
        mode={sheetsConfirmMode}
        exportScope={sheetsExportScope}
        spreadsheetId={targetSpreadsheetId}
        status={status}
        serviceAccountEmail={status?.sheetsStatus?.verifiedAccountEmail ?? null}
        onCancel={() => setSheetsConfirmMode(null)}
        onConfirm={() => {
          if (sheetsConfirmMode) void executeSheetsAction(sheetsConfirmMode);
        }}
      />
    </div>
  );
}
