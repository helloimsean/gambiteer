#!/usr/bin/env python3
"""Exercise every engine on a connected phone or emulator through the app's own API.

    adb forward tcp:18000 tcp:8000
    python scripts/smoke-test.py

Needs the app open. Exits non-zero if anything fails. The app's backend wants its access key
(AccessKey.kt), which a debug build lets adb read with run-as.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:18000/api"
START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
CHECK_POSITION = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3"  # fool's mate: game over
CHESS960 = "bbqnnrkr/pppppppp/8/8/8/8/PPPPPPPP/BBQNNRKR w HFhf - 0 1"
CRAZYHOUSE = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[] w KQkq - 0 1"
HORDE = "rnbqkbnr/pppppppp/8/1PP2PP1/PPPPPPPP/PPPPPPPP/PPPPPPPP/PPPPPPPP w kq - 0 1"
RACING = "8/8/8/8/8/8/krbnNBRK/qrbnNBRQ w - - 0 1"

failures: list[str] = []
ADB = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Android", "Sdk", "platform-tools", "adb.exe")
KEY = subprocess.run(
    [ADB, "shell", "run-as", "com.gambiteer.mobile", "cat", "files/access-key"], capture_output=True, text=True, check=True
).stdout.strip()


def call(path: str, body: object | None = None, timeout: float = 120.0) -> dict:
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(BASE + path, data=data, headers={"Content-Type": "application/json", "X-Gambiteer-Key": KEY})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def check(name: str, run) -> object:
    started = time.monotonic()
    try:
        result = run()
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:300]
        failures.append(name)
        print(f"FAIL {name}: HTTP {error.code} {detail}")
        return None
    except Exception as error:  # noqa: BLE001 - a smoke test reports everything
        failures.append(name)
        print(f"FAIL {name}: {type(error).__name__}: {error}")
        return None
    print(f"ok   {name} ({time.monotonic() - started:.1f}s): {result}")
    return result


def bot(name: str, **body: object) -> None:
    defaults = {"fen": START, "elo": 1500, "movetime_ms": 300}
    check(name, lambda: call("/bot/move", {**defaults, **body}).get("uci") or call("/bot/move", {**defaults, **body}))


def review() -> str:
    moves = ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "c3", "Nf6", "d4", "exd4"]
    job = call("/review", {"moves": moves, "depth": 8})["jobId"]
    deadline = time.monotonic() + 240
    while time.monotonic() < deadline:
        state = call(f"/review/{job}")
        if state.get("status") == "done":
            result = state["result"]
            return f"accuracy {result.get('accuracy')}, {len(result['moves'])} moves"
        if state.get("status") == "error":
            raise RuntimeError(state)
        time.sleep(1)
    raise TimeoutError("review did not finish")


def main() -> int:
    health = check("health", lambda: call("/health"))
    if not health:
        return 1
    check("openings", lambda: len(call("/openings")))
    check("analyze (Stockfish, depth 10)", lambda: call("/analyze", {"fen": START, "depth": 10, "multipv": 3})["lines"][0]["pv"][:3])
    check("game-over position", lambda: call("/analyze", {"fen": CHECK_POSITION, "depth": 4})["lines"])
    bot("bot: Stockfish 1500", bot="stockfish")
    bot("bot: Stockfish 600 (move mixing)", bot="stockfish", elo=600)
    bot("bot: Panicfish full strength", bot="panicfish", elo=3600)
    bot("bot: Panicfish random", bot="panicfish", elo=0)
    for rating in (1100, 1500, 1900):
        bot(f"bot: Maia {rating}", bot="maia", elo=rating, fen=AFTER_E4, moves=["e2e4"])
    bot("variant: Chess960 (Stockfish)", variant="chess960", fen=CHESS960)
    bot("variant: Crazyhouse (Fairy)", variant="crazyhouse", fen=CRAZYHOUSE)
    bot("variant: King of the Hill (Fairy)", variant="kingofthehill")
    bot("variant: Three-Check (Fairy)", variant="3check", fen="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 3+3 0 1")
    bot("variant: Antichess (Fairy)", variant="antichess", fen="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1")
    bot("variant: Atomic (Fairy)", variant="atomic")
    bot("variant: Horde (Fairy)", variant="horde", fen=HORDE)
    bot("variant: Racing Kings (Fairy)", variant="racingkings", fen=RACING)
    check("pgn parse", lambda: len(call("/pgn/parse", {"pgn": "1. e4 e5 2. Nf3 Nc6 *"})["moves"]))
    check("review (depth 8)", review)
    print(f"\n{len(failures)} failure(s)" + (f": {', '.join(failures)}" if failures else ""))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
