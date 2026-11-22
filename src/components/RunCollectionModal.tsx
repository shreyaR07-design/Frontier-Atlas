import { useState } from "react";
import { AlertTriangle, Play, X } from "lucide-react";
import type { AtlasStatusResponse } from "../types/atlas";

interface RunCollectionModalProps {
  open: boolean;
  running: boolean;
  credentials?: AtlasStatusResponse["credentials"] | null;
  onClose: () => void;
  onStartRun: (categories: string[], limit: number, page: number) => void;
}

const RUNNABLE_CATEGORIES = [
  { id: "startups", label: "Startups (YC OSS directory & official websites)" },
  { id: "products", label: "Products (HF Spaces, GitHub Search API & Show HN)" },
  { id: "research_papers", label: "Research Papers (HF Daily Papers, arXiv, OpenAlex, Crossref & GitHub stars)" },
  { id: "jobs", label: "Jobs (24h UTC: 9 distinct job boards)" },
  { id: "news", label: "News (24h UTC: 12+ AI RSS/Atom feeds & HN Algolia)" },
];

export function RunCollectionModal({
  open,
  running,
  credentials,
  onClose,
  onStartRun,
}: RunCollectionModalProps) {
  const [selected, setSelected] = useState<string[]>([
    "startups",
    "products",
    "research_papers",
    "jobs",
    "news",
  ]);
  const [limit, setLimit] = useState<number>(20);
  const [page, setPage] = useState<number>(1);

  if (!open) return null;

  const toggleCategory = (id: string) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const missingNotices: string[] = [];
  if (credentials && !credentials.githubTokenConfigured) {
    missingNotices.push("GITHUB_TOKEN is unset (GitHub API uses unauthenticated 60 req/hr limit).");
  }
  if (credentials && !credentials.geminiConfigured) {
    missingNotices.push("GEMINI_API_KEY is unset (unstructured LLM HTML fallback is disabled; structured public APIs still run).");
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs">
      <div className="w-full max-w-md rounded-xl bg-[#0E172B] border border-slate-800 p-6 space-y-5">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold text-slate-100">
            Run Live Data Collection
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            className="p-1.5 rounded-md text-slate-400 hover:text-slate-100 hover:bg-slate-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-slate-400 leading-relaxed">
          Executes the <code className="text-slate-300">AtlasBackendService</code> collectors against
          real public APIs and feeds with <code className="text-slate-300">robots.txt</code> compliance,
          verifies every record against its source URL, resolves entities, persists to SQLite + CSV, and
          incrementally syncs Google Sheets when configured.
        </p>

        {missingNotices.length > 0 && (
          <div className="rounded-lg bg-amber-950/30 border border-amber-800/50 p-3 text-xs text-amber-200 space-y-1">
            <div className="flex items-center gap-1.5 font-medium text-amber-300">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>Optional Credentials Not Configured</span>
            </div>
            {missingNotices.map((msg) => (
              <p key={msg} className="text-amber-200/90 leading-relaxed">
                {msg}
              </p>
            ))}
          </div>
        )}

        <div className="space-y-2">
          <span className="text-xs font-medium text-slate-300 block">Target Categories</span>
          <div className="space-y-2">
            {RUNNABLE_CATEGORIES.map((cat) => (
              <label
                key={cat.id}
                className="flex items-center gap-2.5 p-2.5 rounded-lg bg-[#070D1A] border border-slate-800 cursor-pointer hover:border-slate-700"
              >
                <input
                  type="checkbox"
                  checked={selected.includes(cat.id)}
                  onChange={() => toggleCategory(cat.id)}
                  className="rounded border-slate-600 bg-slate-900 text-sky-500 focus:ring-sky-500"
                />
                <span className="text-xs text-slate-200">{cat.label}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label htmlFor="limit-input" className="text-xs font-medium text-slate-300 block">
              Limit Per Category
            </label>
            <input
              id="limit-input"
              type="number"
              min={1}
              max={1500}
              value={limit}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v)) {
                  setLimit(Math.min(1500, Math.max(1, Math.floor(v))));
                }
              }}
              className="w-full px-3 py-2 rounded-lg bg-[#070D1A] border border-slate-800 text-sm font-mono tabular-nums text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="page-input" className="text-xs font-medium text-slate-300 block">
              Source Page (Pagination)
            </label>
            <input
              id="page-input"
              type="number"
              min={1}
              max={100}
              value={page}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v)) {
                  setPage(Math.min(100, Math.max(1, Math.floor(v))));
                }
              }}
              className="w-full px-3 py-2 rounded-lg bg-[#070D1A] border border-slate-800 text-sm font-mono tabular-nums text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-slate-500 mr-1">Presets:</span>
          {[10, 25, 100, 500, 1000, 1200].map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => setLimit(preset)}
              className={`px-2 py-1 rounded border font-mono tabular-nums transition-colors ${
                limit === preset
                  ? "bg-sky-600/20 border-sky-500/60 text-sky-300"
                  : "bg-[#070D1A] border-slate-800 text-slate-400 hover:text-slate-200"
              }`}
            >
              {preset}
            </button>
          ))}
        </div>

        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-medium transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={running || selected.length === 0}
            onClick={() => onStartRun(selected, limit, page)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white text-sm font-medium transition-colors"
          >
            <Play className="w-4 h-4" />
            <span>{running ? "Running..." : "Start Collection"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
