"""Maia: lc0 output parsing, move selection, the API and the tools.

Everything runs on the stand-in engine tests/fixtures/fake_lc0.py. Nothing here starts a real lc0,
so these tests say nothing about the real engine's behaviour (tools/check_maia.py is for that).
"""
from __future__ import annotations

import asyncio
import gzip
import os
import random
import re
import subprocess
import sys
import time
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import chess
import chess.engine
import pytest
from fastapi.testclient import TestClient

from app.config import ROOT_DIR, Settings
from app.engine import EngineManager, VerboseSearch
from app.maia import (
    MAIA_RATINGS,
    MAIA_SLOT,
    board_with_history,
    choose_maia_move,
    create_manager,
    installed_ratings,
    net_is_intact,
    parse_policy,
    read_policy,
    same_position,
    sample_move,
    selection_pool,
    weight_path,
)
from app.main import create_app

from .conftest import FIXTURES, needs_stockfish, test_settings
from .fixtures import fake_lc0

FAKE_LC0 = FIXTURES / "fake_lc0.py"
CHECK_MAIA = ROOT_DIR / "tools" / "check_maia.py"
START = chess.STARTING_FEN

# Exact lines, as python-chess hands them over (it removes "info string ").
TAIL = "(WL:  -.-----) (D: -.---) (M:  -.-) (Q: -0.01234) (U: 0.12345) (S: 0.12345) (V:  -.----)"
NODE_LINE = "node  (  20) N:       1 (+ 0) (P: 100.0%) (WL:  0.01234) (D: 0.500) (M:  0.0) (Q:  0.01234) (V:  0.0123)"


def move(uci: str) -> chess.Move:
    return chess.Move.from_uci(uci)


# ----------------------------------------------------------------------------- parse_policy


def test_parse_policy_exact_lc0_lines() -> None:
    lines = [
        f"a2a3  (0   ) N:       0 (+ 0) (P:  1.20%) {TAIL}",
        f"g1f3  (159 ) N:       0 (+ 0) (P: 12.05%) {TAIL}",
        f"e2e4  (322 ) N:       0 (+ 0) (P: 28.40%) {TAIL}",
        f"d2d4  (293 ) N:       0 (+ 0) (P: 31.25%) {TAIL}",
        NODE_LINE,
    ]
    policy = parse_policy(lines, chess.Board())
    assert policy == pytest.approx(
        {move("a2a3"): 0.012, move("g1f3"): 0.1205, move("e2e4"): 0.284, move("d2d4"): 0.3125}
    )


def test_parse_policy_keeps_the_info_string_prefix_optional() -> None:
    line = f"info string e2e4  (322 ) N:       0 (+ 0) (P: 28.40%) {TAIL}"
    assert parse_policy([line], chess.Board()) == pytest.approx({move("e2e4"): 0.284})


def test_parse_policy_black_to_move_uses_real_squares() -> None:
    board = chess.Board("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1")
    lines = [
        f"e2e5  (1   ) N:       0 (+ 0) (P: 50.00%) {TAIL}",  # not a Black move
        f"e7e5  (322 ) N:       0 (+ 0) (P: 30.00%) {TAIL}",
        f"c7c5  (200 ) N:       0 (+ 0) (P: 40.00%) {TAIL}",
    ]
    assert parse_policy(lines, board) == pytest.approx({move("e7e5"): 0.30, move("c7c5"): 0.40})


def test_parse_policy_promotion_labels() -> None:
    board = chess.Board("8/P6k/8/8/8/8/6K1/8 w - - 0 1")
    lines = [
        f"a7a8n (11  ) N:       0 (+ 0) (P:  4.00%) {TAIL}",
        f"a7a8r (12  ) N:       0 (+ 0) (P:  1.00%) {TAIL}",
        f"a7a8q (13  ) N:       0 (+ 0) (P: 93.00%) {TAIL}",
    ]
    assert parse_policy(lines, board) == pytest.approx(
        {move("a7a8n"): 0.04, move("a7a8r"): 0.01, move("a7a8q"): 0.93}
    )


@pytest.mark.parametrize(
    ("fen", "labels", "expected"),
    [
        ("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", ("e1h1", "e1g1"), "e1g1"),
        ("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", ("e1a1", "e1c1"), "e1c1"),
        ("r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1", ("e8h8", "e8g8"), "e8g8"),
        ("r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1", ("e8a8", "e8c8"), "e8c8"),
    ],
)
def test_parse_policy_castling_both_notations(fen: str, labels: tuple[str, str], expected: str) -> None:
    board = chess.Board(fen)
    for label in labels:
        lines = [f"{label:<5} (77  ) N:       0 (+ 0) (P: 11.50%) {TAIL}"]
        assert parse_policy(lines, board) == pytest.approx({move(expected): 0.115})


def test_parse_policy_skips_the_node_line_garbage_and_illegal_moves() -> None:
    lines = [
        NODE_LINE,
        "",
        "hello world",
        "Created Network from file",
        "e2e4 without any policy",
        "(P: 10.00%)",
        f"e2e5  (9   ) N:       0 (+ 0) (P: 10.00%) {TAIL}",  # not legal
        f"zzzz  (9   ) N:       0 (+ 0) (P: 10.00%) {TAIL}",  # not a move
        f"0000  (9   ) N:       0 (+ 0) (P: 10.00%) {TAIL}",  # null move
        f"d2d4  (9   ) N:       0 (+ 0) (P: -.---%) {TAIL}",  # no number
    ]
    assert parse_policy(lines, chess.Board()) == {}


