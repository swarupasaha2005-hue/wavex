import json
import struct
import time
from pathlib import Path

import numpy as np
import polars as pl
import pytest
from fastapi.testclient import TestClient

from backend.app import main
from backend.app.generator import BLOCK_SIZE, SIZES, generate


@pytest.mark.parametrize("size", SIZES)
def test_disk_backed_generation_at_every_supported_scale(tmp_path: Path, size: int):
    progress = []
    metadata = generate(size, root=tmp_path, progress=progress.append)
    values = np.load(tmp_path / metadata["id"] / "values.npy", mmap_mode="r")
    assert isinstance(values, np.memmap)
    assert len(values) == size
    assert values.dtype == np.dtype("<f4")
    assert progress[-1] == 1
    assert len(progress) == (size + BLOCK_SIZE - 1) // BLOCK_SIZE
    assert metadata["storageBytes"] == size * 4 + 128
    assert len(metadata["overview"]) < 2000
    assert metadata["min"] == float(np.min(values))
    assert metadata["max"] == float(np.max(values))
    assert np.isfinite(values).all()
    assert np.std(values) > 2
    summaries = pl.read_parquet(tmp_path / metadata["id"] / "summaries.parquet")
    assert summaries["count"].sum() == size
    assert generate(size, root=tmp_path) == metadata  # Existing datasets are reused.


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DATA_DIR", tmp_path)
    main.jobs.clear()
    with TestClient(main.app) as client:
        yield client


def ready_dataset(client, size=10000):
    response = client.post("/datasets", json={"size": size})
    assert response.status_code == 202
    identifier = response.json()["id"]
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        status = client.get(f"/datasets/{identifier}/status").json()
        if status["status"] == "ready":
            return identifier
        assert status["status"] != "error"
        time.sleep(0.01)
    pytest.fail("Generation did not complete")


def test_http_historical_range_matches_generated_samples(client):
    identifier = ready_dataset(client)
    info = client.get(f"/datasets/{identifier}").json()
    values = np.load(main.DATA_DIR / identifier / "values.npy", mmap_mode="r")
    origin = int(info["startTimeNs"])
    response = client.get(
        f"/datasets/{identifier}/range",
        params={
            "start_ns": str(origin + 5500 * 10000000),
            "end_ns": str(origin + 5520 * 10000000),
            "max_points": 100,
        },
    ).json()
    assert response["series"]["value"]["values"] == values[5500:5521].tolist()
    assert response["sourceRows"] == 21


def test_invalid_requests_are_rejected(client):
    assert client.post("/datasets", json={"size": 500}).status_code == 422
    assert client.post("/datasets", json={"size": 10000, "seed": -1}).status_code == 422
    assert client.get("/datasets/telemetry-invalid/status").status_code == 404
    identifier = ready_dataset(client)
    assert (
        client.get(
            f"/datasets/{identifier}/range", params={"start_ns": "1", "end_ns": "0"}
        ).status_code
        == 422
    )
    assert (
        client.get(
            f"/datasets/{identifier}/range",
            params={"start_ns": "0", "end_ns": "1", "max_points": 1000000},
        ).status_code
        == 422
    )
    assert (
        client.get(
            f"/datasets/{identifier}/range",
            params={"start_ns": "0", "end_ns": "1", "columns": "bad"},
        ).status_code
        == 422
    )


def test_generation_requests_are_deduplicated_and_health_stays_responsive(client):
    first = client.post("/datasets", json={"size": 100000}).json()
    second = client.post("/datasets", json={"size": 100000}).json()
    assert first["id"] == second["id"]
    assert client.get("/health").json()["status"] == "ok"
    identifier = ready_dataset(client, 100000)
    assert client.post("/datasets", json={"size": 100000}).json()["status"] == "ready"
    assert identifier in [d["id"] for d in client.get("/datasets").json()]


def test_seed_reproducibility(tmp_path):
    first = generate(10000, seed=7, root=tmp_path / "first")
    second = generate(10000, seed=7, root=tmp_path / "second")
    np.testing.assert_array_equal(
        np.load(tmp_path / "first" / first["id"] / "values.npy"),
        np.load(tmp_path / "second" / second["id"] / "values.npy"),
    )
