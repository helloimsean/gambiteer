"""Stockfish smoke tests (skipped when engines/stockfish19.exe is missing)."""
from __future__ import annotations

import asyncio
import sys
import time

import chess
import chess.engine
import pytest

from app.chessutil import infos_to_lines
from app.engine import EngineManager, EngineUnavailable
from app.review import evaluate_position

from .conftest import needs_stockfish, test_settings


def manager() -> EngineManager:
    return EngineManager.from_settings(test_settings())


async def _smoke() -> None:
    engines = manager()
    await engines.start()
    try:
        assert not engines.bridged
        board = chess.Board()
        async with engines.use("analysis") as engine:
            infos = await engine.analyse(board, chess.engine.Limit(depth=8), multipv=2)
        lines = infos_to_lines(board, infos)
        assert len(lines) == 2 and lines[0].depth >= 8
        assert lines[0].pv[0] == board.san(chess.Move.from_uci(lines[0].pvUci[0]))
        assert "cp" in lines[0].score.model_dump()
        assert engines.engine_name.startswith("Stockfish")

        # live stream: first snapshot quickly, stop is acknowledged
        async with engines.use("analysis") as engine:
            t0 = time.perf_counter()
            stream = await engine.analysis_stream(board, multipv=3)
            snap = await asyncio.wait_for(stream.next(), timeout=2)
            assert snap is not None and time.perf_counter() - t0 < 1.0
            await stream.stop()
            assert stream.finished

        # review evaluation of a checkmate needs no engine call
        mate = chess.Board("rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3")
        async with engines.use("review") as engine:
            assert (await evaluate_position(engine, mate, 8))[0].score.model_dump() == {"mate": 0}
    finally:
        await engines.close()


@needs_stockfish
def test_engine_smoke_depth8() -> None:
    asyncio.run(_smoke())


@needs_stockfish
@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only event loop fallback")
def test_engine_on_selector_loop_uses_fallback_thread() -> None:
    """uvicorn --reload on Windows runs a SelectorEventLoop, which cannot spawn subprocesses."""

    async def run() -> None:
        engines = manager()
        await engines.start()
        try:
            assert engines.bridged
            board = chess.Board()
            async with engines.use("bot") as engine:
                result = await engine.play(board, chess.engine.Limit(depth=4))
                assert result.move in board.legal_moves
            async with engines.use("analysis") as engine:
                stream = await engine.analysis_stream(board, multipv=1)
                assert await asyncio.wait_for(stream.next(), timeout=2) is not None
                await stream.stop()
        finally:
            await engines.close()

    asyncio.run(run(), loop_factory=asyncio.SelectorEventLoop)


def test_missing_engine_is_reported() -> None:
    async def run() -> None:
        engines = EngineManager("Z:/definitely/missing/stockfish.exe", {"analysis": {}})
        await engines.start()
        with pytest.raises(EngineUnavailable):
            await engines.get("analysis")
        await engines.close()

    asyncio.run(run())
