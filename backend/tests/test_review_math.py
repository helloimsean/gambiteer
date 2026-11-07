"""Classification, win% and accuracy math (expected values computed by hand from the formulas)."""
from __future__ import annotations

import chess
import pytest

from app.review import (
    BookHit,
    MoveFacts,
    build_review_result,
    classify,
    is_sacrifice,
    mean_accuracy,
    move_accuracy,
    mover_cp,
    mover_win_pct,
    win_pct,
)
from app.schemas import EngineLine

# ----------------------------------------------------------------------------- win%
# win% = 50 + 50 * (2 / (1 + exp(-0.00368208 * cp)) - 1)
#   cp=100: exp(-0.368208)=0.691924 -> 2/1.691924=1.182086 -> 50 + 50*0.182086 = 59.1043... (59.10)
#   cp=300: exp(-1.104624)=0.331339 -> 2/1.331339=1.502247 -> 50 + 25.1124 = 75.11
#   cp=600: exp(-2.209248)=0.109818 -> 2/1.109818=1.802097 -> 50 + 40.1049 = 90.11
#   cp=1500 (clamp): exp(-5.52312)=0.003991 -> 2/1.003991=1.992050 -> 99.60


@pytest.mark.parametrize(
    ("cp", "expected"),
    [(0, 50.0), (100, 59.10), (-100, 40.90), (300, 75.11), (-300, 24.89), (600, 90.11), (1500, 99.60), (5000, 99.60)],
)
def test_win_pct(cp: int, expected: float) -> None:
    assert win_pct(cp) == pytest.approx(expected, abs=0.01)


def test_mover_pov_and_mates() -> None:
    W, B = chess.WHITE, chess.BLACK
    assert mover_win_pct({"cp": 100}, W, B) == pytest.approx(59.10, abs=0.01)
    assert mover_win_pct({"cp": 100}, B, W) == pytest.approx(40.90, abs=0.01)  # negated for Black
    assert mover_win_pct({"mate": 3}, W, B) == 100.0
    assert mover_win_pct({"mate": 3}, B, W) == 0.0
    assert mover_win_pct({"mate": -2}, B, W) == 100.0
    # mate 0 = the side to move is checkmated
    assert mover_win_pct({"mate": 0}, W, B) == 100.0  # White just mated Black
    assert mover_win_pct({"mate": 0}, B, B) == 0.0
    assert mover_cp({"cp": 2500}, W, B) == 1500
    assert mover_cp({"cp": 250}, B, W) == -250
    assert mover_cp({"mate": -1}, W, W) == -1500


# ----------------------------------------------------------------------------- accuracy
# acc = 103.1668 * exp(-0.04354 * drop) - 3.1669
#   drop 0 : 103.1668 - 3.1669 = 99.9999
#   drop 10: exp(-0.4354)=0.647036 -> 66.7530 - 3.1669 = 63.586
#   drop 20: exp(-0.8708)=0.418656 -> 43.1917 - 3.1669 = 40.025
#   drop 50: exp(-2.177)=0.113362 -> 11.6952 - 3.1669 = 8.528


@pytest.mark.parametrize(
    ("drop", "expected"),
    [(0, 99.9999), (10, 63.58), (20, 40.02), (50, 8.53), (-5, 100.0), (200, 0.0)],
)
def test_move_accuracy(drop: float, expected: float) -> None:
    assert move_accuracy(drop) == pytest.approx(expected, abs=0.01)


def test_mean_accuracy() -> None:
    # (99.9999 + 63.5826 + 8.5303) / 3 = 57.371
    assert mean_accuracy([0, 10, 50]) == pytest.approx(57.37, abs=0.01)
    assert mean_accuracy([]) == 100.0


# ----------------------------------------------------------------------------- classify


def facts(**kw: object) -> MoveFacts:
    base: dict[str, object] = {"played_is_best": False, "drop": 0.0, "win_before": 50.0}
    base.update(kw)
    return MoveFacts(**base)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("drop", "label"),
    [
        (-3.0, "excellent"), (0.0, "excellent"), (1.99, "excellent"), (2.0, "good"), (4.99, "good"),
        (5.0, "inaccuracy"), (9.99, "inaccuracy"), (10.0, "mistake"), (19.99, "mistake"),
        (20.0, "blunder"), (60.0, "blunder"),
    ],
)
def test_drop_thresholds(drop: float, label: str) -> None:
    assert classify(facts(drop=drop)) == label


