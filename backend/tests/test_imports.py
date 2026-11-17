import hashlib
import json
import time
from pathlib import Path

import numpy as np
import polars as pl
import pytest
from fastapi.testclient import TestClient

from backend.app import main
from backend.app.query import range_query
from backend.app.storage import atomic_json, ingest

ORIGIN = 1789344000000000000
CONFIG = {
    "format": "csv",
    "timestampColumn": "timestamp",
    "timestampUnit": "ns",
    "valueColumns": ["value", "other"],
}


def source_file(path, count=300000, unsorted=False):
    indices = np.arange(count, dtype=np.int64)
    if unsorted:
        indices = indices[::-1]
    values = np.sin(indices / 1000)
    values[indices % 1024 == 67] = 999
    values[indices % 1024 == 71] = -777
    pl.DataFrame(
        {
            "timestamp": ORIGIN + indices * 1000 + indices % 997,
            "value": values,
            "other": indices.astype(float),
        }
    ).write_csv(path)


def await_job(client, identifier):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        job = client.get(f"/imports/{identifier}").json()
        if job["status"] in ("ready", "error"):
            return job
        time.sleep(0.02)
    pytest.fail("Import did not complete")


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DATA_DIR", tmp_path)
    with TestClient(main.app) as client:
        yield client


def test_resumable_upload_integrity_and_background_conversion(client, tmp_path):
    source = tmp_path / "real.csv"
    source_file(source)
    payload = source.read_bytes()
    state = client.post(
        "/uploads", json={**CONFIG, "filename": "real.csv", "size": len(payload)}
    ).json()
    identifier = state["id"]
    offset = 0
    while offset < len(payload):
        chunk = payload[offset : offset + 2 * 1024**2]
        headers = {
            "Upload-Offset": str(offset),
            "X-Chunk-SHA256": hashlib.sha256(chunk).hexdigest(),
        }
        assert (
            client.put(
                f"/uploads/{identifier}",
                content=chunk,
                headers={**headers, "X-Chunk-SHA256": "0" * 64},
            ).status_code
            == 422
        )
        assert client.get(f"/uploads/{identifier}").json()["offset"] == offset
        assert (
            client.put(
                f"/uploads/{identifier}", content=chunk, headers=headers
            ).status_code
            == 200
        )
        assert (
            client.put(
                f"/uploads/{identifier}", content=chunk, headers=headers
            ).status_code
            == 409
        )
        offset += len(chunk)
    assert (tmp_path / ".uploads" / f"{identifier}.part").read_bytes() == payload
    job = client.post(f"/uploads/{identifier}/complete").json()
    assert client.post(f"/uploads/{identifier}/complete").json()["id"] == job["id"]
    completed = await_job(client, job["id"])
    assert completed["status"] == "ready", completed
    metadata = client.get(f"/datasets/{completed['datasetId']}").json()
    assert metadata["size"] == 300000 and metadata["columns"] == ["value", "other"]
    assert "levels" not in metadata
    response = client.get(
        f"/datasets/{completed['datasetId']}/range",
        params={
            "start_ns": str(ORIGIN),
            "end_ns": metadata["endTimeNs"],
            "columns": ["value", "other"],
            "max_points": 256,
        },
    ).json()
    assert max(response["series"]["value"]["values"]) == 999
    assert min(response["series"]["value"]["values"]) == -777
    assert response["sourceRows"] == 300000


