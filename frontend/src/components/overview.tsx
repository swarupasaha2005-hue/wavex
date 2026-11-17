"use client";

import { useEffect, useRef, useState } from "react";
import { scaleLinear } from "d3-scale";
import { API_URL, Dataset } from "@/lib/types";

export function Overview({
  dataset,
  column,
  position,
  windowSeconds,
  onSeek,
}: {
  dataset: Dataset;
  column: string;
  position: number;
  windowSeconds: number;
  onSeek: (position: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [preview, setPreview] = useState<[number, number][]>(dataset.overview);
  useEffect(() => {
    if (column === dataset.columns[0]) {
      setPreview(dataset.overview);
      return;
    }
    const controller = new AbortController();
    setPreview([]);
    const params = new URLSearchParams({
      start_ns: dataset.startTimeNs,
      end_ns: dataset.endTimeNs,
      columns: column,
      max_points: "1600",
    });
    void fetch(`${API_URL}/datasets/${dataset.id}/range?${params}`, {
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error("Overview unavailable");
        return response.json();
      })
      .then((result) => {
        const series = result.series[column];
        if (!controller.signal.aborted)
          setPreview(
            series.timeNs.map((time: string, index: number) => [
              Number(BigInt(time) - BigInt(dataset.startTimeNs)) /
                1e6 /
                dataset.intervalMs,
              series.values[index],
            ]),
          );
      })
      .catch(() => {});
    return () => controller.abort();
  }, [dataset, column]);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const draw = () => {
      const { width, height } = element.getBoundingClientRect();
      const dpr = Math.min(devicePixelRatio || 1, 2);
      element.width = width * dpr;
      element.height = height * dpr;
      const ctx = element.getContext("2d");
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      const x = scaleLinear()
        .domain([0, dataset.size - 1])
        .range([0, width]);
      const bounds = dataset.columnStats?.[column] ?? dataset;
      const y = scaleLinear()
        .domain([bounds.min, bounds.max])
        .range([height - 7, 7]);
      ctx.strokeStyle = "#54746c";
      ctx.lineWidth = 1;
      ctx.beginPath();
      preview.forEach(([index, value], i) =>
        i ? ctx.lineTo(x(index), y(value)) : ctx.moveTo(x(index), y(value)),
      );
      ctx.stroke();
      ctx.lineTo(width, height);
      ctx.lineTo(0, height);
      ctx.closePath();
      ctx.fillStyle = "rgba(110,169,149,.05)";
      ctx.fill();
    };
    const observer = new ResizeObserver(draw);
    observer.observe(element);
    draw();
    return () => observer.disconnect();
  }, [dataset, column, preview]);
  const right = (position / (dataset.size - 1)) * 100;
  const windowWidth =
    ((windowSeconds * 1000) / dataset.intervalMs / dataset.size) * 100;
  return (
    <div className="overview-wrap">
      <canvas ref={canvas} aria-hidden="true" />
      <div
        className="overview-selection"
        style={{
          right: `${100 - right}%`,
          width: `${Math.max(0.35, Math.min(right, windowWidth))}%`,
        }}
      />
      <input
        aria-label="Dataset position"
        type="range"
        min={0}
        max={dataset.size - 1}
        step={1}
        value={Math.floor(position)}
        onChange={(event) => onSeek(Number(event.target.value))}
      />
    </div>
  );
}
