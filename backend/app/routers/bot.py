"""POST /api/bot/move."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request

from ..bot import choose_bot_move
from ..chessutil import parse_fen
from ..deps import services
from ..schemas import BotMoveRequest, BotMoveResponse

router = APIRouter(prefix="/api/bot", tags=["bot"])


@router.post("/move", response_model=BotMoveResponse, response_model_exclude_unset=True)
async def bot_move(req: BotMoveRequest, request: Request) -> dict[str, Any]:
    try:
        board = parse_fen(req.fen)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not any(board.legal_moves):
        raise HTTPException(status_code=400, detail="the game is over: no legal moves")
    async with services(request).engines.use("bot") as engine:
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
