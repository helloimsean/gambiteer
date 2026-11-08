"""A stand-in for lc0: speaks UCI like lc0 v0.32.1 where Maia depends on it, but plays no chess. Tests only.

Copied from lc0's source (it has never been compared with the running engine):
* Output layout and order: "info depth ...", one "info string" per move and one for the root, then
  "bestmove" (Search::GetVerboseStats, Search::SendMovesStats). The policy lines print castling
  king-takes-rook; "bestmove" and the pv print e1g1.
* The net loads at "ucinewgame" or "position", never at "isready" (Engine::SetPosition). A net that
  cannot be loaded prints "error ..." and the process keeps running (engine_loop.cc). When no net
  was ever loaded, "go" answers nothing. After a "ucinewgame" whose net failed there is no search
  tree, and "go" crashes.
* The search tree survives a net change. A "position" identical to the last one searched keeps its
  root, so "go nodes 1" repeats what the net that searched it said (NodeTree::ResetToPosition).
  Only "ucinewgame" clears it.

The "policy" comes from a hash of the loaded net's file name and the position, so it is
deterministic and the tests can tell which net is loaded. lc0's NN cache is not modelled.

Run with: python fake_lc0.py   (python-chess speaks to it over stdin/stdout)

Environment variables for the tests:
  FAKE_LC0_LOG           append every received command to this file
  FAKE_LC0_DIE_FILE      if this file exists at "go": delete it and crash without answering
  FAKE_LC0_DIE_AT_NEW_GAME_FILE  the same at "ucinewgame"
  FAKE_LC0_HANG_FILE     if this file exists at "go": delete it and never answer
  FAKE_LC0_SPREAD        "1": a flat policy where many moves are plausible
  FAKE_LC0_DROP_MOVES    leave out this many of the move lines
  FAKE_LC0_POLICY_SCALE  multiply the printed policy by this factor
"""
from __future__ import annotations

import gzip
import hashlib
import os
import sys
import time
import zlib
from dataclasses import dataclass
from pathlib import Path

import chess

UCI_OPTIONS = (
    "option name WeightsFile type string default <autodiscover>",
    "option name Threads type spin default 0 min 0 max 128",
    "option name NNCacheSize type spin default 2000000 min 0 max 999999999",
    "option name VerboseMoveStats type check default false",
    "option name PolicyTemperature type string default 1.359000",  # lc0 prints floats as strings
    "option name HistoryFill type combo default fen_only var no var fen_only var always",
    "option name MultiPV type spin default 1 min 1 max 500",
    "option name UCI_Chess960 type check default false",
    "option name Ponder type check default false",
)
TOP_MOVE_SHARE = 0.90  # default policy: one clear favourite, so tests know which move is played

NET_HEADER = b"\x0d\xc0\x01\x00\x00"  # how a protobuf holding lc0's magic number 0x1c0 starts
UNLOADABLE_BODY = b"has the right header but does not parse"


class Lc0Error(Exception):
    """What lc0's command loop catches: it prints "error <message>" and carries on."""


@dataclass
class SearchedRoot:
    """The root a finished search leaves in lc0's tree: its position and what the net said."""

    key: tuple[str, ...]
    policy: dict[chess.Move, float]
    cp: int


def stand_in_net(body: bytes = b"stand-in net") -> bytes:
    """The bytes of a net file this stand-in can load (real Maia nets load too)."""
    return gzip.compress(NET_HEADER + body)


def net_load_error(path: str) -> str | None:
    """Why lc0's loader would refuse this file, or None when it loads."""
    try:
        with gzip.open(path, "rb") as stream:
            data = stream.read()
    except (OSError, EOFError, zlib.error):
        return f"Cannot read weights from {path}"
    if not data.startswith(NET_HEADER) or data.endswith(UNLOADABLE_BODY):
        return "Invalid weight file: bad header."
    return None


def _digest(*parts: str) -> int:
    return int(hashlib.sha256("|".join(parts).encode()).hexdigest(), 16)


def move_policy(net_name: str, board: chess.Board, *, spread: bool = False) -> dict[chess.Move, float]:
    """Move -> probability, most likely first; the same for the same net and position."""
    key = board.epd()
    moves = sorted(board.legal_moves, key=lambda move: _digest(net_name, key, move.uci()))
    if len(moves) == 1:
        return {moves[0]: 1.0}
    if spread:
        weights = [1 / (i + 1) for i in range(len(moves))]
    else:
        tail = [0.5**i for i in range(len(moves) - 1)]
        share = (1 - TOP_MOVE_SHARE) / sum(tail)
        weights = [TOP_MOVE_SHARE] + [w * share for w in tail]
    total = sum(weights)
    return {move: w / total for move, w in zip(moves, weights)}


def top_move(net_name: str, board: chess.Board) -> chess.Move:
    return next(iter(move_policy(net_name, board)))


def value_cp(net_name: str, board: chess.Board) -> int:
    """The score printed for this net and position, from the side to move's point of view."""
    return _digest(net_name, board.epd()) % 121 - 60


def percent_text(p: float) -> str:
    return f"{p * 100:5.1f}" if p >= 0.99995 else f"{p * 100:5.2f}"


def move_line(label: str, index: int, p: float) -> str:
    return (
        f"info string {label:<5} ({index:<4}) N: {0:>7} (+{0:>2}) (P: {percent_text(p)}%) "
        "(WL:  -.-----) (D: -.---) (M:  -.-) (Q: -0.01234) (U: 0.12345) (S: 0.12345) (V:  -.----)"
    )


