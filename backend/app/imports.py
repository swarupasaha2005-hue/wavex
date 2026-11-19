"""Crash-safe upload journals and a durable import queue.

Locally (and on any non-Vercel host), journals/jobs live as JSON files under WAVEX_DATA_DIR
and a single subprocess worker drains an in-memory queue, exactly as before.

On Vercel (ON_VERCEL), there is no persistent local disk across requests/instances and no
background worker process, so this module instead keeps upload journals, job records, and
finished datasets as plain JSON/Parquet blobs in Vercel Blob, and runs each import
synchronously (no queue) inside the request that completes the upload, against that one
invocation's local /tmp. This is intentionally simple rather than horizontally scalable —
fine for occasional/small imports, not for heavy concurrent production use.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import sys
import uuid
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from .storage import atomic_json, ingest, validate_config
from . import remote_storage as remote

router = APIRouter()
CHUNK_BYTES = 8 * 1024 * 1024
MAX_FILE_BYTES = 10 * 1024**3

SAMPLE_DIR = Path(__file__).parent / "sample_data"
SAMPLE_DATASETS = {
    "uk-weather": {
        "path": SAMPLE_DIR / "uk_weather.csv",
        "config": {
            "format": "csv",
            "timestampColumn": "time",
            "timestampUnit": "iso",
            "valueColumns": [
                "London_Temperature",
                "Manchester_Temperature",
                "Edinburgh_Temperature",
                "Cardiff_Temperature",
                "Belfast_Humidity",
                "Glasgow_Rainfall",
                "Aberdeen_Wind_Speed",
            ],
            "label": "UK Weather",
            "unit": "",
        },
    },
}


class ImportConfig(BaseModel):
    format: Literal["csv", "jsonl"] = "csv"
    timestampColumn: str = Field(default="timestamp", min_length=1, max_length=128)
    timestampUnit: Literal["iso", "s", "ms", "us", "ns"] = "iso"
    valueColumns: list[str] = Field(default=["value"], min_length=1, max_length=8)
    label: str = Field(default="", max_length=128)
    unit: str = Field(default="", max_length=32)


class UploadCreate(ImportConfig):
    filename: str = Field(min_length=1, max_length=255)
    size: int = Field(ge=1, le=MAX_FILE_BYTES)
    fingerprint: str = Field(default="", max_length=128)


class LocalCreate(ImportConfig):
    path: str = Field(min_length=1, max_length=4096)


def valid_identifier(identifier: str) -> bool:
    return len(identifier) == 32 and all(c in "0123456789abcdef" for c in identifier)


def safe_job(job):
    return {key: value for key, value in job.items() if key not in ("source", "config")}


# ---------------------------------------------------------------------------
# Local filesystem path (unchanged behavior for local dev / non-Vercel hosts)
# ---------------------------------------------------------------------------


def read_state(root: Path, folder: str, identifier: str):
    if not valid_identifier(identifier):
        raise HTTPException(404, "Import session not found")
    path = root / folder / f"{identifier}.json"
    if not path.exists():
        raise HTTPException(404, "Import session not found")
    return path, json.loads(path.read_text())


class ImportManager:
    def __init__(self, root: Path):
        self.root = root
        self.queue: asyncio.Queue[str] = asyncio.Queue()
        self.locks: dict[str, asyncio.Lock] = {}
        self.active: set[str] = set()
        self.retries: set[str] = set()
        self.process = None
        self.runner = None
        self.stopping = False

    def start(self):
        if remote.ON_VERCEL:
            return
        # Prevent two local servers from writing the same processing directories.
        self.owner = (self.root / ".import-owner.lock").open("a+b")
        try:
            if os.name == "nt":
                import msvcrt

                self.owner.seek(0)
                self.owner.write(b"0")
                self.owner.flush()
                self.owner.seek(0)
                msvcrt.locking(self.owner.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(self.owner.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.owner.close()
            raise RuntimeError(
                "Another WaveX import supervisor already owns this data directory"
            )
        for path in (self.root / ".jobs").glob("*.json"):
            job = json.loads(path.read_text())
            if job["status"] in ("queued", "processing"):
                job.update(status="queued", stage="recovering", error=None)
                atomic_json(path, job)
                self.enqueue(job["id"])
        self.runner = asyncio.create_task(self.run())

    def enqueue(self, identifier, retry=False):
        if identifier in self.active and retry:
            self.retries.add(identifier)
        if identifier not in self.active:
            self.active.add(identifier)
            self.queue.put_nowait(identifier)

    async def run(self):
        while not self.stopping:
            identifier = await self.queue.get()
            try:
                log = self.root / ".jobs" / f"{identifier}.log"
                with log.open("ab") as handle:
                    env = {
                        **os.environ,
                        "WAVEX_DATA_DIR": str(self.root),
                        "POLARS_MAX_THREADS": "2",
                    }
                    self.process = await asyncio.create_subprocess_exec(
                        sys.executable,
                        "-m",
                        f"{__package__}.import_worker",
                        identifier,
                        # package is backend.app locally, app when deployed from backend/
                        cwd=Path(__file__).resolve().parents[__package__.count(".") + 1],
                        env=env,
                        stdout=handle,
                        stderr=handle,
                    )
                    code = await self.process.wait()
                path, job = read_state(self.root, ".jobs", identifier)
                if code != 0 and job["status"] != "error" and not self.stopping:
                    job.update(
                        status="error",
                        stage="error",
                        error="Import worker exited unexpectedly. Retry the job; the source is retained.",
                    )
                    atomic_json(path, job)
            except Exception as exc:
                path, job = read_state(self.root, ".jobs", identifier)
                job.update(
                    status="error",
                    stage="error",
                    error=f"Import supervisor error: {str(exc)[:500]}. Retry the job.",
                )
                atomic_json(path, job)
            finally:
                self.process = None
                self.active.discard(identifier)
                self.queue.task_done()
                if identifier in self.retries:
                    self.retries.discard(identifier)
                    self.enqueue(identifier)

    async def stop(self):
        self.stopping = True
        if remote.ON_VERCEL:
            return
        if self.process is not None and self.process.returncode is None:
            self.process.terminate()
            await self.process.wait()
        if self.runner:
            self.runner.cancel()
            try:
                await self.runner
            except asyncio.CancelledError:
                pass
        self.owner.close()

    def create_job(self, source: Path, config: dict, identifier: str | None = None):
        identifier = identifier or uuid.uuid4().hex
        job = {
            "id": identifier,
            "datasetId": f"import-{identifier}",
            "source": str(source),
            "config": config,
            "status": "queued",
            "stage": "queued",
            "progress": 0,
            "rowsProcessed": 0,
        }
        atomic_json(self.root / ".jobs" / f"{identifier}.json", job)
        self.enqueue(identifier)
        return safe_job(job)


def manager(request: Request) -> ImportManager:
    return request.app.state.imports


# ---------------------------------------------------------------------------
# Vercel path: everything is a JSON/Parquet blob in Vercel Blob, no database.
# Each import runs synchronously inside the request that completes the upload.
# ---------------------------------------------------------------------------


def remote_read_upload(identifier: str) -> dict:
    if not valid_identifier(identifier):
        raise HTTPException(404, "Import session not found")
    state = remote.blob_get_json(f"uploads/{identifier}/journal.json")
    if not state:
        raise HTTPException(404, "Import session not found")
    return state


def remote_write_upload(state: dict):
    remote.blob_put_json(f"uploads/{state['id']}/journal.json", state)


def remote_read_job(identifier: str) -> dict:
    if not valid_identifier(identifier):
        raise HTTPException(404, "Import job not found")
    job = remote.blob_get_json(f"jobs/{identifier}.json")
    if not job:
        raise HTTPException(404, "Import job not found")
    return job


def remote_write_job(job: dict):
    remote.blob_put_json(f"jobs/{job['id']}.json", job)


def remote_run_job(job: dict):
    """Runs one import to completion against this invocation's /tmp, then publishes to Blob."""
    work_root = Path(f"/tmp/wavex-import-{job['id']}")
    shutil.rmtree(work_root, ignore_errors=True)
    work_root.mkdir(parents=True)
    source = work_root / "source"
    destination = work_root / job["datasetId"]
    try:
        job.update(status="processing", stage="downloading", progress=0, error=None)
        if job["config"].get("_sampleKey"):
            # Bundled with the deployment itself, not /tmp — no download needed.
            source = SAMPLE_DATASETS[job["config"]["_sampleKey"]]["path"]
        elif job["config"].get("_uploadId"):
            chunk_prefix = f"uploads/{job['config']['_uploadId']}/chunks/"
            with source.open("wb") as handle:
                offset = 0
                while offset < job["config"]["_uploadSize"]:
                    handle.write(remote.blob_get(f"{chunk_prefix}{offset:012d}.bin"))
                    offset += CHUNK_BYTES
        else:
            source.write_bytes(remote.blob_get(job["config"]["_sourceBlobKey"]))
        ingest(source, destination, job["config"], lambda update: job.update(update))
        for path in destination.rglob("*"):
            if path.is_file():
                key = f"datasets/{job['datasetId']}/{path.relative_to(destination)}"
                remote.blob_put(key, path.read_bytes())
        if job["config"].get("_uploadId"):
            remote.blob_delete(f"uploads/{job['config']['_uploadId']}/")
        job.update(status="ready", stage="ready", progress=1)
    except Exception as exc:
        job.update(
            status="error",
            stage="error",
            error=f"{type(exc).__name__}: {str(exc)[:1200]}",
        )
    finally:
        remote_write_job(job)
        shutil.rmtree(work_root, ignore_errors=True)
    return job