def test_parse_policy_single_move_shows_one_decimal() -> None:
    board = chess.Board("7k/8/8/8/8/8/6q1/7K w - - 0 1")  # only Kxg2
    (only,) = board.legal_moves
    line = f"{only.uci():<5} (1   ) N:       0 (+ 0) (P: 100.0%) {TAIL}"
    assert parse_policy([line], board) == pytest.approx({only: 1.0})


# ----------------------------------------------------------------------------- selection


def test_selection_pool_keeps_moves_over_the_cutoff_and_renormalises() -> None:
    # top 0.50 -> cutoff max(0.03, 0.05) = 0.05, so 0.04 and 0.02 go; 0.9 is what remains
    a, b, c, d, e = (move(u) for u in ("e2e4", "d2d4", "g1f3", "c2c4", "b1c3"))
    pool = selection_pool({a: 0.50, b: 0.30, c: 0.10, d: 0.04, e: 0.02})
    assert pool == pytest.approx({a: 0.5 / 0.9, b: 0.3 / 0.9, c: 0.1 / 0.9})
    assert sum(pool.values()) == pytest.approx(1.0)


def test_selection_pool_absolute_floor_applies_when_the_top_move_is_small() -> None:
    # top 0.20 -> cutoff max(0.03, 0.02) = 0.03
    a, b, c = (move(u) for u in ("e2e4", "d2d4", "g1f3"))
    assert set(selection_pool({a: 0.20, b: 0.03, c: 0.029})) == {a, b}


def test_selection_pool_relative_floor_applies_when_the_top_move_is_large() -> None:
    # top 0.50 -> cutoff 0.05: exactly 0.05 stays, 0.049 goes
    a, b, c = (move(u) for u in ("e2e4", "d2d4", "g1f3"))
    assert set(selection_pool({a: 0.50, b: 0.05, c: 0.049})) == {a, b}


def test_selection_pool_always_has_the_top_move() -> None:
    a, b = move("e2e4"), move("d2d4")
    assert selection_pool({a: 0.02, b: 0.01}) == {a: 1.0}
    assert selection_pool({a: 0.0, b: 0.0}) == {a: 1.0}
    assert selection_pool({a: 1.0}) == {a: 1.0}


def test_sample_move_matches_the_pool_distribution_with_a_seed() -> None:
    a, b, c, d = (move(u) for u in ("e2e4", "d2d4", "g1f3", "h2h4"))
    policy = {a: 0.5, b: 0.3, c: 0.15, d: 0.01}  # h4 is below the cutoff
    rng = random.Random(1234)
    n = 20_000
    counts = Counter(sample_move(policy, rng)[0] for _ in range(n))
    assert counts[d] == 0
    assert counts[a] / n == pytest.approx(0.5 / 0.95, abs=0.015)
    assert counts[b] / n == pytest.approx(0.3 / 0.95, abs=0.015)
    assert counts[c] / n == pytest.approx(0.15 / 0.95, abs=0.015)
    assert sample_move(policy, random.Random(5)) == sample_move(policy, random.Random(5))


# ----------------------------------------------------------------------------- history


def test_board_with_history_replays_moves() -> None:
    board = chess.Board("rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2")
    replay = board_with_history(board, ["e2e4", "e7e5", "g1f3"])
    assert [m.uci() for m in replay.move_stack] == ["e2e4", "e7e5", "g1f3"]
    assert replay.root().fen() == START
    assert same_position(replay, board)


def test_board_with_history_without_moves_is_the_fen_board() -> None:
    board = chess.Board()
    assert board_with_history(board, None) is board
    assert board_with_history(board, []) is board


@pytest.mark.parametrize(
    ("moves", "start_fen"),
    [
        (["e2e4", "e7e4"], None),  # illegal
        (["nonsense"], None),
        (["0000"], None),  # null move
        (["e2e4"], "not a fen"),
        (["e2e4"], None),  # legal, but ends somewhere else
    ],
)
def test_board_with_history_falls_back_to_the_fen(moves: list[str], start_fen: str | None) -> None:
    board = chess.Board("r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3")
    assert board_with_history(board, moves, start_fen) is board


def test_same_position_ignores_counters_and_unusable_en_passant() -> None:
    a = chess.Board("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1")
    b = chess.Board("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 7 9")
    assert same_position(a, b)


def test_same_position_compares_turn_castling_and_legal_en_passant() -> None:
    base = chess.Board("rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2")
    assert not same_position(base, chess.Board("rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2"))
    assert not same_position(base, chess.Board("rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w Qkq - 0 2"))
    assert not same_position(base, chess.Board("rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2"))


# ----------------------------------------------------------------------------- choose_maia_move (stub)


class StubMaiaEngine:
    def __init__(self, search: VerboseSearch) -> None:
        self.search = search
        self.configured: list[dict[str, Any]] = []
        self.limits: list[chess.engine.Limit] = []
        self.boards: list[chess.Board] = []

    async def configure(self, options: Any) -> None:
        self.configured.append(dict(options))

    async def search_verbose(self, board: chess.Board, limit: chess.engine.Limit) -> VerboseSearch:
        self.limits.append(limit)
        self.boards.append(board.copy())
        return self.search


