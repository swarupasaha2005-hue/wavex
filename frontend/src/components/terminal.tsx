"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
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
  Waves,
  X,
} from "lucide-react";
import { CanvasEngine } from "@/lib/canvas-engine";
import { API_URL, Dataset, DatasetSize, PlaybackStats } from "@/lib/types";
import { Overview } from "./overview";
import { ImportPanel } from "./import-panel";

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
  const [library, setLibrary] = useState<Dataset[]>([]);
  const [column, setColumn] = useState("value");
  const refreshLibrary = useCallback(() => {
    void request<Dataset[]>("/datasets")
      .then((items) =>
        setLibrary(items.filter((item) => item.kind === "imported")),
      )
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
  const helpTrigger = useRef<HTMLButtonElement>(null);

  const loadDataset = useCallback(async (requestedSize: DatasetSize) => {
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
    } catch (caught) {
      if (sequence !== loadSequence.current) return;
      setGeneration(null);
      setError(
        caught instanceof TypeError
          ? "Cannot reach the data engine. Start the application with npm run dev, then retry."
          : (caught as Error).message,
      );
    }
  }, []);

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
        help
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
  }, [dataset, help]);

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

  return (
    <div className="app-shell">
      <header className="app-header">
        <a className="brand" href="/" aria-label="WaveX home">
          <span className="brand-mark">
            <Waves size={23} strokeWidth={2} />
          </span>
          <span>
            wave<span className="brand-x">x</span>
          </span>
        </a>
        <div className="header-divider" />
        <span className="workspace-label">Signal workspace</span>
        <div className="header-right">
          <span
            className={`connection-dot ${dataset && !streamError ? "connected" : ""}`}
          />
          <span>
            {dataset && !streamError
              ? "Data engine connected"
              : error
                ? "Engine offline"
                : "Connecting to engine"}
          </span>
          <span className="version">EXPLORER</span>
          <button
            className="help-button"
            ref={helpTrigger}
            aria-label="Open keyboard shortcuts"
            onClick={() => setHelp(true)}
          >
            ?
          </button>
        </div>
      </header>

      <main className="workspace">
        <section className="workspace-heading">
          <div>
            <div className="eyebrow">
              <span className="tiny-square" /> HISTORICAL DATA · REAL-TIME
              PLAYBACK
            </div>
            <h1>
              Signal explorer<span className="heading-dot">.</span>
            </h1>
            <p>Big datasets. One continuous view.</p>
          </div>
          <div className="dataset-picker">
            <button
              className="import-open"
              onClick={() => setShowImport((value) => !value)}
            >
              Import dataset <ArrowRight size={14} />
            </button>
            <label htmlFor="dataset-size">DATASET SIZE</label>
            <div className="dataset-picker-row">
              <div className="select-wrap dataset-select">
                <Database size={15} />
                <select
                  id="dataset-size"
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
                <ChevronDown size={13} />
              </div>
              <button
                className="load-button"
                onClick={() => void loadDataset(size)}
                disabled={generation !== null}
              >
                {generation !== null ? (
                  <LoaderCircle className="spin" size={15} />
                ) : (
                  <ArrowRight size={16} />
                )}
                <span>
                  {generation !== null
                    ? `Generating ${generation}%`
                    : "Load dataset"}
                </span>
              </button>
            </div>
          </div>
        </section>

        {showImport && (
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
            }}
          />
        )}
        {library.length > 0 && (
          <div className="library-row">
            <label>
              Imported datasets{" "}
              <select
                aria-label="Imported datasets"
                value={dataset?.kind === "imported" ? dataset.id : ""}
                onChange={(event) => {
                  if (event.target.value)
                    void request<Dataset>(`/datasets/${event.target.value}`)
                      .then((value) => {
                        setDataset(value);
                        setColumn(value.columns[0]);
                        setWindowSeconds(
                          Math.min(30, Math.max(1e-9, value.durationMs / 1000)),
                        );
                        setStats(null);
                      })
                      .catch((caught) => setError(caught.message));
                }}
              >
                <option value="">Choose a dataset</option>
                {library.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label} · {(item.sourceBytes! / 1e9).toFixed(2)} GB
                  </option>
                ))}
              </select>
            </label>
            {dataset && dataset.columns.length > 1 && (
              <label>
                Signal{" "}
                <select
                  aria-label="Signal column"
                  value={column}
                  onChange={(event) => {
                    setColumn(event.target.value);
                    engine.current?.setColumn(event.target.value);
                  }}
                >
                  {dataset.columns.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <span>Historical replay · drag graph to pan · scroll to zoom</span>
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
              <div className="current-value" aria-label="Current response time">
                {stats?.value != null ? stats.value.toFixed(2) : "—"}
                <span>{dataset?.unit}</span>
                <span className="readout-indicator">
                  <Activity size={14} />
                  {stats?.value != null && dataset
                    ? `${stats.value >= (dataset.columnStats?.[column]?.mean ?? dataset.mean) ? "+" : ""}${(stats.value - (dataset.columnStats?.[column]?.mean ?? dataset.mean)).toFixed(2)}`
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
                      WINDOWS.filter((value) => value < windowSeconds).at(-1) ??
                        WINDOWS[0],
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

          <div className="playback-toolbar">
            <div className="playback-buttons">
              <button
                className="restart-button"
                aria-label="Restart playback"
                title="Restart (R)"
                disabled={!dataset}
                onClick={() => engine.current?.restart()}
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
              <span className="utc-label">UTC</span>
            </div>
            <div className="speed-control">
              <Gauge size={15} />
              <label htmlFor="playback-speed">Playback speed</label>
              <div className="select-wrap">
                <select
                  id="playback-speed"
                  value={speed}
                  onChange={(event) => changeSpeed(Number(event.target.value))}
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
                {dataset ? (dataset.storageBytes / 1_000_000).toFixed(2) : "—"}{" "}
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
              HTTP range queries: {stats?.queryMs.toFixed(1) ?? "—"} ms · LOD ×
              {stats?.lod ?? 1}. FPS is measured from animation frames in this
              tab. Draw time measures CPU submission time for WebGL and axes;
              GPU completion is reflected by frame cadence. Buffer figures
              count cached sample arrays; they exclude the browser, transport, and
              canvas memory.
            </p>
          </div>
        )}
        <footer className="workspace-footer">
          <span>Built for the signal, at any scale.</span>
          <span>
            <kbd>SPACE</kbd> play / pause <span className="footer-separator" />
            <kbd>←</kbd>
            <kbd>→</kbd> seek 10s <span className="footer-separator" />
            <kbd>R</kbd> restart
          </span>
        </footer>
      </main>

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
    </div>
  );
}
