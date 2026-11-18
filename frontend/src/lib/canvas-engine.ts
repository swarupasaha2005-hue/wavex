import { scaleLinear, scaleUtc } from "d3-scale";
import { utcFormat } from "d3-time-format";
import { RangeCache, Tile } from "./range-cache";
import { WebGLLine } from "./webgl-line";
import { CHART_THEME } from "./chart-theme";
import { Dataset, PlaybackStats, PlaybackStatus } from "./types";

const label = utcFormat("%H:%M:%S");
const M = { left: 24, right: 77, top: 34, bottom: 42 };
type Point = { time: number; exact: bigint; value: number; row: number };

/** Timestamp clock and WebGL renderer. The name preserves the existing control API. */
export class CanvasEngine {
  private gpu: WebGLLine;
  private cache: RangeCache;
  private overlay: HTMLCanvasElement;
  private context: CanvasRenderingContext2D;
  private observer: ResizeObserver;
  private frame = 0;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private last = 0;
  private reportAt = 0;
  private frames = 0;
  private elapsed = 0;
  private draws = 0;
  private drawTime = 0;
  private points: Point[] = [];
  private geometryKey = "";
  private base = 0;
  private dirty = true;
  private hasFrame = false;
  private disposed = false;
  private pointer: { x: number; y: number } | null = null;
  private drag: { x: number; time: number } | null = null;
  private relativeTime: number;
  private status: PlaybackStatus = "connecting";
  private lod = 1;
  playing = true;
  speed = 1;
  windowSeconds = 30;
  column: string;

