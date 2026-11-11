"""POST /api/explain and WS /ws/explain (Ollama explanations of reviewed moves)."""
from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect

from ..deps import Services, services
from ..ollama_client import OllamaError, build_explain_messages
from ..schemas import ExplainRequest, ExplainResponse

log = logging.getLogger(__name__)
router = APIRouter(tags=["explain"])


class ExplainProblem(Exception):
    """A client-side problem with an explain request (unknown job, bad ply, missing model)."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def _prepare(svc: Services, req: ExplainRequest) -> list[dict[str, str]]:
    job = svc.reviews.get(req.jobId)
    if job is None:
        raise ExplainProblem(404, f"unknown review job '{req.jobId}'")
    if job.status != "done" or job.result is None:
        raise ExplainProblem(409, f"review job '{req.jobId}' is not finished (status: {job.status})")
    moves = job.result.moves
    if not 1 <= req.ply <= len(moves):
        raise ExplainProblem(400, f"ply must be between 1 and {len(moves)}")
    opening = job.result.opening.name if job.result.opening else None
    return build_explain_messages(moves[req.ply - 1], opening, req.language)


async def _stream(svc: Services, req: ExplainRequest) -> AsyncIterator[str]:
    messages = _prepare(svc, req)
    try:
        model = await svc.ollama.resolve(req.model)
    except OllamaError as exc:
        raise ExplainProblem(400 if req.model else 503, str(exc)) from exc
    async for token in svc.ollama.chat_stream(model, messages):
        yield token


@router.post("/api/explain", response_model=ExplainResponse)
async def explain(req: ExplainRequest, request: Request) -> ExplainResponse:
    svc = services(request)
    try:
        text = "".join([tok async for tok in _stream(svc, req)]).strip()
    except ExplainProblem as exc:
        raise HTTPException(status_code=exc.status, detail=exc.message) from exc
    except OllamaError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    if not text:
        raise HTTPException(status_code=502, detail="the model returned an empty answer")
    svc.reviews.set_explanation(req.jobId, req.ply, text)
    return ExplainResponse(text=text)


@router.websocket("/ws/explain")
async def ws_explain(websocket: WebSocket) -> None:
    """Each client message {jobId, ply, model?} yields token messages, then done (or error)."""
    await websocket.accept()
    svc = services(websocket)
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                req = ExplainRequest.model_validate(json.loads(raw))
            except Exception as exc:  # noqa: BLE001 - bad client message
                await websocket.send_json({"type": "error", "message": f"bad request: {exc}"})
                continue
            parts: list[str] = []
            try:
                async for token in _stream(svc, req):
                    parts.append(token)
                    await websocket.send_json({"type": "token", "text": token})
            except ExplainProblem as exc:
                await websocket.send_json({"type": "error", "message": exc.message})
                continue
            except OllamaError as exc:
                await websocket.send_json({"type": "error", "message": str(exc)})
                continue
            text = "".join(parts).strip()
            if not text:
                await websocket.send_json({"type": "error", "message": "the model returned an empty answer"})
                continue
            svc.reviews.set_explanation(req.jobId, req.ply, text)
            await websocket.send_json({"type": "done", "text": text})
    except WebSocketDisconnect:
        pass
    except RuntimeError as exc:  # sending after the client closed
        log.debug("explain websocket closed: %s", exc)
