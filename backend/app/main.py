from __future__ import annotations
import asyncio
import logging
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from .generator import DATA_DIR, SIZES, dataset_id, generate
from .imports import ImportManager, router as imports_router
from .live import router as live_router
from .query import manifest, public_metadata, range_query
from . import remote_storage as remote

logger = logging.getLogger("wavex")
jobs: dict[str, dict] = {}
tasks: set[asyncio.Task] = set()
generation_lock = asyncio.Lock()


@asynccontextmanager
async def lifespan(app: FastAPI):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    app.state.imports = ImportManager(DATA_DIR)
    app.state.imports.start()
    app.state.query_slots = asyncio.Semaphore(2)
    yield
    await app.state.imports.stop()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


app = FastAPI(title="WaveX data engine", version="0.2.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get(
        "WAVEX_ORIGINS", "http://127.0.0.1:3000,http://localhost:3000"
    ).split(","),
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Content-Type", "Upload-Offset", "X-Chunk-SHA256"],
)


class StripApiPrefix:
    """Vercel forwards /api/... unchanged; routes are mounted unprefixed."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "lifespan" and scope["path"].startswith("/api/"):
            scope = {**scope, "path": scope["path"][4:]}
        await self.app(scope, receive, send)


app.add_middleware(StripApiPrefix)
app.include_router(imports_router)
app.include_router(live_router)


class GenerateRequest(BaseModel):
    size: int = 1_000_000
    seed: int = Field(default=42, ge=0, le=2**32 - 1)


def metadata(identifier):
    try:
        return manifest(DATA_DIR, identifier)
    except (FileNotFoundError, ValueError):
        raise HTTPException(404, "Dataset not ready or not found")


async def build_dataset(identifier, size, seed):
    try:
        async with generation_lock:
            jobs[identifier] = {"status": "generating", "progress": 0}

            def report(value):
                jobs[identifier]["progress"] = value

            await asyncio.to_thread(generate, size, seed, DATA_DIR, report)
            jobs[identifier] = {"status": "ready", "progress": 1}
    except Exception:
        logger.exception("Generation failed")
        jobs[identifier] = {
            "status": "error",
            "progress": 0,
            "error": "Generation failed. Check logs and disk space.",
        }


@app.get("/health")
def health():
    return {
        "status": "ok",
        "sizes": SIZES,
        "historicalTransport": "http-range",
        "renderer": "webgl",
        "maxQueryPoints": 8192,
    }


@app.get("/datasets")
def list_datasets():
    ids = sorted(
        path.parent.name
        for path in DATA_DIR.glob("*/manifest.json")
        if not path.parent.name.startswith(".")
    )
    if remote.ON_VERCEL:
        ids = sorted({*ids, *remote.kv_smembers("datasets:index")})
    results = []
    for identifier in ids:
        try:
            info = manifest(DATA_DIR, identifier)
        except (FileNotFoundError, ValueError):
            continue
        results.append(
            {k: v for k, v in public_metadata(info).items() if k != "overview"}
        )
    return results


@app.post("/datasets", status_code=202)
async def create_dataset(request: GenerateRequest):
    if request.size not in SIZES:
        raise HTTPException(422, f"Size must be one of {SIZES}")
    identifier = dataset_id(request.size, request.seed)
    if (DATA_DIR / identifier / "manifest.json").exists():
        return {"id": identifier, "status": "ready", "progress": 1}
    if jobs.get(identifier, {}).get("status") not in ("generating", "queued"):
        jobs[identifier] = {"status": "queued", "progress": 0}
        task = asyncio.create_task(
            build_dataset(identifier, request.size, request.seed)
        )
        tasks.add(task)
        task.add_done_callback(tasks.discard)
    return {"id": identifier, **jobs[identifier]}


@app.get("/datasets/{identifier}/status")
def dataset_status(identifier: str):
    if identifier in jobs:
        return {"id": identifier, **jobs[identifier]}
    metadata(identifier)
    return {"id": identifier, "status": "ready", "progress": 1}


@app.get("/datasets/{identifier}/range")
async def get_range(
    identifier: str,
    request: Request,
    start_ns: str,
    end_ns: str,
    columns: list[str] = Query(default=["value"]),
    max_points: int = Query(default=4096, ge=32, le=8192),
):
    metadata(identifier)
    try:
        if max(len(start_ns), len(end_ns)) > 20:
            raise ValueError("Timestamps must be int64 nanoseconds")
        start, end = int(start_ns), int(end_ns)
        if not -(2**63) <= start <= end < 2**63:
            raise ValueError("Invalid int64 timestamp range")
        async with request.app.state.query_slots:
            return await asyncio.to_thread(
                range_query, DATA_DIR, identifier, start, end, columns, max_points
            )
    except ValueError as exc:
        raise HTTPException(422, str(exc))


@app.get("/datasets/{identifier}")
def get_dataset(identifier: str):
    info = metadata(identifier)
    result = public_metadata(info)
    if info.get("kind") == "imported":
        coarse = range_query(
            DATA_DIR,
            identifier,
            int(info["startTimeNs"]),
            int(info["endTimeNs"]),
            [info["columns"][0]],
            1600,
        )
        points = coarse["series"][info["columns"][0]]
        origin = int(info["startTimeNs"])
        result["overview"] = [
            [(int(t) - origin) / 1e6 / info["intervalMs"], v]
            for t, v in zip(points["timeNs"], points["values"])
        ]
    return result
