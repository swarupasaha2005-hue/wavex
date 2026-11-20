"""Vercel Blob client for the serverless deployment.

Local dev and any non-Vercel deployment keep using the plain filesystem in imports.py/query.py;
this module is only used on the code paths gated by ON_VERCEL. Upload journals, job records, and
dataset manifests are all plain JSON blobs; there's no separate database, and import jobs run
synchronously within the request that completes the upload (no background worker/queue).
"""

from __future__ import annotations

import os

import httpx

ON_VERCEL = bool(os.environ.get("VERCEL"))

BLOB_TOKEN = os.environ.get("BLOB_READ_WRITE_TOKEN", "")
BLOB_API = "https://blob.vercel-storage.com"


def _require_token():
    if not BLOB_TOKEN:
        raise RuntimeError(
            "BLOB_READ_WRITE_TOKEN is not set. Add a Vercel Blob store to this project "
            "(Storage tab in the Vercel dashboard) and redeploy."
        )


def blob_put(key: str, data: bytes, content_type: str = "application/octet-stream") -> str:
    """Uploads (overwriting) and returns the blob's public URL."""
    _require_token()
    response = httpx.put(
        f"{BLOB_API}/{key}",
        content=data,
        headers={
            "authorization": f"Bearer {BLOB_TOKEN}",
            "x-content-type": content_type,
            "x-add-random-suffix": "0",
            "x-allow-overwrite": "1",
        },
        timeout=60,
    )
    response.raise_for_status()
    return response.json()["url"]


def blob_url(key: str) -> str:
    _require_token()
    response = httpx.get(
        BLOB_API,
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


def blob_get_json(key: str, default=None):
    try:
        import json

        return json.loads(blob_get(key))
    except FileNotFoundError:
        return default


def blob_put_json(key: str, value) -> str:
    import json

    return blob_put(key, json.dumps(value).encode(), "application/json")


def blob_list(prefix: str) -> list[str]:
    """Returns pathnames (not URLs) of every blob under prefix."""
    _require_token()
    names, cursor = [], None
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
        names.extend(blob["pathname"] for blob in payload.get("blobs", []))
        if not payload.get("hasMore"):
            break
        cursor = payload.get("cursor")
    return names


def blob_delete(prefix: str):
    _require_token()
    names, cursor = [], None
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
        names.extend(blob["url"] for blob in payload.get("blobs", []))
        if not payload.get("hasMore"):
            break
        cursor = payload.get("cursor")
    if names:
        response = httpx.post(
            f"{BLOB_API}/delete",
            json={"urls": names},
            headers={"authorization": f"Bearer {BLOB_TOKEN}"},
            timeout=30,
        )
        response.raise_for_status()
