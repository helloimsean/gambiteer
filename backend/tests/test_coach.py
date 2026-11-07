"""Single-move coach: classification / book detection (stubbed engine), prompt content, HTTP + WS.

Nothing here needs Ollama: explanations are either off (explain=false) or pointed at a closed port
to check that an Ollama failure still delivers the engine verdict first.
"""
from __future__ import annotations

import asyncio
import re
from collections.abc import AsyncIterator, Iterator, Sequence
from contextlib import asynccontextmanager
from typing import Any

import chess
import chess.engine
import pytest
from fastapi.testclient import TestClient

from app.coach import analyse_move, build_coach_move, prepare
from app.main import create_app
from app.ollama_client import build_coach_messages, build_explain_messages, engine_label
from app.schemas import CoachContext, CoachMove, CoachRequest, EngineLine

from .conftest import needs_stockfish, test_settings

# 1.e4 e5 2.Nf3 Nc6, White to move (the Italian: 3.Bc4)
ITALIAN = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3"
# after 3.Bc4, Black to move
AFTER_BC4 = "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3"
BC4_WHY = "The bishop aims at f7, the weakest square in Black's camp, and prepares castling."
BC5_WHY = "Giuoco Piano: Black develops the bishop to its most active square."
C3_WHY = "White prepares d4 to build a big pawn centre."
# 1.f3 e5 2.g4, Black to move: 2...Qh4# ends the game
FOOLS = "rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2"
# White to move: 1.Qf7 is stalemate, 1.Qf8# would be mate
STALEMATE_TRAP = "7k/8/6K1/8/8/8/8/5Q2 w - - 0 1"


def italian_context(**kw: Any) -> CoachContext:
    data: dict[str, Any] = {
        "openingName": "Italian Game",
        "lineName": "Giuoco Piano",
        "studentSide": "white",
        "bookMoves": [{"san": "Bc4", "why": BC4_WHY}],
        "replyBookMoves": [{"san": "Bc5", "why": BC5_WHY}],
    }
    data.update(kw)
    return CoachContext.model_validate(data)


# ============================================================================ stubbed engine


def line(board: chess.Board, ucis: Sequence[str], score: dict[str, int], multipv: int = 1) -> EngineLine:
    b = board.copy()
    sans = []
    for u in ucis:
        mv = chess.Move.from_uci(u)
        sans.append(b.san(mv))
        b.push(mv)
    return EngineLine(multipv=multipv, score=score, depth=12, pv=sans, pvUci=list(ucis))  # type: ignore[arg-type]


class StubEngine:
    """Answers ``analyse`` from a table {fen: [(pv ucis, white-POV score), ...]} (best first)."""

    name = "Stub 1"

    def __init__(self, table: dict[str, list[tuple[list[str], dict[str, int]]]]) -> None:
        self.table = table
        self.calls: list[tuple[str, int | None]] = []

    async def analyse(self, board: chess.Board, limit: chess.engine.Limit, *, multipv: int | None = None) -> list[dict[str, Any]]:
        self.calls.append((board.fen(), multipv))
        rows = self.table[board.fen()][: multipv or 1]
        infos = []
        for i, (ucis, score) in enumerate(rows, start=1):
            value: chess.engine.Score = chess.engine.Mate(score["mate"]) if "mate" in score else chess.engine.Cp(score["cp"])
            infos.append(
                {
                    "multipv": i,
                    "depth": limit.depth or 1,
                    "score": chess.engine.PovScore(value, chess.WHITE),
                    "pv": [chess.Move.from_uci(u) for u in ucis],
                }
            )
        return infos


class StubEngines:
    def __init__(self, engine: StubEngine) -> None:
        self.engine = engine
        self.used: list[str] = []

    @asynccontextmanager
    async def use(self, name: str) -> AsyncIterator[StubEngine]:
        self.used.append(name)
        yield self.engine


def after(fen: str, uci: str) -> str:
    b = chess.Board(fen)
    b.push(chess.Move.from_uci(uci))
    return b.fen()


