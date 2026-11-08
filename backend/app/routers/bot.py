"""POST /api/bot/move: Stockfish (strength-limited) or Maia (human-like, runs on lc0)."""
from __future__ import annotations

import asyncio
import logging
from typing import Any

import chess
import chess.engine
from fastapi import APIRouter, HTTPException, Request

from ..bot import BotChoice, choose_bot_move
from ..chessutil import parse_fen
from ..deps import Services, services
from ..engine import EngineUnavailable
from ..maia import (
    INSTALL_HINT,
    MAIA_RATINGS,
    MAIA_SLOT,
    RETRY_HINT,
    RUNTIME_HINT,
    board_with_history,
    choose_maia_move,
    net_is_intact,
    weight_path,
)
from ..schemas import BotMoveRequest, BotMoveResponse

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/bot", tags=["bot"])


def _maia_unavailable(reason: object) -> EngineUnavailable:
    return EngineUnavailable(f"Maia is unavailable: {reason}. {INSTALL_HINT}")


def _maia_stopped(reason: str = "") -> EngineUnavailable:
    """lc0 crashed or hung during a move. The next request starts a fresh process, so Retry may be enough."""
    return EngineUnavailable(f"Maia stopped unexpectedly{f' ({reason})' if reason else ''}. {RETRY_HINT}")


async def _maia_choice(svc: Services, board: chess.Board, req: BotMoveRequest) -> BotChoice:
    if req.elo not in MAIA_RATINGS:
        ratings = ", ".join(str(r) for r in MAIA_RATINGS)
        raise HTTPException(status_code=400, detail=f"Maia has no model for {req.elo}. Choose one of: {ratings}.")
    weights = weight_path(svc.settings.maia_weights_dir, req.elo)
    if not svc.maia.available:
        raise _maia_unavailable(f"lc0 not found at {svc.maia.path}")
    if not weights.is_file():
        raise _maia_unavailable(f"the {req.elo} network is missing ({weights})")
    if not await asyncio.to_thread(net_is_intact, weights):
        raise _maia_unavailable(f"the {req.elo} network file is damaged ({weights})")
    position = board_with_history(board, req.moves, req.start_fen)
    try:
        async with asyncio.timeout(svc.settings.maia_timeout_s):
            async with svc.maia.use(MAIA_SLOT) as engine:
                return await choose_maia_move(engine, position, req.elo, weights)
    except TimeoutError as exc:
        await svc.maia.discard(MAIA_SLOT)
        raise _maia_stopped(f"lc0 did not answer within {svc.settings.maia_timeout_s:g} s") from exc
    except EngineUnavailable as exc:  # the process could not be started
        raise EngineUnavailable(f"Maia is unavailable: {exc}. {RUNTIME_HINT}") from exc
    except chess.engine.EngineError as exc:
        log.warning("lc0 failed during a move: %s", exc)
        raise _maia_stopped() from exc


@router.post("/move", response_model=BotMoveResponse, response_model_exclude_unset=True)
async def bot_move(req: BotMoveRequest, request: Request) -> dict[str, Any]:
    try:
        board = parse_fen(req.fen)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not any(board.legal_moves):
        raise HTTPException(status_code=400, detail="the game is over: no legal moves")
    svc = services(request)
    if req.bot == "maia":
        choice = await _maia_choice(svc, board, req)
    else:
        async with svc.engines.use("bot") as engine:
            choice = await choose_bot_move(engine, board, req.elo, req.movetime_ms)
    san = board.san(choice.move)
    board.push(choice.move)
    strength: dict[str, Any] = {"mode": choice.mode, "elo": choice.elo}
    if choice.skill is not None:
        strength["skill"] = choice.skill
    return {
        "uci": choice.move.uci(),
        "san": san,
        "fen_after": board.fen(),
        "eval": choice.score,
        "strength": strength,
    }
