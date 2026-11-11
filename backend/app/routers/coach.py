"""POST /api/coach/move and WS /ws/coach: Stockfish verdict + Ollama explanation for one move.

Used by the Learn tab's practice mode, outside of any game review. The engine part runs on the
``review`` engine (see ``app/coach.py``); the explanation uses ``build_coach_messages``.

WebSocket behaviour: one request per client message, several may be in flight, and every reply
carries the request's ``requestId``. Each socket has two workers connected by queues:

* the analysis worker handles requests strictly in arrival order and sends ``analysis`` (or an
  ``error`` with stage "analysis") as soon as the engine is done;
* the explanation worker streams the Ollama explanations one at a time, also in arrival order.

So a new request's engine verdict never waits behind a slow explanation of an older one, while
the explanations themselves are never interleaved. Nothing is cancelled: to drop stale work, the
client closes the socket (in-flight work is then cancelled and the engine freed).
"""
from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from contextlib import suppress
from typing import Any

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect

from ..coach import CoachAnalysis, CoachInputError, analyse_move, prepare
from ..deps import Services, services
from ..engine import EngineUnavailable
from ..ollama_client import OllamaError, build_coach_messages
from ..schemas import CoachRequest, CoachResponse

log = logging.getLogger(__name__)
router = APIRouter(tags=["coach"])

MAX_PENDING = 64  # queued requests per socket before new ones are refused
EMPTY_ANSWER = "the model returned an empty answer"


async def _explain_stream(svc: Services, req: CoachRequest, analysis: CoachAnalysis) -> AsyncIterator[str]:
    """Ollama tokens for the explanation (raises OllamaError, also for an unknown model)."""
    messages = build_coach_messages(analysis.move, req.context, book_eval=analysis.book_eval, language=req.language)
    model = await svc.ollama.resolve(req.model)
    async for token in svc.ollama.chat_stream(model, messages):
        yield token


@router.post("/api/coach/move", response_model=CoachResponse, response_model_exclude_none=True)
async def coach_move(req: CoachRequest, request: Request) -> CoachResponse:
    """Engine verdict (+ explanation unless ``explain`` is false). An Ollama failure still returns
    200 with the verdict, ``text: ""`` and ``coachError``."""
    svc = services(request)
    try:
        prepared = prepare(req)
    except CoachInputError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    analysis = await analyse_move(svc.engines, req, prepared)  # EngineUnavailable -> 503 (app handler)
    if not req.explain:
        return CoachResponse(move=analysis.move, text="")
    try:
        text = "".join([tok async for tok in _explain_stream(svc, req, analysis)]).strip()
    except OllamaError as exc:
        return CoachResponse(move=analysis.move, text="", coachError=str(exc))
    if not text:
        return CoachResponse(move=analysis.move, text="", coachError=EMPTY_ANSWER)
    return CoachResponse(move=analysis.move, text=text)


class _Closed(Exception):
    """The client went away; stop the worker quietly."""


class CoachSocket:
    """One /ws/coach connection: a receive loop feeding an analysis worker and an explain worker."""

    def __init__(self, ws: WebSocket, svc: Services) -> None:
        self.ws = ws
        self.svc = svc
        self._send_lock = asyncio.Lock()
        self._analysis_q: asyncio.Queue[CoachRequest] = asyncio.Queue()
        self._explain_q: asyncio.Queue[tuple[CoachRequest, CoachAnalysis]] = asyncio.Queue()
        self._closed = False

    async def send(self, message: dict[str, Any]) -> None:
        if self._closed:
            raise _Closed
        try:
            async with self._send_lock:
                await self.ws.send_json(message)
        except (WebSocketDisconnect, RuntimeError, OSError) as exc:
            self._closed = True
            raise _Closed from exc

    async def run(self) -> None:
        workers = [
            asyncio.create_task(self._analysis_worker(), name="coach-analysis"),
            asyncio.create_task(self._explain_worker(), name="coach-explain"),
        ]
        try:
            await self._receive_loop()
        except (_Closed, WebSocketDisconnect):
            pass
        finally:
            self._closed = True
            for task in workers:
                task.cancel()
            for task in workers:
                with suppress(asyncio.CancelledError, Exception):
                    await task

    async def _receive_loop(self) -> None:
        while True:
            message = await self.ws.receive()
            if message["type"] == "websocket.disconnect":
                return
            raw = message.get("text")
            if raw is None and message.get("bytes") is not None:
                raw = message["bytes"].decode("utf-8", "replace")
            if raw is None:
                continue
            request_id = ""
            try:
                data = json.loads(raw)
                if isinstance(data, dict):
                    request_id = str(data.get("requestId") or "")
                req = CoachRequest.model_validate(data)
            except Exception as exc:  # noqa: BLE001 - bad client message
                await self.send(
                    {"type": "error", "requestId": request_id, "stage": "analysis", "message": f"bad request: {exc}"}
                )
                continue
            if self._analysis_q.qsize() + self._explain_q.qsize() >= MAX_PENDING:
                await self.send(
                    {"type": "error", "requestId": req.requestId, "stage": "analysis", "message": "too many pending requests"}
                )
                continue
            self._analysis_q.put_nowait(req)

    async def _analysis_worker(self) -> None:
        with suppress(_Closed):
            while True:
                req = await self._analysis_q.get()
                try:
                    analysis = await analyse_move(self.svc.engines, req)
                except (CoachInputError, EngineUnavailable) as exc:
                    await self._error(req, "analysis", str(exc))
                    continue
                except Exception as exc:  # noqa: BLE001 - reported to the client
                    log.exception("coach analysis failed")
                    await self._error(req, "analysis", f"{type(exc).__name__}: {exc}")
                    continue
                await self.send(
                    {
                        "type": "analysis",
                        "requestId": req.requestId,
                        "move": analysis.move.model_dump(mode="json", exclude_none=True),
                    }
                )
                if req.explain:
                    self._explain_q.put_nowait((req, analysis))
                else:
                    await self.send({"type": "done", "requestId": req.requestId, "text": ""})

    async def _explain_worker(self) -> None:
        with suppress(_Closed):
            while True:
                req, analysis = await self._explain_q.get()
                parts: list[str] = []
                try:
                    async for token in _explain_stream(self.svc, req, analysis):
                        parts.append(token)
                        await self.send({"type": "token", "requestId": req.requestId, "text": token})
                except OllamaError as exc:
                    await self._error(req, "explain", str(exc))
                    continue
                except _Closed:
                    raise
                except Exception as exc:  # noqa: BLE001 - reported to the client
                    log.exception("coach explanation failed")
                    await self._error(req, "explain", f"{type(exc).__name__}: {exc}")
                    continue
                text = "".join(parts).strip()
                if not text:
                    await self._error(req, "explain", EMPTY_ANSWER)
                    continue
                await self.send({"type": "done", "requestId": req.requestId, "text": text})

    async def _error(self, req: CoachRequest, stage: str, message: str) -> None:
        await self.send({"type": "error", "requestId": req.requestId, "stage": stage, "message": message})


@router.websocket("/ws/coach")
async def ws_coach(websocket: WebSocket) -> None:
    await websocket.accept()
    await CoachSocket(websocket, services(websocket)).run()
