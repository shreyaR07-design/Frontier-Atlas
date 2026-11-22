/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Menu, Play, RefreshCw } from "lucide-react";
import { DatasetView } from "./components/DatasetView";
import { OverviewPanel } from "./components/OverviewPanel";
import { RunCollectionModal } from "./components/RunCollectionModal";
import { SheetsConfirmModal } from "./components/SheetsConfirmModal";
import { Sidebar } from "./components/Sidebar";
import {
  clearGoogleAccessToken,
  formatGoogleAuthError,
  getGoogleAccessToken,
  googleSignIn,
  googleSignOut,
  initGoogleAuth,
  isGoogleOAuthBlockedMessage,
  isGoogleTokenValid,
  updateGoogleTokenExpiry,
} from "./lib/googleWorkspaceAuth";
import type {
  AnyDatasetRow,
  AtlasStatusResponse,
  DatasetCategory,
  FailureLogRow,
  RunJobState,
  SectionId,
} from "./types/atlas";

const SECTION_LABELS: Record<SectionId, string> = {
  overview: "Overview",
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
  const raw = await resp.text();
  if (!raw.trim()) {
    return {} as T & { error?: string };
  }
  try {
    return JSON.parse(raw) as T & { error?: string };
  } catch {
    return {
      error: `Unexpected non-JSON response (HTTP ${resp.status}): ${raw.slice(0, 140)}`,
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
  const [targetSpreadsheetId, setTargetSpreadsheetId] = useState("");
  const hasInitializedSheetIdRef = useRef(false);
  const [googleSigningIn, setGoogleSigningIn] = useState(false);
  const [testingIntegrations, setTestingIntegrations] = useState(false);
  const [testingGoogleConnection, setTestingGoogleConnection] = useState(false);
  const [googleUserEmail, setGoogleUserEmail] = useState<string | null>(null);
  const [googleHasToken, setGoogleHasToken] = useState(false);
  const [sheetsFeedback, setSheetsFeedback] = useState<{
    success: boolean;
    message: string;
    url?: string | null;
    needsReauth?: boolean;
  } | null>(null);

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
      datasetRequestSeqRef.current += 1;
      setDatasetRows([]);
      setDatasetTotalCount(0);
      setDatasetError(null);
      setDatasetWindow("all");
      setDatasetLoading(nextSection !== "overview");
      setActiveSection(nextSection);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [activeSection]);

  useEffect(() => {
    void loadStatus();
    void loadFailures();
  }, [loadStatus, loadFailures]);

  useEffect(() => {
    const unsubscribe = initGoogleAuth(
      (user, hasToken) => {
        setGoogleUserEmail(user.email || user.displayName || "Google Account");
        setGoogleHasToken(hasToken);
      },
      () => {
        setGoogleUserEmail(null);
        setGoogleHasToken(false);
      }
    );
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!hasInitializedSheetIdRef.current && status?.sheetsStatus?.spreadsheetId) {
      hasInitializedSheetIdRef.current = true;
      setTargetSpreadsheetId(status.sheetsStatus.spreadsheetId);
    }
  }, [status?.sheetsStatus?.spreadsheetId]);

  useEffect(() => {
    if (activeSection !== "overview") {
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
            if (activeSection !== "overview") {
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
      if (activeSection !== "overview") {
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

  const handleTestIntegrations = useCallback(async (overrideToken?: string | null) => {
    setTestingIntegrations(true);
    try {
      const token = overrideToken !== undefined ? overrideToken : getGoogleAccessToken();
      if (overrideToken === undefined && !token) {
        setGoogleHasToken(false);
      }
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      const resp = await fetch("/api/atlas/integrations/test", {
        method: "POST",
        headers,
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

  const handleTestGoogleConnection = useCallback(
    async (overrideToken?: string | null): Promise<boolean> => {
      setTestingGoogleConnection(true);
      setSheetsFeedback(null);
      try {
        const token = overrideToken !== undefined ? overrideToken : getGoogleAccessToken();
        if (overrideToken === undefined && !token) {
          setGoogleHasToken(false);
        }
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (token) {
          headers.Authorization = `Bearer ${token}`;
        }
        const resp = await fetch("/api/atlas/sheets/verify", {
          method: "POST",
          headers,
          body: JSON.stringify({
            spreadsheetId: targetSpreadsheetId.trim() || undefined,
            createNew: targetSpreadsheetId.trim() === "",
          }),
        });
        const data = await readJsonSafe<Record<string, unknown>>(resp);
        await loadStatus();

        if (data.status === "Connected") {
          if (typeof data.tokenExpiresInSeconds === "number") {
            updateGoogleTokenExpiry(data.tokenExpiresInSeconds);
          }
          if (data.verifiedAccountEmail) {
            setGoogleUserEmail(String(data.verifiedAccountEmail));
          }
          setSheetsFeedback({
            success: true,
            message: data.spreadsheetId
              ? `Google Workspace connection verified (${String(data.verifiedAccountEmail || googleUserEmail || "OAuth")} — Drive & Spreadsheet ${String(data.spreadsheetId)} accessible).`
              : `Google Workspace connection verified (${String(data.verifiedAccountEmail || googleUserEmail || "OAuth")} — Drive & Sheets permissions confirmed).`,
            url: null,
          });
          return true;
        }

        const needsReauth = Boolean(data.authRequired) || resp.status === 401;
        if (needsReauth) {
          clearGoogleAccessToken();
          setGoogleHasToken(false);
        }
        setSheetsFeedback({
          success: false,
          message:
            String(
              data.lastError ||
                data.error ||
                "Google Sheets is not connected. Click 'Sign in with Google' to authorize Drive & Sheets."
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
    },
    [googleUserEmail, loadStatus, targetSpreadsheetId]
  );

  const handleGoogleSignIn = async (selectAccount = false) => {
    setGoogleSigningIn(true);
    setSheetsFeedback(null);
    try {
      const { user, accessToken } = await googleSignIn({ selectAccount });
      setGoogleUserEmail(user.email || user.displayName || "Google Account");
      setGoogleHasToken(true);
      await handleTestGoogleConnection(accessToken);
    } catch (err) {
      setGoogleHasToken(isGoogleTokenValid());
      const formatted = formatGoogleAuthError(err);
      setSheetsFeedback({
        success: false,
        message: formatted,
        url: null,
        needsReauth: !isGoogleOAuthBlockedMessage(formatted),
      });
    } finally {
      setGoogleSigningIn(false);
    }
  };

  const handleGoogleSignOut = async () => {
    await googleSignOut();
    setGoogleUserEmail(null);
    setGoogleHasToken(false);
    await handleTestIntegrations(null);
    setSheetsFeedback({
      success: true,
      message: "Signed out of Google Workspace session.",
      url: null,
    });
  };

  const executeSheetsAction = async (mode: "full" | "incremental") => {
    setSheetsConfirmMode(null);
    const isFull = mode === "full";
    if (isFull) setSheetsExporting(true);
    else setSheetsSyncing(true);
    setSheetsFeedback(null);

    try {
      const token = getGoogleAccessToken();
      if (!token && !status?.credentials.googleSheetsConfigured) {
        setGoogleHasToken(false);
        setSheetsFeedback({
          success: false,
          message:
            "Google OAuth session expired or missing. Click 'Sign in with Google' to authorize before exporting.",
          url: null,
          needsReauth: true,
        });
        return;
      }
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      const resp = await fetch(isFull ? "/api/atlas/export/sheets" : "/api/atlas/sync/sheets", {
        method: "POST",
        headers,
        body: JSON.stringify({
          spreadsheetId: targetSpreadsheetId.trim() || undefined,
          createNew: targetSpreadsheetId.trim() === "",
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

      if (data.success && allTabsVerified && typeof data.spreadsheetUrl === "string" && data.spreadsheetUrl) {
        if (data.spreadsheetId) {
          hasInitializedSheetIdRef.current = true;
          setTargetSpreadsheetId(String(data.spreadsheetId));
        }
        const verifiedMap = (data.verifiedTabRowCounts || data.tabRowCounts || {}) as Record<string, number>;
        const perTabText = requiredTabs
          .map((t) => `${t}: ${Number(verifiedMap[t] ?? 0).toLocaleString()}`)
          .join(" · ");
        if (isFull) {
          const verifiedTotal = Object.values(verifiedMap).reduce(
            (a: number, b: unknown) => a + Number(b || 0),
            0
          );
          setSheetsFeedback({
            success: true,
            message: `Export Successful — verified across all 6 worksheets (${verifiedTotal.toLocaleString()} total rows — ${perTabText}).`,
            url: data.spreadsheetUrl,
          });
        } else {
          setSheetsFeedback({
            success: true,
            message: `Google Sheets incremental sync verified across all 6 worksheets (+${Number(data.rowsAdded ?? 0).toLocaleString()} added, ${Number(data.rowsUpdated ?? 0).toLocaleString()} updated, ${Number(data.rowsUnchanged ?? 0).toLocaleString()} unchanged — ${perTabText}).`,
            url: data.spreadsheetUrl,
          });
        }
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
        if (needsReauth) {
          clearGoogleAccessToken();
          setGoogleHasToken(false);
        }
        setSheetsFeedback({
          success: false,
          message: errMsg,
          url: null,
          needsReauth,
        });
      }
    } catch (err) {
      setSheetsFeedback({
        success: false,
        message: err instanceof Error ? err.message : String(err),
        url: null,
      });
    } finally {
      if (isFull) setSheetsExporting(false);
      else setSheetsSyncing(false);
    }
  };

  const startSheetsFlow = async (mode: "full" | "incremental") => {
    setSheetsFeedback(null);
    const token = getGoogleAccessToken();
    const serviceAccountReady = Boolean(status?.credentials.googleSheetsConfigured);
    if (!token && !serviceAccountReady) {
      setGoogleHasToken(false);
      setGoogleSigningIn(true);
      try {
        const { user, accessToken } = await googleSignIn();
        setGoogleUserEmail(user.email || user.displayName || "Google Account");
        setGoogleHasToken(true);
        const verified = await handleTestGoogleConnection(accessToken);
        if (verified) {
          setSheetsConfirmMode(mode);
        }
      } catch (err) {
        const formatted = formatGoogleAuthError(err);
        const blocked = isGoogleOAuthBlockedMessage(formatted);
        setSheetsFeedback({
          success: false,
          message: blocked
            ? formatted
            : `Google sign-in is required to create or write spreadsheets: ${formatted}`,
          url: null,
          needsReauth: !blocked,
        });
      } finally {
        setGoogleSigningIn(false);
      }
      return;
    }
    setSheetsConfirmMode(mode);
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
    if (activeSection !== "overview") {
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
              sheetsFeedback={sheetsFeedback}
              googleUserEmail={googleUserEmail}
              googleHasToken={googleHasToken}
              googleSigningIn={googleSigningIn}
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
              onGoogleSignIn={() => {
                void handleGoogleSignIn(false);
              }}
              onGoogleSwitchAccount={() => {
                void handleGoogleSignIn(true);
              }}
              onGoogleSignOut={handleGoogleSignOut}
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

      <SheetsConfirmModal
        mode={sheetsConfirmMode}
        spreadsheetId={targetSpreadsheetId}
        counts={status?.counts ?? null}
        googleEmail={googleHasToken ? googleUserEmail : null}
        onCancel={() => setSheetsConfirmMode(null)}
        onConfirm={() => {
          if (sheetsConfirmMode) void executeSheetsAction(sheetsConfirmMode);
        }}
      />
    </div>
  );
}