ITALIAN_TABLE: dict[str, list[tuple[list[str], dict[str, int]]]] = {
    ITALIAN: [(["f1b5", "a7a6"], {"cp": 44}), (["f1c4", "g8f6"], {"cp": 30})],
    after(ITALIAN, "f1c4"): [(["g8f6", "d2d3"], {"cp": 30})],
    after(ITALIAN, "f1b5"): [(["a7a6", "b5a4"], {"cp": 44})],
    after(ITALIAN, "b1a3"): [(["f8a3", "b2a3"], {"cp": -73})],
    after(ITALIAN, "h2h3"): [(["g8f6", "b1c3"], {"cp": 20})],
}


def run_analysis(fen: str, uci: str, table: dict[str, Any], context: CoachContext | None = None, explain: bool = False):
    engines = StubEngines(StubEngine(table))
    req = CoachRequest(requestId="t", fen=fen, uci=uci, explain=explain, depth=12, context=context)
    result = asyncio.run(analyse_move(engines, req))  # type: ignore[arg-type]
    return result, engines


def test_book_by_san_and_uci() -> None:
    for book in ("Bc4", "f1c4", "Bc4!?", "Bc4+"):
        ctx = italian_context(bookMoves=[{"san": "Nc3", "why": "other"}, {"san": book, "why": BC4_WHY}])
        result, engines = run_analysis(ITALIAN, "f1c4", ITALIAN_TABLE, ctx)
        mv = result.move
        assert mv.classification == "book" and mv.inBook is True, book
        assert mv.bookMove is None
        assert engines.used == ["review"]  # the review engine, one lock per request
    assert mv.san == "Bc4" and mv.color == "white" and mv.fenAfter == AFTER_BC4
    assert mv.evalBefore.model_dump() == {"cp": 44} and mv.evalAfter.model_dump() == {"cp": 30}
    assert mv.bestMove.uci == "f1b5" and mv.playedPv[:1] == ["Nf6"]
    assert mv.cpLoss == 14 and mv.winPctBefore > mv.winPctAfter
    # MultiPV 2 before the move, 1 after
    assert [c[1] for c in engines.engine.calls] == [2, 1]
    # a book note given only as UCI in its own field
    ctx = italian_context(bookMoves=[{"san": "?", "uci": "f1c4", "why": BC4_WHY}])
    assert run_analysis(ITALIAN, "f1c4", ITALIAN_TABLE, ctx)[0].move.inBook


def test_off_book_classification_and_book_move() -> None:
    result, engines = run_analysis(ITALIAN, "b1a3", ITALIAN_TABLE, italian_context())
    mv = result.move
    assert mv.inBook is False
    # +0.44 -> -0.73 for White: drop = 54.04 - 43.32 = 10.7 win% -> mistake (10 <= drop < 20)
    assert mv.classification == "mistake"
    assert mv.cpLoss == 117
    assert mv.bookMove is not None and mv.bookMove.san == "Bc4" and mv.bookMove.why == BC4_WHY
    assert mv.bookMove.uci == "f1c4"
    assert result.book_eval is None  # only computed when an explanation is wanted
    # with explain=True the repertoire move's evaluation comes from the 2nd engine line (no extra search)
    result, engines = run_analysis(ITALIAN, "b1a3", ITALIAN_TABLE, italian_context(), explain=True)
    assert result.book_eval == {"cp": 30} and len(engines.engine.calls) == 2
    # ... or from an extra search when the repertoire move is not among the engine lines
    ctx = italian_context(bookMoves=[{"san": "h3", "why": "a quiet move"}])
    result, engines = run_analysis(ITALIAN, "b1a3", ITALIAN_TABLE, ctx, explain=True)
    assert result.book_eval == {"cp": 20} and len(engines.engine.calls) == 3
    # the opponent's off-book move needs no comparison search
    ctx = italian_context(studentSide="black")
    result, engines = run_analysis(ITALIAN, "b1a3", ITALIAN_TABLE, ctx, explain=True)
    assert result.book_eval is None and len(engines.engine.calls) == 2
    # no repertoire moves at all: no bookMove
    result, _ = run_analysis(ITALIAN, "b1a3", ITALIAN_TABLE, italian_context(bookMoves=[]))
    assert result.move.bookMove is None and result.move.classification == "mistake"


