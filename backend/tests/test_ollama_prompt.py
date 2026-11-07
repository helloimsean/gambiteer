"""Explanation prompt builder and model selection (no Ollama needed)."""
from __future__ import annotations

import chess
import pytest

from app.chessutil import hanging_pieces
from app.ollama_client import OllamaError, build_explain_messages, chat_options, resolve_model
from app.schemas import ReviewMove


def test_hanging_pieces() -> None:
    # 1.e4 e5 2.Nf3 d6 3.Bc4 h6?? 4.Ng5?! : the knight on g5 is attacked by the h6 pawn
    board = chess.Board("rnbqkbnr/ppp2pp1/3p3p/4p1N1/2B1P3/8/PPPP1PPP/RNBQK2R b KQkq - 1 4")
    white = hanging_pieces(board, chess.WHITE)
    assert any("knight on g5" in h and "pawn on h6" in h for h in white)
    assert hanging_pieces(chess.Board(), chess.WHITE) == []
    # undefended but attacked: lone rook
    lone = chess.Board("4k3/8/8/8/8/8/3r4/4K2R w K - 0 1")
    assert hanging_pieces(lone, chess.BLACK) == ["black rook on d2 (attacked by the king on e1, undefended)"]


def _move(**kw: object) -> ReviewMove:
    base: dict[str, object] = {
        "ply": 7,
        "san": "Bh6",
        "uci": "c1h6",
        "fenBefore": "rnbqkb1r/ppp1p2p/5np1/3pQ3/3P4/2N5/PPP2PPP/R1B1KBNR w KQkq - 1 8",
        "fenAfter": "rnbqkb1r/ppp1p2p/5npB/3pQ3/3P4/2N5/PPP2PPP/R3KBNR b KQkq - 2 8",
        "color": "white",
        "evalBefore": {"cp": 112},
        "evalAfter": {"cp": -769},
        "bestMove": {"san": "Bg5", "uci": "c1g5", "pv": ["Bg5", "Nc6", "Bb5", "Bg7"]},
        "playedPv": ["Bxh6", "Bb5+", "c6", "Bd3", "O-O"],
        "winPctBefore": 60.17,
        "winPctAfter": 5.56,
        "cpLoss": 881,
        "classification": "miss",
    }
    base.update(kw)
    return ReviewMove.model_validate(base)


def test_build_explain_messages_facts() -> None:
    system, user = build_explain_messages(_move())
    assert system["role"] == "system" and "chess coach" in system["content"]
    assert "why this move is a missed opportunity" in system["content"]
    text = user["content"]
    assert "Move played: 8.Bh6" in text
    assert "+1.12 pawns" in text and "-7.69 pawns" in text  # mover POV, in pawns
    assert "8.Bg5 Nc6 9.Bb5 Bg7" in text  # best line with move numbers
    assert "8...Bxh6 9.Bb5+ c6 10.Bd3 O-O" in text  # played PV, 5 plies
    assert "white bishop on h6" in text  # hanging piece computed with python-chess
    assert "Black is up 3 points" in text  # material at the end of the expected continuation
    assert "previous move was a mistake" in text


def test_capture_notes() -> None:
    # 7...Nf6 instead of 7...Nxe5, which would have taken the queen
    mv = _move(
        ply=14, san="Nf6", uci="g8f6", color="black",
        fenBefore="rnbqkbnr/pppnp2p/6p1/3pQ3/3P4/2N5/PPP2PPP/R1B1KBNR b KQkq - 0 7",
        fenAfter="rnbqkb1r/pppnp2p/5np1/3pQ3/3P4/2N5/PPP2PPP/R1B1KBNR w KQkq - 1 8",
        evalBefore={"cp": -844}, evalAfter={"cp": 116},
        bestMove={"san": "Nxe5", "uci": "d7e5", "pv": ["Nxe5"]}, playedPv=["Bg5"],
    )
    text = build_explain_messages(mv)[1]["content"]
    assert "best move in this position: Nxe5 (captures the white queen on e5)" in text
    assert "Move played: 7...Nf6 (ply 14)" in text


def test_black_mover_and_book_why() -> None:
    mv = _move(
        ply=2, san="Nf6", uci="g8f6", color="black", classification="book",
        fenBefore="rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
        fenAfter="rnbqkb1r/pppppppp/5n2/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 1 2",
        evalBefore={"cp": 30}, evalAfter={"cp": 70},
        bestMove={"san": "e5", "uci": "e7e5", "pv": ["e5", "Nf3"]}, playedPv=["e5", "Nd5"],
        bookWhy="Alekhine's Defence invites the e-pawn forward.", bookOpening="Alien Gambit",
    )
    _, user = build_explain_messages(mv)
    text = user["content"]
    assert "Move played: 1...Nf6" in text
    assert "-0.30 pawns" in text and "-0.70 pawns" in text  # Black's point of view
    assert "Opening theory (Alien Gambit): Alekhine's Defence invites" in text


def test_model_resolution_and_options() -> None:
    installed = ["llama3.2:3b", "gpt-oss:20b", "llama3.1:latest"]
    assert resolve_model(None, installed, "gpt-oss:20b") == "gpt-oss:20b"
    assert resolve_model(None, ["llama3.2:3b"], "gpt-oss:20b") == "llama3.2:3b"  # first installed
    assert resolve_model("llama3.1", installed, "gpt-oss:20b") == "llama3.1:latest"
    with pytest.raises(OllamaError):
        resolve_model("mistral:7b", installed, "gpt-oss:20b")
    with pytest.raises(OllamaError):
        resolve_model(None, [], "gpt-oss:20b")
    assert chat_options("llama3.2:3b") == {"num_ctx": 4096, "temperature": 0.3, "num_predict": 220}
    assert chat_options("gpt-oss:20b")["num_predict"] > 220  # reasoning tokens need headroom


def test_continuation_material_waits_for_the_recapture() -> None:
    # Budapest, Kieninger line after 7.a3: 7...Ngxe5 8.Nxe5 Nxe5 9.e3 Bxd2+ 10.Qxd2 O-O.
    # A fixed 5-ply cut stops after 9...Bxd2+ and reports Black a piece up; the exchange
    # ends with 10.Qxd2, and the material is level.
    from app.ollama_client import _material_text, _settled_continuation

    after = chess.Board("r1b1k2r/ppppqppp/2n5/4P3/1bP2Bn1/P4N2/1P1NPPPP/R2QKB1R b KQkq - 0 7")
    ucis = ["g4e5", "f3e5", "c6e5", "e2e3", "b4d2", "d1d2", "e8g8"]
    end, cut = _settled_continuation(after, ucis)
    assert cut == 6
    assert "material is equal" in _material_text(end)
    # a quiet line still stops at 5 plies
    quiet = chess.Board()
    end, cut = _settled_continuation(quiet, ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6", "d2d3"])
    assert cut == 5