def test_choose_maia_move_samples_from_the_policy(tmp_path: Path) -> None:
    board = chess.Board()
    lines = [
        f"e2e4  (322 ) N:       0 (+ 0) (P: 60.00%) {TAIL}",
        f"d2d4  (293 ) N:       0 (+ 0) (P: 40.00%) {TAIL}",
        NODE_LINE,
    ]
    score = chess.engine.PovScore(chess.engine.Cp(35), chess.WHITE)
    stub = StubMaiaEngine(VerboseSearch(lines, score, move("e2e4")))
    weights = tmp_path / "maia-1500.pb.gz"
    choice = asyncio.run(choose_maia_move(stub, board, 1500, weights, random.Random(9)))
    expected = sample_move(parse_policy(lines, board), random.Random(9))[0]
    assert choice.move == expected and choice.mode == "maia" and choice.elo == 1500
    assert choice.skill is None and choice.score == {"cp": 35} and choice.candidates == 2
    assert stub.configured == [{"WeightsFile": str(weights.resolve())}]
    assert stub.limits[0].nodes == 1


def test_choose_maia_move_sends_the_board_history(tmp_path: Path) -> None:
    board = chess.Board()
    board.push_uci("e2e4")
    stub = StubMaiaEngine(VerboseSearch([], None, move("e7e5")))
    asyncio.run(choose_maia_move(stub, board, 1500, tmp_path / "n.pb.gz"))
    assert [m.uci() for m in stub.boards[0].move_stack] == ["e2e4"]


def test_choose_maia_move_without_a_policy_uses_bestmove(tmp_path: Path) -> None:
    stub = StubMaiaEngine(VerboseSearch(["no policy here"], None, move("g1f3")))
    choice = asyncio.run(choose_maia_move(stub, chess.Board(), 1300, tmp_path / "n.pb.gz", random.Random(1)))
    assert choice.move == move("g1f3") and choice.score is None and choice.candidates == 1


def test_choose_maia_move_score_is_white_pov(tmp_path: Path) -> None:
    board = chess.Board("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1")
    score = chess.engine.PovScore(chess.engine.Cp(30), chess.BLACK)  # Black is better
    stub = StubMaiaEngine(VerboseSearch([], score, move("e7e5")))
    assert asyncio.run(choose_maia_move(stub, board, 1500, tmp_path / "n.pb.gz")).score == {"cp": -30}


def test_choose_maia_move_game_over(tmp_path: Path) -> None:
    mate = chess.Board("rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3")
    stub = StubMaiaEngine(VerboseSearch([], None, None))
    with pytest.raises(ValueError):
        asyncio.run(choose_maia_move(stub, mate, 1500, tmp_path / "n.pb.gz"))
    assert stub.configured == []


def test_choose_maia_move_no_policy_no_bestmove_is_an_engine_error(tmp_path: Path) -> None:
    stub = StubMaiaEngine(VerboseSearch([], None, None))
    with pytest.raises(chess.engine.EngineError):
        asyncio.run(choose_maia_move(stub, chess.Board(), 1500, tmp_path / "n.pb.gz"))


# ----------------------------------------------------------------------------- settings and files


def test_settings_read_the_maia_environment_variables() -> None:
    settings = Settings.from_env({"LC0_PATH": "x/lc0", "MAIA_WEIGHTS_DIR": "y/nets"})
    assert settings.lc0_path == Path("x/lc0") and settings.maia_weights_dir == Path("y/nets")
    defaults = Settings.from_env({})
    assert defaults.lc0_path == ROOT_DIR / "engines" / "lc0" / "lc0.exe"
    assert defaults.maia_weights_dir == ROOT_DIR / "engines" / "maia"


def test_installed_ratings_only_counts_existing_files(tmp_path: Path) -> None:
    assert installed_ratings(tmp_path) == []
    assert installed_ratings(tmp_path / "missing") == []
    weight_path(tmp_path, 1300).write_bytes(b"x")
    weight_path(tmp_path, 1900).write_bytes(b"x")
    (tmp_path / "maia-1950.pb.gz").write_bytes(b"x")  # not a Maia rating
    assert installed_ratings(tmp_path) == [1300, 1900]


def test_net_is_intact_accepts_a_whole_net_with_the_lc0_header(tmp_path: Path) -> None:
    net = tmp_path / "net.pb.gz"
    net.write_bytes(fake_lc0.stand_in_net())
    assert net_is_intact(net)


@pytest.mark.parametrize(
    "content",
    [
        b"",
        b"not gzip at all",
        gzip.compress(b"gzip around the wrong header"),
        fake_lc0.stand_in_net()[:-6],  # truncated
        fake_lc0.stand_in_net()[:-4] + b"\x00\x00\x00\x00",  # the size trailer no longer matches
    ],
)
def test_net_is_intact_refuses_damaged_files(tmp_path: Path, content: bytes) -> None:
    net = tmp_path / "net.pb.gz"
    net.write_bytes(content)
    assert not net_is_intact(net)


def test_net_is_intact_when_the_file_is_missing(tmp_path: Path) -> None:
    assert not net_is_intact(tmp_path / "missing.pb.gz")


# ----------------------------------------------------------------------------- API on the stand-in engine


@dataclass
class Lc0Env:
    weights: Path
    log: Path
    die: Path
    die_at_new_game: Path
    hang: Path

    def commands(self) -> list[str]:
        return self.log.read_text(encoding="utf-8").splitlines() if self.log.exists() else []

    def weight_commands(self) -> list[str]:
        return [c for c in self.commands() if c.startswith("setoption name WeightsFile ")]

    def positions(self) -> list[str]:
        return [c for c in self.commands() if c.startswith("position ")]