def test_book_wins_over_everything() -> None:
    assert classify(facts(book=True, drop=30.0)) == "book"
    assert classify(facts(book=True, played_is_best=True, sacrifice=True)) == "book"


def test_best_great_brilliant() -> None:
    assert classify(facts(played_is_best=True, win_before=55.0, second_win=50.0)) == "best"
    # only move: second line 10+ win% worse
    assert classify(facts(played_is_best=True, win_before=60.0, second_win=50.0)) == "great"
    assert classify(facts(played_is_best=True, win_before=60.0, second_win=50.01)) == "best"
    # ... but not when the position is lost anyway (mover below -300 cp)
    assert classify(facts(played_is_best=True, win_before=20.0, second_win=5.0, cp_before=-400)) == "best"
    # no second line (single legal move) -> best
    assert classify(facts(played_is_best=True, second_win=None)) == "best"
    # brilliant: best + sacrifice, not already winning (> +600) and stays >= -150
    assert classify(facts(played_is_best=True, sacrifice=True, cp_before=120, cp_after=90)) == "brilliant"
    assert classify(facts(played_is_best=True, sacrifice=True, cp_before=700, cp_after=700)) == "best"
    assert classify(facts(played_is_best=True, sacrifice=True, cp_before=0, cp_after=-200)) == "best"
    # a sacrifice that is not the engine's move is never brilliant
    assert classify(facts(played_is_best=False, sacrifice=True, drop=1.0)) == "excellent"


def test_miss() -> None:
    # opponent gave 15 win%, mover throws back 12 -> miss instead of mistake
    assert classify(facts(drop=12.0, prev_gift=15.0)) == "miss"
    assert classify(facts(drop=25.0, prev_gift=10.0)) == "miss"
    # drop below 10 stays an inaccuracy; gift below 10 is not a missed chance
    assert classify(facts(drop=8.0, prev_gift=30.0)) == "inaccuracy"
    assert classify(facts(drop=12.0, prev_gift=9.9)) == "mistake"
    assert classify(facts(drop=12.0, prev_gift=None)) == "mistake"


# ----------------------------------------------------------------------------- sacrifice (SEE)


def test_is_sacrifice() -> None:
    # 1.e4 e5 2.Nf3 Nc6 3.Bc4 Nf6: Bxf7+ gives a bishop (3) for a pawn (1)
    italian = chess.Board("r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4")
    assert is_sacrifice(italian, chess.Move.from_uci("c4f7"))
    assert not is_sacrifice(italian, chess.Move.from_uci("d2d3"))
    # queen trade: Qxd1+ Kxd1 wins back exactly what it gave
    trade = chess.Board("rnbqkbnr/ppp2ppp/8/4P3/2p1P3/8/PP3PPP/RNBQKBNR b KQkq - 0 4")
    assert not is_sacrifice(trade, chess.Move.from_uci("d8d1"))
    # putting the queen where a pawn takes it
    hang = chess.Board("rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2")
    assert is_sacrifice(hang, chess.Move.from_uci("d1g4")) is False  # g4 is safe
    assert is_sacrifice(chess.Board("rnbqkbnr/ppp2ppp/8/3pp3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 3"),
                        chess.Move.from_uci("d1g4"))  # Bxg4 wins the queen


# ----------------------------------------------------------------------------- whole game


def line(score: dict[str, int], *ucis: str) -> EngineLine:
    board_free_pv = list(ucis)
    return EngineLine(multipv=1, score=score, depth=10, pv=board_free_pv, pvUci=board_free_pv)  # type: ignore[arg-type]