def test_best_great_and_never_miss() -> None:
    board = chess.Board(ITALIAN)
    prepared = prepare(CoachRequest(fen=ITALIAN, uci="f1b5"))
    after_lines = [line(chess.Board(after(ITALIAN, "f1b5")), ["a7a6"], {"cp": 44})]
    two = [line(board, ["f1b5", "a7a6"], {"cp": 44}), line(board, ["f1c4"], {"cp": 30}, 2)]
    assert build_coach_move(prepared, two, after_lines, None).classification == "best"
    # second line 10+ win% worse -> only move -> great
    only = [line(board, ["f1b5", "a7a6"], {"cp": 44}), line(board, ["f1c4"], {"cp": -200}, 2)]
    assert build_coach_move(prepared, only, after_lines, None).classification == "great"
    # single line: "best"
    assert build_coach_move(prepared, only[:1], after_lines, None).classification == "best"
    # a huge drop stays "blunder": a single move has no previous move, so never "miss"
    bad = prepare(CoachRequest(fen=ITALIAN, uci="b1a3"))
    lost = [line(chess.Board(after(ITALIAN, "b1a3")), ["f8a3"], {"cp": -900})]
    mv = build_coach_move(bad, two, lost, italian_context())
    assert mv.classification == "blunder" and mv.classification != "miss"


def test_game_over_after_the_move() -> None:
    # 2...Qh4# : the position after the move is checkmate (no engine call for it)
    table = {FOOLS: [(["d8h4"], {"mate": -1}), (["b8c6"], {"cp": -300})]}
    result, engines = run_analysis(FOOLS, "d8h4", table, None, explain=True)
    mv = result.move
    assert mv.evalAfter.model_dump() == {"mate": 0} and mv.playedPv == []
    assert mv.winPctBefore == 100 and mv.winPctAfter == 100 and mv.color == "black"
    assert mv.classification in ("best", "great") and len(engines.engine.calls) == 1
    text = build_coach_messages(mv)[1]["content"]
    assert "the move is checkmate" in text and "Black won" in text
    # 1.Qf7?? stalemates instead of 1.Qf8#
    table = {STALEMATE_TRAP: [(["f1f8"], {"mate": 1}), (["f1f6"], {"mate": 2})]}
    result, _ = run_analysis(STALEMATE_TRAP, "f1f7", table, None)
    mv = result.move
    assert mv.evalAfter.model_dump() == {"cp": 0} and mv.winPctAfter == 50
    assert mv.classification == "blunder" and mv.cpLoss == 1500


def test_bad_input() -> None:
    from app.coach import CoachInputError

    with pytest.raises(CoachInputError):
        prepare(CoachRequest(fen=ITALIAN, uci="e2e5"))
    with pytest.raises(CoachInputError):
        prepare(CoachRequest(fen="not a fen", uci="e2e4"))
    with pytest.raises(ValueError):
        CoachRequest(fen=ITALIAN, uci="f1c4", depth=4)


# ============================================================================ prompts

MOVE_TOKEN = re.compile(r"\b\d+\.(?:\.\.)?([KQRBNO][\w=+#-]*|[a-h][\w=+#-]*)")


def coach_move(**kw: Any) -> CoachMove:
    base: dict[str, Any] = {
        "san": "Bc4",
        "uci": "f1c4",
        "fenBefore": ITALIAN,
        "fenAfter": AFTER_BC4,
        "color": "white",
        "evalBefore": {"cp": 44},
        "evalAfter": {"cp": 30},
        "bestMove": {"san": "Bb5", "uci": "f1b5", "pv": ["Bb5", "a6", "Ba4"]},
        "playedPv": ["Nf6", "d3", "Bc5"],
        "winPctBefore": 54.04,
        "winPctAfter": 52.76,
        "cpLoss": 14,
        "classification": "book",
        "inBook": True,
    }
    base.update(kw)
    return CoachMove.model_validate(base)


def assert_only_given_moves(text: str, allowed: set[str]) -> None:
    """Every numbered move in the prompt ('3.Bc4', '3...Nf6') is one of the given moves."""
    found = {m.rstrip("+#.,;:)") for m in MOVE_TOKEN.findall(text)}
    assert found, text
    assert found <= allowed, f"unexpected moves {found - allowed}"


