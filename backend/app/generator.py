"""Bounded-memory synthesis, disk-backed samples and compact Polars summaries."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import time
from pathlib import Path
from typing import Callable

import numpy as np
import polars as pl

SIZES = (10_000, 100_000, 1_000_000, 10_000_000)
BLOCK_SIZE = 131_072
INTERVAL_MS = 10
START_MS = 1_789_344_000_000  # 2026-09-14T00:00:00Z; shared time origin
# shortcut: on Vercel only /tmp is writable and it is per-instance and ephemeral; use durable storage for real persistence.
DATA_DIR = Path(
    os.environ.get("WAVEX_DATA_DIR")
    or ("/tmp/wavex-data" if os.environ.get("VERCEL") else Path(__file__).resolve().parents[1] / "data")
)


def dataset_id(size: int, seed: int) -> str:
    return f"telemetry-{size}-{seed}"


def generate(
    size: int,
    seed: int = 42,
    root: Path = DATA_DIR,
    progress: Callable[[float], None] = lambda _: None,
) -> dict:
    if size not in SIZES or not 0 <= seed <= 2**32 - 1:
        raise ValueError("Unsupported dataset size or seed")
    identifier = dataset_id(size, seed)
    destination = root / identifier
    manifest = destination / "manifest.json"
    if manifest.exists():
        return json.loads(manifest.read_text())
    root.mkdir(parents=True, exist_ok=True)
    temporary = root / f".{identifier}-{os.getpid()}.tmp"
    temporary.mkdir(exist_ok=True)
    started = time.perf_counter()
    try:
        values = np.lib.format.open_memmap(
            temporary / "values.npy", mode="w+", dtype="<f4", shape=(size,)
        )
        rng = np.random.default_rng(seed)
        summaries: list[dict] = []
        overview: list[list[float]] = []
        # Fixed bins keep the overview bounded, independent of the dataset size.
        overview_step = max(1, (size + 799) // 800)
        walk = 0.0
        for start in range(0, size, BLOCK_SIZE):
            stop = min(size, start + BLOCK_SIZE)
            index = np.arange(start, stop, dtype=np.float64)
            increments = rng.normal(0, 0.004, stop - start)
            wandering = walk + np.cumsum(increments)
            walk = float(wandering[-1])
            # Broad load cycles, correlated sensor noise, drift and intermittent faults.
            noise = rng.normal(0, 1, stop - start + 50)
            correlated = np.convolve(noise, np.ones(51) / 51, mode="valid")
            phase = np.remainder(index + seed * 71, 23_700)
            faults = 26 * np.exp(-(((phase - 12_100) / 110) ** 2))
            faults -= 14 * np.exp(-(((phase - 18_300) / 230) ** 2))
            signal = (
                72
                + 9 * np.sin(index / 1800)
                + 4 * np.sin(index / 317)
                + 2 * np.sin(index / 83)
                + wandering
                + correlated * 8
                + rng.normal(0, 0.32, stop - start)
                + faults
            )
            frame = pl.DataFrame({"value": signal}).with_columns(
                pl.col("value").cast(pl.Float32)
            )
            block = frame["value"].to_numpy()
            values[start:stop] = block
            stats = frame.select(
                pl.col("value").min().alias("min"),
                pl.col("value").max().alias("max"),
                pl.col("value").mean().alias("mean"),
                pl.col("value").std().alias("std"),
            ).row(0, named=True)
            summaries.append({"start": start, "count": stop - start, **stats})
            # Store real min/max extrema in timestamp order, rather than averaging spikes away.
            for offset in range(start, stop, overview_step):
                section = block[
                    offset - start : min(stop - start, offset - start + overview_step)
                ]
                lo, hi = int(section.argmin()), int(section.argmax())
                for position in sorted({lo, hi}):
                    overview.append([offset + position, float(section[position])])
            progress(stop / size)
        values.flush()
        del values
        pl.DataFrame(summaries).write_parquet(
            temporary / "summaries.parquet", compression="zstd"
        )
        minimum = min(row["min"] for row in summaries)
        maximum = max(row["max"] for row in summaries)
        metadata = {
            "id": identifier,
            "size": size,
            "seed": seed,
            "startTime": START_MS,
            "intervalMs": INTERVAL_MS,
            "min": minimum,
            "max": maximum,
            "mean": sum(row["mean"] * row["count"] for row in summaries) / size,
            "overview": overview,
            "generationSeconds": round(time.perf_counter() - started, 3),
            "storageBytes": (temporary / "values.npy").stat().st_size,
            "label": "System telemetry",
            "unit": "ms",
        }
        (temporary / "manifest.json").write_text(json.dumps(metadata, allow_nan=False))
        temporary.rename(destination)
        return metadata
    except BaseException:
        shutil.rmtree(temporary, ignore_errors=True)
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Generate bounded-memory WaveX telemetry datasets"
    )
    parser.add_argument("--size", type=int, choices=SIZES, default=1_000_000)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    result = generate(args.size, args.seed)
    print(json.dumps({k: v for k, v in result.items() if k != "overview"}, indent=2))
