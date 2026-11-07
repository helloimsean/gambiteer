"""POST /api/review, GET /api/review/{jobId}, WS /ws/review/{jobId}."""
from __future__ import annotations

import asyncio
from contextlib import suppress
from typing import Any

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect

from ..deps import services
from ..schemas import ReviewCreated, ReviewJob, ReviewRequest

router = APIRouter(tags=["review"])
TERMINAL = ("done", "error")


def job_json(job: ReviewJob) -> dict[str, Any]:
    """Optional fields are omitted rather than sent as null (matches the TS `field?:` types)."""
    return job.model_dump(mode="json", exclude_none=True)


@router.post("/api/review", response_model=ReviewCreated)
async def start_review(req: ReviewRequest, request: Request) -> ReviewCreated:
    try:
        job_id = services(request).reviews.create(req)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return ReviewCreated(jobId=job_id)


@router.get("/api/review/{job_id}", response_model=ReviewJob, response_model_exclude_none=True)
async def get_review(job_id: str, request: Request) -> ReviewJob:
    snap = services(request).reviews.snapshot(job_id)
    if snap is None:
        raise HTTPException(status_code=404, detail=f"unknown review job '{job_id}'")
    return snap


@router.websocket("/ws/review/{job_id}")
async def ws_review(websocket: WebSocket, job_id: str) -> None:
    """Push ReviewJob snapshots (the current one first), close after done/error."""
    await websocket.accept()
    reviews = services(websocket).reviews
    job = reviews.get(job_id)
    if job is None:
        with suppress(Exception):
            await websocket.send_json({"type": "error", "message": f"unknown review job '{job_id}'"})
            await websocket.close(code=4404)
        return
    queue = reviews.subscribe(job)

    async def watch_disconnect() -> None:
        with suppress(Exception):
            while True:
                msg = await websocket.receive()
                if msg["type"] == "websocket.disconnect":
                    return

    watcher = asyncio.create_task(watch_disconnect())
    try:
        snap = job.snapshot()
        await websocket.send_json(job_json(snap))
        while snap.status not in TERMINAL:
            getter = asyncio.ensure_future(queue.get())
            done, _ = await asyncio.wait({getter, watcher}, return_when=asyncio.FIRST_COMPLETED)
            if getter not in done:
                getter.cancel()
                return  # the client went away
            snap = getter.result()
            while not queue.empty() and snap.status not in TERMINAL:
                snap = queue.get_nowait()  # skip snapshots that are already stale
            await websocket.send_json(job_json(snap))
        with suppress(Exception):
            await websocket.close(code=1000)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        reviews.unsubscribe(job, queue)
        watcher.cancel()
