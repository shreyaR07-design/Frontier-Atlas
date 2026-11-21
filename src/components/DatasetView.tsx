import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Download, ExternalLink, Eye, Play, Search, ShieldCheck, X, XCircle } from "lucide-react";
import type {
  AnyDatasetRow,
  AuditTrailEntry,
  DatasetCategory,
  EntityMappingRow,
  FailureLogRow,
  JobRow,
  NewsRow,
  ProductRow,
  ResearchPaperRow,
  StartupRow,
  StartupVerificationReport,
} from "../types/atlas";

interface DatasetViewProps {
  category: DatasetCategory;
  rows: AnyDatasetRow[];
  categoryFailures?: FailureLogRow[];
  loading: boolean;
  error: string | null;
  hasCsvExport: boolean;
  onRetry: () => void;
  onOpenRunModal: () => void;
}

const VERIFICATION_OPTIONS = [
  "all",
  "Verified",
  "Partially Verified",
  "Unverified",
  "Source Unavailable",
  "Rejected",
] as const;

const CATEGORY_INFO: Record<
  DatasetCategory,
  { title: string; subtitle: string; csvFilename: string }
> = {
  startups: {
    title: "Startups",
    subtitle: "Startup organizations verified against original directory pages and official websites.",
    csvFilename: "startups.csv",
  },
  products: {
    title: "Products",
    subtitle: "Software and AI products traced to GitHub repositories, Show HN, and official sites.",
    csvFilename: "products.csv",
  },
  research_papers: {
    title: "Research Papers",
    subtitle: "Academic preprints and publications from arXiv, OpenAlex, and Crossref with GitHub stars.",
    csvFilename: "research_papers.csv",
  },
  jobs: {
    title: "Jobs (Last 24h UTC)",
    subtitle: "Accessible technical job postings verified within a strict 24-hour UTC publication window.",
    csvFilename: "jobs.csv",
  },
  news: {
    title: "News (Last 24h UTC)",
    subtitle: "Tech and AI articles from RSS/Atom feeds and Hacker News published within the last 24 hours.",
    csvFilename: "news.csv",
  },
  entity_mapping_log: {
    title: "Entity Mapping Log",
    subtitle: "Audit trail of raw names, normalized forms, canonical IDs, match methods, and confidence scores.",
    csvFilename: "entity_mapping_log.csv",
  },
};

function formatUtc(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function parseAuthors(authorsJson: string | undefined): string {
  if (!authorsJson) return "—";
  try {
    const arr = JSON.parse(authorsJson);
    if (Array.isArray(arr) && arr.length > 0) {
      return arr.slice(0, 3).join(", ") + (arr.length > 3 ? ` +${arr.length - 3}` : "");
    }
  } catch {
    return authorsJson;
  }
  return "—";
}

function parseSupportedFields(raw: unknown): string {
  if (!raw) return "—";
  if (Array.isArray(raw)) return raw.join(", ") || "—";
  if (typeof raw === "string") {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.join(", ") || "—";
    } catch {
      return raw || "—";
    }
  }
  return "—";
}

