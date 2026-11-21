/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Menu, Play, RefreshCw } from "lucide-react";
import { DatasetView } from "./components/DatasetView";
import { OverviewPanel } from "./components/OverviewPanel";
import { RunCollectionModal } from "./components/RunCollectionModal";
import { Sidebar } from "./components/Sidebar";
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

export default function App() {
  const [activeSection, setActiveSection] = useState<SectionId>("overview");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const [status, setStatus] = useState<AtlasStatusResponse | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [datasetRows, setDatasetRows] = useState<AnyDatasetRow[]>([]);
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
  const [sheetsExporting, setSheetsExporting] = useState(false);
  const [sheetsFeedback, setSheetsFeedback] = useState<{
    success: boolean;
    message: string;
    url?: string | null;
  } | null>(null);

  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      const resp = await fetch("/api/atlas/status");
      const data = await resp.json();
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

  const loadDataset = useCallback(async (category: DatasetCategory) => {
    const seq = ++datasetRequestSeqRef.current;
    setDatasetLoading(true);
    setDatasetError(null);
    try {
      const resp = await fetch(`/api/atlas/datasets/${category}?limit=500`);
      const data = await resp.json();
      if (seq !== datasetRequestSeqRef.current) return;
      if (!resp.ok) {
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      setDatasetRows(Array.isArray(data.rows) ? data.rows : []);
    } catch (err) {
      if (seq !== datasetRequestSeqRef.current) return;
      setDatasetError(err instanceof Error ? err.message : String(err));
      setDatasetRows([]);
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
      setDatasetError(null);
      setDatasetLoading(nextSection !== "overview");
      setActiveSection(nextSection);
    }
  }, [activeSection]);

  useEffect(() => {
    void loadStatus();
    void loadFailures();
  }, [loadStatus, loadFailures]);

  useEffect(() => {
    if (activeSection !== "overview") {
      void loadDataset(activeSection);
    }
  }, [activeSection, loadDataset]);

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
              void loadDataset(activeSection);
            }
          }
        }
      } catch {
        // Ignore transient poll errors
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [runState.status, activeSection, loadStatus, loadFailures, loadDataset]);

  const handleStartRun = async (categories: string[], limit: number, page = 1) => {
    setRunModalOpen(false);
    try {
      const resp = await fetch("/api/atlas/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categories, limit, page }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setRunState((prev) => ({
          ...prev,
          status: "failed",
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

  const handleAuditRecords = async () => {
    setAuditing(true);
    setSheetsFeedback(null);
    try {
      const resp = await fetch("/api/atlas/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      await loadStatus();
      await loadFailures();
      if (activeSection !== "overview") {
        void loadDataset(activeSection);
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

  const handleExportSheets = async () => {
    setSheetsExporting(true);
    setSheetsFeedback(null);
    try {
      const resp = await fetch("/api/atlas/export/sheets", { method: "POST" });
      const data = await resp.json();
      if (data.success) {
        setSheetsFeedback({
          success: true,
          message: "Google Sheets export completed across all 6 tabs.",
          url: data.spreadsheetUrl,
        });
      } else {
        setSheetsFeedback({
          success: false,
          message:
            data.error ||
            "Google Sheets credentials are not configured. Set GOOGLE_SHEETS_CREDENTIALS_PATH in frontier-atlas/.env.",
        });
      }
    } catch (err) {
      setSheetsFeedback({
        success: false,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSheetsExporting(false);
    }
  };

  const handleExportCsv = async () => {
    setSheetsFeedback(null);
    try {
      const resp = await fetch("/api/atlas/export/csv", { method: "POST" });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      void loadStatus();
      setSheetsFeedback({
        success: true,
        message: `CSV exports refreshed (${Object.values(data.rowCounts || {}).reduce(
          (a: number, b: unknown) => a + Number(b || 0),
          0
        )} total rows written to frontier-atlas/data/exports).`,
      });
    } catch (err) {
      setSheetsFeedback({
        success: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleRefresh = () => {
    void loadStatus();
    void loadFailures();
    if (activeSection !== "overview") {
      void loadDataset(activeSection);
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
              sheetsExporting={sheetsExporting}
              sheetsFeedback={sheetsFeedback}
              onSelectSection={handleSelectSection}
              onOpenRunModal={() => setRunModalOpen(true)}
              onAuditRecords={handleAuditRecords}
              onExportSheets={handleExportSheets}
              onExportCsv={handleExportCsv}
              onRetryStatus={loadStatus}
            />
          ) : (
            <DatasetView
              key={activeSection}
              category={activeSection}
              rows={datasetRows}
              categoryFailures={failures.filter((f) => f.category === activeSection)}
              loading={datasetLoading}
              error={datasetError}
              hasCsvExport={Boolean(
                status?.csvExports.includes(DATASET_CSV_NAMES[activeSection])
              )}
              onRetry={() => loadDataset(activeSection)}
              onOpenRunModal={() => setRunModalOpen(true)}
            />
          )}
        </main>
      </div>

      <RunCollectionModal
        open={runModalOpen}
        running={runState.status === "running"}
        credentials={status?.credentials ?? null}
        onClose={() => setRunModalOpen(false)}
        onStartRun={handleStartRun}
      />
    </div>
  );
}
