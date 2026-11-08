"""Variants and Panicfish. The real Fairy-Stockfish is never started here (tools/check_fairy.py does that)."""
from __future__ import annotations

import asyncio
import hashlib
import random
import subprocess
import sys
from collections import Counter
from pathlib import Path
from typing import Any

import chess
import chess.engine
import chess.variant
import pytest
from fastapi.testclient import TestClient

from app.bot import FAIRY_ELO_RANGE, choose_bot_move, choose_panicfish_move
from app.config import ROOT_DIR, Settings
from app.main import create_app
from app.variants import FAIRY_BOARDS, needs_fairy, parse_variant_fen
from tests.conftest import FIXTURES, needs_stockfish, test_settings

FAKE_FAIRY = FIXTURES / "fake_fairy.py"
INSTALLER = ROOT_DIR / "tools" / "install_fairy.py"
START = chess.STARTING_FEN
CHESS960_START = "bbqnnrkr/pppppppp/8/8/8/8/PPPPPPPP/BBQNNRKR w KQkq - 0 1"
CASTLE_READY_960 = "bbqnnrkr/pppppppp/8/8/8/8/PPPPPPPP/BBQNNRK1 w Qkq - 0 1"


class Stub:
    def __init__(self) -> None:
        self.configured: list[dict[str, Any]] = []
        self.plays = 0
        self.analyses = 0

    async def configure(self, options: dict[str, Any]) -> None:
        self.configured.append(dict(options))

    async def play(self, board: chess.Board, limit: chess.engine.Limit, *, info: Any = None) -> chess.engine.PlayResult:
        self.plays += 1
        score = chess.engine.PovScore(chess.engine.Cp(15), chess.WHITE)
        return chess.engine.PlayResult(next(iter(board.legal_moves)), None, {"score": score})

    async def analyse(self, board: chess.Board, limit: chess.engine.Limit, *, multipv: int | None = None, info: Any = None) -> Any:
        self.analyses += 1
        return [{
            "pv": [next(iter(board.legal_moves))],
            "score": chess.engine.PovScore(chess.engine.Cp(0), board.turn),
        }]


def panic(elo: int, board: chess.Board | None = None, rng: random.Random | None = None) -> tuple[Any, Stub]:
    stub = Stub()
    return asyncio.run(choose_panicfish_move(stub, board or chess.Board(), elo, 200, rng)), stub


# ----------------------------------------------------------------------------- Panicfish's strength


def test_panicfish_starts_with_no_limit_at_all() -> None:
    choice, stub = panic(3600)
    assert choice.mode == "full" and choice.elo == 3600 and choice.score == {"cp": 15}
    assert stub.configured == [{"UCI_LimitStrength": False, "Skill Level": 20}]


def test_the_first_check_already_limits_it() -> None:
    """3300 is above Stockfish's own ceiling, but it must not stay at full strength."""
    choice, stub = panic(3300)
    assert choice.mode == "uci_elo" and stub.configured[-1]["UCI_LimitStrength"] is True
    assert stub.configured[-1]["UCI_Elo"] == 3190


@pytest.mark.parametrize("elo", [3000, 2700, 1500])
def test_panicfish_uses_stockfishs_limiter_while_it_can(elo: int) -> None:
    choice, stub = panic(elo)
    assert choice.mode == "uci_elo" and stub.configured[-1]["UCI_Elo"] == elo


@pytest.mark.parametrize("elo", [1200, 900, 600, 300])
def test_panicfish_below_the_limiter_mixes_moves(elo: int) -> None:
    choice, stub = panic(elo)
    assert choice.mode == "skill" and choice.elo == elo and stub.analyses == 1 and stub.plays == 0


def test_panicfish_at_zero_plays_random_moves_without_the_engine() -> None:
    rng = random.Random(7)
    board = chess.Board()
    seen = Counter()
    for _ in range(2000):
        choice, stub = panic(0, board, rng)
        assert choice.mode == "random" and choice.score is None and choice.elo == 0
        assert stub.plays == 0 and stub.analyses == 0 and stub.configured == []
        seen[choice.move] += 1
    assert len(seen) == 20  # every legal move comes up
    assert max(seen.values()) < 2000 / 20 * 1.6


def test_panicfish_game_over() -> None:
    mate = chess.Board("rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3")
    with pytest.raises(ValueError):
        panic(0, mate)


# ----------------------------------------------------------------------------- Fairy's Elo range


