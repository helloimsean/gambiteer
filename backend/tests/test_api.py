"""FastAPI TestClient tests (Stockfish-backed endpoints are skipped when the exe is missing)."""
from __future__ import annotations

import time
from collections.abc import Iterator

import chess
import pytest
from fastapi.testclient import TestClient

from app.main import create_app

from .conftest import HAS_STOCKFISH, needs_stockfish, test_settings

AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"


@pytest.fixture(scope="module")
def client() -> Iterator[TestClient]:
    with TestClient(create_app(test_settings())) as c:
        yield c


def test_health(client: TestClient) -> None:
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"ok", "stockfish", "ollama", "openings"}
    assert body["openings"] == 1
    assert body["stockfish"]["path"].endswith(".exe") or body["stockfish"]["path"]
    assert isinstance(body["ollama"]["ok"], bool) and isinstance(body["ollama"]["models"], list)
    if HAS_STOCKFISH:
        assert body["ok"] is True and body["stockfish"]["name"].startswith("Stockfish")


def test_openings(client: TestClient) -> None:
    r = client.get("/api/openings")
    assert r.status_code == 200
    (summary,) = r.json()
    assert summary["id"] == "alien-gambit" and summary["lineCount"] == 4 and summary["side"] == "white"
    full = client.get("/api/openings/alien-gambit").json()
    assert full["tree"]["children"][0]["san"] == "e4"
    assert {ln["id"] for ln in full["lines"]} == {"main", "declined-nf6", "sideline-2-e5", "trap-5-e5"}
    assert client.get("/api/openings/nope").status_code == 404
    quiz = client.get("/api/openings/alien-gambit/quiz", params={"mode": "traps"}).json()
    assert [q["kind"] for q in quiz] == ["trap", "trap", "trap"]
    positions = client.get("/api/openings/alien-gambit/quiz", params={"limit": 3}).json()
    assert len(positions) == 3
    assert client.get("/api/openings/alien-gambit/quiz", params={"mode": "bogus"}).status_code == 422


@needs_stockfish
def test_analyze_depth8(client: TestClient) -> None:
    r = client.post("/api/analyze", json={"fen": AFTER_E4, "depth": 8, "multipv": 3})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["fen"] == AFTER_E4 and body["depth"] >= 8
    assert [ln["multipv"] for ln in body["lines"]] == [1, 2, 3]
    first = body["lines"][0]
    board = chess.Board(AFTER_E4)
    assert board.san(chess.Move.from_uci(first["pvUci"][0])) == first["pv"][0]
    assert set(first["score"]) <= {"cp", "mate"}


def test_analyze_errors(client: TestClient) -> None:
    assert client.post("/api/analyze", json={"fen": "not a fen"}).status_code == 400
    assert client.post("/api/analyze", json={"fen": "8/8/8/8/8/8/8/8 w - - 0 1"}).status_code == 400  # no kings
    assert client.post("/api/analyze", json={"fen": AFTER_E4, "multipv": 9}).status_code == 422
    mate = client.post(
        "/api/analyze", json={"fen": "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3"}
    ).json()
    assert mate["lines"][0]["score"] == {"mate": 0}


@needs_stockfish
def test_ws_analyze_streams_and_switches(client: TestClient) -> None:
    with client.websocket_connect("/ws/analyze") as ws:
        ws.send_json({"fen": AFTER_E4, "multipv": 2})
        msg = ws.receive_json()
        assert msg["type"] == "info" and msg["fen"] == AFTER_E4 and msg["lines"]
        other = "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1"
        ws.send_json({"fen": other, "multipv": 1})
        for _ in range(50):
            msg = ws.receive_json()
            if msg["fen"] == other:
                break
        assert msg["fen"] == other
        ws.send_json({"stop": True})
        ws.send_json({"fen": "garbage"})
        for _ in range(50):
            msg = ws.receive_json()
            if msg["type"] == "error":
                break
        assert msg["type"] == "error"


def test_pgn_endpoint(client: TestClient) -> None:
    r = client.post("/api/pgn/parse", json={"pgn": "1. e4 e5 2. Nf3 Nc6 *"})
    assert r.status_code == 200
    assert [m["uci"] for m in r.json()["moves"]] == ["e2e4", "e7e5", "g1f3", "b8c6"]
    assert client.post("/api/pgn/parse", json={"pgn": "1. e4 e5 2. Ke3"}).status_code == 400


@needs_stockfish
def test_bot_move(client: TestClient) -> None:
    for elo, mode in ((800, "skill"), (1600, "uci_elo")):
        r = client.post("/api/bot/move", json={"fen": chess.STARTING_FEN, "elo": elo, "movetime_ms": 100})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["strength"]["mode"] == mode and body["strength"]["elo"] == elo
        assert chess.Move.from_uci(body["uci"]) in chess.Board().legal_moves
        assert ("skill" in body["strength"]) == (mode == "skill")
        assert "eval" in body
    assert client.post("/api/bot/move", json={"fen": chess.STARTING_FEN, "elo": 100}).status_code == 422


@needs_stockfish
def test_review_job(client: TestClient) -> None:
    moves = ["e4", "Nf6", "Nc3", "d5", "e2e4"]  # SAN and UCI mixed; the last one is illegal
    assert client.post("/api/review", json={"moves": moves, "depth": 6}).status_code == 400
    moves = ["e4", "Nf6", "b1c3", "d5", "e5", "Nfd7", "e6", "fxe6", "d4", "e5", "dxe5", "Nxe5"]
    job_id = client.post("/api/review", json={"moves": moves, "depth": 6}).json()["jobId"]
    with client.websocket_connect(f"/ws/review/{job_id}") as ws:
        statuses = []
        while True:
            snap = ws.receive_json()
            statuses.append(snap["status"])
            if snap["status"] in ("done", "error"):
                break
    assert statuses[-1] == "done", snap
    job = client.get(f"/api/review/{job_id}").json()
    result = job["result"]
    assert job["progress"] == 1 and len(result["moves"]) == 12
    assert all(m["classification"] == "book" for m in result["moves"])  # whole game is in the fixture
    assert result["opening"] == {"id": "alien-gambit", "name": "Alien Gambit (test fixture)", "lastBookPly": 12}
    assert result["moves"][9]["bookWhy"].startswith("Black gives the pawn back")
    assert result["engine"].startswith("Stockfish") and result["depth"] == 6
    assert client.get("/api/review/unknown").status_code == 404
    # explain validates before calling Ollama
    assert client.post("/api/explain", json={"jobId": job_id, "ply": 99}).status_code == 400
    assert client.post("/api/explain", json={"jobId": "unknown", "ply": 1}).status_code == 404


def test_frontend_fallback_does_not_shadow_api(client: TestClient) -> None:
    assert client.get("/api/does-not-exist").status_code == 404
    r = client.get("/some/client/route")
    assert r.status_code in (200, 404)  # 200 when frontend/dist is built


def test_ollama_models_shape(client: TestClient) -> None:
    started = time.time()
    body = client.get("/api/ollama/models").json()
    assert set(body) == {"models", "default"}
    assert time.time() - started < 10
