import { useEffect } from "react";
import { AlertTriangle, FileSpreadsheet, Globe, X } from "lucide-react";
import type { AtlasStatusResponse, ExportScope } from "../types/atlas";

interface SheetsConfirmModalProps {
  mode: "full" | "incremental" | null;
  exportScope: ExportScope;
  spreadsheetId: string;
  status: AtlasStatusResponse | null;
  googleEmail: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

const TAB_MAPPING: Array<{ key: keyof AtlasStatusResponse["counts"]; tab: string }> = [
  { key: "startups", tab: "Startups" },
  { key: "products", tab: "Products" },
  { key: "research_papers", tab: "Research Papers" },
  { key: "jobs", tab: "Jobs" },
  { key: "news", tab: "News" },
  { key: "entity_mapping_log", tab: "Entity Mapping Log" },
];

export function SheetsConfirmModal({
  mode,
  exportScope,
  spreadsheetId,
  status,
  googleEmail,
  onCancel,
  onConfirm,
}: SheetsConfirmModalProps) {
  useEffect(() => {
    if (!mode) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mode, onCancel]);

  if (!mode) return null;

  const isFull = mode === "full";
  const isQualified = exportScope === "qualified_24h";

  const getTabEstimatedCount = (key: keyof AtlasStatusResponse["counts"]): number => {
    if (!status) return 0;
    if (!isQualified) {
      return status.counts[key] ?? 0;
    }
    if (key === "jobs") return status.freshCounts24h?.jobs ?? 0;
    if (key === "news") return status.freshCounts24h?.news ?? 0;
    const total = status.counts[key] ?? 0;
    const rejected = status.verificationCounts?.byCategory?.[key]?.Rejected ?? 0;
    return key === "entity_mapping_log" ? total : Math.max(0, total - rejected);
  };

  const totalRows = TAB_MAPPING.reduce((acc, item) => acc + getTabEstimatedCount(item.key), 0);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-lg rounded-xl bg-[#0E172B] border border-slate-800 p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <FileSpreadsheet className="w-5 h-5 text-sky-400" />
            <h2 className="font-display text-lg font-semibold text-slate-100">
              {isFull ? "Confirm Full Google Sheets Export" : "Confirm Incremental Google Sheets Sync"}
            </h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel Google Sheets action"
            className="p-1.5 rounded-md text-slate-400 hover:text-slate-100 hover:bg-slate-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="rounded-lg bg-amber-950/30 border border-amber-700/50 p-3 text-xs text-amber-200 flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-medium text-amber-300">
              {isFull
                ? spreadsheetId.trim()
                  ? "Populates all 6 tabs on the target spreadsheet with batched records from SQLite."
                  : "Creates ONE permanent 6-tab Google Spreadsheet in Google Drive and writes all batched SQLite records."
                : "Preserves existing sheet history: updates modified rows in place and appends unseen records by stable ID without clearing tabs."}
            </p>
            <p className="text-amber-200/85">
              Scope:{" "}
              <span className="font-semibold text-amber-100">
                {isQualified
                  ? "Qualified Valid Records + Last 24h UTC Jobs & News"
                  : "Full SQLite Archive (All Rows)"}
              </span>
            </p>
            <p className="text-amber-200/80">
              Target:{" "}
              <span className="font-mono text-amber-100">
                {spreadsheetId.trim() ? spreadsheetId.trim() : "Create new spreadsheet in Google Drive"}
              </span>
              {googleEmail ? ` (as ${googleEmail})` : " (using backend Service Account)"}
            </p>
          </div>
        </div>

        <div className="rounded-lg bg-[#070D1A] border border-slate-800 p-3 text-xs text-slate-300 flex items-start gap-2">
          <Globe className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
          <span>
            After tab row verification, FrontierAtlas requests{" "}
            <strong className="text-slate-100">Anyone with the link — Viewer</strong> permission via the Google Drive API and confirms it via read-back. If sharing is policy-blocked, it reports that honestly.
          </span>
        </div>

        <div className="space-y-1.5">
          <div className="text-xs font-medium text-slate-300">
            Estimated records to write ({totalRows.toLocaleString()} total across 6 tabs):
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            {TAB_MAPPING.map((item) => (
              <div
                key={item.key}
                className="flex items-center justify-between rounded-md bg-[#070D1A] border border-slate-800 px-2.5 py-1.5"
              >
                <span className="text-slate-300 truncate">{item.tab}</span>
                <span className="font-mono text-slate-100 tabular-nums">
                  {getTabEstimatedCount(item.key).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-medium transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-sm font-medium transition-colors"
          >
            {isFull ? "Confirm Export" : "Confirm Sync"}
          </button>
        </div>
      </div>
    </div>
  );
}