def test_prompt_student_in_book() -> None:
    system, user = build_coach_messages(coach_move(), italian_context())
    assert system["role"] == "system" and "chess coach" in system["content"]
    assert "plays White in the Italian Game" in system["content"]
    assert "2-4 short sentences" in system["content"] and "never invent moves" in system["content"]
    text = user["content"]
    assert "Side that moved: White (the student)." in text
    assert "Move played: 3.Bc4 (ply 5)." in text
    assert "+0.44 pawns" in text and "+0.30 pawns" in text  # mover POV evals
    assert "Repertoire: 3.Bc4 is the student's repertoire move here." in text
    assert BC4_WHY in text
    assert "best line: 3.Bb5 a6 4.Ba4" in text
    assert "Explain why 3.Bc4 is a good repertoire move for White, building on the repertoire note." in text
    assert "engine prefers" not in text.split("Task:")[1]  # 1.3 win% below best: no caveat
    assert_only_given_moves(text, {"Bc4", "Bb5", "a6", "Ba4", "Nf6", "d3", "Bc5"})
    # the engine finds this repertoire move a little weak: still "good", plus an honest caveat
    weak = coach_move(evalAfter={"cp": -32}, winPctAfter=47.06)
    text = build_coach_messages(weak, italian_context())[1]["content"]
    assert "The engine is critical: it prefers 3.Bb5 and rates 3.Bc4 6 win% lower: an inaccuracy" in text
    assert "is a good repertoire move for White" in text
    assert "say honestly, in one short clause, that the engine prefers 3.Bb5" in text
    # a repertoire move the engine calls a mistake that the repertoire plays on purpose (a gambit,
    # e.g. the Alien Gambit's 6.Nxf7!?): the engine's objection in one sentence, then the note's idea
    critical = coach_move(evalAfter={"cp": -150}, winPctAfter=36.5)
    gambit_ctx = italian_context(bookMoves=[{"san": "Bc4", "why": BC4_WHY, "nag": "!?"}])
    text = build_coach_messages(critical, gambit_ctx)[1]["content"]
    assert "The engine is critical: it prefers 3.Bb5 and rates 3.Bc4 17 win% lower: a mistake" in text
    assert 'The repertoire plays 3.Bc4 on purpose (the repertoire marks it "!?")' in text
    task = text.split("Task:")[1]
    assert "what goes wrong" not in task and "good repertoire move" not in task
    assert "First say honestly, in one short sentence, that the engine rates 3.Bc4 as a mistake" in task
    assert "prefers 3.Bb5" in task and "explain the idea behind 3.Bc4 for White using the repertoire note" in task
    # no annotation at all: also the "deliberate choice" wording (the note decides)
    task = build_coach_messages(critical, italian_context())[1]["content"].split("Task:")[1]
    assert "First say honestly" in task and "what goes wrong" not in task
    # the repertoire itself marks the move as bad (a trap line shows what not to play): be honest
    for nag in ("?", "??", "?!"):
        trap_ctx = italian_context(bookMoves=[{"san": "Bc4", "why": BC4_WHY, "nag": nag}])
        text = build_coach_messages(critical, trap_ctx)[1]["content"]
        assert f'The repertoire itself marks 3.Bc4 with "{nag}"' in text
        task = text.split("Task:")[1]
        assert "good repertoire move" not in task and "on purpose" not in text
        assert "Explain honestly what goes wrong with 3.Bc4" in task and "3.Bb5 was the better move" in task
    # the engine's best move carries its number and side, so it is not read as the opponent's reply
    assert "Engine's best move for White in this position (instead of the played move): 3.Bb5" in text


