"""Indexed partition selection and exact-boundary multiresolution range retrieval."""

from __future__ import annotations

import bisect
import json
import math
import time
from functools import lru_cache
from pathlib import Path

import numpy as np

from .storage import connect

MAX_POINTS = 8192


@lru_cache(maxsize=24)
def load_manifest(path: str, modified: int):
    info = json.loads(Path(path).read_text())
    for level in info.get("levels", []):
        level["starts"] = [part["lo"] for part in level["parts"]]
        level["ends"] = [part["hi"] for part in level["parts"]]
    return info


def manifest(root: Path, identifier: str):
    if (
        not identifier
        or len(identifier) > 80
        or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in identifier)
    ):
        raise ValueError("Invalid dataset identifier")
    path = root / identifier / "manifest.json"
    return load_manifest(str(path), path.stat().st_mtime_ns)


def selected_parts(level, start: int, end: int, row_range=None):
    left, right = (
        bisect.bisect_left(level["ends"], start),
        bisect.bisect_right(level["starts"], end),
    )
    parts = level["parts"][left:right]
    if row_range is not None:
        parts = [
            part
            for part in parts
            if part["last"] >= row_range[0] and part["first"] <= row_range[1]
        ]
    return parts


def public_metadata(info: dict):
    result = {k: v for k, v in info.items() if k != "levels"}
    if info.get("kind") != "imported":
        result.update(
            kind="synthetic",
            columns=["value"],
            startTimeNs=str(int(info["startTime"] * 1_000_000)),
            endTimeNs=str(
                int(info["startTime"] * 1_000_000)
                + (info["size"] - 1) * int(info["intervalMs"] * 1_000_000)
            ),
            durationMs=(info["size"] - 1) * info["intervalMs"],
        )
    else:
        result["lodWidths"] = [level["width"] for level in info["levels"]]
    return result


