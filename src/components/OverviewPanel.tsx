import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  Clock,
  Database,
  Download,
  ExternalLink,
  FileSpreadsheet,
  Play,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import type {
  AtlasStatusResponse,
  DatasetCategory,
  FailureLogRow,
  IntegrationConnectionStatus,
  IntegrationHealthItem,
  RunJobState,
  SectionId,
} from "../types/atlas";

interface OverviewPanelProps {
  status: AtlasStatusResponse | null;
  loading: boolean;
  error: string | null;
  failures: FailureLogRow[];
  runState: RunJobState;
  auditing: boolean;
  csvExporting?: boolean;
  schedulerUpdating: boolean;
  sheetsExporting: boolean;
  sheetsSyncing: boolean;
  testingIntegrations: boolean;
  testingGoogleConnection: boolean;
  sheetsFeedback: {
    success: boolean;
    message: string;
    url?: string | null;
    needsReauth?: boolean;
  } | null;
  googleUserEmail: string | null;
  googleHasToken: boolean;
  googleSigningIn: boolean;
  targetSpreadsheetId: string;
  onTargetSpreadsheetIdChange: (value: string) => void;
  onClearTargetSpreadsheetId: () => void;
  onGoogleSignIn: () => void;
  onGoogleSwitchAccount: () => void;
  onGoogleSignOut: () => void;
  onTestIntegrations: () => void;
  onTestGoogleConnection: () => void;
  onSelectSection: (section: SectionId) => void;
  onOpenRunModal: () => void;
  onRefresh24h: () => void;
  onUpdateScheduler: (opts: { enabled?: boolean; utcTime?: string }) => void;
  onAuditRecords: () => void;
  onExportSheets: () => void;
  onSyncSheets: () => void;
  onExportCsv: () => void;
  onRetryStatus: () => void;
}

interface DatasetSummaryMeta {
  key: DatasetCategory;
  label: string;
  target: number | null;
  note: string;
}

const DATASET_META: DatasetSummaryMeta[] = [
  { key: "startups", label: "Startups", target: 1000, note: "YC OSS directory & official sites" },
  { key: "products", label: "Products", target: 1000, note: "HF Spaces, GitHub repos & Show HN" },
  { key: "research_papers", label: "Research Papers", target: 1000, note: "HF Daily Papers, arXiv, OpenAlex, Crossref & GitHub stars" },
  { key: "jobs", label: "Jobs", target: null, note: "Last 24h UTC across 9 job boards" },
  { key: "news", label: "News", target: null, note: "Last 24h UTC across 12+ RSS feeds & HN AI" },
  { key: "entity_mapping_log", label: "Entity Mapping Log", target: null, note: "Resolution decisions & confidence audit" },
];

const SHEETS_TABS_ORDER = [
  "Startups",
  "Products",
  "Research Papers",
  "Jobs",
  "News",
  "Entity Mapping Log",
];

function IntegrationStatusRow({
  item,
}: {
  item: {
    label: string;
    envKey: string;
    status: IntegrationConnectionStatus;
    detail: string;
    error?: string | null;
    latencyMs?: number | null;
  };
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2 py-3 border-b border-slate-800/70 last:border-b-0">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-slate-100">{item.label}</span>
          <span className="text-xs font-mono text-slate-400">{item.envKey}</span>
          {typeof item.latencyMs === "number" && item.status === "Configured" && (
            <span className="text-[11px] font-mono text-slate-500 tabular-nums">{item.latencyMs}ms</span>
          )}
        </div>
        <p
          className={`text-xs mt-0.5 ${
            item.status === "Connection Failed" ? "text-rose-300" : "text-slate-400"
          }`}
        >
          {item.status === "Connection Failed" ? item.error || item.detail : item.detail}
        </p>
      </div>
      <div className="flex items-center gap-1.5 shrink-0 pt-0.5">
        {item.status === "Configured" ? (
          <>
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            <span className="text-xs font-medium text-emerald-400 whitespace-nowrap">Configured</span>
          </>
        ) : item.status === "Connection Failed" ? (
          <>
            <AlertTriangle className="w-4 h-4 text-rose-400" />
            <span className="text-xs font-medium text-rose-400 whitespace-nowrap">Connection Failed</span>
          </>
        ) : (
          <>
            <XCircle className="w-4 h-4 text-amber-400" />
            <span className="text-xs font-medium text-amber-400 whitespace-nowrap">Not Configured</span>
          </>
        )}
      </div>
    </div>
  );
}

