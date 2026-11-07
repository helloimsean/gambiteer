"""POST /api/analyze (one-shot) and the live /ws/analyze stream."""
from __future__ import annotations

import asyncio
import json
import logging
from contextlib import suppress
from typing import Any

import chess
import chess.engine
from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect

from ..chessutil import infos_to_lines, parse_fen, terminal_lines
from ..deps import services
from ..engine import AnalysisStream, EngineManager, EngineUnavailable, Snapshot
from ..schemas import AnalyzeRequest, AnalyzeResponse, WsAnalyzeInfo

log = logging.getLogger(__name__)
router = APIRouter(tags=["analysis"])


@router.post("/api/analyze", response_model=AnalyzeResponse)
async def analyze(req: AnalyzeRequest, request: Request) -> AnalyzeResponse:
    try:
        board = parse_fen(req.fen)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    terminal = terminal_lines(board)
    if terminal is not None:
        return AnalyzeResponse(fen=req.fen, depth=0, lines=terminal)
    svc = services(request)
    depth = req.depth
    if depth is None and req.movetime_ms is None:
        depth = svc.settings.analyze_default_depth
    limit = chess.engine.Limit(
        depth=depth, time=(req.movetime_ms / 1000) if req.movetime_ms is not None else None
    )
    async with svc.engines.use("analysis", preempt=True) as engine:
        infos = await engine.analyse(board, limit, multipv=req.multipv)
    lines = infos_to_lines(board, infos)
    return AnalyzeResponse(fen=req.fen, depth=lines[0].depth if lines else 0, lines=lines)


def snapshot_message(fen: str, board: chess.Board, snapshot: Snapshot) -> dict[str, Any] | None:
    """The {type:"info"} message for one aggregated snapshot, or None if it has no line yet."""
    lines = infos_to_lines(board, snapshot)
    if not lines:
        return None
    head = snapshot[0] if snapshot else {}
    return WsAnalyzeInfo(
        fen=fen,
        depth=int(head.get("depth", lines[0].depth) or 0),
        seldepth=int(head.get("seldepth", 0) or 0),
        nodes=int(head.get("nodes", 0) or 0),
        nps=int(head.get("nps", 0) or 0),
        lines=lines,
    ).model_dump()


class LiveAnalysis:
    """One WebSocket client's live analysis: at most one running search, newest fen wins."""

    def __init__(self, ws: WebSocket, engines: EngineManager, *, min_interval: float, max_seconds: float) -> None:
        self.ws = ws
        self.engines = engines
        self.min_interval = min_interval
        self.max_seconds = max_seconds
        self.task: asyncio.Task[None] | None = None
        self.stream: AnalysisStream | None = None
        self._preempted = False
        self._send_lock = asyncio.Lock()
        self.closed = False

    async def send(self, message: dict[str, Any]) -> None:
        if self.closed:
            return
        async with self._send_lock:
            await self.ws.send_json(message)

    async def switch(self, fen: str, board: chess.Board, multipv: int) -> None:
        await self.halt()
        self.task = asyncio.create_task(self._run(fen, board, multipv), name="live-analysis")

    async def halt(self) -> None:
        """Stop the current search (if any) and wait until the engine has stopped."""
        task, self.task = self.task, None
        if task is None:
            return
        if self.stream is not None:
            self.stream.request_stop()
        if not task.done():
            task.cancel()
        with suppress(asyncio.CancelledError, Exception):
            await task

    def _on_preempt(self) -> None:
        self._preempted = True
        if self.stream is not None:
            self.stream.request_stop()

    async def _run(self, fen: str, board: chess.Board, multipv: int) -> None:
        terminal = terminal_lines(board)
        if terminal is not None:
            await self.send(
                WsAnalyzeInfo(fen=fen, depth=0, seldepth=0, nodes=0, nps=0, lines=terminal).model_dump()
            )
            return
        self._preempted = False
        loop = asyncio.get_running_loop()
        try:
            async with self.engines.use("analysis", preempt=True, on_preempt=self._on_preempt) as engine:
                stream = await engine.analysis_stream(
                    board, multipv=multipv, limit=chess.engine.Limit(time=self.max_seconds)
                )
                self.stream = stream
                if self._preempted:
                    stream.request_stop()
                try:
                    last_sent = -1e9
                    while True:
                        snapshot = await stream.next()
                        if snapshot is None:
                            break
                        wait = last_sent + self.min_interval - loop.time()
                        if wait > 0:
                            await asyncio.sleep(wait)
                            snapshot = stream.take_latest() or snapshot
                        message = snapshot_message(fen, board, snapshot)
                        if message is None:
                            continue
                        await self.send(message)
                        last_sent = loop.time()
                    if stream.error is not None:
                        await self.send({"type": "error", "message": f"engine error: {stream.error}"})
                finally:
                    self.stream = None
                    await stream.stop()
        except EngineUnavailable as exc:
            with suppress(Exception):
                await self.send({"type": "error", "message": str(exc)})


def _client_text(message: dict[str, Any]) -> str | None:
    if message.get("text") is not None:
        return message["text"]
    data = message.get("bytes")
    if data is not None:
        return data.decode("utf-8", "replace")
    return None


@router.websocket("/ws/analyze")
async def ws_analyze(websocket: WebSocket) -> None:
    await websocket.accept()
    svc = services(websocket)
    live = LiveAnalysis(
        websocket,
        svc.engines,
        min_interval=svc.settings.ws_analyze_min_interval_s,
        max_seconds=svc.settings.ws_analyze_max_seconds,
    )
    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break
            text = _client_text(message)
            if text is None:
                continue
            try:
                cmd = json.loads(text)
            except ValueError:
                await live.send({"type": "error", "message": "messages must be JSON"})
                continue
            if not isinstance(cmd, dict):
                await live.send({"type": "error", "message": "messages must be JSON objects"})
                continue
            if cmd.get("stop"):
                await live.halt()
                continue
            fen = cmd.get("fen")
            if not isinstance(fen, str):
                await live.send({"type": "error", "message": "expected {fen, multipv} or {stop: true}"})
                continue
            try:
                board = parse_fen(fen)
            except ValueError as exc:
                await live.halt()
                await live.send({"type": "error", "fen": fen, "message": str(exc)})
                continue
            try:
                multipv = max(1, min(5, int(cmd.get("multipv") or 3)))
            except (TypeError, ValueError):
                multipv = 3
            await live.switch(fen, board, multipv)
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001 - never let one client take the server down
        log.exception("analysis websocket failed")
    finally:
        live.closed = True
        await live.halt()
