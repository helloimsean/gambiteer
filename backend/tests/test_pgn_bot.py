"""PGN parsing and bot move selection (softmax mixing) with a stubbed engine."""
from __future__ import annotations

import asyncio
import random
from collections import Counter
from typing import Any

import chess
import chess.engine
import pytest

from app.bot import (
    choose_bot_move,
    depth_for,
    eligible_indices,
    pick_mixed,
    skill_level_for,
    softmax_weights,
    temperature_for,
)
from app.routers.pgn import parse_pgn

# ----------------------------------------------------------------------------- PGN

PGN = """[Event "Casual"]
[White "Alice"]
[Black "Bob"]
[Result "1-0"]

1. e4 e5 2. Qh5 Nc6 3. Bc4 {threat} Nf6?? 4. Qxf7# 1-0
"""


def test_parse_pgn() -> None:
    res = parse_pgn(PGN)
    assert res.headers["White"] == "Alice" and res.headers["Result"] == "1-0"
    assert [m.san for m in res.moves] == ["e4", "e5", "Qh5", "Nc6", "Bc4", "Nf6", "Qxf7#"]
    assert [m.uci for m in res.moves][:3] == ["e2e4", "e7e5", "d1h5"]
    assert res.moves[0].fen == "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
    assert res.startFen == chess.STARTING_FEN
    assert chess.Board(res.moves[-1].fen).is_checkmate()


def test_parse_pgn_comments_variations_nags() -> None:
    text = '[Event "x"]\n\n1. e4 {a comment (with parens)} e5 (1... c5 2. Nf3) 2. Nf3! $1 Nc6?! 3. Bb5 a6 1/2-1/2'
    assert [m.san for m in parse_pgn(text).moves] == ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"]


def test_parse_pgn_bare_moves_and_fen() -> None:
    assert len(parse_pgn("1. d4 d5 2. c4").moves) == 3
    fen = "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1"
    res = parse_pgn(f'[FEN "{fen}"]\n[SetUp "1"]\n\n1. e4 Kd7 *')
    assert res.startFen == fen and [m.san for m in res.moves] == ["e4", "Kd7"]


@pytest.mark.parametrize("bad", ["", "   ", "1. e4 e5 2. Ke3 Qh4 3. Nf9", "hello world", "1. e4 e5 2. Kf9"])
def test_parse_pgn_errors(bad: str) -> None:
    with pytest.raises(ValueError):
        parse_pgn(bad)


# ----------------------------------------------------------------------------- bot maths


def test_strength_parameters() -> None:
    # skill = round((elo-400)/920*7) clamped 0..7; depth = max(2, round((elo-400)/920*8)+1)
    assert [skill_level_for(e) for e in (400, 500, 800, 1000, 1200, 1319)] == [0, 1, 3, 5, 6, 7]
    assert [depth_for(e) for e in (400, 500, 800, 1000, 1200, 1319)] == [2, 2, 4, 6, 8, 9]
    assert temperature_for(400) == pytest.approx(382.0)  # 60 + 920 * 0.35
    assert temperature_for(1000) == pytest.approx(172.0)  # 60 + 320 * 0.35


def test_softmax_weights_by_hand() -> None:
    # T=382: exp(0)=1, exp(-50/382)=0.8773, exp(-100/382)=0.7697, exp(-300/382)=0.4560, exp(-600/382)=0.2079
    # sum = 3.3109 -> 0.3020, 0.2650, 0.2325, 0.1377, 0.0628
    w = softmax_weights([0, 50, 100, 300, 600], 382.0)
    assert w == pytest.approx([0.3020, 0.2650, 0.2325, 0.1377, 0.0628], abs=0.0005)
    assert sum(w) == pytest.approx(1.0)


def test_cap_rules() -> None:
    assert eligible_indices([0, 50, 600], 650) == [0, 1, 2]  # below 700: no cap
    assert eligible_indices([0, 50, 600], 1000) == [0, 1]  # 500 cp cap
    assert eligible_indices([0, 501], 1300) == [0]


