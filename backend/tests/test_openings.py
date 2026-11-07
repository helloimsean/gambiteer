"""Tree merge and quiz generation against tests/fixtures/alien-gambit.json."""
from __future__ import annotations

import json
import random
from pathlib import Path

import chess
import pytest

from app.openings import Opening, OpeningStore
from app.review import find_book_hits


@pytest.fixture(scope="module")
def opening(fixture_dir: Path) -> Opening:
    data = json.loads((fixture_dir / "alien-gambit.json").read_text(encoding="utf-8"))
    return Opening(data, source="alien-gambit.json")


def find(node, path: str):
    for san in path.split():
        node = next(c for c in node.children if c.san == san)
    return node


def test_summary(opening: Opening) -> None:
    s = opening.summary_model()
    assert s.id == "alien-gambit" and s.side == "white" and s.eco == "B02"
    assert s.lineCount == 4
    assert s.categoriesCount == {"main": 1, "declined": 1, "sideline": 1, "trap": 1}
    assert s.mainLineSans[:7] == ["e4", "Nf6", "Nc3", "d5", "e5", "Nfd7", "e6"]
    assert len(s.mainLineSans) == 14


def test_tree_root_and_first_move(opening: Opening) -> None:
    root = opening.tree
    assert root.id == "" and root.san == "" and root.ply == 0 and root.fen == chess.STARTING_FEN
    assert [c.san for c in root.children] == ["e4"]
    e4 = root.children[0]
    assert e4.id == "e4" and e4.uci == "e2e4" and e4.ply == 1
    assert e4.fen == "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
    assert e4.lineIds == ["main", "declined-nf6", "sideline-2-e5", "trap-5-e5"]
    assert e4.categories == ["main", "declined", "sideline", "trap"]
    assert e4.mainLine is True
    # longest non-empty why among the lines through the node (the declined line's text is longer)
    assert e4.why.startswith("Takes space in the centre and opens lines for the queen")


def test_children_order_and_merge(opening: Opening) -> None:
    root = opening.tree
    nc3 = find(root, "e4 Nf6 Nc3")
    # main-line child first, then (lines desc, san)
    assert [c.san for c in nc3.children] == ["d5", "e5"]
    assert nc3.children[0].lineIds == ["main", "declined-nf6", "trap-5-e5"]
    assert nc3.children[1].mainLine is False and nc3.children[1].categories == ["sideline"]
    e6 = find(root, "e4 Nf6 Nc3 d5 e5 Nfd7 e6")
    assert [c.san for c in e6.children] == ["fxe6", "Nf6"]
    assert e6.nag == "!?"  # first non-empty nag (main has "", declined has "!?")
    d4 = find(root, "e4 Nf6 Nc3 d5 e5 Nfd7 e6 fxe6 d4")
    assert [c.san for c in d4.children] == ["Nf6", "e5"]
    trap = d4.children[1]
    assert trap.id == "e4 Nf6 Nc3 d5 e5 Nfd7 e6 fxe6 d4 e5"
    assert trap.nag == "?!" and trap.categories == ["trap"] and not trap.mainLine
    assert trap.ply == 10
    # 33 distinct positions + the root
    assert len(opening.index) == 34


def test_lines_meta(opening: Opening) -> None:
    full = opening.full_model()
    assert [ln.id for ln in full.lines] == ["main", "declined-nf6", "sideline-2-e5", "trap-5-e5"]
    declined = full.lines[1]
    assert declined.category == "declined" and declined.sans[8] == "exf7+"
    board = chess.Board()
    for san in declined.sans:
        board.push_san(san)
    assert declined.finalFen == board.fen()
    assert len(full.keyIdeas) == 3


def test_quiz_positions(opening: Opening) -> None:
    items = opening.quiz_positions()
    # White-to-move nodes with children: ply 2 (1), 4 (2), 6 (2), 8 (3), 10 (3), 12 (3), 14 (1)
    assert len(items) == 15
    assert all(len(it.sanPath) % 2 == 0 and len(it.sanPath) >= 2 for it in items)
    first = items[0]
    assert first.id == "e4 Nf6" and first.kind == "position"
    assert [a.san for a in first.answers] == ["Nc3"]
    assert first.answers[0].uci == "b1c3"
    assert first.lastOpponentMove is not None and first.lastOpponentMove.san == "Nf6"
    assert set(first.answers[0].lineNames) == {
        "Main line: 4...fxe6 5.d4 Nf6", "Declined: 4...Nf6 5.exf7+", "Sideline: 2...e5 (Vienna-style)",
        "Trap: 5...e5?! 6.dxe5 Nxe5 7.Qh5+ g6??",
    }
    by_id = {it.id: it for it in items}
    after_d5 = by_id["e4 Nf6 Nc3 d5"]
    assert chess.Board(after_d5.fen).turn == chess.WHITE
    assert [a.san for a in after_d5.answers] == ["e5"]


def test_quiz_traps(opening: Opening) -> None:
    items = opening.quiz_traps()
    # nodes on the trap line where Black just went wrong (?! / ?? or already off every other line)
    assert [it.id for it in items] == [
        "e4 Nf6 Nc3 d5 e5 Nfd7 e6 fxe6 d4 e5",
        "e4 Nf6 Nc3 d5 e5 Nfd7 e6 fxe6 d4 e5 dxe5 Nxe5",
        "e4 Nf6 Nc3 d5 e5 Nfd7 e6 fxe6 d4 e5 dxe5 Nxe5 Qh5+ g6",
    ]
    assert [[a.san for a in it.answers] for it in items] == [["dxe5"], ["Qh5+"], ["Qxe5"]]
    assert all(it.kind == "trap" for it in items)
    last = items[2].lastOpponentMove
    assert last is not None and last.san == "g6" and "Nf7" in last.why


def test_quiz_limit(opening: Opening) -> None:
    items = opening.quiz("positions", 5, random.Random(1))
    assert len(items) == 5 and len({it.id for it in items}) == 5


def test_store_and_book_lookup(fixture_dir: Path, tmp_path: Path) -> None:
    store = OpeningStore(fixture_dir)
    store.load()
    assert len(store) == 1 and store.get("alien-gambit") is not None
    hits = store.lookup(["e4", "Nf6", "Nc3"])
    assert [o.id for o, _ in hits] == ["alien-gambit"]
    assert store.lookup(["d4"]) == []
    # book detection for a game that leaves the data with 7...Nf7 (the trap line has 7...g6)
    board = chess.Board()
    moves = []
    for san in "e4 Nf6 Nc3 d5 e5 Nfd7 e6 fxe6 d4 e5 dxe5 Nxe5 Qh5+ Nf7".split():
        mv = board.parse_san(san)
        moves.append(mv)
        board.push(mv)
    book = find_book_hits(chess.Board(), moves, store.lookup)
    assert [b is not None for b in book] == [True] * 13 + [False]
    assert book[9] is not None and book[9].why.startswith("Black gives the pawn back")
    # broken files are skipped, not fatal
    (tmp_path / "broken.json").write_text("{not json", encoding="utf-8")
    bad = OpeningStore(tmp_path)
    bad.load()
    assert len(bad) == 0 and bad.errors
