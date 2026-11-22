import { useEffect } from "react";
import { AlertTriangle, FileSpreadsheet, X } from "lucide-react";

interface SheetsConfirmModalProps {
  mode: "full" | "incremental" | null;
  spreadsheetId: string;
  counts: Record<string, number> | null;
  googleEmail: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

const TAB_MAPPING: Array<{ key: string; tab: string }> = [
  { key: "startups", tab: "Startups" },
  { key: "products", tab: "Products" },
  { key: "research_papers", tab: "Research Papers" },
  { key: "jobs", tab: "Jobs" },
  { key: "news", tab: "News" },
  { key: "entity_mapping_log", tab: "Entity Mapping Log" },
];

export function SheetsConfirmModal({
  mode,
  spreadsheetId,
  counts,
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
  const totalRows = TAB_MAPPING.reduce((acc, item) => acc + (counts?.[item.key] ?? 0), 0);

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
                ? "This operation clears existing cell contents across the 6 target tabs and writes all SQLite rows."
                : "This operation updates modified rows in place and appends unseen records by stable ID."}
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

        <div className="space-y-1.5">
          <div className="text-xs font-medium text-slate-300">
            Database records to write ({totalRows.toLocaleString()} total across 6 tabs):
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            {TAB_MAPPING.map((item) => (
              <div
                key={item.key}
                className="flex items-center justify-between rounded-md bg-[#070D1A] border border-slate-800 px-2.5 py-1.5"
              >
                <span className="text-slate-300 truncate">{item.tab}</span>
                <span className="font-mono text-slate-100 tabular-nums">
                  {(counts?.[item.key] ?? 0).toLocaleString()}
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
