export type DatasetSize = 10000 | 100000 | 1000000 | 10000000;
export interface Dataset {
  id: string;
  size: number;
  seed: number;
  startTime: number;
  intervalMs: number;
  min: number;
  max: number;
  mean: number;
  overview: [number, number][];
  generationSeconds: number;
  storageBytes: number;
  label: string;
  unit: string;
  kind: "synthetic" | "imported";
  columns: string[];
  startTimeNs: string;
  endTimeNs: string;
  durationMs: number;
  sourceBytes?: number;
  columnStats?: Record<string, { min: number; max: number; mean: number }>;
}
export type PlaybackStatus =
  "connecting" | "buffering" | "playing" | "paused" | "ended" | "reconnecting";
export interface PlaybackStats {
  status: PlaybackStatus;
  isPlaying: boolean;
  position: number;
  timestamp: number;
  value: number | null;
  fps: number;
  frameMs: number;
  visiblePoints: number;
  renderedPoints: number;
  bufferBytes: number;
  bufferedPoints: number;
  receivedBytes: number;
  queryMs: number;
  lod: number;
}
export const API_URL = (
  process.env.NEXT_PUBLIC_API_URL ||
  // On Vercel the backend service is same-origin under /api.
  (process.env.NEXT_PUBLIC_VERCEL_ENV ? "/api" : "http://127.0.0.1:8000")
).replace(/\/$/, "");
