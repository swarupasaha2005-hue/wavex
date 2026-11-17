# WaveX

Explore generated telemetry or your own **CSV/JSONL files up to 10 GiB** through a moving, interactive WebGL graph. Historical playback uses HTTP time-range queries; separately published live events use WebSockets.

## Run

Requires Node.js 20.9+ and Python 3.11+. From this folder:

```sh
npm install
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.txt
npm run dev
```

Open **http://127.0.0.1:3000**. API documentation: **http://127.0.0.1:8000/docs**. The combined launcher starts both processes; Ctrl+C stops them. Default imports run one worker at a time on the same computer, without additional services.

## Import your data

1. Choose **Import dataset** above the synthetic dataset selector.
2. Choose **Resumable upload** and select your CSV/JSONL file, or **Local file path** and enter its absolute path on the backend computer. A local import reads the existing file without uploading a second copy.
3. Enter the timestamp column, its format, and 1–8 numeric column names separated by commas. Optionally set the dataset name and value unit.
4. Choose **Upload and import** or **Import local file**. The panel reports upload progress, processing stages, row counts, and sampled worker peak memory.
5. The dataset opens when ready. Reopen it later from **Imported datasets**; select another numeric series with **Signal**.

An upload sends one 8 MiB chunk at a time with a SHA-256 checksum. **Pause upload**, reload the page, reopen the panel, reselect the same original file, and choose **Resume upload**. Its name, size, modification time, and beginning/end fingerprints must match. The server's committed byte offset determines where resumption starts. A network failure can be retried the same way.

Processing continues in the background when you close the panel. An interrupted backend resumes queued/processing jobs after restarting; processing restarts from the retained source rather than a partial conversion. Uploaded temporary source copies are removed after successful publication; your original local or browser-selected file is never deleted. Failed uploads/imports retain their uploaded source for retry. After a validation failure, correct the timestamp format or selected columns and choose **Retry import** to reuse the uploaded file without sending it again. **Discard session and start another** removes the abandoned uploaded copy when no import is active.

### Input format

CSV must have a header and comma separators. Quoted CSV fields, including quoted newlines, are supported. JSONL must contain one object per line. Selected timestamps and values must be present and finite; malformed records fail validation with an error instead of being silently skipped. Individual records must fit the bounded 4 MiB parsing block. Other fields are ignored, and only the selected timestamp/value columns are persisted in Parquet.

```csv
timestamp,value,temperature
2026-11-16T10:00:00.000000001Z,72.4,35.1
2026-11-16T10:00:00.013000007Z,73.1,35.4
2026-11-16T10:00:00.029000011Z,71.8,35.2
```

Choose **ISO 8601 / UTC** for this example. Offsets are normalized to UTC; naive ISO timestamps are interpreted as UTC. Nanosecond precision is retained. For epoch timestamps, choose the explicit integer unit: seconds, milliseconds, microseconds, or nanoseconds. JSONL epoch timestamps must be JSON integers; ISO timestamps must be strings. Fractional epoch numbers are intentionally rejected to avoid float rounding; use ISO strings or integer nanoseconds instead.

Rows can be irregularly spaced, unsorted, or share timestamps. Unsorted data is sorted with a disk-spilling DuckDB operation. Duplicate timestamps retain input order. At least two distinct timestamps are required. Timestamps must fit signed 64-bit epoch nanoseconds (approximately 1677–2262); selected values are stored as float64.

## Explore

- **Play / Pause** or **Space** advances/freezes the recorded timestamp clock.
- **Restart** or **R** rewinds to the beginning.
- Choose **Playback speed** from 0.25× through 32×.
- Change **Visible window**, use +/−, or scroll over the graph to zoom. Sub-millisecond axes use relative nanoseconds.
- Drag the graph to pan; this pauses playback. Drag the dataset timeline or press arrow keys outside the controls to seek ±10 seconds.
- Hover for an original sample's nanosecond timestamp and value. Export the combined WebGL graph and axes as PNG, or expand the graph.
- Open **Engine details** for measured FPS, CPU draw/submission time, query latency, active LOD, transferred bytes, and bounded cache usage.

Playback prefills up to 30 seconds initially; restart fills from sample zero. Reduced-motion preference starts paused. A slow/missing range freezes the data clock and retains the last complete frame. Value axes use the selected series' stored global bounds, keeping values comparable across navigation.