def test_prompt_student_off_book() -> None:
    na3 = coach_move(
        san="Na3", uci="b1a3", fenAfter=after(ITALIAN, "b1a3"), evalBefore={"cp": 44}, evalAfter={"cp": -73},
        playedPv=["Bxa3", "bxa3", "Nf6"], winPctBefore=54.04, winPctAfter=43.32, cpLoss=117,
        classification="mistake", inBook=False, bookMove={"san": "Bc4", "why": BC4_WHY, "uci": "f1c4"},
    )
    system, user = build_coach_messages(na3, italian_context(), book_eval={"cp": 30})
    text = user["content"]
    assert "Side that moved: White (the student)." in text
    assert "The played move 3.Na3 is NOT the repertoire move." in text
    assert f"Repertoire move here: 3.Bc4 (note: {BC4_WHY})." in text
    assert "+0.44 pawns" in text and "-0.73 pawns" in text
    assert "Engine evaluation after the repertoire move 3.Bc4, from White's point of view: +0.30 pawns" in text
    assert "In plain words, after the move the position is slightly better for Black." in text
    # 52.76 (after Bc4) - 43.32 (after Na3) = 9.4 win% -> slightly worse
    assert "Verdict: 3.Na3 is slightly worse than the repertoire move 3.Bc4 (9 win% worse): an inaccuracy." in text
    assert "about as good" not in text
    assert "whether 3.Na3 is good or bad compared with the repertoire move 3.Bc4" in text
    assert_only_given_moves(text, {"Na3", "Bc4", "Bb5", "a6", "Ba4", "Bxa3", "bxa3", "Nf6"})
    assert "never call a bad move good" in system["content"]

    # an off-book move the engine rates about as well as the repertoire move: say so honestly
    h3 = coach_move(
        san="h3", uci="h2h3", fenAfter=after(ITALIAN, "h2h3"), evalAfter={"cp": 20}, playedPv=["Nf6"],
        winPctAfter=51.84, cpLoss=24, classification="good", inBook=False,
        bookMove={"san": "Bc4", "why": BC4_WHY, "uci": "f1c4"},
    )
    text = build_coach_messages(h3, italian_context(), book_eval={"cp": 30})[1]["content"]
    assert "Verdict: 3.h3 is about as good as the repertoire move 3.Bc4 according to the engine" in text
    # without an evaluation of the repertoire move the verdict compares with the engine's best
    na3_no_book = na3.model_copy(update={"bookMove": None})
    text = build_coach_messages(na3_no_book, italian_context(bookMoves=[{"san": "d4", "why": "Scotch"}]))[1]["content"]
    assert "Verdict: 3.Na3 is clearly worse than the engine's best move 3.Bb5 (10 win% worse): a mistake." in text
    assert "say that the repertoire move is 3.d4" in text


def test_prompt_opponent_move() -> None:
    bc5 = coach_move(
        san="Bc5", uci="f8c5", fenBefore=AFTER_BC4, fenAfter=after(AFTER_BC4, "f8c5"), color="black",
        evalBefore={"cp": 30}, evalAfter={"cp": 35},
        bestMove={"san": "Nf6", "uci": "g8f6", "pv": ["Nf6", "d3"]}, playedPv=["c3", "Nf6", "d4"],
        winPctBefore=47.24, winPctAfter=46.78, cpLoss=5, classification="book", inBook=True,
    )
    ctx = italian_context(
        bookMoves=[{"san": "Bc5", "why": BC5_WHY}, {"san": "Nf6", "why": "Two Knights Defence."}],
        replyBookMoves=[{"san": "c3", "why": C3_WHY}],
    )
    system, user = build_coach_messages(bc5, ctx)
    assert "training a student who plays White" in system["content"]
    text = user["content"]
    assert "Side that moved: Black (the student's opponent)." in text
    assert "Move played: 3...Bc5 (ply 6)." in text
    assert "from Black's point of view: -0.30 pawns" in text and "-0.35 pawns" in text
    assert "3...Bc5 is one of the opponent moves covered in the student's repertoire" in text and BC5_WHY in text
    assert "Verdict on Black's move: a good move, almost as good as the engine's top choice." in text
    assert f"The student's repertoire reply: 4.c3 (note: {C3_WHY})." in text
    assert "then tell the student to answer with 4.c3 and why" in text
    assert "The engine's best reply" not in text  # the repertoire reply is the engine's reply
    assert_only_given_moves(text, {"Bc5", "Nf6", "d3", "c3", "d4"})
    # a repertoire reply that differs from the engine's reply (e.g. a trap line): both are given
    ctx_d3 = italian_context(bookMoves=ctx.bookMoves, replyBookMoves=[{"san": "d3", "why": "Quiet."}])
    text = build_coach_messages(bc5, ctx_d3)[1]["content"]
    assert "The student's repertoire reply: 4.d3 (note: Quiet.)." in text
    assert "The engine's best reply for White is 4.c3." in text
    assert "if the note says 4.d3 is a mistake or a blunder, warn the student" in text

    # an opponent blunder outside the repertoire, no repertoire reply: engine's reply instead
    qh4 = CoachMove.model_validate({
        **bc5.model_dump(),
        "san": "Qh4", "uci": "d8h4", "fenAfter": after(AFTER_BC4, "d8h4"),
        "evalAfter": {"cp": 400}, "playedPv": ["Nxh4"], "winPctAfter": 18.5, "cpLoss": 370,
        "classification": "blunder", "inBook": False,
    })
    text = build_coach_messages(qh4, italian_context(bookMoves=ctx.bookMoves, replyBookMoves=[]))[1]["content"]
    assert "Verdict on Black's move: a blunder, a very bad move." in text
    assert "The opponent left the repertoire" in text
    assert "the engine's best reply for White is 4.Nxh4" in text
    assert "black queen on h4" in text  # hanging piece computed with python-chess
    assert "4.Nxh4 (captures the black queen on h4)" in text
    assert "from the student's (White's) point of view: +4.00 pawns" in text
    assert "position is winning for White" in text
    assert "Material result of the move and the expected continuation: White wins a queen (net +9 points for White)." in text

    # a repertoire reply the line marks as a mistake (trap lines): warn, do not recommend
    ctx_bad = italian_context(
        bookMoves=ctx.bookMoves, replyBookMoves=[{"san": "d3", "why": "The losing move this line warns about.", "nag": "??"}]
    )
    text = build_coach_messages(bc5, ctx_bad)[1]["content"]
    assert 'The repertoire itself marks the reply 4.d3 with "??"' in text
    task = text.split("Task:")[1]
    assert "warn the student that answering with 4.d3 is a mistake" in task and "4.c3 is the engine's choice" in task
    assert "tell the student to answer with" not in task


