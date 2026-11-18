"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  Bell,
  ChartNoAxesCombined,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Database,
  FolderClosed,
  Gauge,
  History,
  LayoutGrid,
  Menu,
  Radio,
  Search,
  Settings2,
  Upload,
  Waves,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Dataset } from "@/lib/types";

export type DashboardSection =
  | "Overview"
  | "Datasets"
  | "Live Visualization"
  | "Historical Playback"
  | "Analytics"
  | "Performance"
  | "Settings";
const navigation: { name: DashboardSection; icon: LucideIcon }[] = [
  { name: "Overview", icon: LayoutGrid },
  { name: "Datasets", icon: Database },
  { name: "Live Visualization", icon: Radio },
  { name: "Historical Playback", icon: History },
  { name: "Analytics", icon: ChartNoAxesCombined },
  { name: "Performance", icon: Gauge },
];

export const DashboardNavigation = memo(function DashboardNavigation({
  active,
  catalog,
  onNavigate,
  onOpen,
  onHelp,
  mobileOpen,
  onClose,
}: {
  active: DashboardSection;
  catalog: Dataset[];
  onNavigate: (section: DashboardSection) => void;
  onOpen: (id: string) => void;
  onHelp: () => void;
  mobileOpen: boolean;
  onClose: () => void;
}) {
  return (
    <>
      <nav className="icon-rail" aria-label="Quick navigation">
        <a className="rail-brand" href="/" aria-label="WaveX home">
          <Waves size={24} strokeWidth={1.8} />
        </a>
        <div className="rail-links">
          {navigation.slice(0, 5).map(({ name, icon: Icon }) => (
            <button
              key={name}
              className={active === name ? "active" : ""}
              aria-label={`Go to ${name.toLowerCase()}`}
              title={name}
              onClick={() => onNavigate(name)}
            >
              <Icon size={19} strokeWidth={1.65} />
            </button>
          ))}
        </div>
        <div className="rail-bottom">
          <button
            onClick={onHelp}
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts"
          >
            <CircleHelp size={19} strokeWidth={1.6} />
          </button>
          <button
            onClick={() => onNavigate("Settings")}
            aria-label="Workspace settings"
            title="Workspace settings"
          >
            <Settings2 size={19} strokeWidth={1.6} />
          </button>
          <button
            className="workspace-avatar"
            onClick={() => onNavigate("Settings")}
            aria-label="Local workspace"
          >
            W
          </button>
        </div>
      </nav>
      {mobileOpen && (
        <button
          className="navigation-backdrop"
          aria-label="Close navigation"
          onClick={onClose}
        />
      )}
      <aside
        className={`secondary-sidebar ${mobileOpen ? "mobile-open" : ""}`}
        aria-label="Workspace navigation"
      >
        <div className="sidebar-brand">
          <span>
            wave<span>x</span>
          </span>
          <span className="workspace-badge">WORKSPACE</span>
        </div>
        <div className="workspace-switch">
          <span className="workspace-symbol">
            <Activity size={18} />
          </span>
          <div>
            <strong>Signal workspace</strong>
            <span>Your data, in motion</span>
          </div>
          <span className="local-dot" title="Local workspace" />
        </div>
        <p className="nav-group-label">Workspace</p>
        <nav className="section-navigation">
          {navigation.map(({ name, icon: Icon }) => (
            <button
              key={name}
              className={active === name ? "active" : ""}
              aria-current={active === name ? "page" : undefined}
              onClick={() => onNavigate(name)}
            >
              <Icon size={16} strokeWidth={1.7} />
              <span>{name}</span>
              {name === "Datasets" && catalog.length > 0 ? (
                <span className="nav-count">{catalog.length}</span>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-rule" />
        <div className="nav-library-heading">
          <p className="nav-group-label">Your library</p>
          <FolderClosed size={13} />
        </div>
        <div className="sidebar-datasets">
          {catalog.slice(0, 3).map((item) => (
            <button
              key={item.id}
              onClick={() => onOpen(item.id)}
              title={item.label}
            >
              <span
                className={`dataset-file-icon ${item.kind === "imported" ? "imported" : ""}`}
              >
                <Database size={14} />
              </span>
              <span>
                <strong>{item.label}</strong>
                <small>
                  {Intl.NumberFormat("en", {
                    notation: "compact",
                    maximumFractionDigits: 1,
                  }).format(item.size)}{" "}
                  records ·{" "}
                  {item.kind === "imported" ? "Imported" : "Generated"}
                </small>
              </span>
              <ChevronRight size={12} />
            </button>
          ))}
          {catalog.length === 0 && (
            <p className="library-empty">
              Your saved datasets will appear here.
            </p>
          )}
        </div>
        <div className="sidebar-bottom">
          <button
            onClick={() => onNavigate("Settings")}
            className={active === "Settings" ? "active" : ""}
          >
            <Settings2 size={16} />
            Settings
          </button>
          <button onClick={onHelp} aria-label="Open keyboard shortcuts">
            <CircleHelp size={16} />
            Help & shortcuts <ArrowUpRight size={12} />
          </button>
          <div className="sidebar-environment">
            <span className="environment-mark" />
            <div>
              <strong>Local environment</strong>
              <span>Private to this workspace</span>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
});

export const DashboardHeader = memo(function DashboardHeader({
  active,
  catalog,
  onOpen,
  onUpload,
  onSettings,
  onActivity,
  onMenu,
  activityCount,
}: {
  active: DashboardSection;
  catalog: Dataset[];
  onOpen: (id: string) => void;
  onUpload: () => void;
  onSettings: () => void;
  onActivity: () => void;
  onMenu: () => void;
  activityCount: number;
}) {
  const [search, setSearch] = useState(""),
    [open, setOpen] = useState(false),
    [mobileSearch, setMobileSearch] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const matches = useMemo(
    () =>
      catalog
        .filter((item) =>
          `${item.label} ${item.kind} ${item.size}`
            .toLowerCase()
            .includes(search.toLowerCase()),
        )
        .slice(0, 5),
    [catalog, search],
  );
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "k" &&
        !document.querySelector('[aria-modal="true"]')
      ) {
        event.preventDefault();
        setMobileSearch(true);
        setOpen(true);
        requestAnimationFrame(() => input.current?.focus());
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  return (
    <header className="app-header">
      <button
        className="mobile-menu-button icon-button"
        aria-label="Open navigation"
        onClick={onMenu}
      >
        <Menu size={19} />
      </button>
      <div className="header-breadcrumb">
        <LayoutGrid size={15} />
        <span>Workspace</span>
        <ChevronRight size={13} />
        <strong>{active}</strong>
      </div>
      <div className="header-actions">
        <div
          className={`dataset-search ${mobileSearch ? "mobile-search-open" : ""}`}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) {
              setOpen(false);
              setMobileSearch(false);
            }
          }}
        >
          <Search size={15} />
          <input
            ref={input}
            aria-label="Search datasets"
            role="combobox"
            aria-expanded={open}
            aria-controls="dataset-search-results"
            aria-autocomplete="list"
            placeholder="Search datasets..."
            value={search}
            onFocus={() => setOpen(true)}
            onChange={(event) => {
              setSearch(event.target.value);
              setOpen(true);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setOpen(false);
                setMobileSearch(false);
              }
              if (event.key === "Enter" && matches[0]) {
                onOpen(matches[0].id);
                setOpen(false);
                setSearch("");
              }
            }}
          />
          <kbd>⌘ K</kbd>
          {open && (
            <div
              className="search-results"
              id="dataset-search-results"
              role="listbox"
              aria-label="Matching datasets"
            >
              <span className="search-results-label">
                {search ? "Matching datasets" : "Available datasets"}
              </span>
              {matches.map((item) => (
                <button
                  role="option"
                  aria-selected={false}
                  key={item.id}
                  onClick={() => {
                    onOpen(item.id);
                    setOpen(false);
                    setSearch("");
                    setMobileSearch(false);
                  }}
                >
                  <span className="search-result-icon">
                    <Database size={15} />
                  </span>
                  <span>
                    <strong>{item.label}</strong>
                    <small>
                      {Intl.NumberFormat("en-US").format(item.size)} records ·{" "}
                      {item.kind}
                    </small>
                  </span>
                  <ArrowUpRight size={13} />
                </button>
              ))}
              {matches.length === 0 && <p>No matching datasets.</p>}
            </div>
          )}
        </div>
        <button
          className="mobile-search-button icon-button"
          aria-label="Open dataset search"
          onClick={() => {
            setMobileSearch((value) => !value);
            setTimeout(() => input.current?.focus(), 0);
          }}
        >
          <Search size={18} />
        </button>
        <button
          className="primary-button upload-dataset-button"
          aria-label="Import dataset"
          onClick={onUpload}
        >
          <Upload size={15} />
          <span className="upload-label-long">Upload dataset</span>
          <span className="upload-label-short">Upload</span>
        </button>
        <span className="header-divider" />
        <button
          className="notification-button icon-button"
          aria-label="Show dataset activity"
          title={`${activityCount} recent operations`}
          onClick={onActivity}
        >
          <Bell size={17} />
          {activityCount > 0 && <span />}
        </button>
        <button
          className="header-settings icon-button"
          aria-label="Open settings"
          onClick={onSettings}
          title="Workspace settings"
        >
          <Settings2 size={17} />
        </button>
      </div>
    </header>
  );
});
