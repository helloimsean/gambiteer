"""A stand-in for Fairy-Stockfish: speaks UCI with its option names and plays legal moves. Tests only.

The move comes from a hash of the position, so it is deterministic and plays no real chess. It has
never been compared with the running engine; tools/check_fairy.py is what tests the real one.

Run with: python fake_fairy.py   (python-chess speaks to it over stdin/stdout)

Environment variables for the tests:
  FAKE_FAIRY_LOG        append every received command to this file
  FAKE_FAIRY_DIE_FILE   if this file exists at "go": delete it and crash without answering
"""
from __future__ import annotations

import hashlib
import os
import sys

import chess
import chess.variant

BOARDS = {cls.uci_variant: cls for cls in chess.variant.VARIANTS}
OPTIONS = (
    "option name Threads type spin default 1 min 1 max 512",
    "option name Hash type spin default 16 min 1 max 33554432",
    "option name MultiPV type spin default 1 min 1 max 500",
    "option name Skill Level type spin default 20 min -20 max 20",
    "option name UCI_Chess960 type check default false",
    "option name UCI_Variant type combo default chess " + " ".join(f"var {name}" for name in BOARDS),
    "option name UCI_LimitStrength type check default false",
    "option name UCI_Elo type spin default 1350 min 500 max 2850",
)


def emit(text: str) -> None:
    print(text, flush=True)


class FakeFairy:
    def __init__(self) -> None:
        self.options = {"UCI_Variant": "chess", "UCI_Chess960": "false", "MultiPV": "1"}
        self.board = chess.Board()
        self.log_path = os.environ.get("FAKE_FAIRY_LOG")

    def set_option(self, args: str) -> None:
        name, _, value = args.removeprefix("name ").partition(" value ")
        self.options[name.strip()] = value.strip()

    def set_position(self, args: str) -> None:
        head, _, moves = args.partition(" moves ")
        board_class = BOARDS[self.options["UCI_Variant"]]
        chess960 = self.options["UCI_Chess960"] == "true"
        board = board_class(chess960=chess960) if head == "startpos" else board_class(head.removeprefix("fen ").strip(), chess960=chess960)
        for uci in moves.split():
            board.push_uci(uci)
        self.board = board

    def go(self) -> None:
        control = os.environ.get("FAKE_FAIRY_DIE_FILE")
        if control and os.path.exists(control):
            os.remove(control)
            os._exit(3)
        key = self.board.fen()
        moves = sorted(self.board.legal_moves, key=lambda m: hashlib.sha256(f"{key}|{m.uci()}".encode()).hexdigest())
        if not moves:
            emit("bestmove (none)")
            return
        for index, move in enumerate(moves[: int(self.options["MultiPV"])], start=1):
            emit(f"info depth 2 multipv {index} score cp {20 - index * 5} nodes 10 time 1 pv {self.board.uci(move)}")
        emit(f"bestmove {self.board.uci(moves[0])}")

    def run(self) -> None:
        for raw in sys.stdin:
            line = raw.strip()
            if self.log_path and line:
                with open(self.log_path, "a", encoding="utf-8") as out:
                    out.write(line + "\n")
            command, _, args = line.partition(" ")
            if command == "uci":
                emit("id name Fairy-Stockfish 14 stand-in")
                for option in OPTIONS:
                    emit(option)
                emit("uciok")
            elif command == "isready":
                emit("readyok")
            elif command == "setoption":
                self.set_option(args)
            elif command == "position":
                self.set_position(args)
            elif command == "go":
                self.go()
            elif command == "quit":
                return


if __name__ == "__main__":
    FakeFairy().run()
