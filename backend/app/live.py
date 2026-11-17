"""Genuine source-published live batches, bounded history and slow-consumer closure."""

import asyncio
import math
import os
from collections import deque
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

router = APIRouter()
streams = {}


class LivePoint(BaseModel):
    timeNs: str = Field(min_length=1, max_length=20)
    value: float


class LiveBatch(BaseModel):
    points: list[LivePoint] = Field(min_length=1, max_length=512)


def get_stream(name):
    if not 1 <= len(name) <= 64 or any(
        c not in "abcdefghijklmnopqrstuvwxyz0123456789-_" for c in name
    ):
        raise HTTPException(
            422, "Use lowercase letters, numbers, hyphens or underscores"
        )
    if name not in streams:
        if len(streams) >= 16:
            raise HTTPException(429, "At most 16 live streams may be active")
        streams[name] = {
            "history": deque(maxlen=16384),
            "subscribers": set(),
            "last": None,
        }
    return streams[name]


@router.post("/live/{name}/publish")
async def publish(name: str, batch: LiveBatch):
    stream = get_stream(name)
    previous = stream["last"]
    points = []
    for point in batch.points:
        try:
            timestamp = int(point.timeNs)
        except ValueError:
            raise HTTPException(422, "timeNs must contain integer epoch nanoseconds")
        if not -(2**63) <= timestamp < 2**63 or not math.isfinite(point.value):
            raise HTTPException(422, "Invalid timestamp or value")
        if previous is not None and timestamp < previous:
            raise HTTPException(422, "Live timestamps must be nondecreasing")
        previous = timestamp
        points.append({"timeNs": str(timestamp), "value": point.value})
    stream["last"] = previous
    stream["history"].extend(points)
    for queue in tuple(stream["subscribers"]):
        if queue.full():
            while not queue.empty():
                queue.get_nowait()
            queue.put_nowait(None)
            stream["subscribers"].discard(queue)
        else:
            queue.put_nowait(points)
    return {"accepted": len(points), "subscribers": len(stream["subscribers"])}


@router.websocket("/ws/live/{name}")
async def subscribe(websocket: WebSocket, name: str):
    origin = websocket.headers.get("origin")
    if origin and origin not in os.environ.get(
        "WAVEX_ORIGINS", "http://127.0.0.1:3000,http://localhost:3000"
    ).split(","):
        await websocket.close(code=1008)
        return
    try:
        stream = get_stream(name)
    except HTTPException:
        await websocket.close(code=1008)
        return
    if len(stream["subscribers"]) >= 8:
        await websocket.close(code=1013)
        return
    await websocket.accept()
    queue = asyncio.Queue(maxsize=32)
    stream["subscribers"].add(queue)
    receiver = asyncio.create_task(websocket.receive())
    outgoing = None
    try:
        await websocket.send_json(
            {"type": "snapshot", "points": list(stream["history"]), "mode": "live"}
        )
        while True:
            outgoing = asyncio.create_task(queue.get())
            done, _ = await asyncio.wait(
                [receiver, outgoing], return_when=asyncio.FIRST_COMPLETED
            )
            if receiver in done:
                break
            points = outgoing.result()
            if points is None:
                await websocket.close(
                    code=1013,
                    reason="Consumer fell behind. Reconnect for a bounded snapshot.",
                )
                break
            await websocket.send_json(
                {"type": "points", "points": points, "mode": "live"}
            )
    except WebSocketDisconnect:
        pass
    finally:
        receiver.cancel()
        if outgoing:
            outgoing.cancel()
        stream["subscribers"].discard(queue)
