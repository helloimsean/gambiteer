"""Load the opening JSON files, merge every opening's lines into one tree, and build quiz items.

Data schema: see the docstring of tools/validate_opening.py. Files that fail to parse (invalid
JSON, illegal moves) are skipped with a warning instead of crashing the server, because the data
files may be edited while the server runs.
"""
from __future__ import annotations

import json
import logging
import random
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator, Sequence

import chess

from .schemas import (
    LastOpponentMove,
    LineMeta,
    OpeningFull,
    OpeningNode,
    OpeningSummary,
    QuizAnswer,
    QuizItem,
)

log = logging.getLogger(__name__)

CATEGORIES = ("main", "accepted", "declined", "sideline", "trap", "transposition", "alternative")
DUBIOUS_NAGS = {"?", "??", "?!"}
START_FEN = chess.STARTING_FEN


def _canonical_san(text: str) -> str:
    return str(text).strip().replace("0-0-0", "O-O-O").replace("0-0", "O-O")


@dataclass
class LoadedLine:
    id: str
    name: str
    category: str
    description: str
    evaluation: str
    sans: list[str]
    ucis: list[str]
    fens: list[str]  # position after each move
    whys: list[str]
    nags: list[str]

    @property
    def final_fen(self) -> str:
        return self.fens[-1] if self.fens else START_FEN

    def meta(self) -> LineMeta:
        return LineMeta(
            id=self.id,
            name=self.name,
            category=self.category,
            description=self.description,
            evaluation=self.evaluation,
            sans=list(self.sans),
            finalFen=self.final_fen,
        )


@dataclass
class Node:
    """Mutable tree node used while merging; exported as an OpeningNode."""

    path: tuple[str, ...]
    san: str
    uci: str
    fen: str
    ply: int
    whys: list[str] = field(default_factory=list)
    nags: list[str] = field(default_factory=list)
    line_ids: list[str] = field(default_factory=list)
    categories: list[str] = field(default_factory=list)
    main: bool = False
    children: dict[str, "Node"] = field(default_factory=dict)

    @property
    def id(self) -> str:
        return " ".join(self.path)

    @property
    def why(self) -> str:
        """Longest non-empty explanation among the lines through this node."""
        candidates = [w for w in self.whys if w]
        return max(candidates, key=len) if candidates else ""

    @property
    def nag(self) -> str:
        return next((n for n in self.nags if n), "")

    @property
    def turn(self) -> chess.Color:
        return chess.WHITE if " w " in self.fen else chess.BLACK

    def ordered_children(self) -> list["Node"]:
        """Main-line child first, then by (number of lines desc, san)."""
        return sorted(self.children.values(), key=lambda n: (not n.main, -len(n.line_ids), n.san))

    def walk(self) -> Iterator["Node"]:
        yield self
        for child in self.ordered_children():
            yield from child.walk()

    def export(self) -> OpeningNode:
        return OpeningNode(
            id=self.id,
            san=self.san,
            uci=self.uci,
            fen=self.fen,
            ply=self.ply,
            why=self.why,
            nag=self.nag,
            lineIds=list(self.line_ids),
            mainLine=self.main,
            categories=list(self.categories),
            children=[c.export() for c in self.ordered_children()],
        )


class OpeningError(ValueError):
    """Raised when an opening dict cannot be turned into an Opening."""