def test_prompt_piece_list_material_and_stalemate() -> None:
    # Blackburne Shilling position: 4.Nxe5? Qg5 5.Ng4 d5 6.Bxd5 Qxg4: White gives a knight for 2 pawns
    fen = "r1bqkbnr/pppp1ppp/8/4p3/2BnP3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4"
    nxe5 = coach_move(
        san="Nxe5", uci="f3e5", fenBefore=fen, fenAfter=after(fen, "f3e5"), evalBefore={"cp": 60}, evalAfter={"cp": -250},
        bestMove={"san": "Nxd4", "uci": "f3d4", "pv": ["Nxd4", "exd4"]}, playedPv=["Qg5", "Ng4", "d5", "Bxd5", "Qxg4"],
        winPctBefore=55.5, winPctAfter=28.8, cpLoss=310, classification="book", inBook=True,
    )
    ctx = italian_context(bookMoves=[{"san": "Nxe5", "why": "The tempting pawn grab.", "nag": "?"}], replyBookMoves=[])
    system, user = build_coach_messages(nxe5, ctx)
    text = user["content"]
    assert (
        "Pieces on the board after the move: White: Ke1, Qd1, Ra1, Rh1, Bc1 (dark-squared), Bc4 (light-squared), "
        "Nb1, Ne5, pawns a2 b2 c2 d2 e4 f2 g2 h2; Black: Ke8, Qd8, Ra8, Rh8, Bc8 (light-squared), "
        "Bf8 (dark-squared), Nd4, Ng8, pawns a7 b7 c7 d7 f7 g7 h7." in text
    )
    assert "Material result of the move and the expected continuation: White gives up a knight for 2 pawns (net -1 point for White)." in text
    assert "Engine's best move for White in this position (instead of the played move): 4.Nxd4" in text
    assert "piece list says exactly where every piece stands" in system["content"]
    # 1.Qf7?? is stalemate: say so, never "about equal"
    qf7 = coach_move(
        san="Qf7", uci="f1f7", fenBefore=STALEMATE_TRAP, fenAfter=after(STALEMATE_TRAP, "f1f7"), evalBefore={"mate": 1},
        evalAfter={"cp": 0}, bestMove={"san": "Qf8#", "uci": "f1f8", "pv": ["Qf8#"]}, playedPv=[],
        winPctBefore=100, winPctAfter=50, cpLoss=1500, classification="blunder", inBook=False, bookMove=None,
    )
    text = build_coach_messages(qf7, italian_context(bookMoves=[{"san": "Qf8#", "why": "Mate on the back rank."}]))[1]["content"]
    assert "the move is STALEMATE (Black has no legal move and is not in check)" in text
    assert "the game ends immediately in a draw" in text
    assert "position is a draw by stalemate (the game is over)" in text and "about equal" not in text
    assert "Say plainly that 1.Qf7 ends the game at once in a draw by stalemate." in text.split("Task:")[1]
    assert "Material result of the move: no net material change for White" in text