def ensure_samples_imported(root: Path):
    """Pre-imports every bundled sample so it's already in the dataset library on startup,
    instead of only appearing after someone opens the import panel and loads it manually."""
    for key, sample in SAMPLE_DATASETS.items():
        job_id = hashlib.md5(f"sample-{key}".encode()).hexdigest()
        dataset_id = f"import-{job_id}"
        if remote.ON_VERCEL:
            existing = remote.blob_get_json(f"jobs/{job_id}.json")
            if existing and existing["status"] == "ready":
                continue
            remote_run_job(
                {
                    "id": job_id,
                    "datasetId": dataset_id,
                    "config": {**sample["config"], "_sampleKey": key},
                    "status": "queued",
                    "stage": "queued",
                    "progress": 0,
                    "rowsProcessed": 0,
                }
            )
        else:
            if (root / dataset_id / "manifest.json").exists():
                continue
            try:
                ingest(sample["path"], root / dataset_id, sample["config"])
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Routes: branch per-request on ON_VERCEL
# ---------------------------------------------------------------------------


@router.post("/uploads", status_code=201)
async def create_upload(config: UploadCreate, request: Request):
    try:
        validate_config(config.model_dump())
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    identifier = uuid.uuid4().hex
    state = {
        "id": identifier,
        "offset": 0,
        "chunkBytes": CHUNK_BYTES,
        **config.model_dump(),
        "jobId": None,
    }
    if remote.ON_VERCEL:
        remote_write_upload(state)
        return state
    root = manager(request).root
    # Reserve headroom for the source, Parquet, sorting and temporary files.
    if shutil.disk_usage(root).free < config.size * 3 + 256 * 1024**2:
        raise HTTPException(
            507, "Insufficient free disk space for the source and processing files"
        )
    directory = root / ".uploads"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{identifier}.part").touch()
    atomic_json(directory / f"{identifier}.json", state)
    return state


