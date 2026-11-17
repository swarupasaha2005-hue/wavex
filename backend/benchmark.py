"""Real on-disk CSV/JSONL scale checks. Decimal GB; run cases sequentially."""

import argparse
import json
import os
import shutil
import statistics
import subprocess
import sys
import threading
import time
from pathlib import Path

import numpy as np
import polars as pl
import psutil

from backend.app.storage import ingest
from backend.app.query import range_query


def generate_file(path: Path, target: int, format: str, unsorted=False):
    offset = 0
    rng = np.random.default_rng(409)
    with path.open("wb") as handle:
        while handle.tell() < target:
            indices = np.arange(offset, offset + 65536, dtype=np.int64)
            if unsorted:
                rng.shuffle(indices)
            signal = np.round(
                72 + np.sin(indices / 2000) * 12 + rng.normal(0, 1.5, len(indices)), 6
            )
            signal[indices % 100003 == 7] = (
                1000  # Isolated recorded anomalies must survive zoom-out.
            )
            frame = pl.DataFrame(
                {
                    "timestamp": 1789344000000000000
                    + indices * 1000000
                    + indices % 997,
                    "value": signal,
                    "temperature": np.round(rng.normal(35, 2, len(indices)), 6),
                    "pressure": np.round(rng.normal(101.3, 3, len(indices)), 6),
                }
            )
            if format == "csv":
                frame.write_csv(handle, include_header=offset == 0)
            else:
                frame.write_ndjson(handle)
            offset += len(indices)
    return offset


def worker(source: Path, root: Path, format: str):
    rss = [0]
    done = threading.Event()

    def watch():
        process = psutil.Process()
        while not done.wait(0.05):
            rss[0] = max(rss[0], process.memory_info().rss)

    thread = threading.Thread(target=watch, daemon=True)
    thread.start()
    started = time.perf_counter()
    last = [0]

    def report(state):
        if time.monotonic() - last[0] > 10:
            print(json.dumps({"progress": state}), flush=True)
            last[0] = time.monotonic()

    info = ingest(
        source,
        root / "import-benchmark",
        {
            "format": format,
            "timestampColumn": "timestamp",
            "timestampUnit": "ns",
            "valueColumns": ["value", "temperature", "pressure"],
        },
        report,
    )
    ingestion_seconds = time.perf_counter() - started
    origin, end = int(info["startTimeNs"]), int(info["endTimeNs"])
    results = []
    for fraction in np.linspace(0.001, 0.98, 20):
        for span in [30_000_000_000, max(1, (end - origin) // 5)]:
            start = origin + int((end - origin - span) * fraction)
            query = range_query(
                root,
                "import-benchmark",
                start,
                min(end, start + span),
                ["value", "pressure"],
                2048,
            )
            assert len(query["series"]["value"]["values"]) <= 2048
            results.append(
                {
                    k: query[k]
                    for k in (
                        "queryMs",
                        "partitionsRead",
                        "partitionsTotal",
                        "sourceRows",
                        "level",
                    )
                }
            )
    overview = range_query(root, "import-benchmark", origin, end, ["value"], 1600)
    assert max(overview["series"]["value"]["values"]) == 1000
    done.set()
    thread.join()
    result = {
        "sourceBytes": source.stat().st_size,
        "sourceFormat": format,
        "rows": info["size"],
        "ingestionSeconds": ingestion_seconds,
        "peakWorkerRssBytes": rss[0],
        "parquetBytes": info["storageBytes"],
        "queryP50Ms": statistics.median(q["queryMs"] for q in results),
        "queryP95Ms": sorted(q["queryMs"] for q in results)[
            int(len(results) * 0.95) - 1
        ],
        "overviewMs": overview["queryMs"],
        "anomalyPreserved": True,
        "queries": results,
        "sortedOnImport": info["sortedOnImport"],
        "memoryLimit": "256MB DuckDB per connection; bounded 4MiB Arrow parsing and 131072-row Polars partitions",
    }
    (root / "result.json").write_text(json.dumps(result, indent=2))
    print(
        json.dumps({"result": {k: v for k, v in result.items() if k != "queries"}}),
        flush=True,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--sizes-gb", nargs="+", type=float, default=[1, 5, 10])
    parser.add_argument(
        "--directory", type=Path, default=Path("backend/data/.benchmarks")
    )
    parser.add_argument("--format", choices=["csv", "jsonl"], default="csv")
    parser.add_argument("--cleanup", action="store_true")
    parser.add_argument("--unsorted", action="store_true")
    parser.add_argument("--worker", type=Path)
    args = parser.parse_args()
    args.directory.mkdir(parents=True, exist_ok=True)
    if args.worker:
        worker(args.worker, args.directory, args.format)
    else:
        all_results = []
        for size in args.sizes_gb:
            case = (
                args.directory
                / f"{size:g}gb-{args.format}{'-unsorted' if args.unsorted else ''}"
            )
            case.mkdir(exist_ok=True)
            source = case / f"source.{args.format}"
            started = time.perf_counter()
            print(f"Writing a real {size:g} GB {args.format} file…", flush=True)
            rows = generate_file(source, int(size * 1e9), args.format, args.unsorted)
            print(
                f"Wrote {source.stat().st_size} bytes / {rows} rows in {time.perf_counter() - started:.2f}s",
                flush=True,
            )
            subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "backend.benchmark",
                    "--worker",
                    str(source.resolve()),
                    "--directory",
                    str(case.resolve()),
                    "--format",
                    args.format,
                ],
                check=True,
                env={**os.environ, "POLARS_MAX_THREADS": "2"},
            )
            result = json.loads((case / "result.json").read_text())
            all_results.append(result)
            report = (
                Path("test-results")
                / f"large-files-{args.format}{'-unsorted' if args.unsorted else ''}.json"
            )
            report.parent.mkdir(exist_ok=True)
            report.write_text(
                json.dumps(
                    {
                        "machineRamBytes": psutil.virtual_memory().total,
                        "cases": all_results,
                    },
                    indent=2,
                )
            )
            if args.cleanup:
                shutil.rmtree(case)
