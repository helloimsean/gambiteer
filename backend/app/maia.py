"""Maia, the human-like bot: lc0 running one CSSLab Maia net per 100 Lichess rating points.

Each net was trained on real Lichess games at one rating band. It runs inside lc0 with search
switched off (``go nodes 1``), so the "move time" setting means nothing here.

Alone, that is deterministic: the most likely move every time, and stronger than the rating label.
So the bot reads the net's policy from lc0's ``VerboseMoveStats`` output and samples a move from
the plausible ones, which gives human-style variety and mistakes.

The net's input includes the last 8 positions, so the real move history is sent when the client
provides it (``board_with_history``).

Real lc0 output has been checked against its source code only. ``tools/check_maia.py`` is the test
that runs against the real engine.
"""
from __future__ import annotations

import gzip
import logging
import random
import re
import zlib
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any, Protocol

import chess
import chess.engine

from .bot import BotChoice
from .chessutil import parse_fen, score_to_dict
from .config import Settings
from .engine import EngineManager, VerboseSearch

log = logging.getLogger(__name__)

MAIA_SLOT = "maia"
MAIA_RATINGS: tuple[int, ...] = tuple(range(1100, 2000, 100))
INSTALL_HINT = r"Install it with: python tools\install_maia.py, then restart the app."
RETRY_HINT = r"Press Retry. If it keeps happening, repair the install with: python tools\install_maia.py."
RUNTIME_HINT = (
    "lc0 needs the Microsoft Visual C++ 2015-2022 x64 Redistributable "
    "(https://aka.ms/vs/17/release/vc_redist.x64.exe). "
    r"If that is installed, repair lc0 with: python tools\install_maia.py."
)
NET_HEADER = b"\x0d\xc0\x01\x00\x00"  # how a protobuf holding lc0's magic number 0x1c0 starts

# Move selection. These numbers are a first guess and are NOT yet calibrated against real play, so
# how close the bot's strength is to the net's rating label is unknown.
MIN_POLICY = 0.03  # a playable move needs at least this share of the policy...
MIN_POLICY_OF_TOP = 0.10  # ...and at least this fraction of the most likely move's share

# One VerboseMoveStats line, after python-chess has removed "info string ", for example:
#   e2e4  (322 ) N:       0 (+ 0) (P: 28.40%) (WL:  -.-----) (D: -.---) ...
_POLICY_LINE = re.compile(r"^\s*(?:info\s+string\s+)?(\S+)\s.*?\(P:\s*([0-9.]+)%\)")


class MaiaEngine(Protocol):
    """The subset of EngineProxy Maia needs (stubbed in tests)."""

    async def configure(self, options: Mapping[str, Any]) -> None: ...

    async def search_verbose(self, board: chess.Board, limit: chess.engine.Limit) -> VerboseSearch: ...


def weight_path(weights_dir: Path | str, rating: int) -> Path:
    return Path(weights_dir) / f"maia-{rating}.pb.gz"


def installed_ratings(weights_dir: Path | str) -> list[int]:
    """The ratings whose weight file exists. Only looks at files; never starts lc0."""
    return [rating for rating in MAIA_RATINGS if weight_path(weights_dir, rating).is_file()]


def net_is_intact(path: Path | str) -> bool:
    """Whether a net file is one whole gzip stream that starts with lc0's header.

    lc0 does not fail fast on a damaged net: it prints an error, keeps running and never answers,
    so without this check the request would wait for the timeout. Reading a whole net takes about
    5 ms, and reading to the end makes gzip check the file's CRC.
    """
    try:
        with gzip.open(path, "rb") as stream:
            return stream.read().startswith(NET_HEADER)
    except (OSError, EOFError, zlib.error):
        return False


def create_manager(settings: Settings) -> EngineManager:
    """The lc0 process behind Maia. It starts with the first Maia move, never at app startup."""
    return EngineManager(
        settings.lc0_path,
        {
            MAIA_SLOT: {
                "Threads": settings.lc0_threads,
                "NNCacheSize": settings.lc0_nn_cache_size,
                "VerboseMoveStats": True,  # prints the policy
                "PolicyTemperature": 1.0,  # lc0's default of 1.359 flattens the policy
            }
        },
        label="lc0",
        path_env="LC0_PATH",
    )


def _legal_ep_square(board: chess.Board) -> chess.Square | None:
    return board.ep_square if board.has_legal_en_passant() else None


