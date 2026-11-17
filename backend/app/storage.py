"""Bounded Polars transformations, time-ordered Parquet, and composable extrema LODs."""

from __future__ import annotations

import bisect
import json
import os
import shutil
import time
from pathlib import Path
from typing import Callable

os.environ.setdefault("POLARS_MAX_THREADS", "2")
import duckdb
import numpy as np
import polars as pl
import pyarrow as pa
import pyarrow.csv as pacsv
import pyarrow.json as pajson
import pyarrow.parquet as pq

RAW_ROWS = 131_072
SUMMARY_ROWS = 8_192
LEVEL_WIDTHS = [64, 1024, 16384, 262144, 4194304, 67108864, 1073741824]
READ_BYTES = 4 * 1024 * 1024
MAX_COLUMNS = 8


def atomic_json(path: Path, value: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".writing")
    with temporary.open("w") as handle:
        json.dump(value, handle, allow_nan=False)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    if os.name != "nt":
        descriptor = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def connect(directory: Path):
    directory.mkdir(parents=True, exist_ok=True)
    connection = duckdb.connect(
        config={
            "memory_limit": os.environ.get("WAVEX_QUERY_MEMORY", "256MB"),
            "threads": 2,
            "temp_directory": str(directory),
            "max_temp_directory_size": "30GB",
            "preserve_insertion_order": False,
        }
    )
    return connection


def validate_config(config: dict):
    columns = config["valueColumns"]
    if not 1 <= len(columns) <= MAX_COLUMNS or len(set(columns)) != len(columns):
        raise ValueError("Choose 1–8 distinct numeric columns")
    if config["timestampColumn"] in columns:
        raise ValueError("The timestamp column cannot also be a value column")
    if config["timestampUnit"] not in ("iso", "s", "ms", "us", "ns"):
        raise ValueError(
            "Choose ISO timestamps or integer epoch seconds, ms, µs, or ns"
        )
    if any(
        not isinstance(c, str) or not c or len(c) > 128
        for c in [config["timestampColumn"], *columns]
    ):
        raise ValueError("Column names must be nonempty and at most 128 characters")


def input_batches(source: Path, config: dict):
    """Arrow's bounded record parser handles quoted CSV records; Polars handles transforms.

    Explicit timestamp strings avoid inference through float64 or microsecond timestamps.
    Unselected CSV/JSON fields are not materialized.
    """
    names = [config["timestampColumn"], *config["valueColumns"]]
    if config["format"] == "csv":
        reader = pacsv.open_csv(
            source,
            read_options=pacsv.ReadOptions(block_size=READ_BYTES, use_threads=False),
            parse_options=pacsv.ParseOptions(newlines_in_values=True),
            convert_options=pacsv.ConvertOptions(
                include_columns=names,
                column_types={name: pa.string() for name in names},
                strings_can_be_null=True,
            ),
        )
    else:
        # Epoch JSON numbers stay int64. ISO strings stay strings, including all 9 fractional digits.
        schema = pa.schema(
            [
                (
                    names[0],
                    pa.string() if config["timestampUnit"] == "iso" else pa.int64(),
                ),
                *[(name, pa.float64()) for name in names[1:]],
            ]
        )
        reader = pajson.open_json(
            source,
            read_options=pajson.ReadOptions(block_size=READ_BYTES, use_threads=False),
            parse_options=pajson.ParseOptions(
                explicit_schema=schema, unexpected_field_behavior="ignore"
            ),
        )
    offset = 0
    for batch in reader:
        frame = pl.from_arrow(batch)
        timestamp = pl.col(names[0])
        if config["timestampUnit"] == "iso":
            timestamp = timestamp.str.to_datetime(
                time_unit="ns", time_zone="UTC", strict=True
            ).cast(pl.Int64)
        else:
            multiplier = {"s": 1_000_000_000, "ms": 1_000_000, "us": 1000, "ns": 1}[
                config["timestampUnit"]
            ]
            # Decimal multiplication detects int64 overflow instead of silently wrapping.
            timestamp = (
                timestamp.cast(pl.Int64).cast(pl.Decimal(38, 0)) * multiplier
            ).cast(pl.Int64)
        result = frame.select(
            timestamp.alias("ts"),
            *[
                pl.col(name).cast(pl.Float64, strict=True).alias(f"v{i}")
                for i, name in enumerate(names[1:])
            ],
        )
        if (
            result.null_count().sum_horizontal().item()
            or not result.select(pl.all().is_finite().all()).row(0).count(True)
            == result.width
        ):
            raise ValueError(
                f"Missing, nonnumeric, or nonfinite selected data near row {offset + 1}. No rows were silently dropped."
            )
        result = result.with_columns(
            pl.int_range(offset, offset + len(result), dtype=pl.Int64).alias("row")
        )
        offset += len(result)
        yield result


