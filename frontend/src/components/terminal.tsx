"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  Download,
  ArrowDownToLine,
  ChevronDown,
  Database,
  Gauge,
  LoaderCircle,
  Maximize2,
  Minus,
  Pause,
  Play,
  Plus,
  RotateCcw,
  X,
} from "lucide-react";
import { CanvasEngine } from "@/lib/canvas-engine";
import { API_URL, Dataset, DatasetSize, PlaybackStats } from "@/lib/types";
import { Overview } from "./overview";
import { ImportPanel } from "./import-panel";
import {
  DashboardHeader,
  DashboardNavigation,
  type DashboardSection,
} from "./dashboard-chrome";
import {
  SummaryCards,
  AnalyticsPanels,
  formatBytes,
  type DatasetActivity,
} from "./analytics-panels";
import { WorkspaceDialog } from "./workspace-dialog";

const SIZES: DatasetSize[] = [10_000, 100_000, 1_000_000, 10_000_000];
const WINDOWS = [
  1e-9, 1e-6, 0.001, 0.01, 0.1, 1, 10, 30, 60, 120, 300, 900, 3600, 21600,
  86400,
];
const windowLabel = (value: number) =>
  value < 1e-6
    ? `${(value * 1e9).toPrecision(3)} ns`
    : value < 0.001
      ? `${(value * 1e6).toPrecision(3)} µs`
      : value < 1
        ? `${value * 1000} ms`
        : value < 60
          ? `${value} seconds`
          : value < 3600
            ? `${value / 60} minutes`
            : `${value / 3600} hours`;
const number = new Intl.NumberFormat("en-US");
const formatReadout = (value: number) =>
  value !== 0 && (Math.abs(value) >= 1e6 || Math.abs(value) < 0.001)
    ? value.toExponential(3)
    : value.toFixed(2);
const formatTime = (timestamp: number) =>
  new Date(timestamp).toISOString().slice(11, 19);