The synthetic generator and all four sizes remain available: 10,000, 100,000, 1 million, and 10 million points. Generate from the command line with:

```sh
backend/.venv/bin/python -m backend.app.generator --size 10000000 --seed 42
```

## Architecture and measured scale

Next.js/TypeScript/Tailwind controls a React-independent WebGL renderer. D3 computes axes and coordinate transforms. A bounded record parser feeds Polars validation/transformation, time-ordered Parquet partitions, and a stored extrema hierarchy. DuckDB queries indexed partition subsets and selected columns. The browser fetches/prefetches bounded time tiles rather than downloading dataset files.

Verified with real, fully written files on this 8 GiB RAM computer:

| Source | Size | Rows | Ingest | Peak worker RSS | Range query p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| CSV | 1.003 GB | 19.9 million | 6.83 s | 343 MB | 12.60 ms |
| CSV | 5.001 GB | 99.4 million | 37.35 s | 354 MB | 17.17 ms |
| CSV | 10.002 GB | 198.7 million | 75.12 s | 358 MB | 18.02 ms |
| JSONL | 1.001 GB | 10.3 million | 7.90 s | 303 MB | 12.87 ms |
| JSONL | 5.001 GB | 51.4 million | 39.66 s | 320 MB | 16.86 ms |
| JSONL | 10.002 GB | 102.8 million | 78.48 s | 336 MB | 16.93 ms |

A separate unsorted 1 GB CSV run exercised external sorting: 18.23 seconds, 524 MB peak worker RSS. A real 1 GB browser upload passed pause/reload/resume and reopening. The real 10 GB imported dataset measured **60 FPS** at 32× in headless Chrome; the timestamp-window cache stayed below its **24,576-point** cap. These results describe these generated-on-disk telemetry fixtures and this machine, not arbitrary file schemas or all devices. Query timings are in-process, following ingestion, and do not include HTTP or cold-disk costs. GPU draw submission time is not GPU completion time; measured animation cadence is reported separately.

See [architecture](docs/ARCHITECTURE.md) for data contracts, precision, memory bounds, and storage behavior. See [benchmarks](docs/BENCHMARKS.md) for reproduction and raw report locations.

## Checks

```sh
npm run typecheck
npm run build
npm run test:backend
# Keep the application running for browser checks:
npm run test:browser
```

Browser checks use an isolated headless Google Chrome. `PLAYWRIGHT_CHANNEL` can select another installed channel for the regular checks; `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` is supported by the main browser check. `BASE_URL` can change the frontend URL; test APIs assume the backend runs on port 8000.

For production locally, stop the dev frontend, run `npm run build`, then `npm run start --workspace frontend`; start the API with `npm run dev:backend`.

## Configuration

- `NEXT_PUBLIC_API_URL` in `frontend/.env.local`: backend URL; rebuild production assets after changing it. Example in `frontend/.env.example`.
- `WAVEX_DATA_DIR`: backend storage root, default `backend/data` (ignored by Git).
- `WAVEX_ORIGINS`: comma-separated frontend origins; localhost and 127.0.0.1 on port 3000 are allowed by default.
- `WAVEX_QUERY_MEMORY`: DuckDB memory setting per connection, default `256MB`. Two concurrent historical HTTP range queries are admitted.
- Use an SSD and leave working space for the upload, conversion, sorting spill, and Parquet. The upload preflight requires 3× the source size free; local-file imports require 2× free in the storage filesystem. A failed job reports insufficient-space/I/O errors and retains its original source for retry.
- `package-lock.json` locks frontend dependencies. `backend/requirements.lock.txt` records the tested macOS/Python 3.14 development environment; `requirements.txt` resolves platform-appropriate wheels.

The server binds loopback by default. Local-path imports can read files accessible to the backend account. This is a local workstation application; shared public hosting would require authentication, scoped file access, and quota policies. No distributed infrastructure is required for local use.

## Genuine live events

Historical replay is explicitly labeled in the interface and uses HTTP. Genuine live events are a separate backend contract: send timestamped observations to `POST /live/{name}/publish`, and subscribe at `ws://127.0.0.1:8000/ws/live/{name}`. These endpoints emit source-published observations, with no generated replay clock. See the architecture document for an example and bounded slow-consumer behavior. The current explorer UI opens historical datasets; connecting an external live source to a dedicated UI mode is separate from historical import/playback.
