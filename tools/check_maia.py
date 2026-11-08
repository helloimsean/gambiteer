#!/usr/bin/env python3
r"""Check the installed Maia setup against the real lc0 engine. Run it yourself after installing:

    python tools\check_maia.py

It uses the app's own code (settings, EngineManager, maia.py), loads every installed net and asks
for its move in a few positions. It prints the time, the 3 most likely moves and how many legal
moves were found in lc0's output, and exits non-zero when something looks wrong.
"""
from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import chess  # noqa: E402
import chess.engine  # noqa: E402

from app.config import Settings  # noqa: E402
from app.engine import EngineUnavailable  # noqa: E402
from app.maia import (  # noqa: E402
    INSTALL_HINT,
    MAIA_SLOT,
    RUNTIME_HINT,
    MaiaEngine,
    create_manager,
    installed_ratings,
    net_is_intact,
    read_policy,
    weight_path,
)

POSITIONS = (
    ("start", chess.STARTING_FEN),
    ("Black to move", "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2"),
    ("castling available", "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 6 5"),
    ("promotion", "8/P6k/8/8/8/8/6K1/8 w - - 0 1"),
)
POLICY_SUM_TOLERANCE = 3.0  # percentage points away from 100 (lc0 rounds each move to 2 decimals)


def describe_top_moves(board: chess.Board, policy: dict[chess.Move, float]) -> str:
    best = sorted(policy.items(), key=lambda item: item[1], reverse=True)[:3]
    return ", ".join(f"{board.san(move)} {p * 100:.1f}%" for move, p in best)


def find_problems(legal: int, parsed: int, total_percent: float) -> list[str]:
    problems: list[str] = []
    if parsed != legal:
        problems.append(f"{parsed} policy lines parsed but there are {legal} legal moves")
    if abs(total_percent - 100) > POLICY_SUM_TOLERANCE:
        problems.append(f"the policy adds up to {total_percent:.1f}%")
    return problems


async def check_net(engine: MaiaEngine, rating: int, settings: Settings) -> list[str]:
    weights = weight_path(settings.maia_weights_dir, rating)
    print(f"maia-{rating}")
    if not net_is_intact(weights):
        print("  the file is damaged")
        return [f"maia-{rating}: the file is damaged ({weights}). {INSTALL_HINT}"]
    failures: list[str] = []
    for name, fen in POSITIONS:
        board = chess.Board(fen)
        started = time.perf_counter()
        async with asyncio.timeout(settings.maia_timeout_s):
            _search, policy = await read_policy(engine, board, weights)
        elapsed = time.perf_counter() - started
        legal = board.legal_moves.count()
        total_percent = sum(policy.values()) * 100
        problems = find_problems(legal, len(policy), total_percent)
        print(
            f"  {name:<20} {elapsed:6.3f} s  {describe_top_moves(board, policy) or '(no policy)':<42}"
            f"  {len(policy)}/{legal} moves, policy {total_percent:.1f}%"
            f"{'  <-- ' + '; '.join(problems) if problems else ''}"
        )
        failures += [f"maia-{rating}, {name}: {problem}" for problem in problems]
    return failures


async def run(settings: Settings) -> int:
    ratings = installed_ratings(settings.maia_weights_dir)
    if not settings.lc0_path.is_file():
        print(f"lc0 was not found at {settings.lc0_path}. {INSTALL_HINT}", file=sys.stderr)
        return 1
    if not ratings:
        print(f"No Maia nets were found in {settings.maia_weights_dir}. {INSTALL_HINT}", file=sys.stderr)
        return 1
    manager = create_manager(settings)
    await manager.start()
    failures: list[str] = []
    try:
        async with manager.use(MAIA_SLOT) as engine:
            print(f"engine: {engine.name}  ({settings.lc0_path})")
            print(f"nets:   {len(ratings)} in {settings.maia_weights_dir}\n")
            for rating in ratings:
                failures += await check_net(engine, rating, settings)
    except EngineUnavailable as exc:
        print(f"\nFAILED: {exc}\n{RUNTIME_HINT}", file=sys.stderr)
        return 1
    except (chess.engine.EngineError, TimeoutError) as exc:
        print(f"\nFAILED: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    finally:
        await manager.close()
    if failures:
        print(f"\nFAILED: {len(failures)} problem(s):", file=sys.stderr)
        for failure in failures:
            print(f"  {failure}", file=sys.stderr)
        return 1
    print(f"\nOK: {len(ratings)} net(s), {len(POSITIONS)} positions each.")
    return 0


def main() -> int:
    return asyncio.run(run(Settings.from_env()))


if __name__ == "__main__":
    raise SystemExit(main())
