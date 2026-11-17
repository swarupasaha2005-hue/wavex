# Reproducing scale and browser checks

The benchmark writes real, nonsparse, uncompressed source files before ingestion. They are seeded telemetry CSV/JSONL fixtures, with integer-nanosecond timestamps, three selected numeric series, noise, and isolated anomalies. No repeated padding field is used to inflate file size. The 10 GB CSV case has 198,705,152 records; the 10 GB JSONL case has 102,760,448. Sizes are decimal GB, rounded up to a complete generation batch. The machine used has 8,589,934,592 bytes of RAM, so the largest sources exceed physical RAM.

Run sequentially and clean large fixture files after preserving the reports:

```sh
POLARS_MAX_THREADS=2 backend/.venv/bin/python -m backend.benchmark --sizes-gb 1 5 10 --cleanup
POLARS_MAX_THREADS=2 backend/.venv/bin/python -m backend.benchmark --sizes-gb 1 5 10 --format jsonl --cleanup
POLARS_MAX_THREADS=2 backend/.venv/bin/python -m backend.benchmark --sizes-gb 1 --unsorted --cleanup
```

Each case runs ingestion/querying in a fresh subprocess and samples worker RSS every 50 ms. A case runs 40 queries: narrow 30-second views and broad one-fifth-dataset views at different positions, selecting two columns. Assertions verify the response point budget and that a whole-dataset overview preserves the recorded 1,000-unit anomaly. Narrow/broad queries touched 3–9 candidate partitions on the 10 GB CSV source, compared with 1,925 stored partitions across all levels. Query timings follow ingestion and do not represent cold-disk, network, or GUI latency.

Raw measurements are written to ignored `test-results/large-files-csv.json`, `large-files-jsonl.json`, and `large-files-csv-unsorted.json`. Summary measurements are preserved in the README. `--cleanup` removes each case's source and Parquet after its report is written. Without it, files remain under `backend/data/.benchmarks/`; avoid accidentally retaining several 10 GB cases on a small disk.

Run the regular browser regression against the running app:

```sh
npm run test:browser
```

It verifies generated-source regression, actual sample values, timestamp progression, pause, restart, speed, seeking, LOD zoom, drag panning, wheel zoom, cache bounds, end-of-file, exports, expanded view, mobile overflow, reduced motion, retained frames during delayed real HTTP queries, and offline recovery. It counts only backend WebSockets when checking that historical playback uses HTTP; Next.js's development HMR socket is unrelated.

For the optional large-file end-to-end checks, first create the fixtures (these take disk space), then import the 10 GB file through `/imports/local` with nanosecond timestamps and columns `value,temperature,pressure`, naming it `10 GB integration`:

```sh
mkdir -p backend/data/.integration
POLARS_MAX_THREADS=2 backend/.venv/bin/python - <<'PY'
from pathlib import Path
from backend.benchmark import generate_file
root = Path('backend/data/.integration')
generate_file(root / 'upload.csv', 1_000_000_000, 'csv')
generate_file(root / 'ten-gb.csv', 10_000_000_000, 'csv')
PY
node scripts/import-browser-test.mjs
node scripts/large-playback-test.mjs
```

`import-browser-test.mjs` selects the real 1 GB file through the browser, commits an 8 MiB chunk, pauses, reloads, resumes, completes background conversion, selects columns, explores the result, and reopens it after another reload. It records `test-results/import-browser-report.json`. `large-playback-test.mjs` opens the existing 10 GB import, seeks across it, tests 1-second through 1-day windows, changes columns, and measures 32× playback in `test-results/ten-gb-playback.json`.

The verified runs measured 60 FPS for both imported cases in isolated headless Google Chrome at 1440×1000. The 10 GB run averaged 0.313 ms CPU WebGL submission/axes time per draw, with a cache below 24,576 points. The seek report deliberately includes a 350 ms readout wait and must not be quoted as a query-latency benchmark. Whole-tab memory, OS file cache, and GPU completion time are not inferred from sample-cache size or CPU submission time.

Example screenshots are saved as `/tmp/wavex-desktop.png`, `/tmp/wavex-mobile.png`, `/tmp/wavex-imported.png`, and `/tmp/wavex-ten-gb.png`. Dataset/job IDs in reports identify temporary benchmark artifacts, which can be removed after verification.

A final density-selection follow-up is recorded separately in `final-query-density.json`; concurrent upload/browser load is recorded in `concurrent-query-density.json`. These conditions are distinct from the sequential scale cases. Consolidated raw results are preserved in [benchmark-results.json](benchmark-results.json).

`node scripts/import-retry-test.mjs` writes a small real CSV, verifies correcting a failed timestamp mapping without reuploading, and tests the local-path UI while preserving the original file. Its temporary source is cleaned after the check.

The final idle follow-up measured 18.80 ms p50 and 23.56 ms p95 after refining density selection. The concurrent follow-up is intentionally kept separately; its p95 includes competing upload and browser work.
