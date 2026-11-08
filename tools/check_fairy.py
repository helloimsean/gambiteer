#!/usr/bin/env python3
r"""Check the installed Fairy-Stockfish against the app's own code. Run it yourself after installing:

    python tools\check_fairy.py

Asks for a move in every variant at each kind of strength the bots use, and exits non-zero when the
engine fails or answers with an illegal move (python-chess rejects those).
"""
from __future__ import annotations

import asyncio
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import chess  # noqa: E402
import chess.engine  # noqa: E402

from app.bot import FAIRY_ELO_RANGE, choose_bot_move, choose_panicfish_move  # noqa: E402
from app.config import Settings  # noqa: E402
from app.engine import EngineUnavailable  # noqa: E402
from app.variants import FAIRY_BOARDS, FAIRY_INSTALL_HINT, FAIRY_SLOT, create_manager  # noqa: E402

CRAZYHOUSE_WITH_POCKET = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R[Pp] w KQkq - 2 3"
MOVETIME_MS = 200


def positions() -> list[tuple[str, chess.Board]]:
    out = [(name, board()) for name, board in FAIRY_BOARDS.items()]
    out.append(("crazyhouse, pocket", FAIRY_BOARDS["crazyhouse"](CRAZYHOUSE_WITH_POCKET)))
    return out


async def run(settings: Settings) -> int:
    if not settings.fairy_path.is_file():
        print(f"Fairy-Stockfish was not found at {settings.fairy_path}. {FAIRY_INSTALL_HINT}", file=sys.stderr)
        return 1
    manager = create_manager(settings)
    await manager.start()
    rng = random.Random(1)
    strengths = (
        ("full", lambda e, b: choose_panicfish_move(e, b, 3600, MOVETIME_MS, rng, FAIRY_ELO_RANGE)),
        ("elo 1500", lambda e, b: choose_bot_move(e, b, 1500, MOVETIME_MS, rng, FAIRY_ELO_RANGE)),
        ("elo 450", lambda e, b: choose_bot_move(e, b, 450, MOVETIME_MS, rng, FAIRY_ELO_RANGE)),
    )
    try:
        async with manager.use(FAIRY_SLOT) as engine:
            print(f"engine: {engine.name}  ({settings.fairy_path})\n")
            for name, board in positions():
                print(name)
                for label, choose in strengths:
                    started = time.perf_counter()
                    choice = await choose(engine, board)
                    print(f"  {label:<9} {time.perf_counter() - started:6.3f} s  {board.san(choice.move)}")
    except EngineUnavailable as exc:
        print(f"\nFAILED: {exc}", file=sys.stderr)
        return 1
    except (chess.engine.EngineError, RuntimeError, ValueError) as exc:
        print(f"\nFAILED: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    finally:
        await manager.close()
    print(f"\nOK: {len(FAIRY_BOARDS)} variants, {len(strengths)} strengths each.")
    return 0


def main() -> int:
    return asyncio.run(run(Settings.from_env()))


if __name__ == "__main__":
    raise SystemExit(main())