class Opening:
    """One opening: metadata, parsed lines, merged tree and a path index."""

    def __init__(self, data: dict, source: str = "<memory>") -> None:
        if not isinstance(data, dict):
            raise OpeningError(f"{source}: not an object")
        for key in ("id", "name", "side", "lines"):
            if key not in data:
                raise OpeningError(f"{source}: missing field '{key}'")
        if data["side"] not in ("white", "black"):
            raise OpeningError(f"{source}: side must be 'white' or 'black'")
        self.source = source
        self.id: str = str(data["id"])
        self.name: str = str(data["name"])
        self.side: str = data["side"]
        self.student: chess.Color = chess.WHITE if self.side == "white" else chess.BLACK
        self.eco: str = str(data.get("eco") or "")
        self.family: str = str(data.get("family") or "")
        self.summary: str = str(data.get("summary") or "")
        self.key_ideas: list[str] = [str(x) for x in data.get("keyIdeas") or []]
        self.typical_plans: list[str] = [str(x) for x in data.get("typicalPlans") or []]
        self.common_mistakes: list[str] = [str(x) for x in data.get("commonMistakes") or []]
        self.sources: list[str] = [str(x) for x in data.get("sources") or []]
        self.lines: list[LoadedLine] = []
        self.root = Node(path=(), san="", uci="", fen=START_FEN, ply=0)
        self.index: dict[tuple[str, ...], Node] = {(): self.root}
        self._tree: OpeningNode | None = None

        raw_lines = data.get("lines") or []
        if not isinstance(raw_lines, list) or not raw_lines:
            raise OpeningError(f"{source}: 'lines' must be a non-empty list")
        for i, raw in enumerate(raw_lines):
            try:
                line = self._parse_line(raw, i)
            except (ValueError, KeyError, TypeError) as exc:
                log.warning("%s: skipping line %s: %s", source, (raw or {}).get("id", i), exc)
                continue
            self.lines.append(line)
            self._merge(line, raw.get("moves") or [])
        if not self.lines:
            raise OpeningError(f"{source}: no valid lines")
        self.lines_by_id = {ln.id: ln for ln in self.lines}

    # ------------------------------------------------------------------ building

    @staticmethod
    def _parse_line(raw: dict, index: int) -> LoadedLine:
        if not isinstance(raw, dict):
            raise ValueError("line is not an object")
        line_id = str(raw.get("id") or f"line-{index}")
        category = str(raw.get("category") or "sideline")
        if category not in CATEGORIES:
            raise ValueError(f"unknown category '{category}'")
        moves = raw.get("moves")
        if not isinstance(moves, list) or not moves:
            raise ValueError("no moves")
        board = chess.Board()
        sans: list[str] = []
        ucis: list[str] = []
        fens: list[str] = []
        whys: list[str] = []
        nags: list[str] = []
        for ply, mv in enumerate(moves, start=1):
            if not isinstance(mv, dict) or "san" not in mv:
                raise ValueError(f"ply {ply}: move must be an object with 'san'")
            try:
                move = board.parse_san(_canonical_san(mv["san"]))
            except ValueError as exc:
                raise ValueError(f"ply {ply} '{mv['san']}' is illegal: {exc}") from exc
            sans.append(board.san(move))
            ucis.append(move.uci())
            board.push(move)
            fens.append(board.fen())
            whys.append(str(mv.get("why") or "").strip())
            nags.append(str(mv.get("nag") or "").strip())
        return LoadedLine(
            id=line_id,
            name=str(raw.get("name") or line_id),
            category=category,
            description=str(raw.get("description") or ""),
            evaluation=str(raw.get("evaluation") or ""),
            sans=sans,
            ucis=ucis,
            fens=fens,
            whys=whys,
            nags=nags,
        )

    def _merge(self, line: LoadedLine, _raw_moves: list) -> None:
        is_main = line.category == "main"
        node = self.root
        self._touch(node, line, is_main)
        for ply, (san, uci, fen, why, nag) in enumerate(
            zip(line.sans, line.ucis, line.fens, line.whys, line.nags), start=1
        ):
            child = node.children.get(san)
            if child is None:
                child = Node(path=node.path + (san,), san=san, uci=uci, fen=fen, ply=ply)
                node.children[san] = child
                self.index[child.path] = child
            child.whys.append(why)
            child.nags.append(nag)
            self._touch(child, line, is_main)
            node = child

    @staticmethod
    def _touch(node: Node, line: LoadedLine, is_main: bool) -> None:
        if line.id not in node.line_ids:
            node.line_ids.append(line.id)
        if line.category not in node.categories:
            node.categories.append(line.category)
        node.main = node.main or is_main

    # ------------------------------------------------------------------ queries

    @property
    def tree(self) -> OpeningNode:
        if self._tree is None:
            self._tree = self.root.export()
        return self._tree

    def node_at(self, sans: Sequence[str]) -> Node | None:
        return self.index.get(tuple(sans))

    @property
    def main_line(self) -> LoadedLine | None:
        return next((ln for ln in self.lines if ln.category == "main"), None)

    def categories_count(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for ln in self.lines:
            counts[ln.category] = counts.get(ln.category, 0) + 1
        return counts

    def summary_model(self) -> OpeningSummary:
        main = self.main_line
        return OpeningSummary(
            id=self.id,
            name=self.name,
            side=self.side,  # type: ignore[arg-type]
            eco=self.eco,
            family=self.family,
            summary=self.summary,
            lineCount=len(self.lines),
            mainLineSans=list(main.sans) if main else [],
            categoriesCount=self.categories_count(),
        )

    def full_model(self) -> OpeningFull:
        base = self.summary_model().model_dump()
        return OpeningFull(
            **base,
            keyIdeas=self.key_ideas,
            typicalPlans=self.typical_plans,
            commonMistakes=self.common_mistakes,
            sources=self.sources,
            lines=[ln.meta() for ln in self.lines],
            tree=self.tree,
        )

    # ------------------------------------------------------------------ quiz

    def _answer(self, child: Node) -> QuizAnswer:
        return QuizAnswer(
            san=child.san,
            uci=child.uci,
            why=child.why,
            lineIds=list(child.line_ids),
            lineNames=[self.lines_by_id[i].name for i in child.line_ids if i in self.lines_by_id],
        )

    def _item(self, node: Node, answers: list[Node], kind: str) -> QuizItem:
        return QuizItem(
            id=node.id,
            openingId=self.id,
            openingName=self.name,
            fen=node.fen,
            sanPath=list(node.path),
            answers=[self._answer(c) for c in answers],
            kind=kind,  # type: ignore[arg-type]
            lastOpponentMove=LastOpponentMove(san=node.san, why=node.why) if node.ply >= 1 else None,
        )

    def quiz_positions(self) -> list[QuizItem]:
        """Every node (ply >= 1) where the student is to move and that has >= 1 child."""
        items: list[QuizItem] = []
        for node in self.root.walk():
            if node.ply < 1 or node.turn != self.student or not node.children:
                continue
            items.append(self._item(node, node.ordered_children(), "position"))
        return items

    def quiz_traps(self) -> list[QuizItem]:
        """Positions on trap lines where the opponent just went wrong.

        A node qualifies when it lies on a 'trap' line, the opponent just moved (student to
        move), it has a child on a trap line, and either the opponent's move carries a dubious
        NAG (?, ??, ?!) or the node lies only on trap lines (the line has already deviated from
        the non-trap theory). Answers hold only the trap continuation(s).
        """
        items: list[QuizItem] = []
        for node in self.root.walk():
            if node.ply < 1 or "trap" not in node.categories or node.turn != self.student:
                continue
            trap_children = [c for c in node.ordered_children() if "trap" in c.categories]
            if not trap_children:
                continue
            went_wrong = node.nag in DUBIOUS_NAGS or node.categories == ["trap"]
            if not went_wrong:
                continue
            items.append(self._item(node, trap_children, "trap"))
        return items

    def quiz(self, mode: str, limit: int, rng: random.Random | None = None) -> list[QuizItem]:
        items = self.quiz_traps() if mode == "traps" else self.quiz_positions()
        if limit and len(items) > limit:
            rng = rng or random.Random()
            items = rng.sample(items, limit)
        return items


class OpeningStore:
    """All openings from DATA_DIR, in file-name order."""

    def __init__(self, data_dir: Path, *, refresh_interval_s: float = 1.0) -> None:
        self.data_dir = Path(data_dir)
        self._openings: dict[str, Opening] = {}
        self.errors: list[str] = []
        self._signature: tuple[tuple[str, int, int], ...] = ()
        self._refresh_interval = refresh_interval_s
        self._last_check = 0.0

    def _dir_signature(self) -> tuple[tuple[str, int, int], ...]:
        if not self.data_dir.is_dir():
            return ()
        sig = []
        for path in self.data_dir.glob("*.json"):
            try:
                st = path.stat()
            except OSError:
                continue
            sig.append((path.name, st.st_mtime_ns, st.st_size))
        return tuple(sorted(sig))

    def refresh_if_changed(self) -> bool:
        """Reload when a data file was added, removed or modified (checked at most once a second).

        Lets the opening files be edited while the server runs. Returns True if it reloaded.
        """
        now = time.monotonic()
        if now - self._last_check < self._refresh_interval:
            return False
        self._last_check = now
        if self._dir_signature() == self._signature:
            return False
        self.load()
        return True

    def load(self) -> None:
        self._signature = self._dir_signature()
        self._last_check = time.monotonic()
        openings: dict[str, Opening] = {}
        errors: list[str] = []
        if not self.data_dir.is_dir():
            log.warning("opening data dir %s does not exist", self.data_dir)
        else:
            for path in sorted(self.data_dir.glob("*.json")):
                try:
                    with path.open(encoding="utf-8") as fh:
                        data = json.load(fh)
                    opening = Opening(data, source=path.name)
                except (OSError, json.JSONDecodeError, OpeningError) as exc:
                    msg = f"{path.name}: {exc}"
                    log.warning("skipping opening file %s", msg)
                    errors.append(msg)
                    continue
                if opening.id != path.stem:
                    log.warning("%s: id '%s' differs from file name", path.name, opening.id)
                if opening.id in openings:
                    log.warning("%s: duplicate opening id '%s', skipped", path.name, opening.id)
                    continue
                openings[opening.id] = opening
        self._openings = openings
        self.errors = errors
        log.info("loaded %d opening(s) from %s", len(openings), self.data_dir)

    def add(self, opening: Opening) -> None:
        self._openings[opening.id] = opening

    def __len__(self) -> int:
        return len(self._openings)

    @property
    def openings(self) -> list[Opening]:
        return list(self._openings.values())

    def get(self, opening_id: str) -> Opening | None:
        return self._openings.get(opening_id)

    def summaries(self) -> list[OpeningSummary]:
        return [o.summary_model() for o in self._openings.values()]

    def lookup(self, sans: Sequence[str]) -> list[tuple[Opening, Node]]:
        """Openings whose tree contains this exact SAN path from the initial position."""
        key = tuple(sans)
        hits: list[tuple[Opening, Node]] = []
        for opening in self._openings.values():
            node = opening.index.get(key)
            if node is not None:
                hits.append((opening, node))
        return hits