@pytest.fixture
def lc0(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Lc0Env:
    """Nets in a folder whose name has a space, and the stand-in's control files."""
    weights = tmp_path / "net files"
    weights.mkdir()
    for rating in MAIA_RATINGS:
        weight_path(weights, rating).write_bytes(fake_lc0.stand_in_net())
    env = Lc0Env(weights, tmp_path / "lc0.log", tmp_path / "die", tmp_path / "die-at-new-game", tmp_path / "hang")
    monkeypatch.setenv("FAKE_LC0_LOG", str(env.log))
    monkeypatch.setenv("FAKE_LC0_DIE_FILE", str(env.die))
    monkeypatch.setenv("FAKE_LC0_DIE_AT_NEW_GAME_FILE", str(env.die_at_new_game))
    monkeypatch.setenv("FAKE_LC0_HANG_FILE", str(env.hang))
    return env


def maia_settings(env: Lc0Env, lc0_path: Path = FAKE_LC0, **overrides: Any) -> Settings:
    return test_settings(lc0_path=lc0_path, maia_weights_dir=env.weights, **overrides)


def maia_client(env: Lc0Env, lc0_path: Path = FAKE_LC0, **overrides: Any) -> TestClient:
    return TestClient(create_app(maia_settings(env, lc0_path, **overrides)))


def post_maia(client: TestClient, fen: str = START, elo: int = 1500, **extra: Any) -> Any:
    return client.post("/api/bot/move", json={"fen": fen, "elo": elo, "bot": "maia", **extra})


def net_name(rating: int) -> str:
    return f"maia-{rating}.pb.gz"


def maia_pid(client: TestClient) -> int:
    manager: EngineManager = client.app.state.services.maia  # type: ignore[attr-defined]
    transport = manager._slots[MAIA_SLOT].transport
    assert transport is not None
    return transport.get_pid()


def maia_pid_or_none(client: TestClient) -> int | None:
    manager: EngineManager = client.app.state.services.maia  # type: ignore[attr-defined]
    transport = manager._slots[MAIA_SLOT].transport
    return None if transport is None else transport.get_pid()


def process_running(pid: int) -> bool:
    if sys.platform == "win32":
        result = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/NH", "/FO", "CSV"], capture_output=True, text=True, check=True
        )
        return f'"{pid}"' in result.stdout
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def wait_until_gone(pid: int, timeout_s: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if not process_running(pid):
            return True
        time.sleep(0.05)
    return False


def test_each_rating_plays_its_own_net(lc0: Lc0Env) -> None:
    board = chess.Board()
    played: dict[int, str] = {}
    with maia_client(lc0) as client:
        for rating in MAIA_RATINGS:
            r = post_maia(client, elo=rating)
            assert r.status_code == 200, r.text
            body = r.json()
            assert body["strength"] == {"mode": "maia", "elo": rating}
            assert body["uci"] == fake_lc0.top_move(net_name(rating), board).uci()
            played[rating] = body["uci"]
    assert len(set(played.values())) > 1  # the nets really differ
    assert lc0.weight_commands() == [
        f"setoption name WeightsFile value {weight_path(lc0.weights, rating).resolve()}" for rating in MAIA_RATINGS
    ]


def test_a_new_rating_on_the_same_position_uses_the_new_net(lc0: Lc0Env) -> None:
    """lc0 keeps its search tree when the net changes, so "go nodes 1" could repeat the old net's policy."""
    board = chess.Board()
    assert fake_lc0.value_cp(net_name(1100), board) != fake_lc0.value_cp(net_name(1900), board)
    with maia_client(lc0) as client:
        for rating in (1100, 1900, 1100):
            body = post_maia(client, elo=rating).json()
            assert body["uci"] == fake_lc0.top_move(net_name(rating), board).uci()
            assert body["eval"] == {"cp": fake_lc0.value_cp(net_name(rating), board)}


def test_every_maia_move_is_a_new_game_for_lc0(lc0: Lc0Env) -> None:
    with maia_client(lc0) as client:
        for _ in range(3):
            assert post_maia(client).status_code == 200
    order = [c.split()[0] for c in lc0.commands() if c.split()[0] in ("ucinewgame", "position", "go")]
    assert order == ["ucinewgame", "position", "go"] * 3


def test_switching_between_nets_loads_each_only_when_it_changes(lc0: Lc0Env) -> None:
    with maia_client(lc0) as client:
        for rating in (1500, 1500, 1900, 1500):
            assert post_maia(client, elo=rating).status_code == 200
    expected = [1500, 1900, 1500]
    assert lc0.weight_commands() == [
        f"setoption name WeightsFile value {weight_path(lc0.weights, rating).resolve()}" for rating in expected
    ]


def test_lc0_is_configured_and_searches_one_node(lc0: Lc0Env) -> None:
    with maia_client(lc0) as client:
        assert post_maia(client).status_code == 200
    commands = lc0.commands()
    for expected in (
        "setoption name VerboseMoveStats value true",
        "setoption name PolicyTemperature value 1.0",
        "setoption name Threads value 1",
        "setoption name NNCacheSize value 20000",
        "go nodes 1",
    ):
        assert expected in commands


def test_response_shape_and_eval_white_to_move(lc0: Lc0Env) -> None:
    board = chess.Board()
    with maia_client(lc0) as client:
        body = post_maia(client).json()
    chosen = fake_lc0.top_move(net_name(1500), board)
    assert body["uci"] == chosen.uci() and body["san"] == board.san(chosen)
    board.push(chosen)
    assert body["fen_after"] == board.fen()
    assert body["eval"] == {"cp": fake_lc0.value_cp(net_name(1500), chess.Board())}
    assert "skill" not in body["strength"]


def test_eval_is_white_pov_with_black_to_move(lc0: Lc0Env) -> None:
    fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
    with maia_client(lc0) as client:
        body = post_maia(client, fen=fen).json()
    assert body["eval"] == {"cp": -fake_lc0.value_cp(net_name(1500), chess.Board(fen))}
    assert body["fen_after"].split()[1] == "w"


def test_sampling_gives_variety_inside_the_selection_pool(lc0: Lc0Env, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FAKE_LC0_SPREAD", "1")
    board = chess.Board()
    allowed = {m.uci() for m in selection_pool(fake_lc0.move_policy(net_name(1500), board, spread=True))}
    with maia_client(lc0) as client:
        seen = {post_maia(client).json()["uci"] for _ in range(40)}
    assert len(seen) > 1 and seen <= allowed


@pytest.mark.parametrize("rating", [100, 1000, 1150, 1950, 2000, 3500])
def test_bad_maia_rating_is_400_with_a_clear_message(lc0: Lc0Env, rating: int) -> None:
    with maia_client(lc0) as client:
        r = post_maia(client, elo=rating)
    assert r.status_code == 400
    assert "1100" in r.json()["detail"] and "1900" in r.json()["detail"]
    assert not lc0.log.exists()


def test_bad_fen_and_finished_games_are_400(lc0: Lc0Env) -> None:
    with maia_client(lc0) as client:
        assert post_maia(client, fen="not a fen").status_code == 400
        mate = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3"
        assert post_maia(client, fen=mate).status_code == 400


def test_movetime_is_ignored_for_maia(lc0: Lc0Env) -> None:
    with maia_client(lc0) as client:
        assert post_maia(client, movetime_ms=1).status_code == 200
        assert post_maia(client, movetime_ms=1_000_000).status_code == 200


def test_missing_lc0_is_503_naming_the_installer(lc0: Lc0Env, tmp_path: Path) -> None:
    with maia_client(lc0, lc0_path=tmp_path / "missing" / "lc0.exe") as client:
        r = post_maia(client)
    assert r.status_code == 503 and "install_maia.py" in r.json()["detail"]


def test_missing_net_is_503_naming_the_installer(lc0: Lc0Env) -> None:
    weight_path(lc0.weights, 1700).unlink()
    with maia_client(lc0) as client:
        r = post_maia(client, elo=1700)
        assert r.status_code == 503 and "install_maia.py" in r.json()["detail"]
        assert post_maia(client, elo=1500).status_code == 200


def test_history_reaches_the_engine(lc0: Lc0Env) -> None:
    moves = ["e2e4", "e7e5", "g1f3"]
    board = chess.Board()
    for uci in moves:
        board.push_uci(uci)
    with maia_client(lc0) as client:
        assert post_maia(client, fen=board.fen(), moves=moves).status_code == 200
    assert lc0.positions() == ["position startpos moves e2e4 e7e5 g1f3"]


def test_history_from_a_custom_start_reaches_the_engine(lc0: Lc0Env) -> None:
    start = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3"
    moves = ["f1b5", "a7a6"]
    board = chess.Board(start)
    for uci in moves:
        board.push_uci(uci)
    with maia_client(lc0) as client:
        assert post_maia(client, fen=board.fen(), moves=moves, start_fen=start).status_code == 200
    assert lc0.positions() == [f"position fen {start} moves f1b5 a7a6"]


@pytest.mark.parametrize("ep_field", ["-", "e3"])
def test_history_is_kept_however_the_fen_writes_en_passant(lc0: Lc0Env, ep_field: str) -> None:
    fen = f"rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq {ep_field} 0 1"
    with maia_client(lc0) as client:
        assert post_maia(client, fen=fen, moves=["e2e4"]).status_code == 200
    assert lc0.positions() == ["position startpos moves e2e4"]


def test_history_with_a_legal_en_passant_must_match_the_fen(lc0: Lc0Env) -> None:
    moves = ["e2e4", "a7a6", "e4e5", "d7d5"]
    with_ep = "rnbqkbnr/1pp1pppp/p7/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3"
    without_ep = "rnbqkbnr/1pp1pppp/p7/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq - 0 3"
    with maia_client(lc0) as client:
        assert post_maia(client, fen=with_ep, moves=moves).status_code == 200
        assert post_maia(client, fen=without_ep, moves=moves).status_code == 200
    assert lc0.positions() == ["position startpos moves e2e4 a7a6 e4e5 d7d5", f"position fen {without_ep}"]


@pytest.mark.parametrize(
    "extra",
    [
        {"moves": ["e2e4", "e7e4"]},  # illegal
        {"moves": ["nope"]},
        {"moves": ["e2e4"]},  # does not end on the position sent
        {"moves": ["e2e4"], "start_fen": "junk"},
        {"moves": []},
    ],
)
def test_bad_history_falls_back_to_the_fen_and_never_fails(lc0: Lc0Env, extra: dict[str, Any]) -> None:
    fen = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3"
    with maia_client(lc0) as client:
        r = post_maia(client, fen=fen, **extra)
    assert r.status_code == 200, r.text
    assert lc0.positions() == [f"position fen {fen}"]


@needs_stockfish
def test_stockfish_requests_are_unchanged(lc0: Lc0Env) -> None:
    with maia_client(lc0) as client:
        for extra, mode in (
            ({"elo": 1600}, "uci_elo"),
            ({"elo": 800}, "skill"),
            ({"elo": 1600, "bot": "stockfish"}, "uci_elo"),
            ({"elo": 1600, "bot": "stockfish", "moves": ["nonsense"], "start_fen": "junk"}, "uci_elo"),
        ):
            r = client.post("/api/bot/move", json={"fen": START, "movetime_ms": 100, **extra})
            assert r.status_code == 200, r.text
            body = r.json()
            assert body["strength"]["mode"] == mode and chess.Move.from_uci(body["uci"]) in chess.Board().legal_moves
    assert not lc0.log.exists()  # lc0 was not involved


def test_stockfish_limits_are_still_422(lc0: Lc0Env) -> None:
    with maia_client(lc0) as client:
        low = client.post("/api/bot/move", json={"fen": START, "elo": 100})
        assert low.status_code == 422 and low.json()["detail"][0]["loc"] == ["body", "elo"]
        assert client.post("/api/bot/move", json={"fen": START, "elo": 3191}).status_code == 422
        assert client.post("/api/bot/move", json={"fen": START, "elo": 1500, "movetime_ms": 10}).status_code == 422
        assert client.post("/api/bot/move", json={"fen": START, "elo": 1500, "bot": "leela"}).status_code == 422


def test_health_reports_files_and_never_starts_lc0(lc0: Lc0Env) -> None:
    weight_path(lc0.weights, 1500).unlink()
    with maia_client(lc0) as client:
        body = client.get("/api/health").json()
    assert body["maia"] == {
        "available": True,
        "ratings": [rating for rating in MAIA_RATINGS if rating != 1500],
        "path": str(FAKE_LC0),
    }
    assert not lc0.log.exists()


def test_health_when_lc0_is_missing(lc0: Lc0Env, tmp_path: Path) -> None:
    missing = tmp_path / "missing.exe"
    with maia_client(lc0, lc0_path=missing) as client:
        body = client.get("/api/health").json()
    assert body["maia"] == {"available": False, "ratings": list(MAIA_RATINGS), "path": str(missing)}


def test_health_when_no_nets_are_installed(lc0: Lc0Env) -> None:
    for rating in MAIA_RATINGS:
        weight_path(lc0.weights, rating).unlink()
    with maia_client(lc0) as client:
        body = client.get("/api/health").json()
    assert body["maia"]["available"] is False and body["maia"]["ratings"] == []


def test_lc0_does_not_start_with_the_app(lc0: Lc0Env) -> None:
    with maia_client(lc0):
        pass
    assert not lc0.log.exists()


def test_recovers_after_the_engine_dies_mid_search(lc0: Lc0Env) -> None:
    with maia_client(lc0) as client:
        assert post_maia(client).status_code == 200
        lc0.die.write_text("", encoding="utf-8")
        r = post_maia(client)
        detail = r.json()["detail"]
        assert r.status_code == 503 and "stopped unexpectedly" in detail and "Press Retry" in detail
        assert "install_maia.py" in detail and "Maia is unavailable" not in detail
        assert post_maia(client).status_code == 200
    assert len(lc0.weight_commands()) == 2  # the fresh process had to load the net again


def test_engine_dying_while_a_new_game_starts_fails_at_once(lc0: Lc0Env) -> None:
    """python-chess never finishes analysis() if the engine dies during its own "isready"."""
    with maia_client(lc0, maia_timeout_s=30.0) as client:
        assert post_maia(client).status_code == 200
        lc0.die_at_new_game.write_text("", encoding="utf-8")
        started = time.monotonic()
        r = post_maia(client)
        assert time.monotonic() - started < 10, "waited for the timeout"
        assert r.status_code == 503 and "stopped unexpectedly" in r.json()["detail"]
        assert post_maia(client).status_code == 200


def test_hung_engine_is_killed_and_replaced(lc0: Lc0Env) -> None:
    with maia_client(lc0, maia_timeout_s=3.0) as client:
        assert post_maia(client).status_code == 200
        hung_pid = maia_pid(client)
        lc0.hang.write_text("", encoding="utf-8")
        r = post_maia(client)
        detail = r.json()["detail"]
        assert r.status_code == 503
        assert "did not answer" in detail and "Press Retry" in detail and "install_maia.py" in detail
        assert wait_until_gone(hung_pid)
        assert post_maia(client).status_code == 200
        assert maia_pid(client) != hung_pid


def test_lc0_that_cannot_start_names_the_runtime_it_needs(lc0: Lc0Env, tmp_path: Path) -> None:
    """How a missing Visual C++ runtime looks from here: the process exits before answering "uci"."""
    broken = tmp_path / "exits_at_once.py"
    broken.write_text("raise SystemExit(3)\n", encoding="utf-8")
    with maia_client(lc0, lc0_path=broken) as client:
        r = post_maia(client)
    detail = r.json()["detail"]
    assert r.status_code == 503 and "could not start lc0" in detail
    assert "vc_redist" in detail and "install_maia.py" in detail


@pytest.mark.parametrize(
    "content",
    [b"not a real net", gzip.compress(b"wrong header"), fake_lc0.stand_in_net()[:-6]],
    ids=["not-gzip", "wrong-header", "truncated"],
)
def test_a_damaged_net_is_refused_at_once_without_lc0(lc0: Lc0Env, content: bytes) -> None:
    weight_path(lc0.weights, 1500).write_bytes(content)
    with maia_client(lc0, maia_timeout_s=30.0) as client:
        started = time.monotonic()
        r = post_maia(client)
        assert time.monotonic() - started < 10, "waited for the timeout"
    assert r.status_code == 503 and "damaged" in r.json()["detail"] and "install_maia.py" in r.json()["detail"]
    assert not lc0.log.exists()


def test_a_net_lc0_cannot_load_is_a_503_at_the_timeout_and_recovers(lc0: Lc0Env) -> None:
    """lc0 prints "error ..." and stays alive, so nothing answers until the request times out."""
    weight_path(lc0.weights, 1500).write_bytes(fake_lc0.stand_in_net(fake_lc0.UNLOADABLE_BODY))
    with maia_client(lc0, maia_timeout_s=2.0) as client:
        r = post_maia(client)
        assert r.status_code == 503 and "did not answer" in r.json()["detail"]
        silent_pid = maia_pid_or_none(client)
        assert silent_pid is None  # thrown away, so the next move gets a clean process
        assert post_maia(client, elo=1700).status_code == 200


def test_a_net_that_fails_after_a_good_one_is_a_503_and_recovers(lc0: Lc0Env) -> None:
    """A "ucinewgame" whose net fails leaves lc0 without a tree, and its "go" then crashes."""
    weight_path(lc0.weights, 1500).write_bytes(fake_lc0.stand_in_net(fake_lc0.UNLOADABLE_BODY))
    black_to_move = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
    with maia_client(lc0, maia_timeout_s=30.0) as client:
        assert post_maia(client, elo=1700).status_code == 200
        started = time.monotonic()
        r = post_maia(client, fen=black_to_move, elo=1500)
        assert time.monotonic() - started < 10, "waited for the timeout"
        assert r.status_code == 503 and "install_maia.py" in r.json()["detail"]
        assert post_maia(client, elo=1700).status_code == 200


def test_shutdown_leaves_no_process(lc0: Lc0Env) -> None:
    with maia_client(lc0) as client:
        assert post_maia(client).status_code == 200
        pid = maia_pid(client)
        assert process_running(pid)
    assert "quit" in lc0.commands()
    assert wait_until_gone(pid)


# ----------------------------------------------------------------------------- the manager on the stand-in


async def _policy_for_castling_position(env: Lc0Env) -> None:
    board = chess.Board("r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 6 5")
    manager = create_manager(maia_settings(env))
    await manager.start()
    try:
        async with manager.use(MAIA_SLOT) as engine:
            assert engine.name == "Lc0 v0.32.1" and manager.engine_name == "Lc0 v0.32.1"
            search, policy = await read_policy(engine, board, weight_path(env.weights, 1500))
        assert sum(1 for line in search.strings if "e1h1" in line) == 1  # printed king-takes-rook
        assert move("e1g1") in policy
        assert set(policy) == set(board.legal_moves)
        assert sum(policy.values()) == pytest.approx(1.0, abs=0.01)
        assert search.score is not None and search.best_move in board.legal_moves
    finally:
        await manager.close()


def test_search_verbose_returns_every_info_string(lc0: Lc0Env) -> None:
    asyncio.run(_policy_for_castling_position(lc0))


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only event loop fallback")
def test_search_verbose_on_the_private_proactor_thread(lc0: Lc0Env) -> None:
    """uvicorn --reload on Windows runs a SelectorEventLoop, which cannot spawn subprocesses."""

    async def run() -> None:
        manager = create_manager(maia_settings(lc0))
        await manager.start()
        assert manager.bridged
        await manager.close()
        await _policy_for_castling_position(lc0)

    asyncio.run(run(), loop_factory=asyncio.SelectorEventLoop)


def test_a_net_that_does_not_exist_gets_no_answer_and_does_not_kill_the_engine(lc0: Lc0Env, tmp_path: Path) -> None:
    async def run() -> None:
        manager = create_manager(maia_settings(lc0))
        await manager.start()
        try:
            async with manager.use(MAIA_SLOT) as engine:
                with pytest.raises(TimeoutError):
                    async with asyncio.timeout(1.5):
                        await choose_maia_move(engine, chess.Board(), 1500, tmp_path / "no-such-net.pb.gz")
                assert manager._slots[MAIA_SLOT].protocol is not None
                assert not manager._slots[MAIA_SLOT].protocol.returncode.done()
            await manager.discard(MAIA_SLOT)  # as the API does after a timeout
        finally:
            await manager.close()

    asyncio.run(run())


# ----------------------------------------------------------------------------- the stand-in itself


def stand_in_session(commands: list[str]) -> str:
    """What the stand-in prints for these commands."""
    text = "\n".join([*commands, "quit"]) + "\n"
    return subprocess.run(
        [sys.executable, str(FAKE_LC0)], input=text, capture_output=True, text=True, timeout=60, check=True
    ).stdout


def printed_scores(output: str) -> list[int]:
    return [int(cp) for cp in re.findall(r"score cp (-?\d+)", output)]


def test_stand_in_repeats_the_old_net_on_the_same_position_until_a_new_game(lc0: Lc0Env) -> None:
    """The regression tests above only mean something if the stand-in has lc0's stale root."""
    first, second = (weight_path(lc0.weights, rating).resolve() for rating in (1100, 1900))
    board = chess.Board()
    use_first = [f"setoption name WeightsFile value {first}", "position startpos", "go nodes 1"]
    use_second = [f"setoption name WeightsFile value {second}", "position startpos", "go nodes 1"]
    cp_first, cp_second = (fake_lc0.value_cp(net_name(rating), board) for rating in (1100, 1900))
    assert printed_scores(stand_in_session([*use_first, *use_second])) == [cp_first, cp_first]
    assert printed_scores(stand_in_session([*use_first, "ucinewgame", *use_second])) == [cp_first, cp_second]


def test_stand_in_is_fresh_on_a_different_position_without_a_new_game(lc0: Lc0Env) -> None:
    nets = [weight_path(lc0.weights, rating).resolve() for rating in (1100, 1900)]
    output = stand_in_session(
        [
            f"setoption name WeightsFile value {nets[0]}",
            "position startpos",
            "go nodes 1",
            f"setoption name WeightsFile value {nets[1]}",
            "position startpos moves e2e4",
            "go nodes 1",
        ]
    )
    board = chess.Board()
    board.push_uci("e2e4")
    assert printed_scores(output)[1] == fake_lc0.value_cp(net_name(1900), board)


def test_stand_in_prints_an_error_and_stays_alive_for_a_bad_net() -> None:
    output = stand_in_session(
        ["setoption name WeightsFile value missing.pb.gz", "isready", "ucinewgame", "position startpos", "go nodes 1", "isready"]
    )
    assert output.count("readyok") == 2
    assert output.count("error Cannot read weights") == 3
    assert "bestmove" not in output


def test_stand_in_order_and_castling_notation(lc0: Lc0Env) -> None:
    fen = "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 6 5"
    board = chess.Board(fen)
    # a file name whose hash makes castling the top move, so "bestmove" has to print it
    name = next(n for n in (f"net-{i}.pb.gz" for i in range(5000)) if fake_lc0.top_move(n, board) == move("e1g1"))
    net = lc0.weights / name
    net.write_bytes(fake_lc0.stand_in_net())
    lines = stand_in_session(
        ["uci", "setoption name VerboseMoveStats value true", f"setoption name WeightsFile value {net}", f"position fen {fen}", "go nodes 1"]
    ).splitlines()
    assert "option name Ponder type check default false" in lines
    search = [line for line in lines if line.startswith(("info", "bestmove"))]
    assert search[0].startswith("info depth 1") and search[0].endswith("pv e1g1")
    assert all(line.startswith("info string") for line in search[1:-1])
    assert any(line.startswith("info string e1h1") for line in search)  # the policy lines print king-takes-rook
    assert search[-1] == "bestmove e1g1"


# ----------------------------------------------------------------------------- tools/check_maia.py


def run_check(env: Lc0Env, lc0_path: Path = FAKE_LC0, **extra_env: str) -> subprocess.CompletedProcess[str]:
    variables = {
        **os.environ,
        "LC0_PATH": str(lc0_path),
        "MAIA_WEIGHTS_DIR": str(env.weights),
        **extra_env,
    }
    return subprocess.run(
        [sys.executable, str(CHECK_MAIA)], capture_output=True, text=True, env=variables, timeout=120, check=False
    )


def test_check_maia_passes_on_a_good_engine(lc0: Lc0Env) -> None:
    result = run_check(lc0)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "maia-1100" in result.stdout and "maia-1900" in result.stdout
    assert "castling available" in result.stdout and "promotion" in result.stdout
    assert "20/20 moves" in result.stdout and "OK: 9 net(s)" in result.stdout


def test_check_maia_flags_missing_policy_lines(lc0: Lc0Env) -> None:
    result = run_check(lc0, FAKE_LC0_DROP_MOVES="1")
    assert result.returncode != 0
    assert "19 policy lines parsed but there are 20 legal moves" in result.stdout + result.stderr


def test_check_maia_flags_a_policy_that_does_not_add_up(lc0: Lc0Env) -> None:
    result = run_check(lc0, FAKE_LC0_POLICY_SCALE="0.5")
    assert result.returncode != 0
    assert "the policy adds up to" in result.stdout + result.stderr


def test_check_maia_says_how_to_install_when_lc0_is_missing(lc0: Lc0Env, tmp_path: Path) -> None:
    result = run_check(lc0, lc0_path=tmp_path / "missing.exe")
    assert result.returncode != 0 and "install_maia.py" in result.stderr


def test_check_maia_reports_a_crashing_engine(lc0: Lc0Env) -> None:
    lc0.die.write_text("", encoding="utf-8")
    result = run_check(lc0)
    assert result.returncode != 0 and "FAILED" in result.stderr


def test_check_maia_names_the_runtime_when_lc0_cannot_start(lc0: Lc0Env, tmp_path: Path) -> None:
    broken = tmp_path / "exits_at_once.py"
    broken.write_text("raise SystemExit(3)\n", encoding="utf-8")
    result = run_check(lc0, lc0_path=broken)
    assert result.returncode != 0 and "FAILED" in result.stderr and "vc_redist" in result.stderr


def test_check_maia_reports_a_damaged_net(lc0: Lc0Env) -> None:
    weight_path(lc0.weights, 1500).write_bytes(b"not a real net")
    result = run_check(lc0)
    assert result.returncode != 0
    assert "maia-1500" in result.stderr and "damaged" in result.stderr and "install_maia.py" in result.stderr
    assert "maia-1900" in result.stdout  # the other nets were still checked