const formatDuration = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 3600)
    .toString()
    .padStart(2, "0")}:${Math.floor((seconds / 60) % 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
};
const SIZE_LABELS: Record<DatasetSize, string> = {
  10000: "10 thousand",
  100000: "100 thousand",
  1000000: "1 million",
  10000000: "10 million",
};
const STATUS_LABELS = {
  connecting: "Connecting",
  reconnecting: "Reconnecting",
  buffering: "Buffering",
  playing: "Playing",
  paused: "Paused",
  ended: "Completed",
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new Error(
      `Data engine returned ${response.status}. Retry the request or check the backend logs.`,
    );
  return response.json();
}

export default function Terminal() {
  const [showImport, setShowImport] = useState(false);
  const [catalog, setCatalog] = useState<Dataset[]>([]);
  const library = catalog.filter((item) => item.kind === "imported");
  const [activeSection, setActiveSection] =
    useState<DashboardSection>("Overview");
  const [mobileNav, setMobileNav] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [liveOpen, setLiveOpen] = useState(false);
  const [activity, setActivity] = useState<DatasetActivity[]>([]);
  const activitySequence = useRef(0);
  const recordActivity = useCallback(
    (
      title: string,
      description: string,
      kind: DatasetActivity["kind"] = "open",
    ) => {
      const item = {
        id: ++activitySequence.current,
        title,
        description,
        kind,
        at: Date.now(),
      };
      setActivity((previous) => [item, ...previous].slice(0, 4));
    },
    [],
  );
  const [column, setColumn] = useState("value");
  const refreshLibrary = useCallback(() => {
    void request<Dataset[]>("/datasets")
      .then((items) => setCatalog(items))
      .catch(() => {});
  }, []);
  const [size, setSize] = useState<DatasetSize>(1_000_000);
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [stats, setStats] = useState<PlaybackStats | null>(null);
  const [speed, setSpeed] = useState(1);
  const [windowSeconds, setWindowSeconds] = useState(30);
  const [generation, setGeneration] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [help, setHelp] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const panel = useRef<HTMLElement>(null);
  const engine = useRef<CanvasEngine | null>(null);
  const loadSequence = useRef(0);
  const helpDialog = useRef<HTMLElement>(null);
  const helpTrigger = useRef<HTMLElement>(null);

  const loadDataset = useCallback(
    async (requestedSize: DatasetSize) => {
      const sequence = ++loadSequence.current;
      setError(null);
      setGeneration(0);
      try {
        const job = await request<{ id: string; status: string }>("/datasets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ size: requestedSize, seed: 42 }),
        });
        let state = job.status;
        while (state !== "ready") {
          await new Promise((resolve) => setTimeout(resolve, 250));
          if (sequence !== loadSequence.current) return;
          const result = await request<{
            status: string;
            progress: number;
            error?: string;
          }>(`/datasets/${job.id}/status`);
          if (sequence !== loadSequence.current) return;
          if (result.status === "error") throw new Error(result.error);
          state = result.status;
          setGeneration(Math.round(result.progress * 100));
        }
        const result = await request<Dataset>(`/datasets/${job.id}`);
        if (sequence !== loadSequence.current) return;
        setStats(null);
        setDataset(result);
        setColumn(result.columns[0]);
        setGeneration(null);
        refreshLibrary();
        recordActivity(
          "Dataset opened",
          `${result.label} · ${number.format(result.size)} records`,
        );
      } catch (caught) {
        if (sequence !== loadSequence.current) return;
        setGeneration(null);
        setError(
          caught instanceof TypeError
            ? "Cannot reach the data engine. Start the application with npm run dev, then retry."
            : (caught as Error).message,
        );
      }
    },
    [recordActivity, refreshLibrary],
  );

  useEffect(() => {
    void loadDataset(1_000_000);
    refreshLibrary();
    return () => {
      ++loadSequence.current;
    };
  }, [loadDataset]);

  useEffect(() => {
    if (!help) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setHelp(false);
      // The dialog has one interactive control, so keep Tab on its close button.
      if (event.key === "Tab") {
        event.preventDefault();
        helpDialog.current?.querySelector("button")?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      helpTrigger.current?.focus();
    };
  }, [help]);

  useEffect(() => {
    if (!dataset || !canvas.current) return;
    let active = true;
    try {
      engine.current = new CanvasEngine(
        canvas.current,
        dataset,
        (value) => {
          if (active) setStats(value);
        },
        (value) => {
          if (active) setStreamError(value);
        },
        (seconds) => setWindowSeconds(seconds),
      );
      engine.current.setColumn(column);
      engine.current.setSpeed(speed);
      engine.current.setWindow(windowSeconds);
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches)
        engine.current.setPlaying(false);
    } catch (caught) {
      setError((caught as Error).message);
    }
    return () => {
      active = false;
      engine.current?.dispose();
      engine.current = null;
    };
    // Controls apply directly to the engine; only dataset changes replace it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        ["INPUT", "SELECT", "BUTTON", "TEXTAREA"].includes(target.tagName) ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        help ||
        settingsOpen ||
        liveOpen
      )
        return;
      if (event.code === "Space") {
        event.preventDefault();
        if (engine.current) engine.current.setPlaying(!engine.current.playing);
      }
      if (event.key.toLowerCase() === "r") engine.current?.restart();
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault();
        if (engine.current && dataset)
          engine.current.seek(
            engine.current.position +
              ((event.key === "ArrowRight" ? 1 : -1) * 10_000) /
                dataset.intervalMs,
          );
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dataset, help, settingsOpen, liveOpen]);

  const changeSpeed = (value: number) => {
    setSpeed(value);
    engine.current?.setSpeed(value);
  };
  const changeWindow = (value: number) => {
    setWindowSeconds(value);
    engine.current?.setWindow(value);
  };
  const status = stats?.status ?? "connecting";
  const playing = stats?.isPlaying ?? false;
  const position = stats?.position ?? 0;
  const progress = dataset ? (position / (dataset.size - 1)) * 100 : 0;
  const exportView = () => {
    if (!canvas.current) return;
    const link = document.createElement("a");
    link.download = `wavex-${dataset?.id}-${Math.floor(position)}.png`;
    link.href =
      engine.current?.snapshot() ?? canvas.current.toDataURL("image/png");
    link.click();
  };

  const openDataset = useCallback(
    async (id: string) => {
      setError(null);
      try {
        const value = await request<Dataset>(`/datasets/${id}`);
        setDataset(value);
        setColumn(value.columns[0]);
        setStats(null);
        if (value.kind === "imported")
          setWindowSeconds(
            Math.min(30, Math.max(1e-9, value.durationMs / 1000)),
          );
        setMobileNav(false);
        recordActivity(
          "Dataset opened",
          `${value.label} · ${number.format(value.size)} records`,
        );
      } catch (caught) {
        setError((caught as Error).message);
      }
    },
    [recordActivity],
  );
  const navigate = useCallback((section: DashboardSection) => {
    setMobileNav(false);
    if (section === "Settings") {
      setSettingsOpen(true);
      return;
    }
    if (section === "Live Visualization") {
      setLiveOpen(true);
      return;
    }
    setActiveSection(section);
    const targets: Partial<Record<DashboardSection, string>> = {
      Overview: "workspace-start",
      Datasets: "dataset-controls",
      "Historical Playback": "playback-controls",
      Analytics: "analytics",
      Performance: "performance",
    };
    document
      .getElementById(targets[section] ?? "workspace-start")
      ?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
        block: "start",
      });
  }, []);
  const openHelp = useCallback(() => {
    helpTrigger.current = document.activeElement as HTMLElement;
    setSettingsOpen(false);
    setLiveOpen(false);
    setHelp(true);
  }, []);
  const toggleImport = useCallback(() => {
    setShowImport((value) => !value);
    if (!showImport)
      setTimeout(
        () =>
          document.getElementById("import-panel-anchor")?.scrollIntoView({
            behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
              .matches
              ? "instant"
              : "smooth",
            block: "start",
          }),
        0,
      );
  }, [showImport]);
  const closeNavigation = useCallback(() => setMobileNav(false), []);
  const toggleNavigation = useCallback(
    () => setMobileNav((value) => !value),
    [],
  );
  const openSettings = useCallback(() => navigate("Settings"), [navigate]);
  const showActivity = useCallback(() => {
    document.getElementById("dataset-activity")?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
      block: "center",
    });
  }, []);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileNav(false);
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, []);

  return (
    <div className="app-shell">
      <DashboardNavigation
        active={
          settingsOpen
            ? "Settings"
            : liveOpen
              ? "Live Visualization"
              : activeSection
        }
        catalog={catalog}
        onNavigate={navigate}
        onOpen={openDataset}
        onHelp={openHelp}
        mobileOpen={mobileNav}
        onClose={closeNavigation}
      />
      <div className="dashboard-body">
        <DashboardHeader
          active={activeSection}
          catalog={catalog}
          onOpen={openDataset}
          onUpload={toggleImport}
          onSettings={openSettings}
          onActivity={showActivity}
          onMenu={toggleNavigation}
          activityCount={activity.length}
        />
        <main className="workspace" id="workspace-start">
          <section className="workspace-heading">
            <div>
              <p className="page-eyebrow">Your workspace, at a glance</p>
              <h1>Workspace overview</h1>
              <p>Explore your signals. Stay close to your data.</p>
            </div>
            <div className="heading-actions">
              <span
                className={`engine-connection ${dataset && !streamError && !error ? "connected" : ""}`}
              >
                <span />
                {dataset && !streamError && !error
                  ? "Data engine connected"
                  : error
                    ? "Engine offline"
                    : "Connecting to engine"}
              </span>
              <button
                className="secondary-button"
                disabled={!dataset}
                onClick={exportView}
              >
                <Download size={14} />
                Export view
              </button>
            </div>
          </section>
          <nav className="workspace-tabs" aria-label="Dashboard sections">
            <button
              className={activeSection === "Overview" ? "selected" : ""}
              onClick={() => navigate("Overview")}
            >
              Overview
            </button>
            <button
              className={activeSection === "Datasets" ? "selected" : ""}
              onClick={() => navigate("Datasets")}
            >
              Data library <span>{catalog.length || "—"}</span>
            </button>
            <button
              className={activeSection === "Performance" ? "selected" : ""}
              onClick={() => navigate("Performance")}
            >
              Performance
            </button>
            <span className="workspace-context">
              <span />
              Historical workspace
            </span>
          </nav>
          <SummaryCards dataset={dataset} stats={stats} />
          <section
            className="dataset-controls"
            id="dataset-controls"
            aria-label="Dataset controls"
          >
            <div className="dataset-control-heading">
              <span className="source-icon">
                <Database size={16} />
              </span>
              <div>
                <strong>Data source</strong>
                <span>
                  {dataset?.kind === "imported"
                    ? "Imported dataset"
                    : "Synthetic telemetry"}
                </span>
              </div>
            </div>
            {library.length > 0 && (
              <div className="source-field imported-source-field">
                <label htmlFor="imported-datasets">Imported datasets</label>
                <div className="select-wrap">
                  <select
                    id="imported-datasets"
                    aria-label="Imported datasets"
                    value={dataset?.kind === "imported" ? dataset.id : ""}
                    onChange={(event) => {
                      if (event.target.value)
                        void openDataset(event.target.value);
                    }}
                  >
                    <option value="">Choose a dataset</option>
                    {library.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label} ·{" "}
                        {formatBytes(item.sourceBytes ?? item.storageBytes)}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={12} />
                </div>
              </div>
            )}
            <div className="source-field">
              <label htmlFor="dataset-size">Synthetic dataset</label>
              <div className="select-wrap">
                <select
                  id="dataset-size"
                  aria-label="DATASET SIZE"
                  value={size}
                  disabled={generation !== null}
                  onChange={(event) =>
                    setSize(Number(event.target.value) as DatasetSize)
                  }
                >
                  {SIZES.map((value) => (
                    <option key={value} value={value}>
                      {SIZE_LABELS[value]} points
                    </option>
                  ))}
                </select>
                <ChevronDown size={12} />
              </div>
            </div>
            <button
              className="load-button"
              disabled={generation !== null}
              onClick={() => void loadDataset(size)}
            >
              {generation !== null ? (
                <LoaderCircle className="spin" size={14} />
              ) : (
                <RotateCcw size={13} />
              )}
              <span>
                {generation !== null
                  ? `Generating ${generation}%`
                  : "Load dataset"}
              </span>
            </button>
            {dataset && dataset.columns.length > 1 && (
              <div className="source-field signal-source-field">
                <label htmlFor="signal-column">Signal column</label>
                <div className="select-wrap">
                  <select
                    id="signal-column"
                    aria-label="Signal column"
                    value={column}
                    onChange={(event) => {
                      setColumn(event.target.value);
                      engine.current?.setColumn(event.target.value);
                    }}
                  >
                    {dataset.columns.map((name) => (
                      <option value={name} key={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={12} />
                </div>
              </div>
            )}
            <span className="dataset-controls-note">
              <span className="metric-dot blue" />
              Stored data · replay mode
            </span>
          </section>
          {showImport && (
            <div id="import-panel-anchor">
              <ImportPanel
                onClose={() => setShowImport(false)}
                onLibraryChanged={refreshLibrary}
                onReady={(value) => {
                  setDataset(value);
                  setColumn(value.columns[0]);
                  setWindowSeconds(
                    Math.min(30, Math.max(1e-9, value.durationMs / 1000)),
                  );
                  setStats(null);
                  setShowImport(false);
                  recordActivity(
                    "Dataset imported",
                    `${value.label} · ${number.format(value.size)} records`,
                    "import",
                  );
                }}
              />
            </div>
          )}
          {error && (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <button onClick={() => void loadDataset(size)}>
                Retry <RotateCcw size={13} />
              </button>
            </div>
          )}
          {streamError && (
            <div className="error-banner" role="status">
              {streamError}
            </div>
          )}
          <section
            className={`graph-panel ${expanded ? "expanded" : ""}`}
            ref={panel}
            aria-label="Telemetry visualization"
          >
            <div className="graph-toolbar">
              <div className="signal-title">
                <span className="signal-icon">
                  <Activity size={16} />
                </span>
                <h2>{dataset?.label ?? "System telemetry"}</h2>
                <span className="signal-tag">
                  {dataset?.kind === "imported"
                    ? "IMPORTED · REPLAY"
                    : "SYNTHETIC · REPLAY"}
                </span>
              </div>
              <div className="chart-actions">
                <span className={`playback-state ${status}`}>
                  <span />
                  {dataset
                    ? STATUS_LABELS[status]
                    : generation !== null
                      ? "Preparing dataset"
                      : "No dataset"}
                </span>
                <span className="toolbar-divider" />
                <button
                  className="icon-button"
                  aria-label="Save graph as PNG"
                  title="Save graph as PNG"
                  disabled={!dataset}
                  onClick={exportView}
                >
                  <ArrowDownToLine size={16} />
                </button>
                <button
                  className="icon-button"
                  aria-label={expanded ? "Exit expanded view" : "Expand graph"}
                  title="Expand graph"
                  onClick={() => setExpanded((value) => !value)}
                >
                  {expanded ? <X size={16} /> : <Maximize2 size={16} />}
                </button>
              </div>
            </div>

            <div className="graph-readout">
              <div>
                <span className="readout-label">
                  {dataset?.kind === "imported"
                    ? column.toUpperCase()
                    : "RESPONSE TIME"}
                </span>
                <div
                  className="current-value"
                  aria-label="Current response time"
                >
                  {stats?.value != null ? formatReadout(stats.value) : "—"}
                  <span title={dataset?.unit}>{dataset?.unit}</span>
                  <span className="readout-indicator">
                    <Activity size={14} />
                    {stats?.value != null && dataset
                      ? `${stats.value >= (dataset.columnStats?.[column]?.mean ?? dataset.mean) ? "+" : ""}${formatReadout(stats.value - (dataset.columnStats?.[column]?.mean ?? dataset.mean))}`
                      : "—"}
                    <span>vs. mean</span>
                  </span>
                </div>
              </div>
              <div className="window-control">
                <span>Visible window</span>
                <div className="zoom-group">
                  <button
                    aria-label="Zoom in"
                    title="Show a shorter time window"
                    disabled={windowSeconds <= WINDOWS[0]}
                    onClick={() =>
                      changeWindow(
                        WINDOWS.filter((value) => value < windowSeconds).at(
                          -1,
                        ) ?? WINDOWS[0],
                      )
                    }
                  >
                    <Plus size={13} />
                  </button>
                  <div className="select-wrap">
                    <select
                      aria-label="Visible time window"
                      value={windowSeconds}
                      onChange={(event) =>
                        changeWindow(Number(event.target.value))
                      }
                    >
                      {(WINDOWS.includes(windowSeconds)
                        ? WINDOWS
                        : [...WINDOWS, windowSeconds].sort((a, b) => a - b)
                      ).map((value) => (
                        <option key={value} value={value}>
                          {windowLabel(value)}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={11} />
                  </div>
                  <button
                    aria-label="Zoom out"
                    title="Show a longer time window"
                    disabled={windowSeconds >= 31536000}
                    onClick={() =>
                      changeWindow(
                        WINDOWS.find((value) => value > windowSeconds) ??
                          Math.min(31536000, windowSeconds * 2),
                      )
                    }
                  >
                    <Minus size={13} />
                  </button>
                </div>
              </div>
            </div>

            <div className="chart-container">
              <canvas
                ref={canvas}
                className="main-canvas"
                aria-label="Moving response time graph. Use the playback controls and dataset position slider to explore timestamped data."
                role="img"
              />
              {!dataset && (
                <div className="chart-empty">
                  <span className="empty-signal">
                    <Activity size={30} />
                  </span>
                  <h3>
                    {generation !== null
                      ? "Preparing your signal"
                      : "Connect to your data"}
                  </h3>
                  <p>
                    {generation !== null
                      ? "Generating timestamped telemetry and preparing the first window."
                      : "Load a dataset to begin exploring."}
                  </p>
                  {generation !== null && (
                    <div className="generation-track">
                      <div style={{ width: `${Math.max(3, generation)}%` }} />
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="chart-caption">
              <span>
                <i /> {dataset?.kind === "imported" ? column : "Response time"}{" "}
                <span className="caption-secondary">
                  ·{" "}
                  {dataset?.kind === "imported"
                    ? "recorded timestamps"
                    : "100 samples / sec"}
                </span>
                {stats && (
                  <time
                    className="chart-current-timestamp"
                    aria-label="Current timestamp"
                    dateTime={new Date(stats.timestamp).toISOString()}
                    title={new Date(stats.timestamp).toISOString()}
                  >
                    {formatTime(stats.timestamp)} UTC
                  </time>
                )}
              </span>
              <span className="caption-secondary">
                {stats ? number.format(stats.visiblePoints) : "—"} displayed
                points <span className="caption-separator">/</span>{" "}
                {dataset ? number.format(dataset.size) : "—"} total
              </span>
            </div>

            <div className="timeline-section">
              <div className="timeline-heading">
                <span>
                  DATASET TIMELINE{" "}
                  <span className="timeline-hint">Drag to explore</span>
                </span>
                <span>
                  {progress.toFixed(2)}
                  <span className="muted">% explored</span>
                </span>
              </div>
              {dataset ? (
                <Overview
                  dataset={dataset}
                  column={column}
                  position={position}
                  windowSeconds={windowSeconds}
                  onSeek={(value) => engine.current?.seek(value)}
                />
              ) : (
                <div className="overview-placeholder" />
              )}
              <div className="timeline-labels">
                <span>
                  {dataset ? formatTime(dataset.startTime) : "00:00:00"}
                </span>
                <span>
                  {dataset
                    ? `${formatDuration((dataset.size - 1) * dataset.intervalMs)} duration`
                    : "—"}
                </span>
                <span>
                  {dataset
                    ? formatTime(
                        dataset.startTime +
                          (dataset.size - 1) * dataset.intervalMs,
                      )
                    : "—"}
                </span>
              </div>
            </div>

            <div className="playback-toolbar" id="playback-controls">
              <div className="playback-buttons">
                <button
                  className="restart-button"
                  aria-label="Restart playback"
                  title="Restart (R)"
                  disabled={!dataset}
                  onClick={() => {
                    engine.current?.restart();
                    if (dataset)
                      recordActivity(
                        "Playback restarted",
                        dataset.label,
                        "playback",
                      );
                  }}
                >
                  <RotateCcw size={16} />
                  <span>Restart</span>
                </button>
                <div className="play-pause-group">
                  <button
                    className="play-button"
                    disabled={!dataset || playing}
                    onClick={() => {
                      if (engine.current && status === "ended")
                        engine.current.restart();
                      else engine.current?.setPlaying(true);
                    }}
                  >
                    <Play size={14} fill="currentColor" />
                    <span>Play</span>
                  </button>
                  <button
                    className="pause-button"
                    disabled={!dataset || !playing}
                    onClick={() => engine.current?.setPlaying(false)}
                  >
                    <Pause size={14} fill="currentColor" />
                    <span>Pause</span>
                  </button>
                </div>
              </div>
              <div className="playback-time">
                <span>
                  {dataset
                    ? formatDuration(position * dataset.intervalMs)
                    : "00:00:00"}
                </span>
                <span className="muted">
                  {" "}
                  /{" "}
                  {dataset
                    ? formatDuration((dataset.size - 1) * dataset.intervalMs)
                    : "00:00:00"}
                </span>
                <span className="utc-label">elapsed</span>
              </div>
              <div className="speed-control">
                <Gauge size={15} />
                <label htmlFor="playback-speed">Playback speed</label>
                <div className="select-wrap">
                  <select
                    id="playback-speed"
                    value={speed}
                    onChange={(event) =>
                      changeSpeed(Number(event.target.value))
                    }
                  >
                    {[0.25, 0.5, 1, 2, 4, 8, 16, 32].map((value) => (
                      <option value={value} key={value}>
                        {value}×
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={12} />
                </div>
              </div>
            </div>
          </section>

          <section className="engine-footer" aria-label="Rendering performance">
            <div className="engine-status">
              <span className="status-led" />
              <span>WebGL</span>
              <span className="footer-separator" />
              <span className="performance-value" data-testid="fps">
                {stats?.fps ?? "—"}
              </span>
              <span>FPS</span>
              <span className="footer-separator" />
              <span className="performance-value" data-testid="frame-ms">
                {stats?.frameMs.toFixed(2) ?? "—"}
              </span>
              <span>ms / draw</span>
            </div>
            <div className="buffer-status">
              <span>
                {stats ? `${(stats.bufferBytes / 1024).toFixed(0)} KB` : "—"}{" "}
                buffered
              </span>
              <button
                className={`details-button ${details ? "active" : ""}`}
                aria-expanded={details}
                aria-controls="engine-details"
                onClick={() => setDetails((value) => !value)}
              >
                Engine details <ChevronDown size={12} />
              </button>
            </div>
          </section>
          {details && (
            <div id="engine-details" className="engine-details">
              <div>
                <span>Samples buffered</span>
                <strong data-testid="buffered-points">
                  {number.format(stats?.bufferedPoints ?? 0)} / 24,576 max
                </strong>
              </div>
              <div>
                <span>Path samples</span>
                <strong>{number.format(stats?.renderedPoints ?? 0)}</strong>
              </div>
              <div>
                <span>Data transferred</span>
                <strong>
                  {((stats?.receivedBytes ?? 0) / 1024).toFixed(0)} KB
                </strong>
              </div>
              <div>
                <span>
                  {dataset?.kind === "imported"
                    ? "Import time"
                    : "Generation time"}
                </span>
                <strong>{dataset?.generationSeconds ?? "—"} s</strong>
              </div>
              <div>
                <span>Dataset on disk</span>
                <strong>
                  {dataset
                    ? (dataset.storageBytes / 1_000_000).toFixed(2)
                    : "—"}{" "}
                  MB
                </strong>
              </div>
              <div>
                <span>
                  {dataset?.kind === "imported"
                    ? "Mean sample interval"
                    : "Sample interval"}
                </span>
                <strong>
                  {dataset ? Number(dataset.intervalMs.toPrecision(5)) : "—"} ms
                </strong>
              </div>
              <p>
                HTTP range queries: {stats?.queryMs.toFixed(1) ?? "—"} ms · LOD
                ×{stats?.lod ?? 1}. FPS is measured from animation frames in
                this tab. Draw time measures CPU submission time for WebGL and
                axes; GPU completion is reflected by frame cadence. Buffer
                figures count cached sample arrays; they exclude the browser,
                transport, and canvas memory.
              </p>
            </div>
          )}
          <AnalyticsPanels
            dataset={dataset}
            stats={stats}
            column={column}
            activity={activity}
            onDetails={() => {
              setDetails(true);
              setTimeout(
                () =>
                  document.getElementById("engine-details")?.scrollIntoView({
                    behavior: window.matchMedia(
                      "(prefers-reduced-motion: reduce)",
                    ).matches
                      ? "instant"
                      : "smooth",
                    block: "center",
                  }),
                0,
              );
            }}
          />
          <footer className="workspace-footer">
            <span>
              <span className="footer-brand">
                wave<span>x</span>
              </span>{" "}
              A clearer view of your data.
            </span>
            <span>
              <kbd>SPACE</kbd>play / pause
              <span className="footer-separator" />
              <kbd>←</kbd>
              <kbd>→</kbd>seek 10s
              <span className="footer-separator" />
              <kbd>R</kbd>restart
            </span>
          </footer>
        </main>
      </div>
      {help && (
        <div className="modal-backdrop" onClick={() => setHelp(false)}>
          <section
            className="help-modal"
            ref={helpDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="shortcuts-title"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape") setHelp(false);
            }}
          >
            <div>
              <h2 id="shortcuts-title">Keyboard shortcuts</h2>
              <button
                className="icon-button"
                autoFocus
                aria-label="Close keyboard shortcuts"
                onClick={() => setHelp(false)}
              >
                <X size={18} />
              </button>
            </div>
            <p>
              <span>Play or pause</span>
              <kbd>SPACE</kbd>
            </p>
            <p>
              <span>Seek 10 seconds</span>
              <span>
                <kbd>←</kbd> <kbd>→</kbd>
              </span>
            </p>
            <p>
              <span>Restart playback</span>
              <kbd>R</kbd>
            </p>
            <p className="help-note">
              Hover over the graph to inspect a sample. Drag the dataset
              timeline to jump to any point. All timestamps use UTC.
            </p>
          </section>
        </div>
      )}
      {settingsOpen && (
        <WorkspaceDialog
          title="Workspace settings"
          description="Adjust the controls for your current visualization."
          onClose={() => setSettingsOpen(false)}
        >
          <div className="settings-field">
            <div>
              <strong>Playback speed</strong>
              <p>How quickly recorded timestamps progress.</p>
            </div>
            <div className="select-wrap">
              <select
                aria-label="Settings playback speed"
                value={speed}
                onChange={(event) => changeSpeed(Number(event.target.value))}
              >
                {[0.25, 0.5, 1, 2, 4, 8, 16, 32].map((value) => (
                  <option key={value} value={value}>
                    {value}×
                  </option>
                ))}
              </select>
              <ChevronDown size={12} />
            </div>
          </div>
          <div className="settings-field">
            <div>
              <strong>Visible window</strong>
              <p>The amount of time shown in the graph.</p>
            </div>
            <div className="select-wrap">
              <select
                aria-label="Settings time window"
                value={windowSeconds}
                onChange={(event) => changeWindow(Number(event.target.value))}
              >
                {(WINDOWS.includes(windowSeconds)
                  ? WINDOWS
                  : [...WINDOWS, windowSeconds].sort((a, b) => a - b)
                ).map((value) => (
                  <option key={value} value={value}>
                    {windowLabel(value)}
                  </option>
                ))}
              </select>
              <ChevronDown size={12} />
            </div>
          </div>
          <div className="settings-information">
            <span>Appearance</span>
            <strong>
              <span className="theme-swatch" />
              Light
            </strong>
          </div>
          <div className="settings-information">
            <span>Timestamp timezone</span>
            <strong>UTC</strong>
          </div>
          <div className="settings-engine">
            <span className="metric-dot blue" />
            <div>
              <strong>Data engine</strong>
              <code>{API_URL}</code>
            </div>
          </div>
        </WorkspaceDialog>
      )}
      {liveOpen && (
        <WorkspaceDialog
          title="Live data connections"
          description="Live event delivery is separate from historical playback."
          onClose={() => setLiveOpen(false)}
        >
          <div className="live-connection-note">
            <span className="signal-icon">
              <Activity size={20} />
            </span>
            <div>
              <strong>Historical replay is selected</strong>
              <p>
                The graph explores your stored datasets. Genuine live
                observations are delivered through the data engine’s dedicated
                endpoints.
              </p>
            </div>
          </div>
          <div className="endpoint-field">
            <span>Publish source observations</span>
            <code>POST {API_URL}/live/your-stream/publish</code>
          </div>
          <div className="endpoint-field">
            <span>Subscribe to live events</span>
            <code>{API_URL.replace(/^http/, "ws")}/ws/live/your-stream</code>
          </div>
          <p className="dialog-note">
            These endpoints accept and deliver actual source events. The
            historical graph keeps its current dataset and playback position.
          </p>
        </WorkspaceDialog>
      )}
    </div>
  );
}