@router.get("/uploads/{identifier}")
async def upload_status(identifier: str, request: Request):
    if remote.ON_VERCEL:
        return remote_read_upload(identifier)
    return read_state(manager(request).root, ".uploads", identifier)[1]


@router.put("/uploads/{identifier}")
async def upload_chunk(identifier: str, request: Request):
    checksum = request.headers.get("X-Chunk-SHA256", "")
    if len(checksum) != 64 or any(c not in "0123456789abcdef" for c in checksum):
        raise HTTPException(400, "Send a SHA-256 checksum for every chunk")
    try:
        offset = int(request.headers.get("Upload-Offset", "-1"))
    except ValueError:
        raise HTTPException(400, "Upload-Offset must be an integer")

    if remote.ON_VERCEL:
        state = remote_read_upload(identifier)
        if offset != state["offset"]:
            raise HTTPException(409, detail={"offset": state["offset"]})
        if state["jobId"] or offset >= state["size"]:
            raise HTTPException(409, "This upload is already complete")
        digest, body = hashlib.sha256(), b""
        async for chunk in request.stream():
            body += chunk
            if len(body) > CHUNK_BYTES or offset + len(body) > state["size"]:
                raise HTTPException(
                    413, "Chunk exceeds the negotiated size or file boundary"
                )
        digest.update(body)
        if not body or digest.hexdigest() != checksum:
            raise HTTPException(422, "Empty chunk or checksum mismatch; resend this chunk")
        remote.blob_put(f"uploads/{identifier}/chunks/{offset:012d}.bin", body)
        state["offset"] = offset + len(body)
        remote_write_upload(state)
        return {"id": identifier, "offset": state["offset"]}

    service = manager(request)
    async with service.locks.setdefault(identifier, asyncio.Lock()):
        path, state = read_state(service.root, ".uploads", identifier)
        if offset != state["offset"]:
            raise HTTPException(409, detail={"offset": state["offset"]})
        if state["jobId"] or offset >= state["size"]:
            raise HTTPException(409, "This upload is already complete")
        source = path.with_suffix(".part")
        digest, written = hashlib.sha256(), 0
        with source.open("r+b") as handle:
            handle.truncate(offset)
            handle.seek(offset)
            try:
                async for chunk in request.stream():
                    written += len(chunk)
                    if written > CHUNK_BYTES or offset + written > state["size"]:
                        raise HTTPException(
                            413, "Chunk exceeds the negotiated size or file boundary"
                        )
                    digest.update(chunk)
                    await asyncio.to_thread(handle.write, chunk)
                if not written or digest.hexdigest() != checksum:
                    raise HTTPException(
                        422, "Empty chunk or checksum mismatch; resend this chunk"
                    )
                await asyncio.to_thread(handle.flush)
                await asyncio.to_thread(os.fsync, handle.fileno())
            except BaseException:
                handle.truncate(offset)
                raise
        state["offset"] += written
        atomic_json(path, state)
        return {"id": identifier, "offset": state["offset"]}