def test_castling_given_as_king_takes_rook() -> None:
    from app.chessutil import parse_move

    fen = "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4"
    board = chess.Board(fen)
    for token in ("e1h1", "E1H1", "e1g1", "O-O", "0-0"):
        assert parse_move(board, token).uci() == "e1g1", token
    with pytest.raises(ValueError):
        parse_move(board, "0000")  # a null move is never a move
    ctx = italian_context(bookMoves=[{"san": "O-O", "uci": "e1g1", "why": "castle"}])
    prepared = prepare(CoachRequest(fen=fen, uci="e1h1", context=ctx))
    assert prepared.move.uci() == "e1g1" and prepared.book_index == 0
    table = {fen: [(["e1g1", "g8f6"], {"cp": 40})], after(fen, "e1g1"): [(["g8f6"], {"cp": 40})]}
    mv = run_analysis(fen, "e1h1", table, ctx)[0].move
    assert mv.uci == "e1g1" and mv.san == "O-O" and mv.inBook and mv.classification == "book"
    mv = run_analysis(fen, "e1h1", table, None)[0].move
    assert mv.classification in ("best", "great")  # compared with the engine's e1g1


def test_engine_label_ignores_book() -> None:
    assert engine_label(coach_move()) == "excellent"  # 54.04 -> 52.76: drop 1.3
    assert engine_label(coach_move(evalAfter={"cp": -150}, winPctAfter=36.5)) == "mistake"
    assert engine_label(coach_move(classification="inaccuracy", inBook=False)) == "inaccuracy"


def test_explain_prompt_unchanged_by_refactor() -> None:
    """build_explain_messages keeps addressing the mover as 'you' in mate phrases."""
    from app.schemas import ReviewMove

    mv = ReviewMove.model_validate({
        "ply": 4, "san": "Qh4#", "uci": "d8h4", "fenBefore": FOOLS, "fenAfter": after(FOOLS, "d8h4"),
        "color": "black", "evalBefore": {"mate": -1}, "evalAfter": {"mate": 0},
        "bestMove": {"san": "Qh4#", "uci": "d8h4", "pv": ["Qh4#"]}, "playedPv": [],
        "winPctBefore": 100, "winPctAfter": 100, "cpLoss": 0, "classification": "best",
    })
    text = build_explain_messages(mv)[1]["content"]
    assert "forced mate in 1 for you" in text and "(the game is over, you won)" in text


# ============================================================================ HTTP + WebSocket


@pytest.fixture(scope="module")
def client() -> Iterator[TestClient]:
    # Ollama pointed at a closed port: explanations fail fast and deterministically.
    with TestClient(create_app(test_settings(ollama_url="http://127.0.0.1:9"))) as c:
        yield c


def test_post_validation(client: TestClient) -> None:
    assert client.post("/api/coach/move", json={"fen": ITALIAN, "uci": "e2e5", "explain": False}).status_code == 400
    assert client.post("/api/coach/move", json={"fen": "nope", "uci": "e2e4", "explain": False}).status_code == 400
    assert client.post("/api/coach/move", json={"fen": ITALIAN, "uci": "f1c4", "depth": 30}).status_code == 422


@needs_stockfish
def test_post_real_engine_depth8(client: TestClient) -> None:
    ctx = italian_context().model_dump()
    r = client.post("/api/coach/move", json={"fen": ITALIAN, "uci": "f1c4", "explain": False, "depth": 8, "context": ctx})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["text"] == "" and "coachError" not in body
    mv = body["move"]
    assert mv["san"] == "Bc4" and mv["classification"] == "book" and mv["inBook"] is True
    assert "bookMove" not in mv and mv["fenAfter"] == AFTER_BC4 and mv["color"] == "white"
    assert set(mv["evalBefore"]) <= {"cp", "mate"} and mv["bestMove"]["pv"] and mv["playedPv"]
    assert 0 <= mv["winPctAfter"] <= 100 and mv["cpLoss"] >= 0

    r = client.post("/api/coach/move", json={"fen": ITALIAN, "uci": "b1a3", "explain": False, "depth": 8, "context": ctx})
    mv = r.json()["move"]
    assert mv["inBook"] is False and mv["classification"] not in ("book", "miss")
    assert mv["bookMove"]["san"] == "Bc4" and mv["bookMove"]["why"] == BC4_WHY

    # game over after the move (checkmate), real engine for the position before
    r = client.post("/api/coach/move", json={"fen": FOOLS, "uci": "d8h4", "explain": False, "depth": 8})
    assert r.status_code == 200, r.text
    mv = r.json()["move"]
    assert mv["evalAfter"] == {"mate": 0} and mv["playedPv"] == [] and mv["classification"] in ("best", "great")