function parseJsonRecord(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function getRecordIdAndTitle(category: DatasetCategory, row: AnyDatasetRow): { id: string; title: string } {
  const rec = row as unknown as Record<string, unknown>;
  const idMap: Record<DatasetCategory, string> = {
    startups: "startup_id",
    products: "product_id",
    research_papers: "paper_id",
    jobs: "job_id",
    news: "news_id",
    entity_mapping_log: "mapping_id",
  };
  const id = String(rec[idMap[category]] ?? "");
  const title = String(rec.name ?? rec.title ?? rec.headline ?? rec.raw_name ?? id);
  return { id, title };
}

function getMetadataReason(rawMeta: unknown): string | null {
  const meta = parseJsonRecord(rawMeta);
  if (typeof meta.verification_reason === "string" && meta.verification_reason.trim()) {
    return meta.verification_reason.trim();
  }
  if (typeof meta.source_error === "string" && meta.source_error.trim()) {
    return meta.source_error.trim();
  }
  return null;
}

function VerificationStatusCell({
  status,
  sourceTitle,
  rejectionReason,
  verificationReason,
}: {
  status?: string;
  sourceTitle?: string | null;
  rejectionReason?: string | null;
  verificationReason?: string | null;
}) {
  const val = status || "Unverified";
  const colorClass =
    val === "Verified"
      ? "text-emerald-400"
      : val === "Partially Verified"
      ? "text-sky-400"
      : val === "Rejected"
      ? "text-rose-400"
      : val === "Source Unavailable"
      ? "text-slate-400"
      : "text-amber-400";

  const subReason = rejectionReason || (val !== "Verified" ? verificationReason : null);

  return (
    <div className="space-y-0.5">
      <div className={`text-xs font-medium whitespace-nowrap ${colorClass}`}>{val}</div>
      {subReason ? (
        <div
          className={`text-[11px] line-clamp-1 max-w-[230px] ${
            val === "Rejected" ? "text-rose-300/80" : "text-slate-400"
          }`}
          title={subReason}
        >
          {subReason}
        </div>
      ) : sourceTitle ? (
        <div className="text-[11px] text-slate-500 line-clamp-1 max-w-[200px]" title={sourceTitle}>
          {sourceTitle}
        </div>
      ) : null}
    </div>
  );
}

export function DatasetView({
  category,
  rows,
  categoryFailures = [],
  loading,
  error,
  hasCsvExport,
  onRetry,
  onOpenRunModal,
}: DatasetViewProps) {
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [verificationFilter, setVerificationFilter] = useState<string>("all");
  const [decisionFilter, setDecisionFilter] = useState("all");
  const [githubOnly, setGithubOnly] = useState(false);
  const [selectedRow, setSelectedRow] = useState<AnyDatasetRow | null>(null);
  const [rowAuditTrail, setRowAuditTrail] = useState<AuditTrailEntry[]>([]);
  const [rowAuditLoading, setRowAuditLoading] = useState(false);
  const [showRawFields, setShowRawFields] = useState(false);

  const info = CATEGORY_INFO[category];
  const supportsVerification = category !== "entity_mapping_log";

  useEffect(() => {
    if (!selectedRow) {
      setRowAuditTrail([]);
      setShowRawFields(false);
      return;
    }
    const { id } = getRecordIdAndTitle(category, selectedRow);
    if (!id || category === "entity_mapping_log") {
      setRowAuditTrail([]);
      return;
    }
    let cancelled = false;
    setRowAuditLoading(true);
    fetch(`/api/atlas/audit-trail?category=${encodeURIComponent(category)}&recordId=${encodeURIComponent(id)}&limit=25`)
      .then((resp) => (resp.ok ? resp.json() : { entries: [] }))
      .then((data) => {
        if (!cancelled) {
          setRowAuditTrail(Array.isArray(data.entries) ? data.entries : []);
        }
      })
      .catch(() => {
        if (!cancelled) setRowAuditTrail([]);
      })
      .finally(() => {
        if (!cancelled) setRowAuditLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [category, selectedRow]);

  const availableSources = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      const rec = r as unknown as Record<string, unknown>;
      const s = rec.source_name ?? rec.publisher;
      if (typeof s === "string" && s.trim()) {
        set.add(s);
      }
    }
    return Array.from(set).sort();
  }, [rows]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((row) => {
      const rec = row as unknown as Record<string, unknown>;
      if (sourceFilter !== "all") {
        const s = String(rec.source_name ?? rec.publisher ?? "");
        if (s !== sourceFilter) return false;
      }
      if (supportsVerification && verificationFilter !== "all") {
        const st = String(rec.verification_status ?? "Unverified");
        if (st !== verificationFilter) return false;
      }
      if (category === "entity_mapping_log" && decisionFilter !== "all") {
        if (String(rec.decision ?? "") !== decisionFilter) return false;
      }
      if (category === "research_papers" && githubOnly) {
        if (!rec.github_repository) return false;
      }
      if (!q) return true;
      return JSON.stringify(row).toLowerCase().includes(q);
    });
  }, [rows, search, sourceFilter, verificationFilter, decisionFilter, githubOnly, category, supportsVerification]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {
      all: rows.length,
      Verified: 0,
      "Partially Verified": 0,
      Unverified: 0,
      "Source Unavailable": 0,
      Rejected: 0,
    };
    for (const row of rows) {
      const rec = row as unknown as Record<string, unknown>;
      const st = String(rec.verification_status ?? "Unverified");
      if (st in counts) {
        counts[st] += 1;
      } else {
        counts.Unverified += 1;
      }
    }
    return counts;
  }, [rows]);

  const filteredCategoryFailures = useMemo(() => {
    if (verificationFilter !== "Rejected") return [];
    const q = search.trim().toLowerCase();
    return categoryFailures.filter((f) => {
      if (!q) return true;
      return JSON.stringify(f).toLowerCase().includes(q);
    });
  }, [categoryFailures, search, verificationFilter]);

  return (
    <div className="space-y-5">
      {/* Header & Controls */}
      <div className="rounded-xl bg-[#0E172B] border border-slate-800/80 p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="font-display text-xl font-semibold text-slate-100">{info.title}</h1>
            <p className="text-sm text-slate-400 mt-0.5">{info.subtitle}</p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <span className="font-mono text-xs text-slate-400 tabular-nums">
              {filteredRows.length.toLocaleString()} / {rows.length.toLocaleString()} rows
            </span>
            {hasCsvExport && rows.length > 0 && (
              <a
                href={`/api/atlas/download/csv/${info.csvFilename}`}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium transition-colors whitespace-nowrap shrink-0"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Download CSV</span>
              </a>
            )}
          </div>
        </div>

        {/* Search & Filters */}
        <div className="flex flex-col md:flex-row md:items-center gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${info.title.toLowerCase()} by name, URL, title, or metadata...`}
              className="w-full pl-9 pr-3 py-2 rounded-lg bg-[#070D1A] border border-slate-800 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-sky-500"
            />
          </div>

          {supportsVerification && (
            <select
              value={verificationFilter}
              onChange={(e) => setVerificationFilter(e.target.value)}
              aria-label="Filter by verification status"
              className="px-3 py-2 rounded-lg bg-[#070D1A] border border-slate-800 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-sky-500"
            >
              {VERIFICATION_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt === "all" ? "All Verification Statuses" : opt}
                </option>
              ))}
            </select>
          )}

          {availableSources.length > 0 && (
            <select
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
              aria-label="Filter by source"
              className="px-3 py-2 rounded-lg bg-[#070D1A] border border-slate-800 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-sky-500"
            >
              <option value="all">All Sources</option>
              {availableSources.map((src) => (
                <option key={src} value={src}>
                  {src}
                </option>
              ))}
            </select>
          )}

          {category === "research_papers" && (
            <button
              type="button"
              onClick={() => setGithubOnly((v) => !v)}
              className={`px-3.5 py-2 rounded-lg text-xs font-medium border transition-colors whitespace-nowrap shrink-0 ${
                githubOnly
                  ? "bg-sky-500/20 border-sky-500/60 text-sky-300"
                  : "bg-[#070D1A] border-slate-800 text-slate-300 hover:border-slate-700"
              }`}
            >
              With GitHub Repo Only
            </button>
          )}

          {category === "entity_mapping_log" && (
            <div className="flex flex-wrap items-center gap-1 p-1 rounded-lg bg-[#070D1A] border border-slate-800">
              {["all", "exact_match", "auto_merge", "manual_review", "new_entity"].map((dec) => (
                <button
                  key={dec}
                  type="button"
                  onClick={() => setDecisionFilter(dec)}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    decisionFilter === dec
                      ? "bg-sky-600 text-white"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {dec === "all" ? "All" : dec}
                </button>
              ))}
            </div>
          )}
        </div>

        {supportsVerification && (
          <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-slate-800/80">
            {VERIFICATION_OPTIONS.map((opt) => {
              const isActive = verificationFilter === opt;
              const baseCount = statusCounts[opt] ?? 0;
              const displayCount =
                opt === "Rejected" && categoryFailures.length > 0
                  ? `${baseCount} (+${categoryFailures.length})`
                  : baseCount.toLocaleString();
              const accentClass =
                opt === "Verified"
                  ? "text-emerald-400"
                  : opt === "Partially Verified"
                  ? "text-sky-400"
                  : opt === "Rejected"
                  ? "text-rose-400"
                  : opt === "Source Unavailable"
                  ? "text-slate-400"
                  : opt === "Unverified"
                  ? "text-amber-400"
                  : "text-slate-200";
              return (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setVerificationFilter(opt)}
                  className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    isActive
                      ? "bg-slate-800 border-sky-500/70 text-slate-100"
                      : "bg-[#070D1A] border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-200"
                  }`}
                >
                  <span className={isActive ? accentClass : undefined}>
                    {opt === "all" ? "All Statuses" : opt}
                  </span>
                  <span className="font-mono text-[11px] text-slate-300 tabular-nums">
                    {displayCount}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Table States */}
      {loading ? (
        <div className="rounded-xl bg-[#0E172B] border border-slate-800/80 p-5 space-y-3">
          {Array.from({ length: 6 }).map((_, idx) => (
            <div key={idx} className="h-10 rounded bg-slate-800/60 animate-pulse" />
          ))}
        </div>
      ) : error ? (
        <div className="rounded-xl bg-[#0E172B] border border-red-500/40 p-6 space-y-3">
          <p className="text-sm text-red-400">{error}</p>
          <button
            type="button"
            onClick={onRetry}
            className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-sm font-medium"
          >
            Retry Query
          </button>
        </div>
      ) : filteredRows.length === 0 && filteredCategoryFailures.length === 0 ? (
        <div className="rounded-xl bg-[#0E172B] border border-slate-800/80 p-8 text-center space-y-3">
          <h2 className="font-display text-base font-semibold text-slate-200">
            {rows.length === 0 ? `No ${info.title} collected yet` : "No matching records"}
          </h2>
          <p className="text-sm text-slate-400 max-w-xl mx-auto">
            {rows.length === 0
              ? "FrontierAtlas never displays fabricated placeholder records. Run a live collection cycle to populate this dataset from verified public sources."
              : "Adjust your search query or active verification/source filters to see collected rows."}
          </p>
          {rows.length === 0 && (
            <div className="pt-2">
              <button
                type="button"
                onClick={onOpenRunModal}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-sm font-medium transition-colors"
              >
                <Play className="w-4 h-4" />
                <span>Run Collection</span>
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
        <div className="rounded-xl bg-[#0E172B] border border-slate-800/80 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-800 bg-[#0B1324] text-xs text-slate-400">
                  {category === "startups" && (
                    <>
                      <th className="py-3 px-4 font-medium">Startup</th>
                      <th className="py-3 px-4 font-medium">Industry &amp; Location</th>
                      <th className="py-3 px-4 font-medium">Verification</th>
                      <th className="py-3 px-4 font-medium">Source &amp; Traceability</th>
                      <th className="py-3 px-4 font-medium text-right">Checked</th>
                      <th className="py-3 px-4 font-medium text-right">Actions</th>
                    </>
                  )}
                  {category === "products" && (
                    <>
                      <th className="py-3 px-4 font-medium">Product</th>
                      <th className="py-3 px-4 font-medium">Company &amp; Category</th>
                      <th className="py-3 px-4 font-medium">Verification</th>
                      <th className="py-3 px-4 font-medium">Source &amp; Website</th>
                      <th className="py-3 px-4 font-medium text-right">Checked</th>
                      <th className="py-3 px-4 font-medium text-right">Actions</th>
                    </>
                  )}
                  {category === "research_papers" && (
                    <>
                      <th className="py-3 px-4 font-medium">Title &amp; Authors</th>
                      <th className="py-3 px-4 font-medium">Verification</th>
                      <th className="py-3 px-4 font-medium">Source &amp; Identifiers</th>
                      <th className="py-3 px-4 font-medium">GitHub Repo</th>
                      <th className="py-3 px-4 font-medium text-right">Stars</th>
                      <th className="py-3 px-4 font-medium text-right">Published / Checked</th>
                      <th className="py-3 px-4 font-medium text-right">Actions</th>
                    </>
                  )}
                  {category === "jobs" && (
                    <>
                      <th className="py-3 px-4 font-medium">Role &amp; Company</th>
                      <th className="py-3 px-4 font-medium">Location &amp; Type</th>
                      <th className="py-3 px-4 font-medium">Verification</th>
                      <th className="py-3 px-4 font-medium">Source &amp; Apply</th>
                      <th className="py-3 px-4 font-medium text-right">Posted / Checked (UTC)</th>
                      <th className="py-3 px-4 font-medium text-right">Actions</th>
                    </>
                  )}
                  {category === "news" && (
                    <>
                      <th className="py-3 px-4 font-medium">Headline</th>
                      <th className="py-3 px-4 font-medium">Publisher &amp; Category</th>
                      <th className="py-3 px-4 font-medium">Verification</th>
                      <th className="py-3 px-4 font-medium">Source &amp; Traceability</th>
                      <th className="py-3 px-4 font-medium text-right">Published / Checked (UTC)</th>
                      <th className="py-3 px-4 font-medium text-right">Actions</th>
                    </>
                  )}
                  {category === "entity_mapping_log" && (
                    <>
                      <th className="py-3 px-4 font-medium">Raw &amp; Normalized Name</th>
                      <th className="py-3 px-4 font-medium">Canonical Name &amp; ID</th>
                      <th className="py-3 px-4 font-medium">Method &amp; Decision</th>
                      <th className="py-3 px-4 font-medium">Source Link</th>
                      <th className="py-3 px-4 font-medium text-right">Confidence</th>
                      <th className="py-3 px-4 font-medium text-right">Timestamp (UTC)</th>
                      <th className="py-3 px-4 font-medium text-right">Actions</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {filteredRows.map((row, idx) => {
                  if (category === "startups") {
                    const r = row as StartupRow;
                    return (
                      <tr
                        key={r.startup_id || idx}
                        onClick={() => setSelectedRow(r)}
                        className="hover:bg-slate-800/40 cursor-pointer transition-colors"
                      >
                        <td className="py-3 px-4">
                          <div className="font-medium text-slate-100">{r.name}</div>
                          {r.description && (
                            <div className="text-xs text-slate-400 line-clamp-1 max-w-md mt-0.5">
                              {r.description}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-xs text-slate-300">
                          <div>{r.industry || "Unknown"}</div>
                          <div className="text-slate-400">{r.location || "Unknown"}</div>
                        </td>
                        <td className="py-3 px-4">
                          <VerificationStatusCell
                            status={r.verification_status}
                            sourceTitle={r.source_title}
                            rejectionReason={r.rejection_reason}
                            verificationReason={getMetadataReason(r.source_metadata_json)}
                          />
                        </td>
                        <td className="py-3 px-4 text-xs text-slate-400" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center gap-2">
                            <span>{r.source_name}</span>
                            <span aria-hidden="true">·</span>
                            <a
                              href={r.source_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-sky-400 hover:underline inline-flex items-center gap-1"
                            >
                              <span>Source</span>
                              <ExternalLink className="w-3 h-3" />
                            </a>
                            {(r.official_website || r.website) && (
                              <>
                                <span aria-hidden="true">·</span>
                                <a
                                  href={(r.official_website || r.website) ?? undefined}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-slate-300 hover:text-sky-300 hover:underline inline-flex items-center gap-1"
                                >
                                  <span>Site</span>
                                  <ExternalLink className="w-3 h-3" />
                                </a>
                              </>
                            )}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-xs text-slate-400 tabular-nums whitespace-nowrap">
                          {formatUtc(r.last_checked_at || r.collected_at)}
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            onClick={() => setSelectedRow(r)}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-slate-700 bg-slate-800/70 hover:bg-slate-700 text-xs font-medium text-sky-300 transition-colors whitespace-nowrap shrink-0"
                          >
                            <Eye className="w-3.5 h-3.5" />
                            <span>View Evidence</span>
                          </button>
                        </td>
                      </tr>
                    );
                  }

                  if (category === "products") {
                    const r = row as ProductRow;
                    const siteUrl = r.official_website || r.website;
                    return (
                      <tr
                        key={r.product_id || idx}
                        onClick={() => setSelectedRow(r)}
                        className="hover:bg-slate-800/40 cursor-pointer transition-colors"
                      >
                        <td className="py-3 px-4">
                          <div className="font-medium text-slate-100">{r.name}</div>
                          {r.description && (
                            <div className="text-xs text-slate-400 line-clamp-1 max-w-md mt-0.5">
                              {r.description}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-xs text-slate-300">
                          <div>{r.company_name || "Unknown"}</div>
                          <div className="text-slate-400">{r.category || "Unknown"}</div>
                        </td>
                        <td className="py-3 px-4">
                          <VerificationStatusCell
                            status={r.verification_status}
                            sourceTitle={r.source_title}
                            rejectionReason={r.rejection_reason}
                            verificationReason={getMetadataReason(r.source_metadata_json)}
                          />
                        </td>
                        <td className="py-3 px-4 text-xs text-slate-400" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center gap-2">
                            <span>{r.source_name}</span>
                            <span aria-hidden="true">·</span>
                            <a
                              href={r.source_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-sky-400 hover:underline inline-flex items-center gap-1"
                            >
                              <span>Source</span>
                              <ExternalLink className="w-3 h-3" />
                            </a>
                            {siteUrl && siteUrl !== r.source_url && (
                              <>
                                <span aria-hidden="true">·</span>
                                <a
                                  href={siteUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-slate-300 hover:text-sky-300 hover:underline inline-flex items-center gap-1"
                                >
                                  <span>Site</span>
                                  <ExternalLink className="w-3 h-3" />
                                </a>
                              </>
                            )}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-xs text-slate-400 tabular-nums whitespace-nowrap">
                          {formatUtc(r.last_checked_at || r.collected_at)}
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            onClick={() => setSelectedRow(r)}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-slate-700 bg-slate-800/70 hover:bg-slate-700 text-xs font-medium text-sky-300 transition-colors whitespace-nowrap shrink-0"
                          >
                            <Eye className="w-3.5 h-3.5" />
                            <span>View Evidence</span>
                          </button>
                        </td>
                      </tr>
                    );
                  }

                  if (category === "research_papers") {
                    const r = row as ResearchPaperRow;
                    return (
                      <tr
                        key={r.paper_id || idx}
                        onClick={() => setSelectedRow(r)}
                        className="hover:bg-slate-800/40 cursor-pointer transition-colors"
                      >
                        <td className="py-3 px-4 max-w-md">
                          <div className="font-medium text-slate-100 line-clamp-2">{r.title}</div>
                          <div className="text-xs text-slate-400 mt-0.5">{parseAuthors(r.authors_json)}</div>
                        </td>
                        <td className="py-3 px-4">
                          <VerificationStatusCell
                            status={r.verification_status}
                            sourceTitle={r.source_title}
                            rejectionReason={r.rejection_reason}
                            verificationReason={getMetadataReason(r.source_metadata_json)}
                          />
                        </td>
                        <td className="py-3 px-4 text-xs text-slate-300" onClick={(e) => e.stopPropagation()}>
                          <div className="font-mono">{r.arxiv_id ? `arXiv:${r.arxiv_id}` : r.doi ? `DOI:${r.doi}` : "—"}</div>
                          <div className="flex items-center gap-2 text-slate-400 mt-0.5">
                            <span>{r.source_name}</span>
                            {r.source_url && (
                              <>
                                <span aria-hidden="true">·</span>
                                <a
                                  href={r.source_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-sky-400 hover:underline inline-flex items-center gap-1"
                                >
                                  <span>Source</span>
                                  <ExternalLink className="w-3 h-3" />
                                </a>
                              </>
                            )}
                            {r.official_website && r.official_website !== r.source_url && (
                              <>
                                <span aria-hidden="true">·</span>
                                <a
                                  href={r.official_website}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-slate-300 hover:text-sky-300 hover:underline inline-flex items-center gap-1"
                                >
                                  <span>Ref</span>
                                  <ExternalLink className="w-3 h-3" />
                                </a>
                              </>
                            )}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-xs" onClick={(e) => e.stopPropagation()}>
                          {r.github_repository ? (
                            <a
                              href={r.github_repository}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-sky-400 hover:underline inline-flex items-center gap-1 font-mono"
                            >
                              <span className="truncate max-w-[180px]">
                                {r.github_repository.replace("https://github.com/", "")}
                              </span>
                              <ExternalLink className="w-3 h-3 shrink-0" />
                            </a>
                          ) : (
                            <span className="text-slate-500">—</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-xs text-slate-200 tabular-nums">
                          {r.github_stars !== null && r.github_stars !== undefined
                            ? r.github_stars.toLocaleString()
                            : "—"}
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-xs tabular-nums whitespace-nowrap">
                          <div className="text-slate-300">{r.publication_date ?? "—"}</div>
                          <div className="text-[11px] text-slate-500">
                            {formatUtc(r.last_checked_at || r.collected_at)}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            onClick={() => setSelectedRow(r)}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-slate-700 bg-slate-800/70 hover:bg-slate-700 text-xs font-medium text-sky-300 transition-colors whitespace-nowrap shrink-0"
                          >
                            <Eye className="w-3.5 h-3.5" />
                            <span>View Evidence</span>
                          </button>
                        </td>
                      </tr>
                    );
                  }

                  if (category === "jobs") {
                    const r = row as JobRow;
                    return (
                      <tr
                        key={r.job_id || idx}
                        onClick={() => setSelectedRow(r)}
                        className="hover:bg-slate-800/40 cursor-pointer transition-colors"
                      >
                        <td className="py-3 px-4">
                          <div className="font-medium text-slate-100">{r.title}</div>
                          <div className="text-xs text-slate-400 mt-0.5">{r.company || "Unknown"}</div>
                        </td>
                        <td className="py-3 px-4 text-xs text-slate-300">
                          {[r.location || "Unknown", r.employment_type || "Unknown"].join(" · ")}
                        </td>
                        <td className="py-3 px-4">
                          <VerificationStatusCell
                            status={r.verification_status}
                            sourceTitle={r.source_title}
                            rejectionReason={r.rejection_reason}
                            verificationReason={getMetadataReason(r.source_metadata_json)}
                          />
                        </td>
                        <td className="py-3 px-4 text-xs text-slate-400" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center gap-2">
                            <span>{r.source_name}</span>
                            {r.source_url && (
                              <>
                                <span aria-hidden="true">·</span>
                                <a
                                  href={r.source_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-sky-400 hover:underline inline-flex items-center gap-1"
                                >
                                  <span>Source</span>
                                  <ExternalLink className="w-3 h-3" />
                                </a>
                              </>
                            )}
                            {r.application_url && r.application_url !== r.source_url && (
                              <>
                                <span aria-hidden="true">·</span>
                                <a
                                  href={r.application_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-slate-300 hover:text-sky-300 hover:underline inline-flex items-center gap-1"
                                >
                                  <span>Apply</span>
                                  <ExternalLink className="w-3 h-3" />
                                </a>
                              </>
                            )}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-xs tabular-nums whitespace-nowrap">
                          <div className="text-emerald-400">{formatUtc(r.posted_at)}</div>
                          <div className="text-[11px] text-slate-500">
                            {formatUtc(r.last_checked_at || r.collected_at)}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            onClick={() => setSelectedRow(r)}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-slate-700 bg-slate-800/70 hover:bg-slate-700 text-xs font-medium text-sky-300 transition-colors whitespace-nowrap shrink-0"
                          >
                            <Eye className="w-3.5 h-3.5" />
                            <span>View Evidence</span>
                          </button>
                        </td>
                      </tr>
                    );
                  }

                  if (category === "news") {
                    const r = row as NewsRow;
                    return (
                      <tr
                        key={r.news_id || idx}
                        onClick={() => setSelectedRow(r)}
                        className="hover:bg-slate-800/40 cursor-pointer transition-colors"
                      >
                        <td className="py-3 px-4 max-w-lg" onClick={(e) => e.stopPropagation()}>
                          <a
                            href={r.article_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-medium text-slate-100 hover:text-sky-300 inline-flex items-start gap-1.5"
                          >
                            <span>{r.headline}</span>
                            <ExternalLink className="w-3.5 h-3.5 shrink-0 mt-1 text-slate-400" />
                          </a>
                          {r.summary && (
                            <p className="text-xs text-slate-400 line-clamp-1 mt-0.5">{r.summary}</p>
                          )}
                        </td>
                        <td className="py-3 px-4 text-xs text-slate-300">
                          {[r.publisher || "Unknown", r.category || "Unknown"].join(" · ")}
                        </td>
                        <td className="py-3 px-4">
                          <VerificationStatusCell
                            status={r.verification_status}
                            sourceTitle={r.source_title}
                            rejectionReason={r.rejection_reason}
                            verificationReason={getMetadataReason(r.source_metadata_json)}
                          />
                        </td>
                        <td className="py-3 px-4 text-xs text-slate-400" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center gap-2">
                            <span>{r.source_name || r.publisher || "Unknown"}</span>
                            {r.source_url && (
                              <>
                                <span aria-hidden="true">·</span>
                                <a
                                  href={r.source_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-sky-400 hover:underline inline-flex items-center gap-1"
                                >
                                  <span>Source</span>
                                  <ExternalLink className="w-3 h-3" />
                                </a>
                              </>
                            )}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-xs tabular-nums whitespace-nowrap">
                          <div className="text-emerald-400">{formatUtc(r.published_at)}</div>
                          <div className="text-[11px] text-slate-500">
                            {formatUtc(r.last_checked_at || r.collected_at)}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            onClick={() => setSelectedRow(r)}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-slate-700 bg-slate-800/70 hover:bg-slate-700 text-xs font-medium text-sky-300 transition-colors whitespace-nowrap shrink-0"
                          >
                            <Eye className="w-3.5 h-3.5" />
                            <span>View Evidence</span>
                          </button>
                        </td>
                      </tr>
                    );
                  }

                  const r = row as EntityMappingRow;
                  const decisionColor =
                    r.decision === "exact_match" || r.decision === "auto_merge"
                      ? "text-emerald-400"
                      : r.decision === "manual_review"
                      ? "text-amber-400"
                      : "text-sky-300";
                  return (
                    <tr
                      key={r.mapping_id || idx}
                      onClick={() => setSelectedRow(r)}
                      className="hover:bg-slate-800/40 cursor-pointer transition-colors"
                    >
                      <td className="py-3 px-4">
                        <div className="font-medium text-slate-100">{r.raw_name ?? "—"}</div>
                        <div className="font-mono text-xs text-slate-400 mt-0.5">{r.normalized_name ?? "—"}</div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="text-slate-100 text-xs font-medium">{r.canonical_name ?? "—"}</div>
                        <div className="font-mono text-xs text-slate-500">{r.canonical_id ?? "—"}</div>
                      </td>
                      <td className="py-3 px-4 text-xs">
                        <div>
                          <span className={`font-medium ${decisionColor}`}>{r.decision ?? "—"}</span>
                          <span className="text-slate-500"> · {r.match_method ?? "—"}</span>
                        </div>
                        {r.match_reason && (
                          <div className="text-[11px] text-slate-400 line-clamp-1 max-w-[230px] mt-0.5" title={r.match_reason}>
                            {r.match_reason}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-4 text-xs" onClick={(e) => e.stopPropagation()}>
                        {r.source_url ? (
                          <a
                            href={r.source_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sky-400 hover:underline inline-flex items-center gap-1"
                          >
                            <span>Source</span>
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        ) : (
                          <span className="text-slate-500">—</span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-xs text-slate-200 tabular-nums">
                        {typeof r.confidence === "number" ? r.confidence.toFixed(2) : "—"}
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-xs text-slate-400 tabular-nums whitespace-nowrap">
                        {formatUtc(r.timestamp)}
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          onClick={() => setSelectedRow(r)}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-slate-700 bg-slate-800/70 hover:bg-slate-700 text-xs font-medium text-sky-300 transition-colors whitespace-nowrap shrink-0"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          <span>View Evidence</span>
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {filteredCategoryFailures.length > 0 && (
          <div className="rounded-xl bg-[#0E172B] border border-rose-500/30 p-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-rose-400 text-sm font-semibold">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>Pre-Persistence Rejections Logged in failure_logs ({filteredCategoryFailures.length})</span>
              </div>
              <span className="text-xs text-slate-400">Filtered by Rejected</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400">
                    <th className="py-2 pr-3 font-medium">Stage</th>
                    <th className="py-2 px-2 font-medium">Rejection Reason</th>
                    <th className="py-2 px-2 font-medium">Source URL</th>
                    <th className="py-2 pl-2 font-medium text-right">Logged</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {filteredCategoryFailures.map((f) => (
                    <tr key={f.failure_id} className="hover:bg-slate-800/30">
                      <td className="py-2 pr-3 font-mono text-rose-300">{f.stage}</td>
                      <td className="py-2 px-2 text-slate-200 max-w-lg break-words">{f.reason}</td>
                      <td className="py-2 px-2 text-slate-400 max-w-xs truncate">
                        {f.source_url ? (
                          <a
                            href={f.source_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sky-400 hover:underline"
                          >
                            {f.source_url}
                          </a>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-2 pl-2 text-right font-mono text-slate-400 tabular-nums whitespace-nowrap">
                        {formatUtc(f.created_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        </>
      )}

      {/* Detailed Record Inspection & Source Evidence Drawer */}
      {selectedRow && (() => {
        const rec = selectedRow as unknown as Record<string, unknown>;
        const { id: recordId, title: recordTitle } = getRecordIdAndTitle(category, selectedRow);
        const meta = parseJsonRecord(rec.source_metadata_json);
        const verStatus = String(rec.verification_status ?? "Unverified");
        const verMode = String(meta.verification_mode ?? "");
        const isLiveChecked = verMode === "live_http_check";
        const evidenceExcerpt =
          typeof meta.source_evidence_excerpt === "string" && meta.source_evidence_excerpt.trim()
            ? meta.source_evidence_excerpt
            : null;
        const auditIssues = Array.isArray(meta.audit_issues) ? meta.audit_issues.map(String) : [];
        const unsupportedFields = Array.isArray(meta.unsupported_fields) ? meta.unsupported_fields.map(String) : [];
        const incompleteFields = Array.isArray(meta.incomplete_fields) ? meta.incomplete_fields.map(String) : [];
        const duplicateOf = typeof meta.duplicate_of === "string" ? meta.duplicate_of : null;
        const rejectionReason = typeof rec.rejection_reason === "string" && rec.rejection_reason.trim()
          ? rec.rejection_reason
          : null;
        const verificationReason =
          typeof meta.verification_reason === "string" && meta.verification_reason.trim()
            ? meta.verification_reason
            : null;
        const startupReport =
          category === "startups" &&
          meta.startup_verification_report &&
          typeof meta.startup_verification_report === "object"
            ? (meta.startup_verification_report as StartupVerificationReport)
            : null;
        const statusColor =
          verStatus === "Verified"
            ? "text-emerald-400"
            : verStatus === "Partially Verified"
            ? "text-sky-400"
            : verStatus === "Rejected"
            ? "text-rose-400"
            : verStatus === "Source Unavailable"
            ? "text-slate-300"
            : "text-amber-400";

        return (
          <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-xs">
            <div className="w-full max-w-xl bg-[#0B1324] border-l border-slate-800 h-full overflow-y-auto p-6 space-y-5">
              {/* Drawer Header */}
              <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-4">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2 text-xs font-mono text-slate-400">
                    <span>{info.title}</span>
                    <span aria-hidden="true">/</span>
                    <span className="truncate">{recordId}</span>
                  </div>
                  <h2 className="font-display text-lg font-semibold text-slate-100 break-words">
                    {recordTitle}
                  </h2>
                  {supportsVerification && (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-xs">
                      <span className={`font-semibold ${statusColor}`}>{verStatus}</span>
                      <span className="text-slate-600" aria-hidden="true">·</span>
                      <span className={isLiveChecked ? "text-emerald-300" : "text-amber-300"}>
                        {isLiveChecked ? "Live HTTP Source Checked" : "Offline / Not Live-Verified"}
                      </span>
                      {typeof meta.source_http_status === "number" && (
                        <>
                          <span className="text-slate-600" aria-hidden="true">·</span>
                          <span className="font-mono text-slate-400 tabular-nums">
                            HTTP {meta.source_http_status}
                          </span>
                        </>
                      )}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedRow(null)}
                  aria-label="Close detail drawer"
                  className="p-1.5 rounded-md text-slate-400 hover:text-slate-100 hover:bg-slate-800 shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Rejection / Detected Issues Alert */}
              {(rejectionReason || auditIssues.length > 0 || duplicateOf) && (
                <div className="rounded-lg bg-rose-950/25 border border-rose-500/40 p-4 space-y-2 text-xs">
                  <div className="flex items-center gap-2 font-semibold text-rose-300">
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                    <span>Audit Issues &amp; Rejection Diagnostics</span>
                  </div>
                  {rejectionReason && (
                    <p className="text-rose-200 leading-relaxed">{rejectionReason}</p>
                  )}
                  {duplicateOf && (
                    <p className="font-mono text-rose-300/90">
                      Duplicate of persisted record: {duplicateOf}
                    </p>
                  )}
                  {auditIssues.length > 0 && (
                    <div className="font-mono text-[11px] text-amber-300">
                      Flags: {auditIssues.join(", ")}
                    </div>
                  )}
                  {incompleteFields.length > 0 && (
                    <div className="text-slate-300">
                      Incomplete / Unknown fields: <span className="font-mono">{incompleteFields.join(", ")}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Startup Verification Report */}
              {category === "startups" && (
                <div className="rounded-lg bg-[#070D1A] border border-slate-800 p-4 space-y-3 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 font-semibold text-slate-200">
                      <ShieldCheck className="w-4 h-4 text-sky-400 shrink-0" />
                      <span>Startup Verification Report</span>
                    </div>
                    <span className={`font-semibold ${statusColor}`}>{verStatus}</span>
                  </div>

                  {startupReport ? (
                    <div className="space-y-2.5">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                        {/* 1. Company Name Match */}
                        <div className="rounded-lg border border-slate-800 bg-[#0B1324] p-3 space-y-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-slate-400">Company Name Match</span>
                            <span className={`inline-flex items-center gap-1 font-medium ${startupReport.company_name_match.matched ? "text-emerald-400" : "text-rose-400"}`}>
                              {startupReport.company_name_match.matched ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                              <span>{startupReport.company_name_match.matched ? "Matched" : "Not Matched"}</span>
                            </span>
                          </div>
                          <div className="text-slate-200 font-medium break-words">{startupReport.company_name_match.claimed || "—"}</div>
                          {startupReport.company_name_match.evidence && (
                            <div className="text-[11px] text-slate-400 line-clamp-2">{startupReport.company_name_match.evidence}</div>
                          )}
                        </div>

                        {/* 2. Official Website Validity */}
                        <div className="rounded-lg border border-slate-800 bg-[#0B1324] p-3 space-y-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-slate-400">Official Website Validity</span>
                            <span className={`inline-flex items-center gap-1 font-medium ${
                              startupReport.official_website_validity.accessible
                                ? "text-emerald-400"
                                : startupReport.official_website_validity.valid_url
                                ? "text-amber-400"
                                : "text-slate-400"
                            }`}>
                              {startupReport.official_website_validity.accessible ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                              <span>
                                {startupReport.official_website_validity.accessible === true
                                  ? `Accessible${startupReport.official_website_validity.http_status ? ` (HTTP ${startupReport.official_website_validity.http_status})` : ""}`
                                  : startupReport.official_website_validity.accessible === false
                                  ? `Unreachable${startupReport.official_website_validity.http_status ? ` (HTTP ${startupReport.official_website_validity.http_status})` : ""}`
                                  : startupReport.official_website_validity.valid_url
                                  ? "Valid URL (Not Checked)"
                                  : "Invalid / Missing"}
                              </span>
                            </span>
                          </div>
                          {startupReport.official_website_validity.url && (
                            <a
                              href={startupReport.official_website_validity.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-sky-400 hover:underline inline-flex items-center gap-1 break-all"
                            >
                              <span>{startupReport.official_website_validity.url}</span>
                              <ExternalLink className="w-3 h-3 shrink-0" />
                            </a>
                          )}
                          {startupReport.official_website_validity.page_title && (
                            <div className="text-[11px] text-slate-400 line-clamp-1">
                              Title: {startupReport.official_website_validity.page_title}
                            </div>
                          )}
                          {startupReport.official_website_validity.error && (
                            <div className="text-[11px] font-mono text-rose-300">
                              Error: {startupReport.official_website_validity.error}
                            </div>
                          )}
                        </div>

                        {/* 3. Description Match */}
                        <div className="rounded-lg border border-slate-800 bg-[#0B1324] p-3 space-y-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-slate-400">Description Match</span>
                            <span className={`inline-flex items-center gap-1 font-medium ${startupReport.description_match.matched ? "text-emerald-400" : "text-amber-400"}`}>
                              {startupReport.description_match.matched ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                              <span>{startupReport.description_match.matched ? "Matched" : "Uncorroborated"}</span>
                            </span>
                          </div>
                          <div className="text-slate-300 line-clamp-2">{startupReport.description_match.claimed || "Missing"}</div>
                        </div>

                        {/* 4. Industry Evidence */}
                        <div className="rounded-lg border border-slate-800 bg-[#0B1324] p-3 space-y-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-slate-400">Industry Evidence</span>
                            <span className={`inline-flex items-center gap-1 font-medium ${startupReport.industry_evidence.matched ? "text-emerald-400" : "text-amber-400"}`}>
                              {startupReport.industry_evidence.matched ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                              <span>{startupReport.industry_evidence.matched ? "Matched" : "Uncorroborated"}</span>
                            </span>
                          </div>
                          <div className="text-slate-200">{startupReport.industry_evidence.claimed || "Unknown"}</div>
                          {startupReport.industry_evidence.evidence && (
                            <div className="text-[11px] text-slate-400 line-clamp-2">{startupReport.industry_evidence.evidence}</div>
                          )}
                        </div>

                        {/* 5. Location Evidence */}
                        <div className="rounded-lg border border-slate-800 bg-[#0B1324] p-3 space-y-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-slate-400">Location Evidence</span>
                            <span className={`inline-flex items-center gap-1 font-medium ${startupReport.location_evidence.matched ? "text-emerald-400" : "text-amber-400"}`}>
                              {startupReport.location_evidence.matched ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                              <span>{startupReport.location_evidence.matched ? "Matched" : "Uncorroborated"}</span>
                            </span>
                          </div>
                          <div className="text-slate-200">{startupReport.location_evidence.claimed || "Unknown"}</div>
                          {startupReport.location_evidence.hq_guard_triggered && (
                            <div className="text-[11px] text-amber-300">HQ Guard: branch/factory location rejected as HQ</div>
                          )}
                          {startupReport.location_evidence.evidence && (
                            <div className="text-[11px] text-slate-400 line-clamp-2">{startupReport.location_evidence.evidence}</div>
                          )}
                        </div>

                        {/* 6. Source Accessibility & Timestamp */}
                        <div className="rounded-lg border border-slate-800 bg-[#0B1324] p-3 space-y-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-slate-400">Source Accessibility</span>
                            <span className={`inline-flex items-center gap-1 font-medium ${startupReport.source_accessibility.accessible ? "text-emerald-400" : "text-rose-400"}`}>
                              {startupReport.source_accessibility.accessible ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                              <span>
                                {startupReport.source_accessibility.accessible
                                  ? `Accessible${startupReport.source_accessibility.http_status ? ` (HTTP ${startupReport.source_accessibility.http_status})` : ""}`
                                  : `Unavailable${startupReport.source_accessibility.error ? ` (${startupReport.source_accessibility.error})` : ""}`}
                              </span>
                            </span>
                          </div>
                          <div className="font-mono text-[11px] text-slate-300 tabular-nums">
                            Verified: {formatUtc(startupReport.verification_timestamp || (typeof rec.last_checked_at === "string" ? rec.last_checked_at : null))}
                          </div>
                        </div>
                      </div>

                      {/* 7. Exact Verification / Partial / Rejection Reason */}
                      <div className="rounded-lg border border-slate-800 bg-[#0B1324] p-3 space-y-1">
                        <div className="text-slate-400">Exact Verification / Rejection Reason</div>
                        <p className="text-slate-200 leading-relaxed">
                          {startupReport.exact_reason || rejectionReason || verificationReason || "No reason recorded."}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <p className="text-slate-400 leading-relaxed">
                      Detailed startup report not yet backfilled for this legacy record. Run Audit Records to populate the 7-point verification breakdown.
                    </p>
                  )}
                </div>
              )}

              {/* Entity Mapping Log Traceability */}
              {category === "entity_mapping_log" && (() => {
                const em = selectedRow as EntityMappingRow;
                return (
                  <div className="rounded-lg bg-[#070D1A] border border-slate-800 p-4 space-y-3 text-xs">
                    <div className="flex items-center gap-2 font-semibold text-slate-200">
                      <ShieldCheck className="w-4 h-4 text-sky-400 shrink-0" />
                      <span>Entity Resolution Traceability</span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <div className="text-slate-500 mb-0.5">Raw Observed Name</div>
                        <div className="text-slate-200 font-medium">{em.raw_name || "—"}</div>
                      </div>
                      <div>
                        <div className="text-slate-500 mb-0.5">Normalized Name</div>
                        <div className="font-mono text-slate-300">{em.normalized_name || "—"}</div>
                      </div>
                      <div>
                        <div className="text-slate-500 mb-0.5">Canonical Entity</div>
                        <div className="text-slate-200 font-medium">{em.canonical_name || "—"}</div>
                        <div className="font-mono text-[11px] text-slate-500">{em.canonical_id || "—"}</div>
                      </div>
                      <div>
                        <div className="text-slate-500 mb-0.5">Decision &amp; Confidence</div>
                        <div className="font-mono text-sky-300 tabular-nums">
                          {em.decision} · {em.match_method} · {typeof em.confidence === "number" ? em.confidence.toFixed(2) : "—"}
                        </div>
                      </div>
                    </div>
                    <div>
                      <div className="text-slate-500 mb-0.5">Match Reasoning</div>
                      <p className="text-slate-300 leading-relaxed">{em.match_reason || "—"}</p>
                    </div>
                    <div>
                      <div className="text-slate-500 mb-0.5">Source URL</div>
                      {em.source_url ? (
                        <a
                          href={em.source_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sky-400 hover:underline inline-flex items-center gap-1 break-all"
                        >
                          <span>{em.source_url}</span>
                          <ExternalLink className="w-3 h-3 shrink-0" />
                        </a>
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </div>
                    <div>
                      <div className="text-slate-500 mb-0.5">Logged Timestamp (UTC)</div>
                      <div className="font-mono text-slate-300 tabular-nums">{formatUtc(em.timestamp)}</div>
                    </div>
                  </div>
                );
              })()}

              {/* Source Evidence & Traceability */}
              {supportsVerification && (
                <div className="rounded-lg bg-[#070D1A] border border-slate-800 p-4 space-y-3 text-xs">
                  <div className="flex items-center gap-2 font-semibold text-slate-200">
                    <ShieldCheck className="w-4 h-4 text-sky-400 shrink-0" />
                    <span>Source Evidence &amp; Field Corroboration</span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <div className="text-slate-500 mb-0.5">Last Checked (UTC)</div>
                      <div className="font-mono text-slate-200 tabular-nums">
                        {formatUtc(typeof rec.last_checked_at === "string" ? rec.last_checked_at : null)}
                      </div>
                    </div>
                    <div>
                      <div className="text-slate-500 mb-0.5">Collected At (UTC)</div>
                      <div className="font-mono text-slate-200 tabular-nums">
                        {formatUtc(typeof rec.collected_at === "string" ? rec.collected_at : null)}
                      </div>
                    </div>
                  </div>

                  <div>
                    <div className="text-slate-500 mb-0.5">Extracted Page Title</div>
                    <div className="text-slate-200">
                      {typeof rec.source_title === "string" && rec.source_title.trim()
                        ? rec.source_title
                        : "— (no accessible page title captured)"}
                    </div>
                  </div>

                  <div>
                    <div className="text-slate-500 mb-0.5">Original Source URL</div>
                    {typeof rec.source_url === "string" && rec.source_url ? (
                      <a
                        href={rec.source_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sky-400 hover:underline inline-flex items-center gap-1 break-all"
                      >
                        <span>{rec.source_url}</span>
                        <ExternalLink className="w-3 h-3 shrink-0" />
                      </a>
                    ) : (
                      <span className="text-slate-500">—</span>
                    )}
                  </div>

                  {typeof (rec.official_website ?? rec.website) === "string" && Boolean(rec.official_website ?? rec.website) && (
                    <div>
                      <div className="text-slate-500 mb-0.5">Official Website</div>
                      <a
                        href={String(rec.official_website ?? rec.website)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sky-400 hover:underline inline-flex items-center gap-1 break-all"
                      >
                        <span>{String(rec.official_website ?? rec.website)}</span>
                        <ExternalLink className="w-3 h-3 shrink-0" />
                      </a>
                    </div>
                  )}

                  <div>
                    <div className="text-slate-500 mb-0.5">Supported Fields</div>
                    <div className="font-mono text-emerald-300">
                      {parseSupportedFields(rec.supported_fields_json)}
                    </div>
                  </div>

                  {unsupportedFields.length > 0 && (
                    <div>
                      <div className="text-slate-500 mb-0.5">Unsupported / Stripped Fields</div>
                      <div className="font-mono text-amber-300">{unsupportedFields.join(", ")}</div>
                    </div>
                  )}

                  {verificationReason && category !== "startups" && (
                    <div>
                      <div className="text-slate-500 mb-0.5">Verification Rationale</div>
                      <p className="text-slate-300 leading-relaxed">{verificationReason}</p>
                    </div>
                  )}

                  <div>
                    <div className="text-slate-500 mb-1">Captured Source Evidence Excerpt</div>
                    {evidenceExcerpt ? (
                      <blockquote className="border border-slate-800 rounded-lg p-3 text-slate-300 leading-relaxed bg-[#0B1324]">
                        {evidenceExcerpt}
                      </blockquote>
                    ) : (
                      <p className="text-slate-500 italic">
                        No corroborating source excerpt captured. Evidence is never invented when unavailable.
                      </p>
                    )}
                  </div>
                </div>
              )}

              {/* Per-Record Audit Trail History */}
              {category !== "entity_mapping_log" && (
                <div className="rounded-lg bg-[#070D1A] border border-slate-800 p-4 space-y-3 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-slate-200">Record Audit Trail</span>
                    <span className="font-mono text-slate-400 tabular-nums">
                      {rowAuditLoading ? "Loading..." : `${rowAuditTrail.length} events`}
                    </span>
                  </div>

                  {!rowAuditLoading && rowAuditTrail.length === 0 ? (
                    <p className="text-slate-500">
                      No status transitions logged for this record yet. Run Audit Records to append an entry.
                    </p>
                  ) : (
                    <ul className="space-y-2.5">
                      {rowAuditTrail.map((entry) => (
                        <li key={entry.audit_id} className="border border-slate-800 bg-[#0B1324] rounded-lg p-3 space-y-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium text-slate-200">
                              {entry.previous_status || "new"} -&gt; {entry.new_status}
                            </span>
                            <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                              {formatUtc(entry.checked_at)}
                            </span>
                          </div>
                          <p className="text-slate-300 leading-relaxed">{entry.reason}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {/* Collapsible Raw Record Fields */}
              <div className="border-t border-slate-800 pt-3">
                <button
                  type="button"
                  onClick={() => setShowRawFields((v) => !v)}
                  className="flex items-center gap-1.5 text-xs font-medium text-slate-300 hover:text-sky-300"
                >
                  {showRawFields ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  <span>All Stored Record Fields ({Object.keys(selectedRow).length})</span>
                </button>

                {showRawFields && (
                  <dl className="mt-3 space-y-3 text-xs">
                    {Object.entries(selectedRow).map(([key, value]) => (
                      <div key={key} className="border-b border-slate-800/60 pb-2.5">
                        <dt className="font-mono text-slate-400 mb-1">{key}</dt>
                        <dd className="text-slate-200 break-words whitespace-pre-wrap">
                          {key === "supported_fields_json" ? (
                            parseSupportedFields(value)
                          ) : typeof value === "string" && /^https?:\/\//i.test(value) ? (
                            <a
                              href={value}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-sky-400 hover:underline inline-flex items-center gap-1"
                            >
                              <span>{value}</span>
                              <ExternalLink className="w-3 h-3 shrink-0" />
                            </a>
                          ) : value === null || value === "" ? (
                            <span className="text-slate-500">null</span>
                          ) : (
                            String(value)
                          )}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