@router.post("/uploads/{identifier}/complete", status_code=202)
async def complete_upload(identifier: str, request: Request):
    if remote.ON_VERCEL:
        state = remote_read_upload(identifier)
        if state["jobId"]:
            return safe_job(remote_read_job(state["jobId"]))
        if state["offset"] != state["size"]:
            raise HTTPException(409, "Upload every byte before completing")
        job_id = identifier
        job = {
            "id": job_id,
            "datasetId": f"import-{job_id}",
            "config": {
                **{k: state[k] for k in ImportConfig.model_fields},
                "_uploadId": identifier,
                "_uploadSize": state["size"],
            },
            "status": "queued",
            "stage": "queued",
            "progress": 0,
            "rowsProcessed": 0,
        }
        state["jobId"] = job_id
        remote_write_upload(state)
        job = await asyncio.to_thread(remote_run_job, job)
        return safe_job(job)

    service = manager(request)
    async with service.locks.setdefault(identifier, asyncio.Lock()):
        path, state = read_state(service.root, ".uploads", identifier)
        if state["jobId"]:
            return safe_job(read_state(service.root, ".jobs", state["jobId"])[1])
        if state["offset"] != state["size"]:
            raise HTTPException(409, "Upload every byte before completing")
        job = service.create_job(path.with_suffix(".part"), state, identifier)
        state["jobId"] = identifier
        atomic_json(path, state)
        return job


@router.delete("/uploads/{identifier}")
async def discard_upload(identifier: str, request: Request):
    if remote.ON_VERCEL:
        state = remote_read_upload(identifier)
        if state["jobId"]:
            job = remote_read_job(state["jobId"])
            if job["status"] in ("queued", "processing"):
                raise HTTPException(
                    409,
                    "The import is processing. Wait for it to finish before discarding its upload session.",
                )
            if job["status"] == "error":
                job.update(
                    error="Uploaded source discarded. Start a new upload to import this file again."
                )
                remote_write_job(job)
        remote.blob_delete(f"uploads/{identifier}/")
        return {"status": "discarded"}

    service = manager(request)
    async with service.locks.setdefault(identifier, asyncio.Lock()):
        path, state = read_state(service.root, ".uploads", identifier)
        if state["jobId"]:
            job_path, job = read_state(service.root, ".jobs", state["jobId"])
            if job["status"] in ("queued", "processing"):
                raise HTTPException(
                    409,
                    "The import is processing. Wait for it to finish before discarding its upload session.",
                )
            if job["status"] == "error":
                job.update(
                    error="Uploaded source discarded. Start a new upload to import this file again."
                )
                atomic_json(job_path, job)
        path.with_suffix(".part").unlink(missing_ok=True)
        path.unlink()
        return {"status": "discarded"}


