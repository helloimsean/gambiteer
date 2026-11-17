"""PityFish (POST /api/bot/worst: was a move the worst one available? It then loses 300 Elo) and Worstfish (always plays it)."""
from __future__ import annotations

import asyncio
from typing import Any

import chess
import chess.engine
import chess.variant
import pytest
from fastapi.testclient import TestClient

import random

from app.bot import choose_worstfish_move, is_worst_move
from app.main import create_app
from tests.conftest import needs_stockfish, test_settings

START = chess.STARTING_FEN


class Rater:
    """An engine that rates the legal moves from a table (centipawns for the side to move)."""

    def __init__(self, ratings: dict[str, int]) -> None:
        self.ratings = ratings
        self.configured: list[dict[str, Any]] = []
        self.multipv: int | None = None

    async def configure(self, options: dict[str, Any]) -> None:
        self.configured.append(dict(options))

    async def analyse(self, board: chess.Board, limit: chess.engine.Limit, *, multipv: int | None = None, info: Any = None) -> Any:
        self.multipv = multipv
        return [
            {"pv": [chess.Move.from_uci(uci)], "score": chess.engine.PovScore(chess.engine.Cp(cp), board.turn), "multipv": i}
            for i, (uci, cp) in enumerate(self.ratings.items(), start=1)
        ]


def worst(ratings: dict[str, int], played: str, fen: str = START) -> bool:
    board = chess.Board(fen)
    return asyncio.run(is_worst_move(Rater(ratings), board, chess.Move.from_uci(played)))


def test_the_lowest_rated_move_is_the_worst() -> None:
    ratings = {"e2e4": 30, "d2d4": 25, "f2f3": -80, "g2g4": -150}
    assert worst(ratings, "g2g4")
    assert not worst(ratings, "f2f3")  # bad, but not the worst
    assert not worst(ratings, "e2e4")


def test_a_tie_for_the_lowest_counts() -> None:
    ratings = {"e2e4": 30, "f2f3": -150, "g2g4": -150}
    assert worst(ratings, "f2f3") and worst(ratings, "g2g4")


def test_a_position_where_every_move_rates_the_same_has_no_worst_move() -> None:
    assert not worst({"e2e4": 0, "d2d4": 0, "g2g4": 0}, "g2g4")


def test_getting_mated_is_worse_than_losing_a_queen() -> None:
    assert worst({"e2e4": 0, "d2d4": -900, "f2f3": -99_990}, "f2f3")


def test_a_move_the_engine_did_not_rate_is_not_the_worst() -> None:
    assert not worst({"e2e4": 30, "d2d4": 25}, "g2g4")


def test_every_legal_move_is_searched_at_full_strength() -> None:
    rater = Rater({"e2e4": 30, "g2g4": -150})
    asyncio.run(is_worst_move(rater, chess.Board(), chess.Move.from_uci("g2g4")))
    assert rater.multipv == 20
    assert rater.configured == [{"UCI_LimitStrength": False, "Skill Level": 20}]


def test_a_single_legal_move_is_never_the_worst() -> None:
    board = chess.Board("k7/2K5/8/8/8/8/8/1R6 b - - 0 1")  # Ka7 is forced
    assert board.legal_moves.count() == 1
    assert not asyncio.run(is_worst_move(Rater({"a8a7": 0}), board, chess.Move.from_uci("a8a7")))


def test_too_many_legal_moves_to_list_is_never_judged() -> None:
    board = chess.variant.CrazyhouseBoard("k7/8/8/8/8/8/8/K7[QRBNPqrbnpPPPPPPPP] w - - 0 1")
    assert board.legal_moves.count() > 256
    rater = Rater({"a1b1": 0, "a1a2": -500})
    assert not asyncio.run(is_worst_move(rater, board, chess.Move.from_uci("a1a2")))
    assert rater.multipv is None  # the engine was not even asked


@pytest.fixture(scope="module")
def client() -> Any:
    with TestClient(create_app(test_settings())) as c:
        yield c


def post(client: TestClient, **body: Any) -> Any:
    return client.post("/api/bot/worst", json={"fen": START, **body})


@needs_stockfish
def test_real_stockfish_finds_the_worst_opening_move(client: TestClient) -> None:
    board = chess.Board()
    worst_sans = [board.san(m) for m in board.legal_moves if post(client, move=board.san(m)).json()["worst"]]
    assert worst_sans and len(worst_sans) <= 3, worst_sans
    assert "e4" not in worst_sans and "d4" not in worst_sans


