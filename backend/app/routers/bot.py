"""POST /api/bot/move: Stockfish (strength-limited), Maia (human-like, runs on lc0) or Panicfish.

Standard chess and Chess960 run on Stockfish 19, the other variants on Fairy-Stockfish.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

import chess
import chess.engine
from fastapi import APIRouter, HTTPException, Request

from ..bot import FAIRY_ELO_RANGE, STOCKFISH_ELO_RANGE, BotChoice, choose_bot_move, choose_panicfish_move
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
from ..variants import FAIRY_INSTALL_HINT, FAIRY_SLOT, needs_fairy, parse_variant_fen

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


async def _engine_choice(svc: Services, board: chess.Board, req: BotMoveRequest) -> BotChoice:
    uses_fairy = needs_fairy(req.variant)
    if uses_fairy and not svc.fairy.available:
        raise EngineUnavailable(f"Fairy-Stockfish plays this variant and it is not installed. {FAIRY_INSTALL_HINT}")
    manager, slot, elo_range = (
        (svc.fairy, FAIRY_SLOT, FAIRY_ELO_RANGE) if uses_fairy else (svc.engines, "bot", STOCKFISH_ELO_RANGE)
    )
    choose = choose_panicfish_move if req.bot == "panicfish" else choose_bot_move
    try:
        async with manager.use(slot) as engine:
            return await choose(engine, board, req.elo, req.movetime_ms, uci_elo_range=elo_range)
    except chess.engine.EngineError as exc:
        log.warning("%s failed during a move: %s", manager.label, exc)
        raise EngineUnavailable(f"{manager.label} stopped unexpectedly. {RETRY_HINT}") from exc


@router.post("/move", response_model=BotMoveResponse, response_model_exclude_unset=True)
async def bot_move(req: BotMoveRequest, request: Request) -> dict[str, Any]:
    if req.bot == "maia" and req.variant != "standard":
        raise HTTPException(status_code=400, detail="Maia only plays standard chess.")
    try:
        board = parse_variant_fen(req.variant, req.fen)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not any(board.legal_moves):
        raise HTTPException(status_code=400, detail="the game is over: no legal moves")
    svc = services(request)
    choice = await (_maia_choice if req.bot == "maia" else _engine_choice)(svc, board, req)
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