@router.post("/imports/local", status_code=202)
async def import_local(config: LocalCreate, request: Request):
    if remote.ON_VERCEL:
        raise HTTPException(
            422,
            "Local file path import isn't available on this deployment; there is no persistent "
            "backend filesystem to read from. Use Resumable upload instead.",
        )
    service = manager(request)
    source = Path(config.path).expanduser().resolve()
    try:
        validate_config(config.model_dump())
        if not source.is_file():
            raise ValueError("Enter an existing regular file on the backend machine")
        if not 0 < source.stat().st_size <= MAX_FILE_BYTES:
            raise ValueError("Files must be nonempty and at most 10 GiB")
        if (
            shutil.disk_usage(service.root).free
            < source.stat().st_size * 2 + 256 * 1024**2
        ):
            raise HTTPException(507, "Insufficient free disk space for processing")
    except (ValueError, OSError) as exc:
        raise HTTPException(422, str(exc))
    return service.create_job(source, config.model_dump())


@router.get("/imports/samples")
async def list_samples():
    """Bundled demo datasets the frontend can offer without requiring an upload."""
    return [{"key": key, "label": sample["config"]["label"]} for key, sample in SAMPLE_DATASETS.items()]


@router.post("/imports/sample/{key}", status_code=202)
async def import_sample(key: str, request: Request):
    sample = SAMPLE_DATASETS.get(key)
    if not sample:
        raise HTTPException(404, "Unknown sample dataset")
    job_id = hashlib.md5(f"sample-{key}".encode()).hexdigest()
    dataset_id = f"import-{job_id}"
    config = sample["config"]

    if remote.ON_VERCEL:
        existing = remote.blob_get_json(f"jobs/{job_id}.json")
        if existing and existing["status"] in ("queued", "processing", "ready"):
            return safe_job(existing)
        job = {
            "id": job_id,
            "datasetId": dataset_id,
            "config": {**config, "_sampleKey": key},
            "status": "queued",
            "stage": "queued",
            "progress": 0,
            "rowsProcessed": 0,
        }
        job = await asyncio.to_thread(remote_run_job, job)
        return safe_job(job)

    service = manager(request)
    if (service.root / dataset_id / "manifest.json").exists():
        return {"id": job_id, "datasetId": dataset_id, "status": "ready", "stage": "ready", "progress": 1, "rowsProcessed": 0}
    return service.create_job(sample["path"], config, job_id)


@router.get("/imports")
async def list_imports(request: Request):
    if remote.ON_VERCEL:
        jobs = []
        for name in remote.blob_list("jobs/"):
            job = remote.blob_get_json(name)
            if job:
                jobs.append(safe_job(job))
        return sorted(jobs, key=lambda j: j["id"])
    return [
        safe_job(json.loads(path.read_text()))
        for path in sorted((manager(request).root / ".jobs").glob("*.json"))
    ]


@router.get("/imports/{identifier}")
async def import_status(identifier: str, request: Request):
    if remote.ON_VERCEL:
        return safe_job(remote_read_job(identifier))
    return safe_job(read_state(manager(request).root, ".jobs", identifier)[1])


@router.post("/imports/{identifier}/retry", status_code=202)
async def retry_import(
    identifier: str, request: Request, config: ImportConfig | None = None
):
    if remote.ON_VERCEL:
        job = remote_read_job(identifier)
        if job["status"] == "error":
            if config is not None:
                try:
                    validate_config(config.model_dump())
                except ValueError as exc:
                    raise HTTPException(422, str(exc))
                job["config"].update(config.model_dump())
            job = await asyncio.to_thread(remote_run_job, job)
        return safe_job(job)

    service = manager(request)
    path, job = read_state(service.root, ".jobs", identifier)
    if job["status"] == "error":
        if config is not None:
            try:
                validate_config(config.model_dump())
            except ValueError as exc:
                raise HTTPException(422, str(exc))
            job["config"] = config.model_dump()
        job.update(status="queued", stage="queued", progress=0, error=None)
        atomic_json(path, job)
        service.enqueue(identifier, retry=True)
    return safe_job(job)