@needs_stockfish
def test_uci_is_accepted_too(client: TestClient) -> None:
    assert post(client, move="e2e4").json() == {"worst": False}


@pytest.mark.parametrize("body", [{"move": "Ke4"}, {"move": ""}, {"move": "e2e5"}, {"fen": "not a fen", "move": "e4"}])
def test_a_move_that_is_not_legal_is_a_400(client: TestClient, body: dict[str, str]) -> None:
    assert post(client, **body).status_code == 400


def test_pityfish_is_a_bot_with_an_elo_from_0_to_3600(client: TestClient) -> None:
    for elo, code in ((-1, 422), (3601, 422)):
        assert client.post("/api/bot/move", json={"fen": START, "bot": "pityfish", "elo": elo}).status_code == code


@needs_stockfish
def test_pityfish_plays_at_full_strength_then_gets_weaker_and_then_random(client: TestClient) -> None:
    modes = {
        elo: client.post("/api/bot/move", json={"fen": START, "bot": "pityfish", "elo": elo, "movetime_ms": 100}).json()["strength"]["mode"]
        for elo in (3600, 3300, 300, 0)
    }
    assert modes == {3600: "full", 3300: "uci_elo", 300: "skill", 0: "random"}


# ----------------------------------------------------------------------------- Worstfish


def worstfish(ratings: dict[str, int], fen: str = START, seed: int = 0) -> Any:
    return asyncio.run(choose_worstfish_move(Rater(ratings), chess.Board(fen), 0, 200, random.Random(seed)))


def test_worstfish_plays_the_lowest_rated_move() -> None:
    choice = worstfish({"e2e4": 30, "d2d4": 25, "f2f3": -80, "g2g4": -150})
    assert choice.move.uci() == "g2g4" and choice.mode == "worst"
    assert choice.score == {"cp": -150}


def test_worstfish_prefers_a_quiet_move_then_a_check_then_a_capture() -> None:
    fen = "rnbqkbnr/ppp2ppp/8/3pp3/3PP3/8/PPP2PPP/RNBQKBNR w KQkq - 0 3"  # exd5 and dxe5 capture, Bb5+ checks
    quiet, check, capture = "a2a3", "f1b5", "e4d5"
    assert worstfish({capture: -500, check: -500, quiet: -500, "g1f3": 10}, fen).move.uci() == quiet
    assert worstfish({capture: -500, check: -500, "g1f3": 10}, fen).move.uci() == check
    assert worstfish({capture: -500, "g1f3": 10}, fen).move.uci() == capture
    # inside a group it picks at random, and every member can come up
    tied = {"a2a3": -500, "h2h3": -500, "g1f3": 10}
    assert {worstfish(tied, fen, seed).move.uci() for seed in range(20)} == {"a2a3", "h2h3"}


def test_worstfish_a_forced_loss_is_worse_than_a_lost_queen() -> None:
    assert worstfish({"e2e4": 0, "d2d4": -900, "f2f3": -99_990}).move.uci() == "f2f3"


def test_worstfish_with_too_many_moves_to_rate_plays_a_random_legal_move() -> None:
    board = chess.variant.CrazyhouseBoard("k7/8/8/8/8/8/8/K7[QRBNPqrbnpPPPPPPPP] w - - 0 1")
    rater = Rater({})
    choice = asyncio.run(choose_worstfish_move(rater, board, 0, 200, random.Random(1)))
    assert choice.move in board.legal_moves and rater.multipv is None and choice.score is None


def test_worstfish_a_finished_game_is_an_error() -> None:
    mate = chess.Board("rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3")
    with pytest.raises(ValueError):
        asyncio.run(choose_worstfish_move(Rater({}), mate, 0, 200))


def test_worstfish_is_a_bot_the_api_accepts(client: TestClient) -> None:
    body = {"fen": "not a fen", "bot": "worstfish", "elo": 3600}
    assert client.post("/api/bot/move", json=body).status_code == 400  # past validation, into the FEN check


@needs_stockfish
def test_real_stockfish_worstfish_opens_with_the_worst_move(client: TestClient) -> None:
    res = client.post("/api/bot/move", json={"fen": START, "bot": "worstfish", "elo": 3600, "movetime_ms": 300}).json()
    assert res["san"] == "g4" and res["strength"]["mode"] == "worst"
    after = chess.Board(res["fen_after"])
    assert after.turn == chess.BLACK