def range_query(
    root: Path,
    identifier: str,
    start: int,
    end: int,
    columns: list[str],
    max_points: int = 4096,
):
    began = time.perf_counter()
    if start > end or not 32 <= max_points <= MAX_POINTS:
        raise ValueError("Invalid time range or point budget (32–8192)")
    info = manifest(root, identifier)
    available = info.get("columns", ["value"])
    if (
        not columns
        or len(columns) > 8
        or len(set(columns)) != len(columns)
        or any(c not in available for c in columns)
    ):
        raise ValueError("Choose existing value columns, at most eight")
    if info.get("kind") != "imported":
        result = synthetic_range(root, info, start, end, max_points)
        result["queryMs"] = (time.perf_counter() - began) * 1000
        return result
    levels = info["levels"]
    raw_parts = selected_parts(levels[0], start, end)
    estimate = sum(
        max(
            1,
            math.ceil(
                p["rows"]
                * max(0, min(end, p["hi"]) - max(start, p["lo"]) + 1)
                / max(1, p["hi"] - p["lo"] + 1)
            ),
        )
        for p in raw_parts
    )
    level_index = 0
    for i, level in enumerate(levels):
        level_index = i
        if estimate / level["width"] * (1 if i == 0 else 4) <= max_points * 0.65:
            break
    indices = [available.index(c) for c in columns]
    touched: set[str] = set()
    inspected = 0
    # Every response consists of actual recorded samples, never synthetic averages.
    series: dict[str, dict[int, tuple[int, float]]] = {c: {} for c in columns}
    count = 0
    with connect(root / ".query-spill") as connection:

        def visit(index: int, row_range=None):
            nonlocal count, inspected
            level = levels[index]
            parts = selected_parts(level, start, end, row_range)
            if not parts:
                return
            files = [str(root / identifier / p["path"]) for p in parts]
            touched.update(files)
            if index == 0:
                selected = ", ".join(["ts", "row", *[f"v{i}" for i in indices]])
                sql = (
                    f"SELECT {selected} FROM read_parquet(?) WHERE ts >= ? AND ts <= ?"
                )
                params = [files, start, end]
                if row_range is not None:
                    sql += " AND row >= ? AND row <= ?"
                    params.extend(row_range)
                sql += " ORDER BY ts, row LIMIT ?"
                params.append(max_points + 1)
                records = connection.execute(sql, params).fetchall()
                if len(records) > max_points:
                    raise OverflowError
                count += len(records)
                inspected += len(records)
                for record in records:
                    for j, column in enumerate(columns):
                        series[column][record[1]] = (record[0], record[j + 2])
                return
            selected = ["lo", "hi", "first_row", "last_row", "count"]
            for i in indices:
                selected.extend(
                    f"v{i}_{suffix}"
                    for suffix in (
                        "first",
                        "last",
                        "min",
                        "max",
                        "min_t",
                        "max_t",
                        "min_r",
                        "max_r",
                    )
                )
            sql = f"SELECT {', '.join(selected)} FROM read_parquet(?) WHERE hi >= ? AND lo <= ?"
            params = [files, start, end]
            if row_range is not None:
                sql += " AND first_row >= ? AND last_row <= ?"
                params.extend(row_range)
            sql += " ORDER BY first_row LIMIT ?"
            params.append(max_points // 4 + 3)
            records = connection.execute(sql, params).fetchall()
            if len(records) >= max_points // 4 + 3:
                raise OverflowError
            inspected += len(records)
            for record in records:
                lo, hi, first, last, size = record[:5]
                if lo < start or hi > end:
                    # Refinement of only the two edge buckets preserves extrema inside
                    # arbitrary timestamp boundaries without reading a coarse bucket raw.
                    visit(index - 1, (first, last))
                    continue
                count += size
                for j, column in enumerate(columns):
                    a, b, minimum, maximum, min_t, max_t, min_r, max_r = record[
                        5 + 8 * j : 13 + 8 * j
                    ]
                    for row, timestamp, value in [
                        (first, lo, a),
                        (last, hi, b),
                        (min_r, min_t, minimum),
                        (max_r, max_t, maximum),
                    ]:
                        series[column][row] = (timestamp, value)

        while True:
            try:
                visit(level_index)
                break
            except OverflowError:
                if level_index + 1 >= len(levels):
                    raise ValueError("The requested range exceeds the query budget")
                level_index += 1
                count = 0
                for values in series.values():
                    values.clear()
    result = {
        "series": {},
        "sourceRows": count,
        "level": levels[level_index]["width"],
        "partitionsRead": len(touched),
        "partitionsTotal": sum(len(x["parts"]) for x in levels),
        "summaryRowsRead": inspected,
        "queryMs": (time.perf_counter() - began) * 1000,
        "startNs": str(start),
        "endNs": str(end),
    }
    for column, records in series.items():
        points = sorted(
            ((timestamp, value, row) for row, (timestamp, value) in records.items()),
            key=lambda x: (x[0], x[2]),
        )
        # Edge refinement can add a few hundred vertices. A final bounded extrema
        # pass preserves every bucket's min/max and the global endpoints.
        if len(points) > max_points:
            group = math.ceil(len(points) / max(1, (max_points - 2) // 4))
            retained = {0, len(points) - 1}
            for i in range(0, len(points), group):
                block = points[i : i + group]
                retained.update(
                    [
                        i,
                        i + len(block) - 1,
                        i + min(range(len(block)), key=lambda j: block[j][1]),
                        i + max(range(len(block)), key=lambda j: block[j][1]),
                    ]
                )
            points = [points[i] for i in sorted(retained)]
        result["series"][column] = {
            "timeNs": [str(p[0]) for p in points],
            "values": [p[1] for p in points],
            "rows": [p[2] for p in points],
        }
    return result


def synthetic_range(root: Path, info: dict, start: int, end: int, budget: int):
    origin = int(info["startTime"] * 1_000_000)
    step = int(info["intervalMs"] * 1_000_000)
    first, last = (
        max(0, -(-(start - origin) // step)),
        min(info["size"] - 1, (end - origin) // step),
    )
    points = []
    if first <= last:
        values = np.load(root / info["id"] / "values.npy", mmap_mode="r")
        stride = max(1, math.ceil((last - first + 1) / max(1, (budget - 2) // 4)))
        for offset in range(first, last + 1, stride):
            block = values[offset : min(last + 1, offset + stride)]
            for index in sorted(
                {
                    offset,
                    offset + len(block) - 1,
                    offset + int(block.argmin()),
                    offset + int(block.argmax()),
                }
            ):
                points.append((origin + index * step, float(values[index]), index))
    return {
        "series": {
            "value": {
                "timeNs": [str(p[0]) for p in points],
                "values": [p[1] for p in points],
                "rows": [p[2] for p in points],
            }
        },
        "sourceRows": max(0, last - first + 1),
        "level": 1 if last - first < budget else stride,
        "partitionsRead": 1 if points else 0,
        "partitionsTotal": 1,
        "summaryRowsRead": len(points),
        "startNs": str(start),
        "endNs": str(end),
    }
