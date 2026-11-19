"""Vercel Blob (files) and Upstash Redis/Vercel KV (metadata) clients for the serverless deployment.

Local dev and any non-Vercel deployment keep using the plain filesystem in imports.py/query.py;
this module is only imported on the code paths gated by ON_VERCEL.
"""

from __future__ import annotations

import os

import httpx

ON_VERCEL = bool(os.environ.get("VERCEL"))

BLOB_TOKEN = os.environ.get("BLOB_READ_WRITE_TOKEN", "")
BLOB_API = "https://blob.vercel-storage.com"

KV_URL = os.environ.get("KV_REST_API_URL", "")
KV_TOKEN = os.environ.get("KV_REST_API_TOKEN", "")


def _require(value: str, name: str):
    if not value:
        raise RuntimeError(f"{name} is not set; Blob/KV are required when running on Vercel")
    return value


def blob_put(key: str, data: bytes, content_type: str = "application/octet-stream") -> str:
    """Uploads (overwriting) and returns the blob's public URL."""
    _require(BLOB_TOKEN, "BLOB_READ_WRITE_TOKEN")
    response = httpx.put(
        f"{BLOB_API}/{key}",
        content=data,
        headers={
            "authorization": f"Bearer {BLOB_TOKEN}",
            "x-content-type": content_type,
            "x-add-random-suffix": "0",
        },
        timeout=60,
    )
    response.raise_for_status()
    return response.json()["url"]


def blob_url(key: str) -> str:
    _require(BLOB_TOKEN, "BLOB_READ_WRITE_TOKEN")
    response = httpx.get(
        f"{BLOB_API}",
        params={"prefix": key, "limit": "1"},
        headers={"authorization": f"Bearer {BLOB_TOKEN}"},
        timeout=30,
    )
    response.raise_for_status()
    blobs = response.json().get("blobs", [])
    if not blobs or blobs[0]["pathname"] != key:
        raise FileNotFoundError(key)
    return blobs[0]["url"]


def blob_get(key: str) -> bytes:
    response = httpx.get(blob_url(key), timeout=60)
    response.raise_for_status()
    return response.content


def blob_delete(prefix: str):
    _require(BLOB_TOKEN, "BLOB_READ_WRITE_TOKEN")
    urls = []
    cursor = None
    while True:
        params = {"prefix": prefix, "limit": "1000"}
        if cursor:
            params["cursor"] = cursor
        response = httpx.get(
            BLOB_API,
            params=params,
            headers={"authorization": f"Bearer {BLOB_TOKEN}"},
            timeout=30,
        )
        response.raise_for_status()
        payload = response.json()
        urls.extend(blob["url"] for blob in payload.get("blobs", []))
        if not payload.get("hasMore"):
            break
        cursor = payload.get("cursor")
    if urls:
        response = httpx.post(
            f"{BLOB_API}/delete",
            json={"urls": urls},
            headers={"authorization": f"Bearer {BLOB_TOKEN}"},
            timeout=30,
        )
        response.raise_for_status()


def _kv(*command: str):
    _require(KV_URL, "KV_REST_API_URL")
    _require(KV_TOKEN, "KV_REST_API_TOKEN")
    response = httpx.post(
        KV_URL,
        json=list(command),
        headers={"authorization": f"Bearer {KV_TOKEN}"},
        timeout=15,
    )
    response.raise_for_status()
    body = response.json()
    if body.get("error"):
        raise RuntimeError(body["error"])
    return body["result"]


def kv_get(key: str) -> str | None:
    return _kv("GET", key)


def kv_set(key: str, value: str):
    _kv("SET", key, value)


def kv_delete(key: str):
    _kv("DEL", key)


def kv_sadd(set_key: str, member: str):
    _kv("SADD", set_key, member)


def kv_srem(set_key: str, member: str):
    _kv("SREM", set_key, member)


def kv_smembers(set_key: str) -> list[str]:
    return _kv("SMEMBERS", set_key) or []


def kv_hset(key: str, mapping: dict):
    flat = []
    for field, value in mapping.items():
        flat.extend([field, "" if value is None else str(value)])
    _kv("HSET", key, *flat)


def kv_hgetall(key: str) -> dict | None:
    flat = _kv("HGETALL", key)
    if not flat:
        return None
    return dict(zip(flat[0::2], flat[1::2]))


# Atomically checks the upload journal's committed offset and advances it, so two
# concurrent/retried chunk PUTs across different serverless instances can't corrupt
# the byte offset the way an in-memory asyncio.Lock could only do on one instance.
_ADVANCE_OFFSET_SCRIPT = """
local current = redis.call('HGET', KEYS[1], 'offset')
if current == false then return redis.error_reply('missing') end
if tonumber(current) ~= tonumber(ARGV[1]) then return current end
redis.call('HSET', KEYS[1], 'offset', tonumber(ARGV[1]) + tonumber(ARGV[2]))
return tostring(tonumber(ARGV[1]) + tonumber(ARGV[2]))
"""


def kv_advance_offset(key: str, expected_offset: int, written: int) -> int:
    """Returns the journal's offset after the call; unchanged (and != expected+written) on a mismatch."""
    result = _kv("EVAL", _ADVANCE_OFFSET_SCRIPT, "1", key, str(expected_offset), str(written))
    return int(result)