@needs_stockfish
def test_post_explain_failure_still_returns_verdict(client: TestClient) -> None:
    r = client.post("/api/coach/move", json={"fen": ITALIAN, "uci": "f1c4", "depth": 8, "context": italian_context().model_dump()})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["text"] == "" and body["coachError"] and body["move"]["inBook"] is True


@needs_stockfish
def test_coach_waits_for_running_review(client: TestClient) -> None:
    moves = ["e4", "Nf6", "Nc3", "d5", "e5", "Nfd7", "e6", "fxe6", "d4", "e5", "dxe5", "Nxe5"]
    job_id = client.post("/api/review", json={"moves": moves, "depth": 10}).json()["jobId"]
    r = client.post("/api/coach/move", json={"fen": ITALIAN, "uci": "f1c4", "explain": False, "depth": 8})
    assert r.status_code == 200, r.text
    with client.websocket_connect(f"/ws/review/{job_id}") as ws:
        while (snap := ws.receive_json())["status"] not in ("done", "error"):
            pass
    assert snap["status"] == "done", snap


@needs_stockfish
def test_ws_order_and_errors(client: TestClient) -> None:
    ctx = italian_context().model_dump()
    with client.websocket_connect("/ws/coach") as ws:
        ws.send_json({"requestId": "a", "fen": ITALIAN, "uci": "f1c4", "explain": False, "depth": 8, "context": ctx})
        ws.send_json({"requestId": "b", "fen": ITALIAN, "uci": "b1a3", "explain": False, "depth": 8, "context": ctx})
        ws.send_json({"requestId": "c", "fen": ITALIAN, "uci": "e2e5", "explain": False})
        ws.send_text("{not json")
        msgs = [ws.receive_json() for _ in range(6)]
    ordered = [(m["type"], m["requestId"]) for m in msgs if m["requestId"] in ("a", "b", "c")]
    assert ordered == [("analysis", "a"), ("done", "a"), ("analysis", "b"), ("done", "b"), ("error", "c")]
    by_key = {(m["type"], m["requestId"]): m for m in msgs}
    assert by_key[("analysis", "a")]["move"]["classification"] == "book" and by_key[("done", "a")]["text"] == ""
    assert by_key[("analysis", "b")]["move"]["bookMove"]["san"] == "Bc4"
    errors = [m for m in msgs if m["type"] == "error"]
    assert all(m["stage"] == "analysis" for m in errors) and len(errors) == 2
    assert any(m["requestId"] == "" and "bad request" in m["message"] for m in errors)


@needs_stockfish
def test_ws_explain_failure_comes_after_analysis(client: TestClient) -> None:
    with client.websocket_connect("/ws/coach") as ws:
        ws.send_json({"requestId": "x", "fen": ITALIAN, "uci": "b1a3", "depth": 8, "context": italian_context().model_dump()})
        first, second = ws.receive_json(), ws.receive_json()
    assert first["type"] == "analysis" and first["requestId"] == "x"
    assert second["type"] == "error" and second["stage"] == "explain" and second["requestId"] == "x"


@needs_stockfish
def test_ws_survives_disconnect_mid_request(client: TestClient) -> None:
    with client.websocket_connect("/ws/coach") as ws:
        ws.send_json({"requestId": "gone", "fen": ITALIAN, "uci": "f1c4", "explain": False, "depth": 16})
    # the server must still serve new sockets and requests afterwards
    with client.websocket_connect("/ws/coach") as ws:
        ws.send_json({"requestId": "next", "fen": ITALIAN, "uci": "f1c4", "explain": False, "depth": 8})
        assert ws.receive_json()["type"] == "analysis"
        assert ws.receive_json()["type"] == "done"
