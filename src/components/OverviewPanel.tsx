import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Database,
  Download,
  ExternalLink,
  FileSpreadsheet,
  Play,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import type {
  AtlasStatusResponse,
  DatasetCategory,
  FailureLogRow,
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
  sheetsExporting: boolean;
  sheetsFeedback: {
    success: boolean;
    message: string;
    url?: string | null;
  } | null;
  onSelectSection: (section: SectionId) => void;
  onOpenRunModal: () => void;
  onAuditRecords: () => void;
  onExportSheets: () => void;
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
  { key: "products", label: "Products", target: 1000, note: "GitHub repositories & Show HN" },
  { key: "research_papers", label: "Research Papers", target: 1000, note: "arXiv, OpenAlex, Crossref & GitHub stars" },
  { key: "jobs", label: "Jobs", target: null, note: "Last 24h UTC (Remotive, Arbeitnow, Greenhouse)" },
  { key: "news", label: "News", target: null, note: "Last 24h UTC (RSS/Atom & HN Algolia)" },
  { key: "entity_mapping_log", label: "Entity Mapping Log", target: null, note: "Resolution decisions & confidence audit" },
];

function CredentialRow({
  label,
  envKey,
  configured,
  detail,
}: {
  label: string;
  envKey: string;
  configured: boolean;
  detail: string;
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 py-3 border-b border-slate-800/70 last:border-b-0">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-slate-100">{label}</span>
          <span className="text-xs font-mono text-slate-400">{envKey}</span>
        </div>
        <p className="text-xs text-slate-400 mt-0.5">{detail}</p>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {configured ? (
          <>
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            <span className="text-xs font-medium text-emerald-400 whitespace-nowrap">Configured</span>
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
  sheetsExporting,
  sheetsFeedback,
  onSelectSection,
  onOpenRunModal,
  onAuditRecords,
  onExportSheets,
  onExportCsv,
  onRetryStatus,
}: OverviewPanelProps) {
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
  const missingCredsList: string[] = [];
  if (status && !status.credentials.geminiConfigured) missingCredsList.push("GEMINI_API_KEY");
  if (status && !status.credentials.githubTokenConfigured) missingCredsList.push("GITHUB_TOKEN");
  if (status && !status.credentials.googleSheetsConfigured) missingCredsList.push("GOOGLE_SHEETS_CREDENTIALS_PATH");

  return (
    <div className="space-y-8">
      {/* Top Pipeline Summary Strip */}
      <section className="rounded-xl bg-[#0E172B] border border-slate-800/80 p-5 sm:p-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1">
            <h1 className="font-display text-xl sm:text-2xl font-semibold text-slate-100">
              Data Intelligence Pipeline Overview
            </h1>
            <p className="text-sm text-slate-400">
              {totalRecords === 0
                ? "Database initialized with 0 records. Run a live collection to populate source-verified datasets."
                : `${totalRecords.toLocaleString()} persisted rows across 6 datasets in ${status?.storage.backend ?? "sqlite"}.`}
              {report?.generated_at_utc
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
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-medium transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              <Download className="w-4 h-4" />
              <span>Export CSV</span>
            </button>

            <button
              type="button"
              onClick={onExportSheets}
              disabled={sheetsExporting}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-60 text-slate-200 text-sm font-medium transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              <FileSpreadsheet className="w-4 h-4" />
              <span>{sheetsExporting ? "Exporting..." : "Export Google Sheets"}</span>
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

        {/* Verification Status Summary Row (Verified / Partially Verified / Unverified / Source Unavailable / Rejected) */}
        <div className="mt-5 pt-4 border-t border-slate-800/80 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          <div className="space-y-0.5">
            <div className="text-xs text-slate-400">Verified</div>
            <div className="font-mono text-lg font-semibold text-emerald-400 tabular-nums">
              {verificationTotals.Verified.toLocaleString()}
            </div>
            <div className="text-[11px] text-slate-500">Accessible &amp; corroborated</div>
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
            <div className="text-[11px] text-slate-500">HTTP error, timeout, or blocked</div>
          </div>

          <div className="space-y-0.5">
            <div className="text-xs text-slate-400">Rejected</div>
            <div className="font-mono text-lg font-semibold text-rose-400 tabular-nums">
              {verificationTotals.Rejected.toLocaleString()}
            </div>
            <div className="text-[11px] text-slate-500">Preserved rejected rows &amp; failures</div>
          </div>
        </div>

        {/* Active / Recent Run Execution Feed */}
        {runState.status !== "idle" && (
          <div className="mt-5 pt-4 border-t border-slate-800/80 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="font-medium text-slate-200">
                Pipeline Execution: {runState.status === "running" ? "In Progress" : runState.status === "completed" ? "Completed" : "Failed"}
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
                : "bg-amber-950/30 border-amber-800/60 text-amber-300"
            }`}
          >
            <span>{sheetsFeedback.message}</span>
            {sheetsFeedback.url && (
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
        )}
        {(unavailableSources.length > 0 || missingCredsList.length > 0) && (
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
            {missingCredsList.length > 0 && (
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <span className="font-medium text-amber-300">Unconfigured API Credentials: </span>
                  <span>
                    <code className="text-amber-100">{missingCredsList.join(", ")}</code> not set in{" "}
                    <code className="text-amber-100">frontier-atlas/.env</code> (public unauthenticated endpoints continue normally; Sheets export and LLM fallback require configuration).
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
            const catReport = report?.categories[meta.key];
            const catVer = verificationByCategory[meta.key];
            const target = meta.target;
            const pct = target ? Math.min(100, Math.round((count / target) * 100)) : null;

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
                  <span className="font-mono text-2xl font-semibold text-slate-100 tabular-nums">
                    {count.toLocaleString()}
                  </span>
                  {target !== null ? (
                    <span className="font-mono text-xs text-slate-400 tabular-nums">
                      Target {target.toLocaleString()} ({pct}%)
                    </span>
                  ) : (
                    <span className="font-mono text-xs text-slate-400">
                      {meta.key === "entity_mapping_log" ? "Audit entries" : "24h UTC window"}
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
            <h2 className="font-display text-base font-semibold text-slate-100">
              Source Verification &amp; 24h UTC Audit
            </h2>
            <Clock className="w-4 h-4 text-slate-400 shrink-0" />
          </div>

          {!report ? (
            <div className="flex-1 flex flex-col justify-center py-6 text-sm text-slate-400 space-y-2">
              <p>No quality report has been generated yet (`data/quality_report.json` not present).</p>
              <p className="text-xs text-slate-500 font-mono">
                Run `Run Collection` above or execute `python -m src.pipeline.orchestrator --limit 25` to audit real sources.
              </p>
            </div>
          ) : (
            <div className="space-y-4 text-sm">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-800 text-xs text-slate-400">
                      <th className="py-2 pr-3 font-medium">Dataset</th>
                      <th className="py-2 px-2 font-medium text-right">Verified</th>
                      <th className="py-2 px-2 font-medium text-right">Partial</th>
                      <th className="py-2 px-2 font-medium text-right">Unverified</th>
                      <th className="py-2 px-2 font-medium text-right">Dupes</th>
                      <th className="py-2 pl-2 font-medium text-right">Rejected</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 text-xs font-mono tabular-nums">
                    {Object.entries(report.categories).map(([cat, stats]) => {
                      const vb = stats.verification_breakdown ?? {};
                      const verCount = verificationByCategory[cat]?.Verified ?? vb.Verified ?? 0;
                      const partCount =
                        verificationByCategory[cat]?.["Partially Verified"] ?? vb["Partially Verified"] ?? 0;
                      const unvCount =
                        (verificationByCategory[cat]?.Unverified ?? vb.Unverified ?? 0) +
                        (verificationByCategory[cat]?.["Source Unavailable"] ?? vb["Source Unavailable"] ?? 0);
                      return (
                        <tr key={cat} className="hover:bg-slate-800/30">
                          <td className="py-2.5 pr-3 font-sans text-slate-200 font-medium">{cat}</td>
                          <td className="py-2.5 px-2 text-right text-emerald-400">{verCount}</td>
                          <td className="py-2.5 px-2 text-right text-sky-400">{partCount}</td>
                          <td className="py-2.5 px-2 text-right text-amber-400">{unvCount}</td>
                          <td className="py-2.5 px-2 text-right text-slate-400">{stats.duplicates}</td>
                          <td className="py-2.5 pl-2 text-right text-rose-400">{stats.rejected}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {report.entity_resolution && (
                <div className="pt-3 border-t border-slate-800/70 text-xs text-slate-300 flex flex-wrap gap-x-4 gap-y-1 tabular-nums">
                  <span className="font-medium text-slate-200">Entity Resolution:</span>
                  <span>Exact {report.entity_resolution.exact_match ?? 0}</span>
                  <span>Auto Merge {report.entity_resolution.auto_merge ?? 0}</span>
                  <span>Manual Review {report.entity_resolution.manual_review ?? 0}</span>
                  <span>New Entities {report.entity_resolution.new_entity ?? 0}</span>
                </div>
              )}

              {report.unavailable_sources.length > 0 && (
                <div className="pt-2 text-xs text-amber-300">
                  Unavailable sources during last run: {report.unavailable_sources.join(", ")}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Credentials & Integration Status */}
        <div className="rounded-xl bg-[#0E172B] border border-slate-800/80 p-5 sm:p-6">
          <div className="flex items-center justify-between gap-2 mb-2">
            <h2 className="font-display text-base font-semibold text-slate-100">
              Integration &amp; Credential Status
            </h2>
            <Database className="w-4 h-4 text-slate-400 shrink-0" />
          </div>
          <p className="text-xs text-slate-400 mb-3">
            Live environment state read from <code className="text-slate-300">frontier-atlas/.env</code> and runtime secrets.
          </p>

          <div>
            <CredentialRow
              label={`Google Gemini (${status?.credentials.geminiModel ?? "gemini-4-hydrogen"})`}
              envKey="GEMINI_API_KEY"
              configured={status?.credentials.geminiConfigured ?? false}
              detail="Used by LLMRouter for unstructured HTML extraction. LLM outputs remain Unverified until verified against live source URLs."
            />
            <CredentialRow
              label="Optional LLM Fallbacks (Groq / DeepSeek)"
              envKey="GROQ_API_KEY / DEEPSEEK_API_KEY"
              configured={Boolean(
                status?.credentials.groqConfigured || status?.credentials.deepseekConfigured
              )}
              detail="Activated only when keys are present; otherwise Gemini errors fail cleanly."
            />
            <CredentialRow
              label="Google Sheets Export"
              envKey="GOOGLE_SHEETS_CREDENTIALS_PATH"
              configured={status?.credentials.googleSheetsConfigured ?? false}
              detail="Service Account JSON key required for Sheets API export. CSV fallback is always available."
            />
            <CredentialRow
              label="GitHub REST API Enrichment"
              envKey="GITHUB_TOKEN"
              configured={status?.credentials.githubTokenConfigured ?? false}
              detail="Optional token raising star-count lookup limit from 60 to 5,000 requests/hour."
            />
          </div>
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