def test_pick_mixed_distribution() -> None:
    rng = random.Random(1234)
    losses = [0, 50, 100, 300, 600]
    n = 20_000
    counts = Counter(pick_mixed(losses, 400, rng) for _ in range(n))
    expected = [0.3020, 0.2650, 0.2325, 0.1377, 0.0628]
    for i, p in enumerate(expected):
        assert counts[i] / n == pytest.approx(p, abs=0.015)
    # at 1000 Elo the 600 cp move is never chosen; T=172 -> 0.4030, 0.3013, 0.2253, 0.0704
    counts = Counter(pick_mixed(losses, 1000, rng) for _ in range(n))
    assert counts[4] == 0
    for i, p in enumerate([0.4030, 0.3013, 0.2253, 0.0704]):
        assert counts[i] / n == pytest.approx(p, abs=0.015)


# ----------------------------------------------------------------------------- stubbed engine


class StubEngine:
    """Answers MultiPV requests with fixed centipawn scores (side-to-move POV) per move."""

    def __init__(self, board: chess.Board, scored: list[tuple[str, int]], play_move: str = "e2e4") -> None:
        self.board = board
        self.scored = scored
        self.play_move = play_move
        self.configured: list[dict[str, Any]] = []
        self.calls: list[tuple[str, Any]] = []

    async def configure(self, options: dict[str, Any]) -> None:
        self.configured.append(dict(options))

    async def analyse(self, board: chess.Board, limit: chess.engine.Limit, *, multipv: int | None = None, info: Any = None) -> Any:
        self.calls.append(("analyse", (limit, multipv)))
        out = []
        for i, (uci, cp) in enumerate(self.scored[: multipv or 1], start=1):
            out.append({
                "multipv": i,
                "pv": [chess.Move.from_uci(uci)],
                "score": chess.engine.PovScore(chess.engine.Cp(cp), board.turn),
                "depth": limit.depth,
            })
        return out

    async def play(self, board: chess.Board, limit: chess.engine.Limit, *, info: Any = None) -> chess.engine.PlayResult:
        self.calls.append(("play", limit))
        score = chess.engine.PovScore(chess.engine.Cp(-20), chess.WHITE)
        return chess.engine.PlayResult(chess.Move.from_uci(self.play_move), None, {"score": score})


def test_bot_low_elo_mixes_with_stub() -> None:
    board = chess.Board()
    scored = [("e2e4", 40), ("d2d4", 0), ("g1f3", -40), ("a2a3", -160), ("g2g4", -560)]
    stub = StubEngine(board, scored)
    rng = random.Random(7)

    async def run(n: int) -> Counter[str]:
        c: Counter[str] = Counter()
        for _ in range(n):
            choice = await choose_bot_move(stub, board, 1000, 800, rng)
            assert choice.mode == "skill" and choice.skill == 5 and choice.elo == 1000
            c[choice.move.uci()] += 1
        return c

    counts = asyncio.run(run(4000))
    assert counts["g2g4"] == 0  # 600 cp loss is capped at 1000 Elo
    assert counts["e2e4"] > counts["d2d4"] > counts["g1f3"] > counts["a2a3"] > 0
    limit, multipv = stub.calls[0][1]
    assert multipv == 5 and limit.depth == 6
    assert stub.configured[0] == {"UCI_LimitStrength": False, "Skill Level": 5}


def test_bot_low_elo_scores_are_white_pov() -> None:
    board = chess.Board("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1")
    stub = StubEngine(board, [("c7c5", -30)])  # Black is better by 30 from its own POV
    choice = asyncio.run(choose_bot_move(stub, board, 600, 800, random.Random(0)))
    assert choice.move.uci() == "c7c5" and choice.score == {"cp": 30}


def test_bot_uci_elo_uses_limit_strength() -> None:
    board = chess.Board()
    stub = StubEngine(board, [], play_move="d2d4")
    choice = asyncio.run(choose_bot_move(stub, board, 1500, 300))
    assert choice.mode == "uci_elo" and choice.move.uci() == "d2d4" and choice.score == {"cp": -20}
    assert stub.configured[-1]["UCI_LimitStrength"] is True and stub.configured[-1]["UCI_Elo"] == 1500
    assert stub.calls[-1][1].time == pytest.approx(0.3)
    choice = asyncio.run(choose_bot_move(stub, board, 3190, 300))
    assert stub.configured[-1]["UCI_Elo"] == 3190


def test_bot_game_over() -> None:
    mate = chess.Board("rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3")
    with pytest.raises(ValueError):
        asyncio.run(choose_bot_move(StubEngine(mate, []), mate, 1500))