def test_upload_journal_survives_server_restart_and_uncommitted_tail(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(main, "DATA_DIR", tmp_path)
    data = b"timestamp,value\n123,5\n"
    with TestClient(main.app) as client:
        state = client.post(
            "/uploads", json={**CONFIG, "filename": "a.csv", "size": len(data)}
        ).json()
        first = data[:8]
        assert (
            client.put(
                f"/uploads/{state['id']}",
                content=first,
                headers={
                    "Upload-Offset": "0",
                    "X-Chunk-SHA256": hashlib.sha256(first).hexdigest(),
                },
            ).status_code
            == 200
        )
    with (tmp_path / ".uploads" / f"{state['id']}.part").open("ab") as handle:
        handle.write(b"uncommitted crash tail")
    with TestClient(main.app) as client:
        assert client.get(f"/uploads/{state['id']}").json()["offset"] == 8
        rest = data[8:]
        assert (
            client.put(
                f"/uploads/{state['id']}",
                content=rest,
                headers={
                    "Upload-Offset": "8",
                    "X-Chunk-SHA256": hashlib.sha256(rest).hexdigest(),
                },
            ).status_code
            == 200
        )
        assert (tmp_path / ".uploads" / f"{state['id']}.part").read_bytes() == data


@pytest.mark.parametrize("unsorted", [False, True])
def test_peak_preservation_arbitrary_boundaries_and_partition_pruning(
    tmp_path, unsorted
):
    source = tmp_path / "source.csv"
    source_file(source, 400000, unsorted)
    info = ingest(source, tmp_path / "import-test", CONFIG)
    assert info["sortedOnImport"] == unsorted
    raw = pl.read_csv(source)
    # Viewport boundaries deliberately cut through LOD buckets and Parquet partitions.
    for lower, upper in [
        (0, 399999),
        (63, 83),
        (64001, 199873),
        (131070, 131080),
        (225000, 232997),
    ]:
        start = ORIGIN + lower * 1000 + lower % 997
        end = ORIGIN + upper * 1000 + upper % 997
        expected = raw.filter(pl.col("timestamp").is_between(start, end))
        query = range_query(
            tmp_path, "import-test", start, end, ["value", "other"], 100
        )
        assert query["sourceRows"] == len(expected)
        for col in ["value", "other"]:
            assert min(query["series"][col]["values"]) == expected[col].min()
            assert max(query["series"][col]["values"]) == expected[col].max()
            assert len(query["series"][col]["values"]) <= 100
        assert all(start <= int(t) <= end for t in query["series"]["value"]["timeNs"])
    small = range_query(tmp_path, "import-test", ORIGIN, ORIGIN + 10000, ["value"], 100)
    assert small["partitionsRead"] < small["partitionsTotal"]


def test_jsonl_iso_precision_duplicates_and_timezone(tmp_path):
    source = tmp_path / "input.jsonl"
    source.write_text(
        "\n".join(
            json.dumps({"timestamp": f"2026-11-16T01:00:00.{i:09d}+01:00", "value": v})
            for i, v in [(1999, 8), (1, 1), (1, 99), (1, -7), (5, 5)]
        )
    )
    info = ingest(
        source,
        tmp_path / "import-json",
        {
            **CONFIG,
            "format": "jsonl",
            "timestampUnit": "iso",
            "valueColumns": ["value"],
        },
    )
    assert info["startTimeNs"] == "1794787200000000001"
    query = range_query(
        tmp_path,
        "import-json",
        1794787200000000001,
        1794787200000001999,
        ["value"],
        100,
    )
    assert query["series"]["value"]["values"] == [1, 99, -7, 5, 8]
    assert query["series"]["value"]["timeNs"][-1] == "1794787200000001999"


def test_local_import_errors_and_persistent_job_recovery(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DATA_DIR", tmp_path)
    source = tmp_path / "input.csv"
    source_file(source, 10000)
    identifier = "a" * 32
    atomic_json(
        tmp_path / ".jobs" / f"{identifier}.json",
        {
            "id": identifier,
            "datasetId": f"import-{identifier}",
            "source": str(source),
            "config": CONFIG,
            "status": "processing",
            "stage": "validating",
            "progress": 0.2,
            "rowsProcessed": 1,
        },
    )
    with TestClient(main.app) as client:
        assert await_job(client, identifier)["status"] == "ready"
        assert (
            client.post(
                "/imports/local", json={**CONFIG, "path": str(tmp_path / "missing")}
            ).status_code
            == 422
        )
        invalid = tmp_path / "invalid.csv"
        invalid.write_text("timestamp,value,other\nbad,2,3\n")
        job = client.post(
            "/imports/local", json={**CONFIG, "path": str(invalid)}
        ).json()
        result = await_job(client, job["id"])
        assert result["status"] == "error" and result["error"]
        assert not (tmp_path / result["datasetId"]).exists()


def test_true_live_published_events(client):
    with client.websocket_connect("/ws/live/test-source") as socket:
        assert socket.receive_json()["mode"] == "live"
        assert (
            client.post(
                "/live/test-source/publish",
                json={"points": [{"timeNs": str(ORIGIN), "value": 44.2}]},
            ).status_code
            == 200
        )
        message = socket.receive_json()
        assert message["type"] == "points" and message["points"][0]["value"] == 44.2
        assert (
            client.post(
                "/live/test-source/publish",
                json={"points": [{"timeNs": str(ORIGIN - 1), "value": 2}]},
            ).status_code
            == 422
        )


def test_discard_session_and_upload_limits(client, tmp_path):
    state = client.post(
        "/uploads", json={**CONFIG, "filename": "discard.csv", "size": 100}
    ).json()
    assert client.post(f"/uploads/{state['id']}/complete").status_code == 409
    assert client.delete(f"/uploads/{state['id']}").status_code == 200
    assert client.get(f"/uploads/{state['id']}").status_code == 404
    assert not (tmp_path / ".uploads" / f"{state['id']}.part").exists()
    assert (
        client.post(
            "/uploads", json={**CONFIG, "filename": "large.csv", "size": 11 * 1024**3}
        ).status_code
        == 422
    )


def test_retry_can_fix_mapping_without_reupload(client, tmp_path):
    source = tmp_path / "mapping.csv"
    source_file(source, 10000)
    payload = source.read_bytes()
    state = client.post(
        "/uploads",
        json={
            **CONFIG,
            "timestampUnit": "iso",
            "filename": "mapping.csv",
            "size": len(payload),
        },
    ).json()
    identifier = state["id"]
    assert (
        client.put(
            f"/uploads/{identifier}",
            content=payload,
            headers={
                "Upload-Offset": "0",
                "X-Chunk-SHA256": hashlib.sha256(payload).hexdigest(),
            },
        ).status_code
        == 200
    )
    client.post(f"/uploads/{identifier}/complete")
    assert await_job(client, identifier)["status"] == "error"
    assert (tmp_path / ".uploads" / f"{identifier}.part").exists()
    assert client.post(f"/imports/{identifier}/retry", json=CONFIG).status_code == 202
    assert await_job(client, identifier)["status"] == "ready"
    deadline = time.monotonic() + 2
    while (
        tmp_path / ".uploads" / f"{identifier}.part"
    ).exists() and time.monotonic() < deadline:
        time.sleep(0.01)
    assert not (tmp_path / ".uploads" / f"{identifier}.part").exists()


def test_import_directory_has_one_supervisor(client, tmp_path):
    from backend.app.imports import ImportManager

    with pytest.raises(RuntimeError, match="already owns"):
        ImportManager(tmp_path).start()
    assert client.get("/health").status_code == 200


def test_dense_burst_after_long_gap_refines_without_oversized_response(tmp_path):
    count = 300000
    timestamps = np.concatenate(
        [
            ORIGIN + np.arange(40000, dtype=np.int64),
            ORIGIN + 10**12 + np.arange(count - 40000, dtype=np.int64),
        ]
    )
    values = np.zeros(count)
    values[55067] = 888
    values[55101] = -444
    source = tmp_path / "bursts.csv"
    pl.DataFrame({"timestamp": timestamps, "value": values}).write_csv(source)
    info = ingest(
        source, tmp_path / "import-burst", {**CONFIG, "valueColumns": ["value"]}
    )
    query = range_query(
        tmp_path,
        info["id"],
        ORIGIN + 10**12 + 100,
        ORIGIN + 10**12 + 20000,
        ["value"],
        100,
    )
    assert query["sourceRows"] == 19901
    assert len(query["series"]["value"]["values"]) <= 100
    assert min(query["series"]["value"]["values"]) == -444
    assert max(query["series"]["value"]["values"]) == 888
