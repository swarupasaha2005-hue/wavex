"use client";
import { memo, useEffect, useState } from "react";

import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Clock3,
  Database,
  FileCheck2,
  Gauge,
  HardDrive,
  Layers3,
  Radio,
  Timer,
  Upload,
} from "lucide-react";
import type { Dataset, PlaybackStats } from "@/lib/types";
import { MAX_TILES } from "@/lib/range-cache";

export type DatasetActivity = {
  id: number;
  title: string;
  description: string;
  at: number;
  kind: "open" | "import" | "playback";
};
export const formatBytes = (value: number) => {
  if (value < 1000) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = value / 1000,
    i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return `${n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)} ${units[i]}`;
};
const compact = (value: number) =>
  Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
const metric = (value: number | undefined) =>
  value === undefined
    ? "—"
    : value !== 0 && (Math.abs(value) >= 1e6 || Math.abs(value) < 0.001)
      ? value.toExponential(2)
      : Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
const duration = (ms: number) => {
  const secs = Math.floor(ms / 1000);
  return secs >= 3600
    ? `${Math.floor(secs / 3600)}h ${Math.floor((secs / 60) % 60)}m`
    : secs >= 60
      ? `${Math.floor(secs / 60)}m ${secs % 60}s`
      : `${(ms / 1000).toFixed(ms < 1000 ? 3 : 0)}s`;
};
const utcDate = (ms: number) =>
  Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(ms);

const DatasetSummary = memo(function DatasetSummary({
  dataset,
}: {
  dataset: Dataset | null;
}) {
  return (
    <>
      {" "}
      <article className="summary-card summary-highlight">
        <div className="summary-label">
          Total records
          <span className="summary-icon yellow">
            <Database size={15} />
          </span>
        </div>
        <div className="summary-value">
          {dataset ? compact(dataset.size) : "—"}
          <span>records</span>
        </div>
        <div className="summary-foot">
          <span className="metric-dot" />
          {dataset
            ? `${dataset.size.toLocaleString("en-US")} timestamped observations`
            : "Preparing your dataset"}
        </div>
      </article>
      <article className="summary-card">
        <div className="summary-label">
          Storage footprint
          <span className="summary-icon blue">
            <HardDrive size={15} />
          </span>
        </div>
        <div className="summary-value">
          {dataset ? formatBytes(dataset.storageBytes) : "—"}
        </div>
        <div className="summary-foot">
          <Layers3 size={12} />
          {dataset
            ? `${dataset.columns.length} signal column${dataset.columns.length !== 1 ? "s" : ""} · ${dataset.kind === "imported" ? "Parquet storage" : "Generated telemetry"}`
            : "Waiting for metadata"}
        </div>
      </article>
      <article className="summary-card">
        <div className="summary-label">
          Time coverage
          <span className="summary-icon neutral">
            <Clock3 size={15} />
          </span>
        </div>
        <div className="summary-value">
          {dataset ? duration(dataset.durationMs) : "—"}
        </div>
        <div className="summary-foot">
          <span className="metric-dot blue" />
          {dataset ? `${utcDate(dataset.startTime)} · UTC` : "Timestamp range"}
        </div>
      </article>
    </>
  );
});
export function SummaryCards({
  dataset,
  stats,
}: {
  dataset: Dataset | null;
  stats: PlaybackStats | null;
}) {
  return (
    <section className="summary-grid" aria-label="Dataset overview">
      <DatasetSummary dataset={dataset} />{" "}
      <article className="summary-card">
        <div className="summary-label">
          Rendering performance
          <span className="summary-icon blue">
            <Gauge size={15} />
          </span>
        </div>
        <div className="summary-value">
          {stats?.fps ?? "—"}
          <span>FPS</span>
          <span className="metric-tag">WebGL</span>
        </div>
        <div className="summary-foot">
          <Timer size={12} />
          {stats
            ? `${stats.frameMs.toFixed(2)} ms CPU draw time`
            : "Measuring frame cadence"}
        </div>
      </article>
    </section>
  );
}