@pytest.mark.parametrize(("elo", "sent"), [(3190, 2850), (2850, 2850), (500, 500)])
def test_fairy_limiter_stays_inside_its_range(elo: int, sent: int) -> None:
    """python-chess refuses a value outside the engine's advertised range."""
    stub = Stub()
    choice = asyncio.run(choose_bot_move(stub, chess.Board(), elo, 200, None, FAIRY_ELO_RANGE))
    assert choice.mode == "uci_elo" and stub.configured[-1]["UCI_Elo"] == sent


def test_below_fairys_range_the_moves_are_mixed() -> None:
    stub = Stub()
    assert asyncio.run(choose_bot_move(stub, chess.Board(), 499, 200, None, FAIRY_ELO_RANGE)).mode == "skill"


# ----------------------------------------------------------------------------- boards


@pytest.mark.parametrize("name", list(FAIRY_BOARDS))
def test_every_variant_start_position_is_accepted(name: str) -> None:
    board = parse_variant_fen(name, FAIRY_BOARDS[name]().fen())
    assert type(board) is FAIRY_BOARDS[name] and any(board.legal_moves) and needs_fairy(name)


def test_chess960_is_stockfish_work() -> None:
    board = parse_variant_fen("chess960", CHESS960_START)
    assert board.chess960 and not needs_fairy("chess960") and not needs_fairy("standard")


def test_three_check_keeps_its_counter() -> None:
    fen = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 3+2 0 2"
    assert parse_variant_fen("3check", fen).remaining_checks[chess.BLACK] == 2


@pytest.mark.parametrize("bad", ["", "not a fen", "8/8/8/8/8/8/8/8 w - - 0 1"])
def test_bad_variant_fens_are_refused(bad: str) -> None:
    with pytest.raises(ValueError):
        parse_variant_fen("atomic", bad)


# ----------------------------------------------------------------------------- the API


def fairy_client(path: Path = FAKE_FAIRY) -> TestClient:
    return TestClient(create_app(test_settings(fairy_path=path)))


def post(client: TestClient, **body: Any) -> Any:
    return client.post("/api/bot/move", json={"fen": START, "elo": 1500, "movetime_ms": 60, **body})


