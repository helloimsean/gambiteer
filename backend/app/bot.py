"""Strength-limited bot moves.

* elo >= 1320: Stockfish's own limiter (``UCI_LimitStrength=true, UCI_Elo=elo``) on the dedicated
  ``bot`` engine, searching for ``movetime_ms``. The limited engine's score is returned if it sent one.
* elo < 1320: Stockfish's Elo limiter stops at 1320, so below that we use ``Skill Level``
  ``round((elo - 400) / 920 * 7)`` (0..7) at depth ``max(2, round((elo - 400) / 920 * 8) + 1)``
  plus a mixing step: MultiPV 5 at that depth, then move i is picked with probability
  softmax(-cpLoss_i / T), T = 60 + (1320 - elo) * 0.35 centipawns. Moves losing more than 500 cp
  are excluded unless elo < 700. **This sub-1320 strength is approximate**: it has not been
  calibrated against rated play.

Panicfish loses 300 Elo per check, and the frontend sends what it has left. 3600 means no limit at
all. Anything from there down is the ladder above, and 0 is a uniformly random legal move.

The analysis engine is a separate process, so these strength options never affect analysis.
"""
from __future__ import annotations

import math
import random
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Protocol

import chess
import chess.engine

from .chessutil import ScoreDict, score_to_dict

UCI_ELO_MIN = 1320
UCI_ELO_MAX = 3190
STOCKFISH_ELO_RANGE = (UCI_ELO_MIN, UCI_ELO_MAX)
FAIRY_ELO_RANGE = (500, 2850)
PANICFISH_FULL_ELO = 3600
MIX_MULTIPV = 5
CP_LOSS_CAP = 500
CAP_EXEMPT_BELOW = 700
MATE_CP = 100_000


class BotEngine(Protocol):
    """The subset of EngineProxy the bot needs (stubbed in tests)."""

    async def configure(self, options: dict[str, Any]) -> None: ...

    async def analyse(
        self, board: chess.Board, limit: chess.engine.Limit, *, multipv: int | None = None, info: Any = ...
    ) -> Any: ...

    async def play(self, board: chess.Board, limit: chess.engine.Limit, *, info: Any = ...) -> chess.engine.PlayResult: ...


def skill_level_for(elo: int) -> int:
    return max(0, min(7, round((elo - 400) / 920 * 7)))


def depth_for(elo: int) -> int:
    return max(2, round((elo - 400) / 920 * 8) + 1)


def temperature_for(elo: int) -> float:
    return 60 + (1320 - elo) * 0.35


def softmax_weights(cp_losses: Sequence[float], temperature: float) -> list[float]:
    """Normalised softmax(-loss / T) probabilities."""
    t = max(1e-6, temperature)
    lo = min(cp_losses)
    raw = [math.exp(-(loss - lo) / t) for loss in cp_losses]
    total = sum(raw)
    return [w / total for w in raw]


def eligible_indices(cp_losses: Sequence[float], elo: int) -> list[int]:
    """Indices that may be picked: everything below 700 Elo, otherwise loss <= 500 cp (best always)."""
    if elo < CAP_EXEMPT_BELOW:
        return list(range(len(cp_losses)))
    keep = [i for i, loss in enumerate(cp_losses) if loss <= CP_LOSS_CAP]
    return keep or [min(range(len(cp_losses)), key=lambda i: cp_losses[i])]


def pick_mixed(cp_losses: Sequence[float], elo: int, rng: random.Random) -> int:
    """Index of the chosen candidate (softmax over the eligible ones)."""
    idx = eligible_indices(cp_losses, elo)
    weights = softmax_weights([cp_losses[i] for i in idx], temperature_for(elo))
    return rng.choices(idx, weights=weights, k=1)[0]


@dataclass
class BotChoice:
    move: chess.Move
    score: ScoreDict | None
    mode: str  # "uci_elo" | "skill" | "full" | "random"
    elo: int
    skill: int | None = None
    candidates: int = 1


async def _timed_move(engine: BotEngine, board: chess.Board, movetime_ms: int) -> tuple[chess.Move, ScoreDict | None]:
    result = await engine.play(
        board, chess.engine.Limit(time=max(0.05, movetime_ms / 1000)), info=chess.engine.INFO_SCORE
    )
    if result.move is None:
        raise RuntimeError("engine returned no move")
    score = result.info.get("score") if result.info else None
    return result.move, score_to_dict(score) if score is not None else None


async def choose_panicfish_move(
    engine: BotEngine,
    board: chess.Board,
    elo: int,
    movetime_ms: int = 800,
    rng: random.Random | None = None,
    uci_elo_range: tuple[int, int] = STOCKFISH_ELO_RANGE,
) -> BotChoice:
    if not any(board.legal_moves):
        raise ValueError("the game is over: no legal moves")
    if elo <= 0:
        return BotChoice(move=(rng or random.Random()).choice(list(board.legal_moves)), score=None, mode="random", elo=0)
    if elo >= PANICFISH_FULL_ELO:
        await engine.configure({"UCI_LimitStrength": False, "Skill Level": 20})
        move, score = await _timed_move(engine, board, movetime_ms)
        return BotChoice(move=move, score=score, mode="full", elo=elo)
    return await choose_bot_move(engine, board, elo, movetime_ms, rng, uci_elo_range)


async def choose_bot_move(
    engine: BotEngine,
    board: chess.Board,
    elo: int,
    movetime_ms: int = 800,
    rng: random.Random | None = None,
    uci_elo_range: tuple[int, int] = STOCKFISH_ELO_RANGE,
) -> BotChoice:
    if not any(board.legal_moves):
        raise ValueError("the game is over: no legal moves")
    elo = int(elo)
    lowest, highest = uci_elo_range
    if elo >= lowest:
        await engine.configure({"UCI_LimitStrength": True, "UCI_Elo": min(highest, elo), "Skill Level": 20})
        move, score = await _timed_move(engine, board, movetime_ms)
        return BotChoice(move=move, score=score, mode="uci_elo", elo=elo)

    skill = skill_level_for(elo)
    depth = depth_for(elo)
    await engine.configure({"UCI_LimitStrength": False, "Skill Level": skill})
    infos = await engine.analyse(
        board,
        chess.engine.Limit(depth=depth, time=max(0.2, movetime_ms / 1000)),
        multipv=MIX_MULTIPV,
        info=chess.engine.INFO_SCORE | chess.engine.INFO_PV,
    )
    if isinstance(infos, dict):
        infos = [infos]
    candidates: list[tuple[chess.Move, int, Any]] = []
    seen: set[chess.Move] = set()
    for info in infos:
        pv = info.get("pv")
        score = info.get("score")
        if not pv or score is None or pv[0] in seen or pv[0] not in board.legal_moves:
            continue
        seen.add(pv[0])
        cp = score.pov(board.turn).score(mate_score=MATE_CP)
        candidates.append((pv[0], int(cp if cp is not None else 0), score))
    if not candidates:
        result = await engine.play(board, chess.engine.Limit(depth=depth))
        if result.move is None:
            raise RuntimeError("engine returned no move")
        return BotChoice(move=result.move, score=None, mode="skill", elo=elo, skill=skill)
    best_cp = max(cp for _, cp, _ in candidates)
    losses = [best_cp - cp for _, cp, _ in candidates]
    i = pick_mixed(losses, elo, rng or random.Random())
    move, _, score = candidates[i]
    return BotChoice(
        move=move, score=score_to_dict(score), mode="skill", elo=elo, skill=skill, candidates=len(candidates)
    )