def scholar_game() -> tuple[chess.Board, list[chess.Move], list[list[EngineLine]]]:
    """1.e4 e5 2.Qh5 Nc6 3.Bc4 Nf6?? 4.Qxf7# with hand-made engine lines (pv SAN = UCI here)."""
    ucis = ["e2e4", "e7e5", "d1h5", "b8c6", "f1c4", "g8f6", "h5f7"]
    evals = [
        [line({"cp": 30}, "e2e4"), line({"cp": 25}, "d2d4")],  # start
        [line({"cp": 30}, "e7e5"), line({"cp": 35}, "c7c5")],  # after 1.e4
        [line({"cp": 30}, "g1f3"), line({"cp": 25}, "b1c3")],  # after 1...e5
        [line({"cp": 0}, "b8c6"), line({"cp": 10}, "g7g6")],  # after 2.Qh5
        [line({"cp": 0}, "f1c4"), line({"cp": -5}, "d2d3")],  # after 2...Nc6
        [line({"cp": 0}, "g7g6"), line({"cp": 20}, "d8e7")],  # after 3.Bc4
        [line({"mate": 1}, "h5f7"), line({"cp": 300}, "c4f7")],  # after 3...Nf6??
        [EngineLine(multipv=1, score={"mate": 0}, depth=0, pv=[], pvUci=[])],  # checkmate  # type: ignore[arg-type]
    ]
    return chess.Board(), [chess.Move.from_uci(u) for u in ucis], evals


def test_build_review_result() -> None:
    start, moves, evals = scholar_game()
    res = build_review_result(start, moves, evals, depth=10, engine="Stockfish 19")
    labels = [m.classification for m in res.moves]
    # Qh5: win(30)-win(0) = 52.76-50 = 2.76 -> good; Nf6: 50 -> 0 -> blunder; Qxf7#: mate-in-1 whose
    # second line (+3) is 24.9 win% worse -> great
    assert labels == ["best", "best", "good", "best", "best", "blunder", "great"]
    qh5 = res.moves[2]
    assert qh5.winPctBefore == pytest.approx(52.76, abs=0.01)
    assert qh5.winPctAfter == pytest.approx(50.0, abs=0.01)
    assert qh5.cpLoss == 30
    assert qh5.bestMove.uci == "g1f3"
    assert res.moves[5].color == "black"
    assert res.moves[5].winPctAfter == 0.0
    assert res.moves[6].winPctAfter == 100.0
    assert res.moves[6].fenAfter.startswith("r1bqkb1r/pppp1Qpp/2n2n2/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b")
    # white drops [0, 2.76, 0, 0] -> (99.9999*3 + acc(2.7647)) / 4; acc(2.7647) = 103.1668*e^-0.12037 - 3.1669 = 88.33
    assert res.accuracy.white == pytest.approx((99.9999 * 3 + 88.33) / 4, abs=0.1)
    # black drops [0, 0, 50] -> (99.9999*2 + 8.5303)/3 = 69.51
    assert res.accuracy.black == pytest.approx(69.5, abs=0.1)
    assert res.counts.white["best"] == 2 and res.counts.white["great"] == 1 and res.counts.white["good"] == 1
    assert res.counts.black["blunder"] == 1 and sum(res.counts.black.values()) == 3
    assert set(res.counts.white) == {
        "brilliant", "great", "best", "excellent", "good", "book", "inaccuracy", "mistake", "blunder", "miss"
    }
    assert res.opening is None


def test_build_review_result_book() -> None:
    start, moves, evals = scholar_game()
    hit = BookHit(why="Takes the centre.", opening_id="x", opening_name="X Opening")
    res = build_review_result(start, moves, evals, depth=10, engine="sf", book=[hit, hit])
    assert [m.classification for m in res.moves[:3]] == ["book", "book", "good"]
    assert res.moves[0].bookWhy == "Takes the centre." and res.moves[0].bookOpening == "X Opening"
    assert res.moves[2].bookWhy is None
    assert res.opening is not None and res.opening.lastBookPly == 2 and res.opening.id == "x"
    assert res.counts.white["book"] == 1 and res.counts.black["book"] == 1


def test_eval_count_mismatch() -> None:
    start, moves, evals = scholar_game()
    with pytest.raises(ValueError):
        build_review_result(start, moves, evals[:-1], depth=10, engine="sf")