const SignalStatistics = memo(function SignalStatistics({
  dataset,
  column,
}: {
  dataset: Dataset | null;
  column: string;
}) {
  const values = dataset?.columnStats?.[column] ?? dataset;
  const average =
    values && values.max !== values.min
      ? ((values.mean - values.min) / (values.max - values.min)) * 100
      : 50;
  return (
    <article className="analytics-card statistics-card">
      <div className="card-heading">
        <h2>Signal statistics</h2>
        <span className="subtle-tag">{column}</span>
      </div>
      <p className="card-description">A closer look at the selected dataset.</p>
      <div className="statistics-values">
        <div>
          <span>
            <ArrowDown size={11} />
            Minimum
          </span>
          <strong>{metric(values?.min)}</strong>
          <small>{dataset?.unit || "value"}</small>
        </div>
        <div className="average-stat">
          <span>Average</span>
          <strong>{metric(values?.mean)}</strong>
          <small>{dataset?.unit || "value"}</small>
        </div>
        <div>
          <span>
            <ArrowUp size={11} />
            Maximum
          </span>
          <strong>{metric(values?.max)}</strong>
          <small>{dataset?.unit || "value"}</small>
        </div>
      </div>
      <div
        className="statistics-range"
        role="img"
        aria-label="Mean position within the dataset value range"
      >
        {values && (
          <span style={{ left: `${Math.min(100, Math.max(0, average))}%` }} />
        )}
      </div>
      <div className="card-bottom-note">
        <span>Across the complete dataset</span>
        <span>
          Range{" "}
          <strong>{values ? metric(values.max - values.min) : "—"}</strong>
        </span>
      </div>
    </article>
  );
});
const SessionActivity = memo(function SessionActivity({
  activity,
}: {
  activity: DatasetActivity[];
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  return (
    <article className="analytics-card activity-card" id="dataset-activity">
      <div className="card-heading">
        <h2>Dataset activity</h2>
        <span className="activity-count">{activity.length}</span>
      </div>
      <p className="card-description">Operations from this session.</p>
      <div className="activity-list">
        {activity.map((item) => (
          <div className="activity-item" key={item.id}>
            <span className={`activity-icon ${item.kind}`}>
              {item.kind === "import" ? (
                <Upload size={13} />
              ) : item.kind === "playback" ? (
                <Radio size={13} />
              ) : (
                <FileCheck2 size={13} />
              )}
            </span>
            <div>
              <strong>{item.title}</strong>
              <p>{item.description}</p>
              <time dateTime={new Date(item.at).toISOString()}>
                {Math.max(0, Math.floor((now - item.at) / 60000)) < 1
                  ? "Just now"
                  : `${Math.floor((now - item.at) / 60000)} min ago`}
              </time>
            </div>
          </div>
        ))}
        {activity.length === 0 && (
          <p className="activity-empty">
            Dataset operations will be recorded here as you work.
          </p>
        )}
      </div>
    </article>
  );
});
export function AnalyticsPanels({
  dataset,
  stats,
  column,
  activity,
  onDetails,
}: {
  dataset: Dataset | null;
  stats: PlaybackStats | null;
  column: string;
  activity: DatasetActivity[];
  onDetails: () => void;
}) {
  const utilization = stats
    ? Math.min(100, (stats.bufferedPoints / (MAX_TILES * 4096)) * 100)
    : 0;
  return (
    <section
      className="analytics-grid"
      id="analytics"
      aria-label="Dataset analytics"
    >
      <SignalStatistics dataset={dataset} column={column} />
      <article className="analytics-card performance-card" id="performance">
        <div className="card-heading">
          <h2>Playback performance</h2>
          <button
            className="text-icon-button"
            aria-label="Show detailed performance"
            title="Show detailed performance"
            onClick={onDetails}
          >
            <ArrowUpRight size={15} />
          </button>
        </div>
        <p className="card-description">
          Measured from this visualization session.
        </p>
        <div className="performance-metrics">
          <div>
            <span>Visible samples</span>
            <strong>
              {stats ? stats.visiblePoints.toLocaleString("en-US") : "—"}
            </strong>
          </div>
          <div>
            <span>Query latency</span>
            <strong>
              {stats ? stats.queryMs.toFixed(1) : "—"}
              <small>ms</small>
            </strong>
          </div>
          <div>
            <span>Level of detail</span>
            <strong>
              {stats ? `${stats.lod.toLocaleString("en-US")}×` : "—"}
            </strong>
          </div>
          <div>
            <span>Sample cache</span>
            <strong>{stats ? formatBytes(stats.bufferBytes) : "—"}</strong>
          </div>
        </div>
        <div className="buffer-caption">
          <span>Buffer utilization</span>
          <strong>{stats ? `${utilization.toFixed(1)}%` : "—"}</strong>
        </div>
        <div className="buffer-meter">
          <span style={{ width: `${utilization}%` }} />
        </div>
      </article>
      <SessionActivity activity={activity} />
    </section>
  );
}