def summarize(frame: pl.DataFrame, width: int, columns: int, raw: bool):
    expressions = [
        pl.col("ts" if raw else "lo").first().alias("lo"),
        pl.col("ts" if raw else "hi").last().alias("hi"),
        pl.col("row" if raw else "first_row").first().alias("first_row"),
        pl.col("row" if raw else "last_row").last().alias("last_row"),
        (pl.len().cast(pl.UInt64) if raw else pl.col("count").sum()).alias("count"),
    ]
    for i in range(columns):
        col = f"v{i}"
        lo, hi = (col, col) if raw else (f"{col}_min", f"{col}_max")
        expressions.extend(
            [
                pl.col(col if raw else f"{col}_first").first().alias(f"{col}_first"),
                pl.col(col if raw else f"{col}_last").last().alias(f"{col}_last"),
                pl.col(lo).min().alias(f"{col}_min"),
                pl.col(hi).max().alias(f"{col}_max"),
                pl.col("ts" if raw else f"{col}_min_t")
                .get(pl.col(lo).arg_min())
                .alias(f"{col}_min_t"),
                pl.col("ts" if raw else f"{col}_max_t")
                .get(pl.col(hi).arg_max())
                .alias(f"{col}_max_t"),
                pl.col("row" if raw else f"{col}_min_r")
                .get(pl.col(lo).arg_min())
                .alias(f"{col}_min_r"),
                pl.col("row" if raw else f"{col}_max_r")
                .get(pl.col(hi).arg_max())
                .alias(f"{col}_max_r"),
            ]
        )
    return (
        frame.with_columns(
            (pl.col("row" if raw else "first_row") // width).alias("bucket")
        )
        .group_by("bucket", maintain_order=True)
        .agg(expressions)
        .drop("bucket")
    )


class PartitionWriter:
    def __init__(self, root: Path, level: int, capacity: int):
        self.directory = root / f"level-{level}"
        self.directory.mkdir(parents=True, exist_ok=True)
        self.root, self.level, self.capacity = root, level, capacity
        self.pending: list[pl.DataFrame] = []
        self.length = 0
        self.parts: list[dict] = []

    def append(self, frame: pl.DataFrame):
        for offset in range(0, len(frame), self.capacity):
            self.pending.append(frame.slice(offset, self.capacity))
            self.length += len(self.pending[-1])
            if self.length >= self.capacity:
                combined = pl.concat(self.pending, rechunk=False)
                self.write(combined.head(self.capacity))
                remainder = combined.slice(self.capacity)
                self.pending = [remainder] if len(remainder) else []
                self.length = len(remainder)

    def write(self, frame: pl.DataFrame):
        if not len(frame):
            return
        path = self.directory / f"part-{len(self.parts):06d}.parquet"
        frame.write_parquet(
            path,
            compression="zstd",
            compression_level=1,
            statistics=True,
            row_group_size=8192 if self.level == 0 else 1024,
        )
        raw = self.level == 0
        self.parts.append(
            {
                "path": str(path.relative_to(self.root)),
                "lo": int(frame["ts" if raw else "lo"][0]),
                "hi": int(frame["ts" if raw else "hi"][-1]),
                "first": int(frame["row" if raw else "first_row"][0]),
                "last": int(frame["row" if raw else "last_row"][-1]),
                "rows": len(frame),
            }
        )

    def finish(self):
        if self.pending:
            self.write(pl.concat(self.pending, rechunk=False))
        self.pending, self.length = [], 0
        return self.parts


def parquet_batches(root: Path, parts: list[dict]):
    for part in parts:
        for batch in pq.ParquetFile(root / part["path"]).iter_batches(
            batch_size=RAW_ROWS
        ):
            yield pl.from_arrow(batch)


def build_lods(root: Path, raw_parts: list[dict], columns: int, report: Callable):
    levels = [{"width": 1, "parts": raw_parts}]
    for level, width in enumerate(LEVEL_WIDTHS, 1):
        if levels[-1]["width"] >= raw_parts[-1]["last"] + 1:
            break
        writer = PartitionWriter(root, level, SUMMARY_ROWS)
        report(
            {
                "stage": "aggregating",
                "progress": min(0.98, 0.72 + (level - 1) * 0.035),
                "level": level,
            }
        )
        carry = None
        for frame in parquet_batches(root, levels[-1]["parts"]):
            if carry is not None:
                frame = pl.concat([carry, frame], rechunk=False)
            # Carry the final unfinished bucket across reader and partition boundaries.
            key = "row" if level == 1 else "first_row"
            final_bucket = int(frame[key][-1]) // width
            split = int(
                frame.select(((pl.col(key) // width) < final_bucket).sum()).item()
            )
            if split:
                writer.append(summarize(frame.head(split), width, columns, level == 1))
            carry = frame.slice(split)
        if carry is not None:
            writer.append(summarize(carry, width, columns, level == 1))
        parts = writer.finish()
        levels.append({"width": width, "parts": parts})
        report(
            {
                "stage": "aggregating",
                "progress": min(0.98, 0.72 + level * 0.035),
                "level": level,
            }
        )
    return levels


def ingest(
    source: Path, destination: Path, config: dict, report: Callable = lambda _: None
):
    validate_config(config)
    started = time.perf_counter()
    stat = source.stat()
    if not stat.st_size:
        raise ValueError("The input file is empty")
    work = destination.with_name(f".{destination.name}.processing")
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    staging = work / "staging"
    staging.mkdir()
    rows, sorted_input, previous = 0, True, None
    columns = len(config["valueColumns"])
    minima, maxima, sums = (
        [float("inf")] * columns,
        [float("-inf")] * columns,
        [0.0] * columns,
    )
    stage_parts = []
    try:
        for index, frame in enumerate(input_batches(source, config)):
            times = frame["ts"]
            if (
                not times.is_sorted()
                or previous is not None
                and int(times[0]) < previous
            ):
                sorted_input = False
            previous = int(times[-1])
            rows += len(frame)
            for i in range(columns):
                values = frame[f"v{i}"]
                minima[i] = min(minima[i], values.min())
                maxima[i] = max(maxima[i], values.max())
                sums[i] += values.sum()
            path = staging / f"{index:06d}.parquet"
            frame.write_parquet(
                path, compression="zstd", compression_level=1, row_group_size=8192
            )
            stage_parts.append(path)
            if index % 4 == 0:
                report(
                    {
                        "stage": "validating",
                        "rowsProcessed": rows,
                        "progress": min(
                            0.45, 0.45 * (index + 1) * READ_BYTES / stat.st_size
                        ),
                    }
                )
        if rows < 2:
            raise ValueError("A dataset needs at least two rows")
        if (
            source.stat().st_size != stat.st_size
            or source.stat().st_mtime_ns != stat.st_mtime_ns
        ):
            raise ValueError(
                "The source file changed during import. Retry with a stable file."
            )
        report(
            {
                "stage": "partitioning" if sorted_input else "sorting",
                "rowsProcessed": rows,
                "progress": 0.48,
            }
        )
        if not sorted_input:
            # Disk-spilling external sort. The original row number resolves duplicate timestamps.
            sorted_file = work / "sorted.parquet"
            with connect(work / "spill") as connection:
                target = str(sorted_file).replace("'", "''")
                connection.execute(
                    f"COPY (SELECT * FROM read_parquet(?) ORDER BY ts, row) TO '{target}' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 8192)",
                    [[str(p) for p in stage_parts]],
                )
            frames = (
                pl.from_arrow(batch)
                for batch in pq.ParquetFile(sorted_file).iter_batches(
                    batch_size=RAW_ROWS
                )
            )
        else:
            frames = (
                pl.from_arrow(batch)
                for path in stage_parts
                for batch in pq.ParquetFile(path).iter_batches(batch_size=RAW_ROWS)
            )
        writer = PartitionWriter(work, 0, RAW_ROWS)
        sequence = 0
        for frame in frames:
            # Canonical ordinal follows time order, even after an external sort.
            frame = frame.with_columns(
                pl.int_range(sequence, sequence + len(frame), dtype=pl.Int64).alias(
                    "row"
                )
            )
            sequence += len(frame)
            writer.append(frame)
            report(
                {
                    "stage": "partitioning",
                    "progress": 0.50 + 0.20 * sequence / rows,
                    "rowsProcessed": rows,
                }
            )
        raw_parts = writer.finish()
        shutil.rmtree(staging)
        (work / "sorted.parquet").unlink(missing_ok=True)
        shutil.rmtree(work / "spill", ignore_errors=True)
        levels = build_lods(work, raw_parts, columns, report)
        first, last = raw_parts[0]["lo"], raw_parts[-1]["hi"]
        if last <= first:
            raise ValueError("The dataset needs at least two distinct timestamps")
        metadata = {
            "id": destination.name,
            "kind": "imported",
            "size": rows,
            "seed": 0,
            "label": config.get("label") or source.stem,
            "unit": config.get("unit", ""),
            "columns": config["valueColumns"],
            "timestampColumn": config["timestampColumn"],
            "startTimeNs": str(first),
            "endTimeNs": str(last),
            "startTime": first / 1e6,
            "durationMs": (last - first) / 1e6,
            "intervalMs": (last - first) / 1e6 / (rows - 1),
            "min": minima[0],
            "max": maxima[0],
            "mean": sums[0] / rows,
            "columnStats": {
                name: {"min": minima[i], "max": maxima[i], "mean": sums[i] / rows}
                for i, name in enumerate(config["valueColumns"])
            },
            "sourceBytes": stat.st_size,
            "sourceFormat": config["format"],
            "generationSeconds": round(time.perf_counter() - started, 3),
            "storageBytes": sum(p.stat().st_size for p in work.rglob("*.parquet")),
            "sortedOnImport": not sorted_input,
            "levels": levels,
            "overview": [],
        }
        atomic_json(work / "manifest.json", metadata)
        work.rename(destination)
        report({"stage": "ready", "progress": 1, "rowsProcessed": rows})
        return metadata
    except BaseException:
        shutil.rmtree(work, ignore_errors=True)
        raise
