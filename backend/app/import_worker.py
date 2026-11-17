"""One isolated worker per import; the parent serializes workers and persists jobs."""

import json
import sys
import time
import traceback
import threading
import psutil
from pathlib import Path
from .generator import DATA_DIR
from .storage import atomic_json, ingest


def release_upload(job):
    source = Path(job["source"])
    if source.parent == DATA_DIR / ".uploads" and source.name == f"{job['id']}.part":
        source.unlink(missing_ok=True)


def run(identifier: str):
    path = DATA_DIR / ".jobs" / f"{identifier}.json"
    job = json.loads(path.read_text())
    destination = DATA_DIR / job["datasetId"]
    if (destination / "manifest.json").exists():
        job.update(status="ready", stage="ready", progress=1)
        atomic_json(path, job)
        release_upload(job)
        return
    job.update(status="processing", stage="validating", progress=0, error=None)
    atomic_json(path, job)
    last_update = 0
    began = time.perf_counter()
    initial_rss = psutil.Process().memory_info().rss
    memory = {"rssBytes": initial_rss, "peakRssBytes": initial_rss}
    stopped = threading.Event()

    def monitor():
        process = psutil.Process()
        while not stopped.wait(0.1):
            memory["rssBytes"] = process.memory_info().rss
            memory["peakRssBytes"] = max(memory["peakRssBytes"], memory["rssBytes"])

    sampler = threading.Thread(target=monitor, daemon=True)
    sampler.start()

    def report(update):
        nonlocal last_update
        job.update(update)
        job.update(memory, processingSeconds=round(time.perf_counter() - began, 2))
        now = time.monotonic()
        if now - last_update > 0.4 or update.get("progress") == 1:
            atomic_json(path, job)
            last_update = now

    try:
        ingest(Path(job["source"]), destination, job["config"], report)
        job.update(status="ready", stage="ready", progress=1)
    except Exception as exc:
        traceback.print_exc()
        job.update(
            status="error",
            stage="error",
            error=f"{type(exc).__name__}: {str(exc)[:1200]}",
        )
    finally:
        stopped.set()
        sampler.join()
        job.update(memory, processingSeconds=round(time.perf_counter() - began, 2))
    atomic_json(path, job)
    if job["status"] == "ready":
        release_upload(job)


if __name__ == "__main__":
    run(sys.argv[1])
