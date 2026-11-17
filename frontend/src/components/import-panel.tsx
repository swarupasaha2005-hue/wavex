"use client";
import { useEffect, useRef, useState } from "react";
import { FolderOpen, Pause, Upload, X } from "lucide-react";
import { API_URL, Dataset } from "@/lib/types";

interface Config {
  format: string;
  timestampColumn: string;
  timestampUnit: string;
  valueColumns: string[];
  label: string;
  unit: string;
}
interface Session {
  id?: string;
  jobId?: string;
  fingerprint?: string;
  config: Config;
}
interface Job {
  id: string;
  datasetId: string;
  status: string;
  stage: string;
  progress: number;
  rowsProcessed: number;
  peakRssBytes?: number;
  processingSeconds?: number;
  error?: string;
}
const KEY = "wavex-import-session-v2";
const defaults: Config = {
  format: "csv",
  timestampColumn: "timestamp",
  timestampUnit: "iso",
  valueColumns: ["value"],
  label: "",
  unit: "",
};
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      typeof body.detail === "string"
        ? body.detail
        : `Request failed (${response.status}). Retry to resume from the server's committed offset.`,
    );
  }
  return response.json();
}
const digest = async (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export function ImportPanel({
  onReady,
  onClose,
  onLibraryChanged,
}: {
  onReady: (dataset: Dataset) => void;
  onClose: () => void;
  onLibraryChanged: () => void;
}) {
  const [mode, setMode] = useState("upload"),
    [file, setFile] = useState<File | null>(null),
    [path, setPath] = useState("");
  const [config, setConfig] = useState<Config>(defaults),
    [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false),
    [status, setStatus] = useState(""),
    [error, setError] = useState<string | null>(null),
    [progress, setProgress] = useState(0),
    [job, setJob] = useState<Job | null>(null);
  const abort = useRef<AbortController | null>(null),
    mounted = useRef(true),
    poll = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persist = (value: Session) => {
    localStorage.setItem(KEY, JSON.stringify(value));
    setSession(value);
  };
  const pollJob = useRef<(id: string) => void>(() => {});
  pollJob.current = (id: string) => {
    void (async () => {
      try {
        const state = await api<Job>(`/imports/${id}`, {
          signal: AbortSignal.timeout(15000),
        });
        if (!mounted.current) return;
        setJob(state);
        setProgress(state.progress * 100);
        setStatus(
          `${state.stage} · ${state.rowsProcessed.toLocaleString()} rows${state.peakRssBytes ? ` · ${(state.peakRssBytes / 1048576).toFixed(0)} MiB peak` : ""}`,
        );
        if (state.status === "ready") {
          const dataset = await api<Dataset>(`/datasets/${state.datasetId}`);
          if (!mounted.current) return;
          setBusy(false);
          setStatus("Import ready");
          localStorage.removeItem(KEY);
          setSession(null);
          onLibraryChanged();
          onReady(dataset);
          return;
        }
        if (state.status === "error") {
          setError(state.error ?? "Import failed");
          setBusy(false);
          return;
        }
        poll.current = setTimeout(() => pollJob.current(id), 750);
      } catch (caught) {
        if (mounted.current) {
          setError((caught as Error).message);
          setBusy(false);
        }
      }
    })();
  };
  useEffect(() => {
    mounted.current = true;
    try {
      const saved = JSON.parse(
        localStorage.getItem(KEY) ?? "null",
      ) as Session | null;
      if (saved) {
        setSession(saved);
        setConfig(saved.config);
        if (saved.jobId) {
          setBusy(true);
          pollJob.current(saved.jobId);
        } else setStatus("Upload paused. Select the same file to resume.");
      }
    } catch {
      localStorage.removeItem(KEY);
    }
    return () => {
      mounted.current = false;
      abort.current?.abort();
      if (poll.current) clearTimeout(poll.current);
    };
  }, []);

  async function start() {
    setError(null);
    setBusy(true);
    const controller = new AbortController();
    abort.current = controller;
    try {
      if (session?.jobId) {
        const job = await api<Job>(`/imports/${session.jobId}/retry`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(config),
        });
        persist({ ...session, config });
        pollJob.current(job.id);
        return;
      }
      if (mode === "local") {
        const result = await api<Job>("/imports/local", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...config, path }),
          signal: controller.signal,
        });
        persist({ jobId: result.id, config });
        pollJob.current(result.id);
        return;
      }
      if (!file) throw new Error("Select a CSV or JSONL file first.");
      if (file.size > 10 * 1024 ** 3)
        throw new Error("The largest supported file is 10 GiB.");
      setStatus("Checking file identity…");
      const fingerprint = await digest(
        new TextEncoder().encode(
          `${file.name}:${file.size}:${file.lastModified}:${await digest(await file.slice(0, 1048576).arrayBuffer())}:${await digest(await file.slice(Math.max(0, file.size - 1048576)).arrayBuffer())}`,
        ).buffer,
      );
      let current = session;
      if (current?.id && current.fingerprint !== fingerprint)
        throw new Error(
          "Select the original file to resume, or discard the paused upload to start another.",
        );
      if (!current?.id) {
        const created = await api<{ id: string }>("/uploads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...config,
            label: config.label || file.name,
            filename: file.name,
            size: file.size,
            fingerprint,
          }),
          signal: controller.signal,
        });
        current = { id: created.id, config, fingerprint };
        persist(current);
      }
      const state = await api<{ offset: number; chunkBytes: number }>(
        `/uploads/${current.id}`,
        { signal: controller.signal },
      );
      let offset = state.offset;
      while (offset < file.size) {
        if (controller.signal.aborted)
          throw new DOMException("Paused", "AbortError");
        setStatus(
          `Uploading · ${(offset / 1e9).toFixed(2)} / ${(file.size / 1e9).toFixed(2)} GB`,
        );
        setProgress((offset / file.size) * 100);
        const chunk = await file
          .slice(offset, Math.min(file.size, offset + state.chunkBytes))
          .arrayBuffer();
        const checksum = await digest(chunk);
        const response = await api<{ offset: number }>(
          `/uploads/${current.id}`,
          {
            method: "PUT",
            headers: {
              "Content-Type": "application/octet-stream",
              "Upload-Offset": String(offset),
              "X-Chunk-SHA256": checksum,
            },
            body: chunk,
            signal: controller.signal,
          },
        );
        offset = response.offset;
      }
      const result = await api<Job>(`/uploads/${current.id}/complete`, {
        method: "POST",
        signal: controller.signal,
      });
      persist({ ...current, jobId: result.id });
      setProgress(0);
      pollJob.current(result.id);
    } catch (caught) {
      if (!mounted.current) return;
      setBusy(false);
      if ((caught as Error).name === "AbortError")
        setStatus(
          "Upload paused. Resume to continue from the committed offset.",
        );
      else setError((caught as Error).message);
    }
  }
  const locked = busy || (Boolean(session) && job?.status !== "error");
  return (
    <section className="import-panel" aria-label="Import dataset">
      <div className="import-heading">
        <div>
          <h2>Import your dataset</h2>
          <p>
            CSV or JSONL · up to 10 GiB · timestamps and 1–8 numeric columns
          </p>
        </div>
        <button
          className="icon-button"
          aria-label="Close import panel"
          onClick={onClose}
        >
          <X size={17} />
        </button>
      </div>
      <div className="import-tabs">
        <button
          disabled={busy || Boolean(session)}
          className={mode === "upload" ? "selected" : ""}
          onClick={() => setMode("upload")}
        >
          <Upload size={14} /> Resumable upload
        </button>
        <button
          disabled={busy || Boolean(session)}
          className={mode === "local" ? "selected" : ""}
          onClick={() => setMode("local")}
        >
          <FolderOpen size={14} /> Local file path
        </button>
      </div>
      <fieldset disabled={locked} className="import-fields">
        <label className="import-source">
          {mode === "upload" ? "Source file" : "Absolute path on this computer"}
          {mode === "upload" ? (
            <input
              aria-label="Source file"
              type="file"
              accept=".csv,.jsonl,.ndjson"
              disabled={busy || Boolean(session?.jobId)}
              onChange={(event) => {
                const next = event.target.files?.[0] ?? null;
                setFile(next);
                if (next && !session)
                  setConfig({
                    ...config,
                    format: /\.(jsonl|ndjson)$/i.test(next.name)
                      ? "jsonl"
                      : "csv",
                  });
              }}
            />
          ) : (
            <input
              aria-label="Local file path"
              disabled={Boolean(session)}
              placeholder="/Users/you/data/telemetry.csv"
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
          )}
        </label>
        <label>
          Format
          <select
            aria-label="Format"
            value={config.format}
            onChange={(e) => setConfig({ ...config, format: e.target.value })}
          >
            <option value="csv">CSV</option>
            <option value="jsonl">JSONL / NDJSON</option>
          </select>
        </label>
        <label>
          Timestamp column
          <input
            aria-label="Timestamp column"
            value={config.timestampColumn}
            onChange={(e) =>
              setConfig({ ...config, timestampColumn: e.target.value })
            }
          />
        </label>
        <label>
          Timestamp format
          <select
            aria-label="Timestamp format"
            value={config.timestampUnit}
            onChange={(e) =>
              setConfig({ ...config, timestampUnit: e.target.value })
            }
          >
            <option value="iso">ISO 8601 / UTC</option>
            <option value="s">Epoch seconds (integer)</option>
            <option value="ms">Epoch milliseconds</option>
            <option value="us">Epoch microseconds</option>
            <option value="ns">Epoch nanoseconds</option>
          </select>
        </label>
        <label>
          Numeric columns, comma separated
          <input
            aria-label="Numeric columns, comma separated"
            value={config.valueColumns.join(",")}
            onChange={(e) =>
              setConfig({
                ...config,
                valueColumns: e.target.value.split(",").map((v) => v.trim()),
              })
            }
          />
        </label>
        <label>
          Dataset name
          <input
            placeholder="Uses the filename"
            aria-label="Dataset name"
            value={config.label}
            onChange={(e) => setConfig({ ...config, label: e.target.value })}
          />
        </label>
        <label>
          Value unit
          <input
            placeholder="e.g. ms, °C, V"
            aria-label="Value unit"
            value={config.unit}
            onChange={(e) => setConfig({ ...config, unit: e.target.value })}
          />
        </label>
      </fieldset>
      {session?.id && !session.jobId && !busy && (
        <label className="resume-file">
          Reselect the original file to resume
          <input
            aria-label="Resume source file"
            type="file"
            accept=".csv,.jsonl,.ndjson"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
      )}
      <div className="import-progress">
        <div style={{ width: `${Math.min(100, progress)}%` }} />
      </div>
      <div className="import-bottom">
        <span role="status">
          {status ||
            "Files are validated and processed in the background. Your original local file stays in place."}
        </span>
        <div>
          {busy && !session?.jobId ? (
            <button onClick={() => abort.current?.abort()}>
              <Pause size={13} />
              Pause upload
            </button>
          ) : (
            <button
              className="load-button"
              disabled={busy}
              onClick={() => void start()}
            >
              {busy
                ? "Processing…"
                : job?.status === "error"
                  ? "Retry import"
                  : session?.jobId
                    ? "Check import"
                    : session?.id
                      ? "Resume upload"
                      : mode === "local"
                        ? "Import local file"
                        : "Upload and import"}
            </button>
          )}
        </div>
      </div>
      {error && (
        <p className="import-error" role="alert">
          {error}
        </p>
      )}
      {session && !busy && (
        <button
          className="discard-button"
          onClick={async () => {
            try {
              if (session.id)
                await api(`/uploads/${session.id}`, { method: "DELETE" });
            } catch (caught) {
              setError((caught as Error).message);
              return;
            }
            localStorage.removeItem(KEY);
            setSession(null);
            setJob(null);
            setStatus("");
            setProgress(0);
            setError(null);
          }}
        >
          Discard session and start another
        </button>
      )}
    </section>
  );
}