  constructor(
    private canvas: HTMLCanvasElement,
    private dataset: Dataset,
    private report: (stats: PlaybackStats) => void,
    private connectionError: (message: string | null) => void,
    private zoomChanged?: (seconds: number) => void,
  ) {
    this.column = dataset.columns[0];
    this.relativeTime = Math.min(30000, dataset.durationMs * 0.3);
    this.gpu = new WebGLLine(canvas, (message) =>
      this.connectionError(message),
    );
    this.cache = new RangeCache(dataset, (message) =>
      this.connectionError(message),
    );
    this.overlay = document.createElement("canvas");
    this.overlay.className = "axes-canvas";
    this.overlay.setAttribute("aria-hidden", "true");
    this.context = this.overlay.getContext("2d")!;
    canvas.parentElement!.appendChild(this.overlay);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
    canvas.addEventListener("pointermove", this.onPointer);
    canvas.addEventListener("pointerleave", this.onLeave);
    canvas.addEventListener("pointerdown", this.onDown);
    canvas.addEventListener("pointerup", this.onUp);
    canvas.addEventListener("pointercancel", this.onUp);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    document.addEventListener("visibilitychange", this.onVisibility);
    this.resize();
    this.frame = requestAnimationFrame(this.tick);
  }
  get position() {
    return this.relativeTime / this.dataset.intervalMs;
  }
  setPlaying(value: boolean) {
    this.playing = value;
    this.dirty = true;
  }
  setSpeed(value: number) {
    this.speed = value;
  }
  setWindow(value: number) {
    this.windowSeconds = Math.max(1e-9, Math.min(31536000, value));
    this.geometryKey = "";
    this.dirty = true;
  }
  setColumn(column: string) {
    if (this.dataset.columns.includes(column)) {
      this.column = column;
      this.geometryKey = "";
      this.hasFrame = false;
      this.dirty = true;
    }
  }
  seek(index: number) {
    this.relativeTime = Math.max(
      0,
      Math.min(this.dataset.durationMs, index * this.dataset.intervalMs),
    );
    this.last = 0;
    this.dirty = true;
  }
  restart() {
    this.seek(0);
    this.playing = true;
  }
  snapshot() {
    const result = document.createElement("canvas");
    result.width = this.canvas.width;
    result.height = this.canvas.height;
    const ctx = result.getContext("2d")!;
    ctx.drawImage(this.canvas, 0, 0);
    ctx.drawImage(this.overlay, 0, 0);
    return result.toDataURL("image/png");
  }
  private onVisibility = () => {
    this.last = 0;
    this.reportAt = 0;
    this.frames = 0;
    this.elapsed = 0;
    this.drawTime = 0;
    this.draws = 0;
  };
  private onPointer = (event: PointerEvent) => {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    if (this.drag) {
      const span = this.windowSeconds * 1000;
      this.seek(
        (this.drag.time -
          ((event.clientX - this.drag.x) /
            Math.max(1, this.width - M.left - M.right)) *
            span) /
          this.dataset.intervalMs,
      );
    }
    this.dirty = true;
  };
  private onLeave = () => {
    this.pointer = null;
    this.dirty = true;
  };
  private onDown = (event: PointerEvent) => {
    this.playing = false;
    this.drag = { x: event.clientX, time: this.relativeTime };
    this.canvas.setPointerCapture(event.pointerId);
  };
  private onUp = () => {
    this.drag = null;
  };
  private onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const seconds = Math.max(
      1e-9,
      Math.min(
        Math.max(120, this.dataset.durationMs / 1000),
        this.windowSeconds * (event.deltaY > 0 ? 1.25 : 0.8),
      ),
    );
    this.setWindow(seconds);
    this.zoomChanged?.(seconds);
  };
  private resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    for (const canvas of [this.canvas, this.overlay]) {
      canvas.width = Math.round(rect.width * this.dpr);
      canvas.height = Math.round(rect.height * this.dpr);
    }
    this.context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.hasFrame = false;
    this.dirty = true;
  }
  private prepare(tiles: Tile[]) {
    const key = tiles.map((t) => t.key).join("|");
    if (key === this.geometryKey) return;
    const records = new Map<number, Point>();
    for (const tile of tiles)
      for (let i = 0; i < tile.times.length; i++)
        records.set(tile.rows[i], {
          time: tile.times[i],
          exact: tile.exactTimes[i],
          value: tile.values[i],
          row: tile.rows[i],
        });
    this.points = [...records.values()].sort(
      (a, b) => a.time - b.time || a.row - b.row,
    );
    this.base = tiles[0]?.start ?? 0;
    this.lod = Math.max(1, ...tiles.map((t) => t.level));
    const bounds = this.dataset.columnStats?.[this.column] ?? this.dataset;
    this.gpu.upload(
      this.points,
      this.base,
      this.windowSeconds * 1000,
      bounds.min + (bounds.max - bounds.min) / 2,
    );
    this.geometryKey = key;
    this.dirty = true;
  }
  private tick = (now: number) => {
    if (this.disposed) return;
    const delta = this.last ? now - this.last : 0;
    this.last = now;
    const candidate = Math.min(
      this.dataset.durationMs,
      this.relativeTime +
        (this.playing ? Math.min(delta, 100) * this.speed : 0),
    );
    const budget = Math.min(4096, Math.max(256, Math.ceil(this.width * 1.5)));
    const tiles = this.cache.ensure(
      candidate,
      this.windowSeconds * 1000,
      budget,
      this.column,
    );
    if (!tiles) this.status = this.hasFrame ? "buffering" : "connecting";
    else {
      this.relativeTime = candidate;
      if (candidate >= this.dataset.durationMs) this.playing = false;
      this.status =
        candidate >= this.dataset.durationMs
          ? "ended"
          : this.playing
            ? "playing"
            : "paused";
      this.prepare(tiles);
    }
    if (
      (tiles && (this.playing || this.dirty || !this.hasFrame)) ||
      !this.hasFrame
    ) {
      const began = performance.now();
      this.draw(Boolean(tiles));
      this.drawTime += performance.now() - began;
      this.draws++;
      if (tiles) this.hasFrame = true;
      this.dirty = false;
    }
    if (delta > 0) this.frames++;
    this.elapsed += delta;
    if (now - this.reportAt >= 250) {
      const last = this.endpoint();
      this.report({
        status: this.status,
        isPlaying: this.playing,
        position: this.position,
        timestamp: this.dataset.startTime + this.relativeTime,
        value: last?.value ?? null,
        fps: this.elapsed ? Math.round((this.frames * 1000) / this.elapsed) : 0,
        frameMs: this.drawTime / Math.max(1, this.draws),
        visiblePoints: this.points.filter(
          (p) =>
            p.time >= this.relativeTime - this.windowSeconds * 1000 &&
            p.time <= this.relativeTime,
        ).length,
        renderedPoints: this.points.length,
        bufferBytes: this.cache.bufferBytes,
        bufferedPoints: this.cache.bufferedPoints,
        receivedBytes: this.cache.receivedBytes,
        queryMs: this.cache.lastQueryMs,
        lod: this.lod,
      });
      this.frames = 0;
      this.elapsed = 0;
      this.drawTime = 0;
      this.draws = 0;
      this.reportAt = now;
    }
    this.frame = requestAnimationFrame(this.tick);
  };
  private endpoint() {
    let left = 0,
      right = this.points.length;
    while (left < right) {
      const middle = (left + right) >>> 1;
      if (this.points[middle].time <= this.relativeTime) left = middle + 1;
      else right = middle;
    }
    return this.points[left - 1];
  }
  private draw(available: boolean) {
    const { width, height } = this;
    if (width < 100 || height < 100) return;
    const left = M.left,
      right = width - M.right,
      top = M.top,
      bottom = height - M.bottom,
      span = this.windowSeconds * 1000,
      start = this.relativeTime - span;
    const stats = this.dataset.columnStats?.[this.column] ?? this.dataset,
      spread =
        stats.max - stats.min || Math.max(Math.abs(stats.max) * 0.01, 1e-9);
    const y = scaleLinear()
      .domain([stats.min - spread * 0.13, stats.max + spread * 0.13])
      .nice(5)
      .range([bottom, top]);
    this.gpu.draw(
      (start - this.base) / span,
      y.domain() as [number, number],
      { left, bottom: M.bottom, width: right - left, height: bottom - top },
      this.dpr,
    );
    const ctx = this.context;
    ctx.clearRect(0, 0, width, height);
    ctx.font = CHART_THEME.font;
    ctx.textBaseline = "middle";
    ctx.lineWidth = 1;
    for (const value of y.ticks(5)) {
      const py = Math.round(y(value)) + 0.5;
      ctx.strokeStyle = CHART_THEME.grid;
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.moveTo(left, py);
      ctx.lineTo(right, py);
      ctx.stroke();
      ctx.fillStyle = CHART_THEME.axis;
      ctx.textAlign = "left";
      ctx.fillText(
        value !== 0 && (Math.abs(value) < 0.001 || Math.abs(value) >= 1e6)
          ? value.toExponential(2)
          : String(value),
        right + 17,
        py,
      );
    }
    const tickCount = Math.max(2, Math.floor((right - left) / 110));
    const dateScale = scaleUtc()
      .domain([
        new Date(this.dataset.startTime + start),
        new Date(this.dataset.startTime + this.relativeTime),
      ])
      .range([left, right]);
    const localScale = scaleLinear()
      .domain([start, this.relativeTime])
      .range([left, right]);
    const ticks =
      span >= 1
        ? dateScale.ticks(tickCount).map((tick) => ({
            x: dateScale(tick),
            text: span < 1000 ? utcFormat("%H:%M:%S.%L")(tick) : label(tick),
          }))
        : localScale.ticks(tickCount).map((tick) => ({
            x: localScale(tick),
            text: `+${Math.round((tick - start) * 1e6)} ns`,
          }));
    for (const tick of ticks) {
      const px = Math.round(tick.x) + 0.5;
      ctx.strokeStyle = CHART_THEME.verticalGrid;
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.moveTo(px, top);
      ctx.lineTo(px, bottom);
      ctx.stroke();
      ctx.fillStyle = CHART_THEME.axis;
      ctx.textAlign = "center";
      ctx.fillText(tick.text, px, bottom + 25);
    }
    ctx.setLineDash([]);
    ctx.textAlign = "left";
    ctx.fillStyle = CHART_THEME.axis;
    ctx.fillText(this.dataset.unit.toUpperCase(), right + 17, 15);
    if (!available) {
      ctx.textAlign = "center";
      ctx.fillText(
        "Loading historical range…",
        (left + right) / 2,
        (top + bottom) / 2,
      );
      return;
    }
    const endpoint = this.endpoint();
    if (endpoint && endpoint.time >= start) {
      const py = y(endpoint.value);
      ctx.fillStyle = CHART_THEME.highlight;
      ctx.fillRect(right + 7, py - 12, 61, 24);
      ctx.fillStyle = CHART_THEME.highlightText;
      ctx.textAlign = "center";
      ctx.fillText(endpoint.value.toFixed(2), right + 37, py);
    }
    if (
      this.pointer &&
      this.pointer.x >= left &&
      this.pointer.x <= right &&
      this.pointer.y >= top &&
      this.pointer.y <= bottom
    ) {
      const time = start + ((this.pointer.x - left) / (right - left)) * span;
      let nearest: Point | undefined;
      for (const point of this.points) {
        if (point.time > this.relativeTime) break;
        if (
          !nearest ||
          Math.abs(point.time - time) < Math.abs(nearest.time - time)
        )
          nearest = point;
      }
      if (nearest) {
        const px = left + ((nearest.time - start) / span) * (right - left),
          py = y(nearest.value);
        ctx.strokeStyle = CHART_THEME.crosshair;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(px, top);
        ctx.lineTo(px, bottom);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = CHART_THEME.point;
        ctx.beginPath();
        ctx.arc(px, py, 3, 0, Math.PI * 2);
        ctx.fill();
        const tx = Math.max(left, Math.min(right - 270, px + 12));
        ctx.fillStyle = CHART_THEME.tooltip;
        ctx.fillRect(tx, top + 4, 270, 32);
        ctx.fillStyle = CHART_THEME.tooltipText;
        ctx.textAlign = "left";
        const fraction = String(
          ((nearest.exact % 1000000000n) + 1000000000n) % 1000000000n,
        ).padStart(9, "0");
        ctx.fillText(
          `${label(new Date(this.dataset.startTime + nearest.time))}.${fraction}  ${nearest.value.toFixed(3)}`,
          tx + 10,
          top + 20,
        );
      }
    }
  }
  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.cache.dispose();
    this.gpu.dispose();
    this.overlay.remove();
    this.canvas.removeEventListener("pointermove", this.onPointer);
    this.canvas.removeEventListener("pointerleave", this.onLeave);
    this.canvas.removeEventListener("pointerdown", this.onDown);
    this.canvas.removeEventListener("pointerup", this.onUp);
    this.canvas.removeEventListener("pointercancel", this.onUp);
    this.canvas.removeEventListener("wheel", this.onWheel);
    document.removeEventListener("visibilitychange", this.onVisibility);
  }
}