@pytest.mark.parametrize("name", list(FAIRY_BOARDS))
def test_each_variant_gets_a_legal_move(name: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    log = tmp_path / "uci.log"
    monkeypatch.setenv("FAKE_FAIRY_LOG", str(log))
    board = FAIRY_BOARDS[name]()
    with fairy_client() as client:
        response = post(client, fen=board.fen(), variant=name)
    assert response.status_code == 200, response.text
    assert chess.Move.from_uci(response.json()["uci"]) in board.legal_moves
    assert f"setoption name UCI_Variant value {name}" in log.read_text(encoding="utf-8")


def test_crazyhouse_engine_reply_can_be_a_drop() -> None:
    only_drops = "k7/8/8/8/8/1q6/8/K7[Q] w - - 0 1"  # the White king is boxed in and has no other piece
    board = chess.variant.CrazyhouseBoard(only_drops)
    with fairy_client() as client:
        response = post(client, fen=only_drops, variant="crazyhouse")
    assert response.status_code == 200, response.text
    uci = response.json()["uci"]
    assert uci.startswith("Q@") and chess.Move.from_uci(uci) in board.legal_moves


def test_panicfish_plays_variants_on_fairy() -> None:
    board = chess.variant.AtomicBoard()
    with fairy_client() as client:
        full = post(client, fen=board.fen(), variant="atomic", bot="panicfish", elo=3600).json()
        broken = post(client, fen=board.fen(), variant="atomic", bot="panicfish", elo=0).json()
    assert full["strength"] == {"mode": "full", "elo": 3600}
    assert broken["strength"] == {"mode": "random", "elo": 0}


def test_missing_fairy_says_how_to_install(tmp_path: Path) -> None:
    with fairy_client(tmp_path / "nope.exe") as client:
        response = post(client, fen=chess.variant.AtomicBoard().fen(), variant="atomic")
        health = client.get("/api/health").json()
    assert response.status_code == 503 and "install_fairy.py" in response.json()["detail"]
    assert health["fairy"]["available"] is False


def test_health_reports_fairy_without_starting_it(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    log = tmp_path / "uci.log"
    monkeypatch.setenv("FAKE_FAIRY_LOG", str(log))
    with fairy_client() as client:
        health = client.get("/api/health").json()
    assert health["fairy"] == {"available": True, "path": str(FAKE_FAIRY)} and not log.exists()


def test_a_crashed_fairy_is_a_503_and_the_next_move_works(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    die = tmp_path / "die"
    monkeypatch.setenv("FAKE_FAIRY_DIE_FILE", str(die))
    fen = chess.variant.HordeBoard().fen()
    with fairy_client() as client:
        die.write_text("x")
        crashed = post(client, fen=fen, variant="horde")
        assert crashed.status_code == 503 and "stopped unexpectedly" in crashed.json()["detail"]
        assert post(client, fen=fen, variant="horde").status_code == 200


def test_maia_only_plays_standard_chess() -> None:
    with fairy_client() as client:
        response = post(client, fen=chess.variant.AtomicBoard().fen(), variant="atomic", bot="maia", elo=1500)
    assert response.status_code == 400 and "standard" in response.json()["detail"]


@pytest.mark.parametrize(
    ("bot", "elo", "status"),
    [("panicfish", -1, 422), ("panicfish", 3601, 422), ("stockfish", 399, 422), ("stockfish", 3600, 422)],
)
def test_elo_limits_depend_on_the_bot(bot: str, elo: int, status: int) -> None:
    with fairy_client() as client:
        assert post(client, bot=bot, elo=elo).status_code == status


def test_unknown_variant_is_refused() -> None:
    with fairy_client() as client:
        assert post(client, variant="shogi").status_code == 422


def test_a_finished_variant_game_is_refused() -> None:
    over = "rnbqkbnr/pppppppp/8/8/3K4/8/PPPPPPPP/RNBQ1BNR b kq - 0 1"
    with fairy_client() as client:
        response = post(client, fen=over, variant="kingofthehill")
    assert response.status_code == 400 and "game is over" in response.json()["detail"]


@needs_stockfish
def test_panicfish_real_stockfish_full_strength_then_broken() -> None:
    with fairy_client() as client:
        full = post(client, bot="panicfish", elo=3600).json()
        limited = post(client, bot="panicfish", elo=3300).json()
        low = post(client, bot="panicfish", elo=300).json()
        broken = post(client, bot="panicfish", elo=0).json()
    assert full["strength"]["mode"] == "full"
    assert limited["strength"]["mode"] == "uci_elo"
    assert low["strength"]["mode"] == "skill"
    assert broken["strength"]["mode"] == "random" and broken["eval"] is None
    legal = {m.uci() for m in chess.Board().legal_moves}
    assert {full["uci"], limited["uci"], low["uci"], broken["uci"]} <= legal


@needs_stockfish
@pytest.mark.parametrize("fen", [CHESS960_START, CASTLE_READY_960])
def test_real_stockfish_plays_chess960(fen: str) -> None:
    board = chess.Board(fen, chess960=True)
    with fairy_client() as client:
        response = post(client, fen=fen, variant="chess960", elo=2000)
    assert response.status_code == 200, response.text
    assert chess.Move.from_uci(response.json()["uci"]) in board.legal_moves


def test_settings_read_fairy_path() -> None:
    assert Settings.from_env({"FAIRY_PATH": "x/fairy"}).fairy_path == Path("x/fairy")
    assert Settings().fairy_path == ROOT_DIR / "engines" / "fairy" / "fairy-stockfish.exe"


# ----------------------------------------------------------------------------- installer


def install(url: Path, digest: str, dest: Path, platform: str = "windows") -> subprocess.CompletedProcess[str]:
    command = [sys.executable, str(INSTALLER), "--dest", str(dest), "--url", url.as_uri(), "--sha256", digest, "--platform", platform]
    return subprocess.run(command, capture_output=True, text=True, timeout=30)


def test_installer_verifies_and_is_safe_to_rerun(tmp_path: Path) -> None:
    source = tmp_path / "source.exe"
    source.write_bytes(b"a stand-in, never run")
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    dest = tmp_path / "engines"
    first = install(source, digest, dest)
    assert first.returncode == 0, first.stderr
    assert (dest / "fairy" / "fairy-stockfish.exe").read_bytes() == source.read_bytes()
    assert "already installed" in install(source, digest, dest).stdout


def test_installer_refuses_a_file_that_does_not_match(tmp_path: Path) -> None:
    source = tmp_path / "source.exe"
    source.write_bytes(b"something else")
    dest = tmp_path / "engines"
    result = install(source, "0" * 64, dest)
    assert result.returncode == 1 and "SHA-256" in result.stderr
    assert not (dest / "fairy" / "fairy-stockfish.exe").exists()


def test_installer_on_other_systems_explains_itself(tmp_path: Path) -> None:
    result = install(tmp_path / "unused", "0" * 64, tmp_path / "engines", platform="other")
    assert result.returncode == 0 and "FAIRY_PATH" in result.stdout
