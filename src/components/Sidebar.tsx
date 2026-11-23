import {
  Briefcase,
  Building2,
  FileText,
  GitMerge,
  LayoutDashboard,
  Mail,
  Newspaper,
  Package,
  X,
} from "lucide-react";
import type { DatasetCategory, SectionId } from "../types/atlas";

interface SidebarProps {
  activeSection: SectionId;
  onSelect: (section: SectionId) => void;
  counts: Record<DatasetCategory, number> | null;
  storageBackend: string;
  freshnessHours: number;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

interface NavItem {
  id: SectionId;
  label: string;
  icon: typeof LayoutDashboard;
  countKey?: DatasetCategory;
}

const NAV_ITEMS: NavItem[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "startups", label: "Startups", icon: Building2, countKey: "startups" },
  { id: "products", label: "Products", icon: Package, countKey: "products" },
  { id: "research_papers", label: "Research Papers", icon: FileText, countKey: "research_papers" },
  { id: "jobs", label: "Jobs", icon: Briefcase, countKey: "jobs" },
  { id: "news", label: "News", icon: Newspaper, countKey: "news" },
  { id: "entity_mapping_log", label: "Entity Mapping Log", icon: GitMerge, countKey: "entity_mapping_log" },
  { id: "gmail", label: "Gmail", icon: Mail },
];

export function Sidebar({
  activeSection,
  onSelect,
  counts,
  storageBackend,
  freshnessHours,
  mobileOpen,
  onCloseMobile,
}: SidebarProps) {
  const navContent = (
    <div className="flex h-full flex-col bg-[#0B1324] border-r border-slate-800/80">
      <div className="flex h-16 items-center justify-between px-5 border-b border-slate-800/80">
        <span className="font-display text-lg font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0">
          FrontierAtlas
        </span>
        <button
          type="button"
          onClick={onCloseMobile}
          aria-label="Close navigation"
          className="lg:hidden p-2 rounded-md text-slate-400 hover:text-slate-100 hover:bg-slate-800/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1" aria-label="Primary navigation">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = activeSection === item.id;
          const count = item.countKey && counts ? counts[item.countKey] : null;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                onSelect(item.id);
                onCloseMobile();
              }}
              className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
                isActive
                  ? "bg-sky-500/15 text-sky-300"
                  : "text-slate-300 hover:bg-slate-800/60 hover:text-slate-100"
              }`}
            >
              <span className="flex items-center gap-2.5 min-w-0">
                <Icon className={`w-4 h-4 shrink-0 ${isActive ? "text-sky-400" : "text-slate-400"}`} />
                <span className="truncate whitespace-nowrap">{item.label}</span>
              </span>
              {count !== null && (
                <span
                  className={`font-mono text-xs tabular-nums shrink-0 ${
                    isActive ? "text-sky-300" : "text-slate-400"
                  }`}
                >
                  {count.toLocaleString()}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="px-4 py-4 border-t border-slate-800/80 text-xs text-slate-400 space-y-1.5">
        <div className="flex items-center justify-between">
          <span>Storage</span>
          <span className="font-mono text-slate-200">{storageBackend}</span>
        </div>
        <div className="flex items-center justify-between">
          <span>Freshness Window</span>
          <span className="font-mono text-slate-200 tabular-nums">{freshnessHours}h UTC</span>
        </div>
      </div>
    </div>
  );

  return (
    <>
      <aside className="hidden lg:block lg:w-64 lg:shrink-0 lg:sticky lg:top-0 lg:h-screen">
        {navContent}
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/70 backdrop-blur-xs"
            onClick={onCloseMobile}
            aria-hidden="true"
          />
          <div className="relative w-72 max-w-[85vw] h-full z-10">{navContent}</div>
        </div>
      )}
    </>
  );
}