def same_position(a: chess.Board, b: chess.Board) -> bool:
    """Same pieces, side to move, castling rights and en passant.

    En passant counts only when a capture is legal: a FEN may name the square after every double
    push or only when the capture exists, depending on which program wrote it.
    """
    return (
        a.board_fen() == b.board_fen()
        and a.turn == b.turn
        and a.clean_castling_rights() == b.clean_castling_rights()
        and _legal_ep_square(a) == _legal_ep_square(b)
    )


def board_with_history(board: chess.Board, moves: Sequence[str] | None, start_fen: str | None = None) -> chess.Board:
    """A board with a real move stack ending on ``board``'s position, or ``board`` itself (FEN only)
    when the history is missing, has an illegal move, or leads to a different position."""
    if not moves:
        return board
    try:
        replay = parse_fen(start_fen) if start_fen else chess.Board()
        for text in moves:
            move = replay.parse_uci(text)
            if not move:  # parse_uci reads "0000" as a null move
                raise ValueError("null move")
            replay.push(move)
    except ValueError as exc:
        log.info("move history ignored, using the FEN only: %s", exc)
        return board
    if not same_position(replay, board):
        log.info("move history ignored, using the FEN only: it does not end on the position sent")
        return board
    return replay


def parse_policy(lines: Iterable[str], board: chess.Board) -> dict[chess.Move, float]:
    """The net's probability (0..1) for each legal move named in lc0's VerboseMoveStats lines.

    ``parse_uci`` accepts castling as king-takes-rook (e1h1) as well as e1g1. Anything else is
    skipped: the root's "node" line, other ``info string`` text, and moves that are not legal.
    """
    policy: dict[chess.Move, float] = {}
    for line in lines:
        match = _POLICY_LINE.match(line)
        if match is None:
            continue
        try:
            move = board.parse_uci(match[1])
            probability = float(match[2]) / 100
        except ValueError:
            continue
        if move:  # Move.null() ("0000") is falsy
            policy[move] = max(probability, policy.get(move, 0.0))
    return policy


def selection_pool(policy: Mapping[chess.Move, float]) -> dict[chess.Move, float]:
    """The moves the bot may play, with probabilities summing to 1 (always at least the top move)."""
    top_move = max(policy, key=lambda move: policy[move])
    cutoff = max(MIN_POLICY, MIN_POLICY_OF_TOP * policy[top_move])
    pool = {move: p for move, p in policy.items() if p >= cutoff}
    total = sum(pool.values())
    if total <= 0:  # nothing reached the cutoff
        return {top_move: 1.0}
    return {move: p / total for move, p in pool.items()}


def sample_move(policy: Mapping[chess.Move, float], rng: random.Random) -> tuple[chess.Move, int]:
    """A move drawn from the selection pool, and the size of that pool."""
    pool = selection_pool(policy)
    moves = list(pool)
    return rng.choices(moves, weights=[pool[move] for move in moves], k=1)[0], len(moves)


async def read_policy(
    engine: MaiaEngine, board: chess.Board, weights: Path | str
) -> tuple[VerboseSearch, dict[chess.Move, float]]:
    """Load one net (lc0 reloads only when the file changes) and read its output for ``board``.
    The caller holds the engine lock, so the net cannot change before the search runs."""
    await engine.configure({"WeightsFile": str(Path(weights).resolve())})
    search = await engine.search_verbose(board, chess.engine.Limit(nodes=1))
    return search, parse_policy(search.strings, board)


async def choose_maia_move(
    engine: MaiaEngine,
    board: chess.Board,
    elo: int,
    weights: Path | str,
    rng: random.Random | None = None,
) -> BotChoice:
    """Sample Maia's move for ``board``. Keep ``board``'s move stack: the net uses the history."""
    if not any(board.legal_moves):
        raise ValueError("the game is over: no legal moves")
    search, policy = await read_policy(engine, board, weights)
    if policy:
        move, candidates = sample_move(policy, rng or random.Random())
    else:
        log.warning("no policy lines in lc0's output; playing its best move")
        if search.best_move is None:
            raise chess.engine.EngineError("lc0 returned no move")
        move, candidates = search.best_move, 1
    score = score_to_dict(search.score) if search.score is not None else None
    return BotChoice(move=move, score=score, mode="maia", elo=elo, candidates=candidates)