export function OverviewPanel({
  status,
  loading,
  error,
  failures,
  runState,
  auditing,
  csvExporting = false,
  schedulerUpdating,
  sheetsExporting,
  sheetsSyncing,
  testingIntegrations,
  testingGoogleConnection,
  sheetsFeedback,
  googleUserEmail,
  googleHasToken,
  googleSigningIn,
  targetSpreadsheetId,
  onTargetSpreadsheetIdChange,
  onClearTargetSpreadsheetId,
  onGoogleSignIn,
  onGoogleSwitchAccount,
  onGoogleSignOut,
  onTestIntegrations,
  onTestGoogleConnection,
  onSelectSection,
  onOpenRunModal,
  onRefresh24h,
  onUpdateScheduler,
  onAuditRecords,
  onExportSheets,
  onSyncSheets,
  onExportCsv,
  onRetryStatus,
}: OverviewPanelProps) {
  const [scheduleUtcInput, setScheduleUtcInput] = useState(
    status?.scheduler?.utc_time ?? "02:00"
  );
  const [scheduleEnabledInput, setScheduleEnabledInput] = useState(
    status?.scheduler?.enabled ?? true
  );

  useEffect(() => {
    if (status?.scheduler) {
      setScheduleUtcInput(status.scheduler.utc_time);
      setScheduleEnabledInput(status.scheduler.enabled);
    }
  }, [status?.scheduler]);
  if (loading && !status) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, idx) => (
            <div
              key={idx}
              className="h-32 rounded-xl bg-[#0E172B] border border-slate-800/80 animate-pulse p-5"
            />
          ))}
        </div>
      </div>
    );
  }

  if (error && !status) {
    return (
      <div className="rounded-xl bg-[#0E172B] border border-red-500/40 p-6 space-y-3">
        <div className="flex items-center gap-2 text-red-400 font-medium">
          <AlertTriangle className="w-5 h-5" />
          <span>Backend Connection Error</span>
        </div>
        <p className="text-sm text-slate-300">{error}</p>
        <button
          type="button"
          onClick={onRetryStatus}
          className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-sm font-medium transition-colors"
        >
          Retry Connection
        </button>
      </div>
    );
  }

  const totalRecords = status
    ? Object.values(status.counts).reduce((sum, n) => sum + n, 0)
    : 0;
  const report = status?.qualityReport ?? null;
  const verificationTotals = status?.verificationCounts?.totals ?? {
    Verified: 0,
    "Partially Verified": 0,
    Unverified: 0,
    "Source Unavailable": 0,
    Rejected: status?.failureCount ?? 0,
  };
  const verificationByCategory = status?.verificationCounts?.byCategory ?? {};
  const unavailableSources = report?.unavailable_sources ?? [];
  const sheetsStatus = status?.sheetsStatus ?? {
    status: "Not Connected",
    configured: status?.credentials.googleSheetsConfigured ?? false,
    credentialSource: null,
    spreadsheetId: null,
    spreadsheetUrl: null,
    lastSyncAt: null,
    lastAttemptAt: null,
    lastMode: null,
    tabRowCounts: {},
    rowsAdded: 0,
    rowsUpdated: 0,
    rowsUnchanged: 0,
    lastError: null,
  };
  const healthItems: IntegrationHealthItem[] = status?.integrationHealth?.items ?? [];
  const failedIntegrations = healthItems.filter((item) => item.status === "Connection Failed");
  const missingCredsList: string[] = [];
  if (status && status.integrationHealth?.byId?.gemini?.status === "Not Configured") {
    missingCredsList.push("GEMINI_API_KEY");
  }
  if (status && status.integrationHealth?.byId?.github?.status === "Not Configured") {
    missingCredsList.push("GITHUB_TOKEN");
  }

  const assessedTotal =
    verificationTotals.Verified +
    verificationTotals["Partially Verified"] +
    verificationTotals.Unverified +
    verificationTotals["Source Unavailable"] +
    verificationTotals.Rejected;
  const verifiedPct =
    assessedTotal > 0 ? ((verificationTotals.Verified / assessedTotal) * 100).toFixed(1) : "0.0";
  const corroboratedPct =
    assessedTotal > 0
      ? (((verificationTotals.Verified + verificationTotals["Partially Verified"]) / assessedTotal) * 100).toFixed(1)
      : "0.0";
  const jobsFresh = report?.categories?.jobs?.freshness ?? null;
  const newsFresh = report?.categories?.news?.freshness ?? null;
  const freshCounts24h = status?.freshCounts24h ?? { jobs: 0, news: 0, research_papers: 0 };
  const latestNewCounts = status?.latestRunNewCounts ?? {};
  const totalNewLatestRun = Object.values(latestNewCounts).reduce((sum, n) => sum + n, 0);
  const githubNotConfigured = status?.integrationHealth?.byId?.github?.status === "Not Configured";
  const pipelineRuns = status?.pipelineRuns ?? [];
  const lastSourceOutcomes = status?.lastSourceOutcomes ?? [];
  const failedSources = lastSourceOutcomes.filter((s) => s.status === "failed");
  const emptySources = lastSourceOutcomes.filter((s) => s.status === "empty");
  const okSources = lastSourceOutcomes.filter((s) => s.status === "ok");

  return (
    <div className="space-y-8">
      {/* Top Pipeline Summary Strip */}
      <section className="rounded-xl bg-[#0E172B] border border-slate-800/80 p-5 sm:p-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="font-display text-xl sm:text-2xl font-semibold text-slate-100">
                Data Intelligence Pipeline Overview
              </h1>
              {status?.latestRunStatus && (
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${
                    status.latestRunStatus === "completed"
                      ? "bg-emerald-950/50 border-emerald-700/60 text-emerald-300"
                      : status.latestRunStatus === "partial"
                      ? "bg-amber-950/50 border-amber-700/60 text-amber-300"
                      : "bg-rose-950/50 border-rose-700/60 text-rose-300"
                  }`}
                >
                  Latest Run: {status.latestRunStatus}
                </span>
              )}
            </div>
            <p className="text-sm text-slate-400">
              {totalRecords === 0
                ? "Database initialized with 0 records. Run a live collection to populate source-verified datasets."
                : `${totalRecords.toLocaleString()} total historical rows across 6 datasets in ${status?.storage.backend ?? "sqlite"}${status?.storage.integrityCheck === "ok" ? " (integrity verified)" : ""}.`}
              {pipelineRuns.length > 0
                ? ` · Latest run added +${totalNewLatestRun.toLocaleString()} new rows`
                : ""}
              {status?.lastSuccessfulRunAt
                ? ` · Last successful collection ${new Date(status.lastSuccessfulRunAt).toLocaleString()}`
                : report?.generated_at_utc
                ? ` · Last audit ${new Date(report.generated_at_utc).toLocaleString()}`
                : ""}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={onAuditRecords}
              disabled={auditing || runState.status === "running"}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-60 text-slate-200 text-sm font-medium transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              <ShieldCheck className="w-4 h-4 text-sky-400" />
              <span>{auditing ? "Auditing Sources..." : "Audit Records"}</span>
            </button>

            <button
              type="button"
              onClick={onExportCsv}
              disabled={csvExporting}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-60 text-slate-200 text-sm font-medium transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              <Download className="w-4 h-4" />
              <span>{csvExporting ? "Exporting CSV..." : "Export CSV"}</span>
            </button>

            <button
              type="button"
              onClick={onExportSheets}
              disabled={sheetsExporting || sheetsSyncing}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-60 text-slate-200 text-sm font-medium transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              <FileSpreadsheet className="w-4 h-4" />
              <span>{sheetsExporting ? "Exporting..." : "Export Google Sheets"}</span>
            </button>

            <button
              type="button"
              onClick={onSyncSheets}
              disabled={sheetsExporting || sheetsSyncing}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-60 text-slate-200 text-sm font-medium transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              <RefreshCw className={`w-4 h-4 ${sheetsSyncing ? "animate-spin" : ""}`} />
              <span>{sheetsSyncing ? "Syncing..." : "Sync Google Sheets"}</span>
            </button>

            <button
              type="button"
              onClick={onRefresh24h}
              disabled={runState.status === "running"}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-60 text-white text-sm font-medium transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            >
              <RefreshCw className={`w-4 h-4 ${runState.status === "running" && runState.mode === "daily_24h" ? "animate-spin" : ""}`} />
              <span>Refresh 24h Feeds</span>
            </button>

            <button
              type="button"
              onClick={onOpenRunModal}
              disabled={runState.status === "running"}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-60 text-white text-sm font-medium transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              <Play className="w-4 h-4" />
              <span>{runState.status === "running" ? "Collection Running..." : "Run Collection"}</span>
            </button>
          </div>
        </div>

        {/* Verification & Freshness KPI Strip */}
        <div className="mt-5 pt-4 border-t border-slate-800/80 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
          <div className="space-y-0.5">
            <div className="text-xs text-slate-400">Verified</div>
            <div className="font-mono text-lg font-semibold text-emerald-400 tabular-nums">
              {verificationTotals.Verified.toLocaleString()}
              <span className="text-xs font-normal text-emerald-400/80 ml-1.5">({verifiedPct}%)</span>
            </div>
            <div className="text-[11px] text-slate-500">Corroborated total: {corroboratedPct}%</div>
          </div>

          <div className="space-y-0.5">
            <div className="text-xs text-slate-400">Partially Verified</div>
            <div className="font-mono text-lg font-semibold text-sky-400 tabular-nums">
              {verificationTotals["Partially Verified"].toLocaleString()}
            </div>
            <div className="text-[11px] text-slate-500">Primary matched, fields uncertain</div>
          </div>

          <div className="space-y-0.5">
            <div className="text-xs text-slate-400">Unverified</div>
            <div className="font-mono text-lg font-semibold text-amber-400 tabular-nums">
              {verificationTotals.Unverified.toLocaleString()}
            </div>
            <div className="text-[11px] text-slate-500">Insufficient source evidence</div>
          </div>

          <div className="space-y-0.5">
            <div className="text-xs text-slate-400">Source Unavailable</div>
            <div className="font-mono text-lg font-semibold text-slate-300 tabular-nums">
              {verificationTotals["Source Unavailable"].toLocaleString()}
            </div>
            <div className="text-[11px] text-slate-500">
              {unavailableSources.length > 0
                ? `${unavailableSources.length} feed${unavailableSources.length === 1 ? "" : "s"} degraded`
                : "HTTP error, timeout, or blocked"}
            </div>
          </div>

          <div className="space-y-0.5">
            <div className="text-xs text-slate-400">Rejected</div>
            <div className="font-mono text-lg font-semibold text-rose-400 tabular-nums">
              {verificationTotals.Rejected.toLocaleString()}
            </div>
            <div className="text-[11px] text-slate-500">Preserved rows &amp; rule failures</div>
          </div>

          <div className="space-y-0.5">
            <div className="text-xs text-slate-400">Rolling 24h UTC Fresh</div>
            <div className="font-mono text-sm font-semibold text-emerald-300 tabular-nums pt-0.5">
              {freshCounts24h.jobs.toLocaleString()} Jobs · {freshCounts24h.news.toLocaleString()} News · {freshCounts24h.research_papers.toLocaleString()} Papers
            </div>
            <div className="text-[11px] text-slate-500 tabular-nums">
              {jobsFresh || newsFresh
                ? `Last run: ${jobsFresh?.accepted ?? 0}J / ${newsFresh?.accepted ?? 0}N within ${status?.freshnessWindowHours ?? 24}h UTC`
                : `Separate from historical archive (${(status?.counts.research_papers ?? 0).toLocaleString()} papers)`}
            </div>
          </div>
        </div>

        {/* Active / Recent Run Execution Feed */}
        {runState.status !== "idle" && (
          <div className="mt-5 pt-4 border-t border-slate-800/80 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="font-medium text-slate-200">
                Pipeline Execution:{" "}
                {runState.status === "running"
                  ? "In Progress"
                  : runState.status === "completed"
                  ? "Completed"
                  : runState.status === "partial"
                  ? "Completed with Source Failures (Partial)"
                  : "Failed"}
                {runState.categories.length > 0 ? ` · Categories: ${runState.categories.join(", ")}` : ""}
                {` · Limit ${runState.limit}/category · Page ${runState.page ?? 1}`}
              </span>
              {runState.startedAt && (
                <span className="font-mono text-slate-400 tabular-nums">
                  Started {new Date(runState.startedAt).toLocaleTimeString()}
                </span>
              )}
            </div>
            {runState.error && (
              <p className="text-xs text-red-400 font-mono bg-red-950/30 border border-red-900/50 rounded-md p-2.5">
                {runState.error}
              </p>
            )}
            {runState.logs && runState.logs.length > 0 && (
              <pre className="text-xs font-mono text-slate-300 bg-[#070D1A] border border-slate-800 rounded-lg p-3 max-h-36 overflow-y-auto whitespace-pre-wrap">
                {runState.logs.slice(-12).join("\n")}
              </pre>
            )}
          </div>
        )}

        {sheetsFeedback && (
          <div
            className={`mt-4 rounded-lg border p-3 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2 ${
              sheetsFeedback.success
                ? "bg-emerald-950/30 border-emerald-800/60 text-emerald-300"
                : "bg-rose-950/30 border-rose-800/60 text-rose-200"
            }`}
          >
            <span>{sheetsFeedback.message}</span>
            <div className="flex items-center gap-2.5 shrink-0">
              {!sheetsFeedback.success &&
                Boolean(targetSpreadsheetId.trim()) &&
                /403|404|not found|Target Spreadsheet/i.test(sheetsFeedback.message) && (
                  <button
                    type="button"
                    onClick={onClearTargetSpreadsheetId}
                    className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium transition-colors"
                  >
                    Clear Target ID (Create New)
                  </button>
                )}
              {sheetsFeedback.needsReauth && (
                <button
                  type="button"
                  onClick={onGoogleSignIn}
                  disabled={googleSigningIn}
                  className="px-2.5 py-1 rounded bg-white hover:bg-slate-100 disabled:opacity-60 text-slate-900 font-medium transition-colors"
                >
                  {googleSigningIn ? "Signing in..." : "Sign in with Google"}
                </button>
              )}
              {sheetsFeedback.success && sheetsFeedback.url && (
                <a
                  href={sheetsFeedback.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-medium underline shrink-0"
                >
                  <span>Open Spreadsheet</span>
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              )}
            </div>
          </div>
        )}
        {(unavailableSources.length > 0 || missingCredsList.length > 0 || failedIntegrations.length > 0) && (
          <div className="mt-4 rounded-lg bg-amber-950/25 border border-amber-700/50 p-3.5 text-xs text-amber-200 space-y-1.5">
            {unavailableSources.length > 0 && (
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <span className="font-medium text-amber-300">External Source Errors: </span>
                  <span>
                    {unavailableSources.join(", ")} returned errors or timed out during collection (logged in{" "}
                    <code className="text-amber-100">failure_logs</code>).
                  </span>
                </div>
              </div>
            )}
            {failedIntegrations.length > 0 && (
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                <div className="text-rose-200">
                  <span className="font-medium text-rose-300">Integration Connection Failed: </span>
                  <span>
                    {failedIntegrations.map((i) => `${i.label}: ${i.error || i.detail}`).join(" · ")}
                  </span>
                </div>
              </div>
            )}
            {missingCredsList.length > 0 && (
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <span className="font-medium text-amber-300">Unconfigured API Credentials: </span>
                  <span>
                    <code className="text-amber-100">{missingCredsList.join(", ")}</code> not set in server environment.
                    {githubNotConfigured
                      ? " GitHub public API continues unauthenticated with a 60 requests/hour rate limit (set GITHUB_TOKEN for 5,000 req/hr)."
                      : " Public unauthenticated endpoints continue normally; optional provider keys enable extra fallbacks."}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Six Dataset Cards */}
      <section aria-label="Dataset record counts and extraction progress">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {DATASET_META.map((meta) => {
            const count = status?.counts[meta.key] ?? 0;
            const uniqueTargetCount =
              meta.key === "startups"
                ? status?.uniqueQualifiedCounts?.startups ?? count
                : meta.key === "products"
                ? status?.uniqueQualifiedCounts?.products ?? count
                : meta.key === "research_papers"
                ? status?.uniqueQualifiedCounts?.research_papers ?? count
                : count;
            const catReport = report?.categories[meta.key];
            const catVer = verificationByCategory[meta.key];
            const target = meta.target;
            const pct = target ? Math.min(100, Math.round((uniqueTargetCount / target) * 100)) : null;

            return (
              <button
                key={meta.key}
                type="button"
                onClick={() => onSelectSection(meta.key)}
                className="text-left rounded-xl bg-[#0E172B] border border-slate-800/80 hover:border-sky-500/50 p-5 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 group"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="font-display text-base font-semibold text-slate-100 group-hover:text-sky-300 transition-colors">
                      {meta.label}
                    </h2>
                    <p className="text-xs text-slate-400 mt-1">{meta.note}</p>
                  </div>
                  <ArrowRight className="w-4 h-4 text-slate-500 group-hover:text-sky-400 shrink-0 mt-0.5 transition-colors" />
                </div>

                <div className="mt-4 flex items-baseline justify-between gap-2">
                  <div>
                    <span className="font-mono text-2xl font-semibold text-slate-100 tabular-nums">
                      {count.toLocaleString()}
                    </span>
                    <span className="ml-1.5 text-[11px] font-mono text-sky-400/90 tabular-nums">
                      (+{(latestNewCounts[meta.key] ?? 0).toLocaleString()} new)
                    </span>
                  </div>
                  {meta.key === "research_papers" ? (
                    <span className="font-mono text-xs text-emerald-300 tabular-nums text-right">
                      24h Fresh: {freshCounts24h.research_papers.toLocaleString()} · {uniqueTargetCount.toLocaleString()} unique / {target?.toLocaleString()} ({pct}%)
                    </span>
                  ) : meta.key === "jobs" ? (
                    <span className="font-mono text-xs text-emerald-300 tabular-nums text-right">
                      24h Fresh: {freshCounts24h.jobs.toLocaleString()} · Archive {count.toLocaleString()}
                    </span>
                  ) : meta.key === "news" ? (
                    <span className="font-mono text-xs text-emerald-300 tabular-nums text-right">
                      24h Fresh: {freshCounts24h.news.toLocaleString()} · Archive {count.toLocaleString()}
                    </span>
                  ) : target !== null ? (
                    <span className="font-mono text-xs text-slate-400 tabular-nums text-right">
                      {uniqueTargetCount.toLocaleString()} unique / {target.toLocaleString()} ({pct}%)
                    </span>
                  ) : (
                    <span className="font-mono text-xs text-slate-400 text-right">
                      Audit entries
                    </span>
                  )}
                </div>

                {pct !== null && (
                  <div className="mt-2.5 h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
                    <div
                      className="h-full bg-sky-500 transition-all duration-300"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                )}

                {catVer ? (
                  <div className="mt-3 pt-3 border-t border-slate-800/70 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs tabular-nums">
                    <span className="text-emerald-400">Verified {catVer.Verified}</span>
                    <span className="text-slate-600" aria-hidden="true">·</span>
                    <span className="text-sky-400">Partial {catVer["Partially Verified"]}</span>
                    <span className="text-slate-600" aria-hidden="true">·</span>
                    <span className="text-amber-400">
                      Unverified {catVer.Unverified + catVer["Source Unavailable"]}
                    </span>
                    <span className="text-slate-600" aria-hidden="true">·</span>
                    <span className="text-rose-400">Rejected {catVer.Rejected}</span>
                  </div>
                ) : catReport ? (
                  <div className="mt-3 pt-3 border-t border-slate-800/70 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400 tabular-nums">
                    <span>Validated {catReport.validated}</span>
                    <span aria-hidden="true">·</span>
                    <span>Duplicates {catReport.duplicates}</span>
                    <span aria-hidden="true">·</span>
                    <span>Rejected {catReport.rejected}</span>
                  </div>
                ) : null}
              </button>
            );
          })}
        </div>
      </section>

      {/* Two-column Quality/Freshness & Integration Readiness */}
      <section className="grid grid-cols-1 xl:grid-cols-2 gap-6 items-stretch">
        {/* Freshness & Verification Quality Audit */}
        <div className="rounded-xl bg-[#0E172B] border border-slate-800/80 p-5 sm:p-6 flex flex-col">
          <div className="flex items-center justify-between gap-2 mb-4">
            <div>
              <h2 className="font-display text-base font-semibold text-slate-100">
                Dataset Quality &amp; Verification Matrix
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Live SQLite verification counts, source health, and 24h UTC freshness enforcement.
              </p>
            </div>
            <Clock className="w-4 h-4 text-slate-400 shrink-0" />
          </div>

          <div className="space-y-4 text-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-800 text-xs text-slate-400">
                    <th className="py-2 pr-3 font-medium">Dataset</th>
                    <th className="py-2 px-2 font-medium text-right">Total</th>
                    <th className="py-2 px-2 font-medium text-right">Verified</th>
                    <th className="py-2 px-2 font-medium text-right">Partial</th>
                    <th className="py-2 px-2 font-medium text-right">Unverified</th>
                    <th className="py-2 px-2 font-medium text-right">Unavail.</th>
                    <th className="py-2 px-2 font-medium text-right">Rejected</th>
                    <th className="py-2 pl-2 font-medium text-right">Ver. %</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-xs font-mono tabular-nums">
                  {DATASET_META.map((meta) => {
                    const rowTotal = status?.counts[meta.key] ?? 0;
                    const catVer = verificationByCategory[meta.key];
                    const repVer = report?.categories?.[meta.key]?.verification_breakdown ?? {};
                    const verCount = catVer?.Verified ?? repVer.Verified ?? 0;
                    const partCount = catVer?.["Partially Verified"] ?? repVer["Partially Verified"] ?? 0;
                    const unvCount = catVer?.Unverified ?? repVer.Unverified ?? 0;
                    const unavailCount = catVer?.["Source Unavailable"] ?? repVer["Source Unavailable"] ?? 0;
                    const rejCount =
                      catVer?.Rejected ??
                      repVer.Rejected ??
                      report?.categories?.[meta.key]?.rejected ??
                      0;
                    const isEntityLog = meta.key === "entity_mapping_log";
                    const pctStr = isEntityLog
                      ? "Audit"
                      : rowTotal > 0
                      ? `${((verCount / rowTotal) * 100).toFixed(1)}%`
                      : "0.0%";
                    return (
                      <tr
                        key={meta.key}
                        onClick={() => onSelectSection(meta.key)}
                        className="hover:bg-slate-800/40 cursor-pointer transition-colors"
                      >
                        <td className="py-2.5 pr-3 font-sans text-slate-200 font-medium">{meta.label}</td>
                        <td className="py-2.5 px-2 text-right text-slate-200">{rowTotal.toLocaleString()}</td>
                        <td className="py-2.5 px-2 text-right text-emerald-400">
                          {isEntityLog ? "—" : verCount.toLocaleString()}
                        </td>
                        <td className="py-2.5 px-2 text-right text-sky-400">
                          {isEntityLog ? "—" : partCount.toLocaleString()}
                        </td>
                        <td className="py-2.5 px-2 text-right text-amber-400">
                          {isEntityLog ? "—" : unvCount.toLocaleString()}
                        </td>
                        <td className="py-2.5 px-2 text-right text-slate-400">
                          {isEntityLog ? "—" : unavailCount.toLocaleString()}
                        </td>
                        <td className="py-2.5 px-2 text-right text-rose-400">
                          {isEntityLog ? "—" : rejCount.toLocaleString()}
                        </td>
                        <td className="py-2.5 pl-2 text-right text-slate-300">{pctStr}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {report?.entity_resolution && (
              <div className="pt-3 border-t border-slate-800/70 text-xs text-slate-300 flex flex-wrap gap-x-4 gap-y-1 tabular-nums">
                <span className="font-medium text-slate-200">Entity Resolution:</span>
                <span>Exact {report.entity_resolution.exact_match ?? 0}</span>
                <span>Auto Merge {report.entity_resolution.auto_merge ?? 0}</span>
                <span>Manual Review {report.entity_resolution.manual_review ?? 0}</span>
                <span>New Entities {report.entity_resolution.new_entity ?? 0}</span>
              </div>
            )}

            <div className="pt-2 border-t border-slate-800/70 text-xs flex flex-wrap items-center justify-between gap-2">
              <span className="text-slate-400">
                Source Health:{" "}
                <span className={unavailableSources.length > 0 ? "text-amber-300" : "text-emerald-400"}>
                  {unavailableSources.length > 0
                    ? `${unavailableSources.length} degraded (${unavailableSources.slice(0, 4).join(", ")}${unavailableSources.length > 4 ? "..." : ""})`
                    : "All monitored API & RSS endpoints operational"}
                </span>
              </span>
              {report?.generated_at_utc && (
                <span className="font-mono text-slate-500 tabular-nums">
                  {new Date(report.generated_at_utc).toLocaleTimeString()}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Credentials & Integration Status */}
        <div className="rounded-xl bg-[#0E172B] border border-slate-800/80 p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <div className="flex items-center gap-2">
              <Database className="w-4 h-4 text-slate-400 shrink-0" />
              <h2 className="font-display text-base font-semibold text-slate-100">
                Integration &amp; Credential Status
              </h2>
            </div>
            <button
              type="button"
              onClick={onTestIntegrations}
              disabled={testingIntegrations}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 disabled:opacity-60 text-slate-200 text-xs font-medium transition-colors"
            >
              <RefreshCw className={`w-3 h-3 ${testingIntegrations ? "animate-spin" : ""}`} />
              <span>{testingIntegrations ? "Testing..." : "Test Connections"}</span>
            </button>
          </div>
          <p className="text-xs text-slate-400 mb-3">
            Statuses reflect live backend health checks only (
            <span className="text-emerald-400">Configured</span> only after a real API probe succeeds
            {status?.integrationHealth?.checkedAt
              ? ` · Last checked ${new Date(status.integrationHealth.checkedAt).toLocaleTimeString()}`
              : ""}
            ).
          </p>

          <div>
            {healthItems.length > 0 ? (
              healthItems.map((item) => <IntegrationStatusRow key={item.id} item={item} />)
            ) : (
              <p className="text-xs text-slate-400 py-2">Loading live integration health checks...</p>
            )}
          </div>

          <div className="mt-5 pt-4 border-t border-slate-800/80 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <FileSpreadsheet className="w-4 h-4 text-sky-400 shrink-0" />
                <span className="text-sm font-medium text-slate-100">Google Sheets Sync Status</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={onTestGoogleConnection}
                  disabled={testingGoogleConnection || googleSigningIn}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 disabled:opacity-60 text-slate-200 text-xs font-medium transition-colors"
                >
                  <RefreshCw className={`w-3 h-3 ${testingGoogleConnection ? "animate-spin" : ""}`} />
                  <span>{testingGoogleConnection ? "Testing Google..." : "Test Google Connection"}</span>
                </button>
                <span
                  className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-0.5 rounded-md border ${
                    sheetsStatus.status === "Connected"
                      ? "bg-emerald-950/50 border-emerald-700/60 text-emerald-300"
                      : sheetsStatus.status === "Sync Failed"
                      ? "bg-rose-950/50 border-rose-700/60 text-rose-300"
                      : "bg-slate-900 border-slate-700 text-slate-300"
                  }`}
                >
                  {sheetsStatus.status === "Connected" ? (
                    <CheckCircle2 className="w-3.5 h-3.5" />
                  ) : sheetsStatus.status === "Sync Failed" ? (
                    <AlertTriangle className="w-3.5 h-3.5" />
                  ) : (
                    <XCircle className="w-3.5 h-3.5 text-amber-400" />
                  )}
                  <span>
                    {sheetsStatus.status === "Sync Failed"
                      ? "Sync Failed"
                      : sheetsStatus.status === "Connected"
                      ? "Connected"
                      : "Not Connected"}
                  </span>
                </span>
                {sheetsStatus.status === "Connected" &&
                  Boolean(sheetsStatus.lastSyncAt) &&
                  Boolean(sheetsStatus.spreadsheetUrl) && (
                    <a
                      href={sheetsStatus.spreadsheetUrl!}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-sky-400 hover:underline"
                    >
                      <span>Open Sheet</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
              </div>
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-lg bg-[#070D1A] border border-slate-800/80 p-3">
              {googleHasToken ? (
                <>
                  <div className="text-xs text-slate-300">
                    Signed in as <span className="font-mono text-emerald-300">{googleUserEmail}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={onGoogleSwitchAccount}
                      disabled={googleSigningIn}
                      className="px-3 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 disabled:opacity-60 text-slate-200 text-xs font-medium transition-colors"
                    >
                      {googleSigningIn ? "Authorizing..." : "Re-authorize"}
                    </button>
                    <button
                      type="button"
                      onClick={onGoogleSignOut}
                      className="px-3 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition-colors"
                    >
                      Sign out
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="text-xs text-slate-400">
                    Sign in with Google to authorize Google Drive &amp; Sheets creation, full 6-tab export, and duplicate-free incremental sync.
                  </div>
                  <button
                    type="button"
                    onClick={onGoogleSignIn}
                    disabled={googleSigningIn}
                    className="inline-flex items-center gap-2 px-3.5 py-2 rounded-md bg-white hover:bg-slate-100 disabled:opacity-60 text-slate-800 text-xs font-medium shadow-xs transition-colors shrink-0"
                  >
                    <svg
                      version="1.1"
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 48 48"
                      className="w-4 h-4 shrink-0"
                      aria-hidden="true"
                    >
                      <path
                        fill="#EA4335"
                        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                      />
                      <path
                        fill="#4285F4"
                        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                      />
                      <path
                        fill="#FBBC05"
                        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                      />
                      <path
                        fill="#34A853"
                        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                      />
                      <path fill="none" d="M0 0h48v48H0z" />
                    </svg>
                    <span>{googleSigningIn ? "Signing in..." : "Sign in with Google"}</span>
                  </button>
                </>
              )}
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="target-spreadsheet-id" className="text-xs text-slate-400 block">
                  Target Spreadsheet ID (optional — leave blank to auto-create)
                </label>
                {targetSpreadsheetId.trim() !== "" && (
                  <button
                    type="button"
                    onClick={onClearTargetSpreadsheetId}
                    className="text-[11px] text-sky-400 hover:text-sky-300 underline"
                  >
                    Clear (auto-create new)
                  </button>
                )}
              </div>
              <input
                id="target-spreadsheet-id"
                type="text"
                value={targetSpreadsheetId}
                onChange={(e) => onTargetSpreadsheetIdChange(e.target.value)}
                placeholder="e.g. 1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms"
                className="w-full px-3 py-1.5 rounded-lg bg-[#070D1A] border border-slate-800 text-xs font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-sky-500"
              />
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
              <div className="rounded-lg bg-[#070D1A] border border-slate-800/80 px-2.5 py-2">
                <div className="text-slate-500">Last Successful Sync</div>
                <div className="font-mono text-slate-200 mt-0.5 truncate">
                  {sheetsStatus.lastSyncAt
                    ? new Date(sheetsStatus.lastSyncAt).toLocaleString()
                    : "Never"}
                </div>
              </div>
              <div className="rounded-lg bg-[#070D1A] border border-slate-800/80 px-2.5 py-2">
                <div className="text-slate-500">Last Sync Mode</div>
                <div className="font-mono text-slate-200 mt-0.5">
                  {sheetsStatus.lastMode ? sheetsStatus.lastMode : "—"}
                </div>
              </div>
              <div className="rounded-lg bg-[#070D1A] border border-slate-800/80 px-2.5 py-2 col-span-2 sm:col-span-1">
                <div className="text-slate-500">Last Delta</div>
                <div className="font-mono text-slate-200 mt-0.5 tabular-nums">
                  {sheetsStatus.lastSyncAt
                    ? `+${sheetsStatus.rowsAdded} / ~${sheetsStatus.rowsUpdated} / =${sheetsStatus.rowsUnchanged}`
                    : "—"}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 text-xs">
              {SHEETS_TABS_ORDER.map((tab) => {
                const tabStat = sheetsStatus.tabStatuses?.[tab];
                const count = tabStat?.verifiedRows ?? sheetsStatus.tabRowCounts?.[tab] ?? 0;
                const isOk = tabStat?.status === "success";
                const isFailed = tabStat?.status === "failed";
                return (
                  <div
                    key={tab}
                    className={`rounded-md border px-2.5 py-2 space-y-0.5 ${
                      isFailed
                        ? "bg-rose-950/30 border-rose-800/60"
                        : isOk
                        ? "bg-[#070D1A] border-emerald-800/50"
                        : "bg-[#070D1A] border-slate-800/70"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-300 font-medium truncate">{tab}</span>
                      <span className="inline-flex items-center gap-1 font-mono text-slate-100 tabular-nums shrink-0">
                        {isOk && <CheckCircle2 className="w-3 h-3 text-emerald-400" />}
                        {isFailed && <XCircle className="w-3 h-3 text-rose-400" />}
                        <span>{count.toLocaleString()}</span>
                      </span>
                    </div>
                    {tabStat?.message && (
                      <div
                        className={`text-[11px] truncate ${
                          isFailed ? "text-rose-300" : isOk ? "text-emerald-400/90" : "text-slate-500"
                        }`}
                        title={tabStat.message}
                      >
                        {tabStat.message}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {sheetsStatus.status === "Sync Failed" && sheetsStatus.lastError && (
              <p className="text-xs text-rose-300 bg-rose-950/30 border border-rose-800/60 rounded-md p-2">
                {sheetsStatus.lastError}
              </p>
            )}
          </div>
        </div>
      </section>

      {/* Daily UTC Schedule & Pipeline Execution History */}
      <section className="grid grid-cols-1 xl:grid-cols-2 gap-6 items-stretch">
        <div className="rounded-xl bg-[#0E172B] border border-slate-800/80 p-5 sm:p-6 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <CalendarClock className="w-4 h-4 text-sky-400 shrink-0" />
              <h2 className="font-display text-base font-semibold text-slate-100">
                Daily 24h UTC Automation Schedule
              </h2>
            </div>
            <span
              className={`text-xs font-medium px-2 py-0.5 rounded border ${
                status?.scheduler?.enabled
                  ? "bg-emerald-950/50 border-emerald-700/60 text-emerald-300"
                  : "bg-slate-900 border-slate-700 text-slate-400"
              }`}
            >
              {status?.scheduler?.enabled ? "Enabled" : "Paused"}
            </span>
          </div>

          <p className="text-xs text-slate-400">
            Runs rolling 24h collection across all 9 job boards, 12+ RSS feeds + HN, and fresh research papers at a configurable UTC time without overlapping active runs.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
            <div>
              <label htmlFor="daily-utc-time" className="text-xs text-slate-400 block mb-1">
                Daily UTC Time (HH:MM)
              </label>
              <input
                id="daily-utc-time"
                type="text"
                value={scheduleUtcInput}
                onChange={(e) => setScheduleUtcInput(e.target.value)}
                placeholder="02:00"
                className="w-full px-3 py-1.5 rounded-lg bg-[#070D1A] border border-slate-800 text-xs font-mono text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500"
              />
            </div>

            <label className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#070D1A] border border-slate-800 text-xs text-slate-200 cursor-pointer h-[32px]">
              <input
                type="checkbox"
                checked={scheduleEnabledInput}
                onChange={(e) => setScheduleEnabledInput(e.target.checked)}
                className="rounded border-slate-700 bg-slate-900 text-sky-500 focus:ring-sky-500"
              />
              <span>Auto-run daily</span>
            </label>

            <button
              type="button"
              disabled={schedulerUpdating}
              onClick={() =>
                onUpdateScheduler({
                  enabled: scheduleEnabledInput,
                  utcTime: scheduleUtcInput,
                })
              }
              className="px-3.5 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-60 text-white text-xs font-medium transition-colors h-[32px]"
            >
              {schedulerUpdating ? "Saving..." : "Save Schedule"}
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs pt-1">
            <div className="rounded-lg bg-[#070D1A] border border-slate-800/80 px-3 py-2">
              <div className="text-slate-500">Next Scheduled (UTC)</div>
              <div className="font-mono text-slate-200 mt-0.5 truncate">
                {status?.scheduler?.enabled && status.scheduler.next_run_at
                  ? status.scheduler.next_run_at.replace("T", " ").slice(0, 16) + " UTC"
                  : "Paused"}
              </div>
            </div>
            <div className="rounded-lg bg-[#070D1A] border border-slate-800/80 px-3 py-2">
              <div className="text-slate-500">Last Successful Run</div>
              <div className="font-mono text-emerald-300 mt-0.5 truncate">
                {status?.lastSuccessfulRunAt
                  ? status.lastSuccessfulRunAt.replace("T", " ").slice(0, 16) + " UTC"
                  : "None persisted yet"}
              </div>
            </div>
            <div className="rounded-lg bg-[#070D1A] border border-slate-800/80 px-3 py-2">
              <div className="text-slate-500">Latest Source Health</div>
              <div className="font-mono text-slate-200 mt-0.5 tabular-nums">
                {lastSourceOutcomes.length === 0
                  ? "No run telemetry yet"
                  : `${okSources.length} ok · ${emptySources.length} empty · ${failedSources.length} failed`}
              </div>
            </div>
          </div>

          {lastSourceOutcomes.length > 0 && (
            <div className="pt-2 border-t border-slate-800/80 space-y-2">
              <div className="text-xs font-medium text-slate-300">
                Latest Source Outcomes (Empty vs Failed)
              </div>
              <div className="max-h-40 overflow-y-auto space-y-1.5 pr-1">
                {lastSourceOutcomes.map((s, idx) => (
                  <div
                    key={`${s.category}-${s.source}-${idx}`}
                    className={`flex items-center justify-between gap-2 text-[11px] rounded px-2.5 py-1.5 border ${
                      s.status === "failed"
                        ? "bg-rose-950/25 border-rose-800/50 text-rose-200"
                        : s.status === "empty"
                        ? "bg-[#070D1A] border-slate-800 text-slate-400"
                        : "bg-[#070D1A] border-emerald-900/40 text-slate-300"
                    }`}
                  >
                    <div className="truncate">
                      <span className="font-mono text-slate-400 mr-1.5">[{s.category}]</span>
                      <span className="font-medium text-slate-200">{s.source}</span>
                      {s.error && <span className="ml-2 text-rose-300">— {s.error}</span>}
                      {s.status === "empty" && !s.error && (
                        <span className="ml-2 text-slate-500">— 200 OK (0 qualifying 24h items)</span>
                      )}
                    </div>
                    <span
                      className={`font-mono shrink-0 ${
                        s.status === "failed"
                          ? "text-rose-400"
                          : s.status === "empty"
                          ? "text-amber-300"
                          : "text-emerald-400"
                      }`}
                    >
                      {s.status === "ok"
                        ? `${s.freshCount ?? s.discoveredCount} kept`
                        : s.status.toUpperCase()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="rounded-xl bg-[#0E172B] border border-slate-800/80 p-5 sm:p-6 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="font-display text-base font-semibold text-slate-100">
                Recent Pipeline Runs
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Persisted execution history separating completed, partial, and failed runs. Historical counts are never wiped on failure.
              </p>
            </div>
            <span className="font-mono text-xs text-slate-400 tabular-nums">
              {pipelineRuns.length} logged
            </span>
          </div>

          {pipelineRuns.length === 0 ? (
            <p className="text-sm text-slate-400">
              No pipeline runs persisted in SQLite yet. Click Refresh 24h Feeds or Run Collection to execute a monitored run.
            </p>
          ) : (
            <div className="overflow-x-auto max-h-80 overflow-y-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400">
                    <th className="py-2 pr-2 font-medium">Trigger</th>
                    <th className="py-2 px-2 font-medium">Status</th>
                    <th className="py-2 px-2 font-medium">New Rows</th>
                    <th className="py-2 px-2 font-medium">24h Fresh</th>
                    <th className="py-2 px-2 font-medium">Summary</th>
                    <th className="py-2 pl-2 font-medium text-right">Started (UTC)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {pipelineRuns.map((run) => {
                    const statusCls =
                      run.status === "completed"
                        ? "text-emerald-400"
                        : run.status === "partial"
                        ? "text-amber-300"
                        : run.status === "running"
                        ? "text-sky-400"
                        : "text-rose-400";
                    const newCounts = run.new_records_counts ?? {};
                    const totalRunNew = Object.values(newCounts).reduce((s, v) => s + Number(v || 0), 0);
                    const newTooltip = Object.entries(newCounts)
                      .map(([k, v]) => `${k}: +${v}`)
                      .join(", ");
                    return (
                      <tr key={run.run_id} className="hover:bg-slate-800/30">
                        <td className="py-2 pr-2 font-mono text-slate-300 whitespace-nowrap">
                          {run.trigger_type}
                        </td>
                        <td className={`py-2 px-2 font-medium whitespace-nowrap ${statusCls}`}>
                          {run.status}
                        </td>
                        <td
                          className="py-2 px-2 font-mono text-sky-300 tabular-nums whitespace-nowrap"
                          title={newTooltip || "Per-dataset net new rows inserted"}
                        >
                          +{totalRunNew.toLocaleString()}
                        </td>
                        <td className="py-2 px-2 font-mono text-slate-300 tabular-nums whitespace-nowrap">
                          {run.fresh_24h_counts?.jobs ?? 0}J / {run.fresh_24h_counts?.news ?? 0}N / {run.fresh_24h_counts?.research_papers ?? 0}P
                        </td>
                        <td className="py-2 px-2 text-slate-400 max-w-[220px] truncate" title={run.summary ?? ""}>
                          {run.summary ?? "—"}
                        </td>
                        <td className="py-2 pl-2 text-right font-mono text-slate-400 tabular-nums whitespace-nowrap">
                          {run.started_at.replace("T", " ").slice(0, 16)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* Verification Audit Trail */}
      <section className="rounded-xl bg-[#0E172B] border border-slate-800/80 p-5 sm:p-6">
        <div className="flex items-center justify-between gap-2 mb-3">
          <div>
            <h2 className="font-display text-base font-semibold text-slate-100">
              Verification Audit Trail
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Immutable history of status transitions, detected issues, and verification evidence across existing records.
            </p>
          </div>
          <span className="font-mono text-xs text-slate-400 tabular-nums shrink-0">
            {(status?.auditTrail ?? []).length} recent entries
          </span>
        </div>

        {(status?.auditTrail ?? []).length === 0 ? (
          <p className="text-sm text-slate-400">
            No verification audit entries recorded yet. Click Audit Records or Run Collection to inspect sources.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="py-2 pr-3 font-medium">Record</th>
                  <th className="py-2 px-2 font-medium">Dataset</th>
                  <th className="py-2 px-2 font-medium">Status Change</th>
                  <th className="py-2 px-2 font-medium">Audit Reason &amp; Issues</th>
                  <th className="py-2 px-2 font-medium">Source</th>
                  <th className="py-2 pl-2 font-medium text-right">Checked</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {(status?.auditTrail ?? []).slice(0, 15).map((entry) => {
                  const newColor =
                    entry.new_status === "Verified"
                      ? "text-emerald-400"
                      : entry.new_status === "Partially Verified"
                      ? "text-sky-400"
                      : entry.new_status === "Rejected"
                      ? "text-rose-400"
                      : entry.new_status === "Source Unavailable"
                      ? "text-slate-300"
                      : "text-amber-400";
                  let parsedIssues: string[] = [];
                  try {
                    const arr = JSON.parse(entry.issues_json || "[]");
                    if (Array.isArray(arr)) parsedIssues = arr.map(String);
                  } catch {
                    parsedIssues = [];
                  }
                  return (
                    <tr key={entry.audit_id} className="hover:bg-slate-800/30">
                      <td className="py-2 pr-3 text-slate-200 font-medium max-w-[200px] truncate">
                        {entry.record_name || entry.record_id}
                      </td>
                      <td className="py-2 px-2 font-mono text-slate-400">{entry.category}</td>
                      <td className="py-2 px-2 whitespace-nowrap">
                        <span className="text-slate-400">{entry.previous_status || "new"}</span>
                        <span className="text-slate-600 mx-1.5" aria-hidden="true">-&gt;</span>
                        <span className={`font-medium ${newColor}`}>{entry.new_status}</span>
                      </td>
                      <td className="py-2 px-2 text-slate-300 max-w-md">
                        <div className="line-clamp-2">{entry.reason}</div>
                        {parsedIssues.length > 0 && (
                          <div className="font-mono text-[11px] text-amber-300/90 mt-0.5 truncate">
                            Issues: {parsedIssues.join(", ")}
                          </div>
                        )}
                      </td>
                      <td className="py-2 px-2 whitespace-nowrap">
                        {entry.source_url ? (
                          <a
                            href={entry.source_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sky-400 hover:underline inline-flex items-center gap-1"
                            title={entry.source_url}
                          >
                            <span>Source</span>
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        ) : (
                          <span className="text-slate-500">—</span>
                        )}
                      </td>
                      <td className="py-2 pl-2 text-right font-mono text-slate-400 tabular-nums whitespace-nowrap">
                        {new Date(entry.checked_at).toLocaleString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Failure Logs Audit Table */}
      <section className="rounded-xl bg-[#0E172B] border border-slate-800/80 p-5 sm:p-6">
        <div className="flex items-center justify-between gap-2 mb-3">
          <h2 className="font-display text-base font-semibold text-slate-100">
            Preserved Failure &amp; Rejection Logs
          </h2>
          <span className="font-mono text-xs text-slate-400 tabular-nums">
            {status?.failureCount ?? 0} total logged
          </span>
        </div>

        {failures.length === 0 ? (
          <p className="text-sm text-slate-400">
            No collection, freshness, or validation failures recorded yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="py-2 pr-3 font-medium">Stage</th>
                  <th className="py-2 px-2 font-medium">Category</th>
                  <th className="py-2 px-2 font-medium">Reason</th>
                  <th className="py-2 px-2 font-medium">Source URL</th>
                  <th className="py-2 pl-2 font-medium text-right">Timestamp</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {failures.slice(0, 15).map((f) => (
                  <tr key={f.failure_id} className="hover:bg-slate-800/30">
                    <td className="py-2 pr-3 font-mono text-amber-300">{f.stage}</td>
                    <td className="py-2 px-2 text-slate-300">{f.category}</td>
                    <td className="py-2 px-2 text-slate-300 max-w-md truncate">{f.reason}</td>
                    <td className="py-2 px-2 text-slate-400 max-w-xs truncate">
                      {f.source_url ? (
                        <a
                          href={f.source_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:text-sky-400 underline"
                        >
                          {f.source_url}
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="py-2 pl-2 text-right font-mono text-slate-400 tabular-nums whitespace-nowrap">
                      {new Date(f.created_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