def node_line(q: float, edges: int) -> str:
    # the root's P is its "visited policy": no child has been visited after one node
    return (
        f"info string node  ({edges:<4}) N: {1:>7} (+{0:>2}) (P:  0.00%) "
        f"(WL: {q:8.5f}) (D: 0.500) (M:  0.0) (Q: {q:8.5f}) (V: {q:7.4f})"
    )


def emit(text: str) -> None:
    print(text, flush=True)


class FakeLc0:
    def __init__(self) -> None:
        self.board = chess.Board()
        self.options: dict[str, str] = {"WeightsFile": "<autodiscover>", "VerboseMoveStats": "false"}
        self.log_path = os.environ.get("FAKE_LC0_LOG")
        self.loaded_net: str | None = None  # lc0's backend_
        self.last_position: tuple[str, ...] | None = None  # lc0's last_position_
        self.has_tree = False  # lc0's tree_ (NewGame resets it, a successful position recreates it)
        self.searched: SearchedRoot | None = None

    def log(self, line: str) -> None:
        if self.log_path:
            with open(self.log_path, "a", encoding="utf-8") as out:
                out.write(line + "\n")

    def update_backend(self) -> None:
        wanted = self.options["WeightsFile"]
        if wanted == self.loaded_net:
            return
        problem = net_load_error(wanted)
        if problem:
            raise Lc0Error(problem)
        self.loaded_net = wanted

    def apply_position(self, key: tuple[str, ...], board: chess.Board) -> None:
        self.update_backend()  # a failed load raises before anything below changes
        self.last_position = key
        self.board = board
        self.has_tree = True
        if self.searched is not None and self.searched.key != key:
            self.searched = None  # the rest of the tree is trimmed

    def new_game(self) -> None:
        self.has_tree = False
        self.searched = None
        self.apply_position(("startpos",), chess.Board())

    def set_option(self, args: str) -> None:
        body = args.removeprefix("name ")
        name, _, value = body.partition(" value ")
        self.options[name.strip()] = value.strip()

    def set_position(self, args: str) -> None:
        tokens = args.split()
        if tokens[:1] == ["startpos"]:
            board = chess.Board()
            rest = tokens[1:]
        else:
            board = chess.Board(" ".join(tokens[1:7]))
            rest = tokens[7:]
        for uci in rest[1:]:  # rest[0] is "moves"
            board.push_uci(uci)
        self.apply_position(tuple(tokens), board)

    def go(self) -> None:
        for name, action in (("FAKE_LC0_DIE_FILE", self._crash), ("FAKE_LC0_HANG_FILE", self._hang)):
            self._on_control_file(name, action)
        if self.last_position is None:
            self.new_game()  # raises when no net can be loaded: "error ..." and no bestmove
        if not self.has_tree:
            self._crash()  # a failed "ucinewgame" left no tree, and lc0 reads through a null pointer
        board = self.board
        if not any(board.legal_moves):
            emit("bestmove (none)")
            return
        assert self.last_position is not None and self.loaded_net is not None
        if self.searched is None:
            net_name = Path(self.loaded_net).name
            spread = os.environ.get("FAKE_LC0_SPREAD") == "1"
            self.searched = SearchedRoot(
                self.last_position, move_policy(net_name, board, spread=spread), value_cp(net_name, board)
            )
        # A root that has already been visited is not evaluated again: "go nodes 1" stops at once.
        policy, cp = self.searched.policy, self.searched.cp
        best = next(iter(policy))
        emit(f"info depth 1 seldepth 1 time 3 nodes 1 score cp {cp} hashfull 0 nps 333 tbhits 0 pv {board.uci(best)}")
        if self.options["VerboseMoveStats"] == "true":
            scale = float(os.environ.get("FAKE_LC0_POLICY_SCALE", "1"))
            ascending = sorted(policy.items(), key=lambda item: item[1])
            for move, p in ascending[int(os.environ.get("FAKE_LC0_DROP_MOVES", "0")):]:
                emit(move_line(board.uci(move, chess960=True), _digest(move.uci()) % 1858, p * scale))
            emit(node_line(cp / 1000, len(policy)))
        emit(f"bestmove {board.uci(best)}")

    def handle(self, command: str, args: str) -> bool:
        """Run one command. False means quit."""
        if command == "uci":
            emit("id name Lc0 v0.32.1")
            emit("id author The LCZero Authors.")
            for option in UCI_OPTIONS:
                emit(option)
            emit("uciok")
        elif command == "isready":
            emit("readyok")  # lc0 only sets a flag here; it does not look at the net
        elif command == "setoption":
            self.set_option(args)
        elif command == "ucinewgame":
            self._on_control_file("FAKE_LC0_DIE_AT_NEW_GAME_FILE", self._crash)
            self.new_game()
        elif command == "position":
            self.set_position(args)
        elif command == "go":
            self.go()
        elif command == "quit":
            return False
        return True

    @staticmethod
    def _on_control_file(name: str, action) -> None:
        control = os.environ.get(name)
        if control and os.path.exists(control):
            os.remove(control)
            action()

    @staticmethod
    def _crash() -> None:
        os._exit(3)

    @staticmethod
    def _hang() -> None:
        while True:
            time.sleep(60)

    def run(self) -> None:
        for raw in sys.stdin:
            line = raw.strip()
            if not line:
                continue
            self.log(line)
            command, _, args = line.partition(" ")
            try:
                if not self.handle(command, args):
                    return
            except Lc0Error as exc:
                emit(f"error {exc}")


if __name__ == "__main__":
    FakeLc0().run()
