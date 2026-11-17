import { API_URL, Dataset } from "./types";

export interface Tile {
  key: string;
  start: number;
  end: number;
  times: Float64Array;
  exactTimes: BigInt64Array;
  values: Float64Array;
  rows: Float64Array;
  level: number;
  queryMs: number;
  bytes: number;
}
export const MAX_TILES = 6;
export const MAX_CACHE_BYTES = 4 * 1024 * 1024;

/** HTTP historical queries only. There is no historical WebSocket playback clock. */
export class RangeCache {
  tiles = new Map<string, Tile>();
  private pending = new Map<string, AbortController>();
  private retryAt = new Map<string, number>();
  private disposed = false;
  private focus = 0;
  private wanted = new Set<string>();
  private origin: bigint;
  receivedBytes = 0;
  revision = 0;
  lastQueryMs = 0;
  constructor(
    private dataset: Dataset,
    private error: (message: string | null) => void,
  ) {
    this.origin = BigInt(dataset.startTimeNs);
  }
  private key(index: number, span: number, budget: number, column: string) {
    return `${column}:${span}:${budget}:${index}`;
  }

  ensure(
    end: number,
    span: number,
    budget: number,
    column: string,
  ): Tile[] | null {
    const duration = this.dataset.durationMs;
    this.focus = end;
    const first = Math.max(0, Math.floor(Math.max(0, end - span) / span));
    const last = Math.max(0, Math.floor(Math.min(duration, end) / span));
    const required = [];
    this.wanted = new Set();
    for (let index = first; index <= last; index++)
      this.wanted.add(this.key(index, span, budget, column));
    if ((last + 1) * span <= duration)
      this.wanted.add(this.key(last + 1, span, budget, column));
    for (const key of this.retryAt.keys())
      if (!this.wanted.has(key)) this.retryAt.delete(key);
    // Abort obsolete work on a distant seek or a changed level of detail.
    for (const [key, controller] of this.pending) {
      if (!this.wanted.has(key)) {
        controller.abort();
        this.pending.delete(key);
      }
    }
    let complete = true;
    for (let index = first; index <= last; index++) {
      const key = this.key(index, span, budget, column),
        tile = this.tiles.get(key);
      if (tile) required.push(tile);
      else {
        complete = false;
        this.request(index, span, budget, column);
      }
    }
    if (complete && (last + 1) * span <= duration) {
      const key = this.key(last + 1, span, budget, column);
      this.wanted.add(key);
      this.request(last + 1, span, budget, column);
    }
    return complete ? required : null;
  }

  private request(index: number, span: number, budget: number, column: string) {
    const key = this.key(index, span, budget, column);
    if (
      this.disposed ||
      this.tiles.has(key) ||
      this.pending.has(key) ||
      this.pending.size >= 3 ||
      performance.now() < (this.retryAt.get(key) ?? 0)
    )
      return;
    const controller = new AbortController();
    this.pending.set(key, controller);
    const start = index * span,
      end = Math.min(this.dataset.durationMs, (index + 1) * span);
    const params = new URLSearchParams({
      start_ns: String(this.origin + BigInt(Math.round(start * 1e6))),
      end_ns:
        end === this.dataset.durationMs
          ? this.dataset.endTimeNs
          : String(this.origin + BigInt(Math.round(end * 1e6))),
      columns: column,
      max_points: String(budget),
    });
    const timeout = setTimeout(() => controller.abort(), 15_000);
    void (async () => {
      try {
        const response = await fetch(
          `${API_URL}/datasets/${this.dataset.id}/range?${params}`,
          { signal: controller.signal },
        );
        if (!response.ok)
          throw new Error(
            `Historical range query failed (${response.status}). Retrying…`,
          );
        const text = await response.text();
        if (text.length > 2 * 1024 * 1024)
          throw new Error("The range response exceeded its memory budget.");
        const payload = JSON.parse(text),
          values = payload.series[column];
        if (
          !values ||
          values.values.length > budget ||
          values.timeNs.length !== values.values.length
        )
          throw new Error("Invalid historical range response");
        const times = new Float64Array(values.timeNs.length),
          exactTimes = new BigInt64Array(values.timeNs.length);
        for (let i = 0; i < times.length; i++) {
          exactTimes[i] = BigInt(values.timeNs[i]);
          times[i] = Number(exactTimes[i] - this.origin) / 1e6;
        }
        const tile: Tile = {
          key,
          start,
          end,
          times,
          exactTimes,
          values: Float64Array.from(values.values),
          rows: Float64Array.from(values.rows),
          level: payload.level,
          queryMs: payload.queryMs,
          bytes: times.length * 32,
        };
        if (this.disposed || controller.signal.aborted) return;
        this.receivedBytes += new TextEncoder().encode(text).byteLength;
        this.lastQueryMs = tile.queryMs;
        this.tiles.set(key, tile);
        this.retryAt.delete(key);
        while (
          this.tiles.size > MAX_TILES ||
          this.bufferBytes > MAX_CACHE_BYTES
        ) {
          const candidates = [...this.tiles.values()]
            .filter((t) => !this.wanted.has(t.key))
            .sort(
              (a, b) =>
                Math.abs(b.end - this.focus) - Math.abs(a.end - this.focus),
            );
          if (!candidates.length) break;
          this.tiles.delete(candidates[0].key);
        }
        this.revision++;
        this.error(null);
      } catch (caught) {
        if (!this.disposed && this.wanted.has(key)) {
          this.retryAt.set(key, performance.now() + 1500);
          this.error(
            controller.signal.aborted
              ? "Historical query interrupted. Retrying…"
              : (caught as Error).message,
          );
        }
      } finally {
        clearTimeout(timeout);
        if (this.pending.get(key) === controller) this.pending.delete(key);
      }
    })();
  }
  get bufferBytes() {
    let size = 0;
    for (const tile of this.tiles.values()) size += tile.bytes;
    return size;
  }
  get bufferedPoints() {
    let size = 0;
    for (const tile of this.tiles.values()) size += tile.times.length;
    return size;
  }
  dispose() {
    this.disposed = true;
    for (const controller of this.pending.values()) controller.abort();
    this.pending.clear();
    this.tiles.clear();
  }
}
