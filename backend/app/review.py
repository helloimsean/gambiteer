"""Game review: engine evaluations, chess.com-like move classification and lichess-style accuracy.

The module is split in two:

* pure functions (``win_pct`` ... ``build_review_result``) that turn evaluations into a
  ``ReviewResult``; they never touch an engine and are unit-tested directly;
* ``ReviewService``, which owns the in-memory job store and runs each job as an asyncio task that
  asks the ``review`` engine for one MultiPV-2 evaluation per position (jobs run one at a time; the
  engine lock is taken per position so single-move coach requests can run in between).

Classification rules (see ARCHITECTURE.md):

* win% (mover POV) = 50 + 50 * (2 / (1 + exp(-0.00368208 * cp)) - 1), cp clamped to +-1500,
  mate = 100 / 0.
* drop = winPctBefore - winPctAfter, both from the mover's point of view.
* book      - the SAN path up to and including the move is in our opening data and ply <= 30.
* brilliant - played == best, it sacrifices material (SEE), the mover was not already above
              +600 cp and stays >= -150 cp after the move.
* great     - played == best, the engine's second line is >= 10 win% worse, position not lost.
* best      - played == best otherwise.
* excellent < 2, good < 5, inaccuracy < 10, mistake < 20, blunder >= 20 (drop in win%).
* miss      - the opponent's previous move gave the mover >= 10 win% and this move drops >= 10:
              replaces inaccuracy / mistake / blunder.
* accuracy per move = 103.1668 * exp(-0.04354 * drop) - 3.1669, clamped 0..100; game accuracy is
  the plain mean per colour.
"""
from __future__ import annotations

import asyncio
import logging
import math
import time
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

import chess
import chess.engine

from .chessutil import (
    PIECE_VALUES,
    color_name,
    infos_to_lines,
    is_standard_start,
    parse_fen,
    parse_move,
    see_gain,
    terminal_lines,
)
from .engine import EngineManager, EngineProxy, EngineUnavailable
from .hardware import cpu_threads, max_hash_mb, total_memory_mb
from .schemas import (
    CLASSIFICATIONS,
    Accuracy,
    BestMove,
    ClassificationCounts,
    EngineLine,
    ReviewJob,
    ReviewMove,
    ReviewOpening,
    ReviewEngineHealth,
    ReviewRequest,
    ReviewResult,
)

log = logging.getLogger(__name__)

WIN_K = 0.00368208
CP_CLAMP = 1500
BOOK_MAX_PLY = 30
BRILLIANT_MAX_BEFORE_CP = 600  # "not already winning"
BRILLIANT_MIN_AFTER_CP = -150
GREAT_MIN_GAP = 10.0  # win% between best and second-best line
LOST_CP = -300  # below this (mover POV) the position counts as lost for "great"
MISS_MIN_GIFT = 10.0
MISS_MIN_DROP = 10.0
REPLACEABLE_BY_MISS = {"inaccuracy", "mistake", "blunder"}

ScoreLike = Mapping[str, int] | Any  # dict {"cp"|"mate": n} or a CpScore/MateScore model


# ============================================================================ pure math


def _score_parts(score: ScoreLike) -> tuple[str, int]:
    if not isinstance(score, Mapping):
        score = score.model_dump()
    if "mate" in score and score["mate"] is not None:
        return "mate", int(score["mate"])
    return "cp", int(score.get("cp", 0) or 0)


def win_pct(cp: float) -> float:
    """Win probability (0..100) for a centipawn score from the player's own point of view."""
    cp = max(-CP_CLAMP, min(CP_CLAMP, cp))
    return 50 + 50 * (2 / (1 + math.exp(-WIN_K * cp)) - 1)


def _mover_mates(kind_value: tuple[str, int], mover: chess.Color, side_to_move: chess.Color) -> bool:
    """For a mate score: True if the mover is the side delivering mate."""
    _, n = kind_value
    if n == 0:  # the position is checkmate: the side to move is mated
        return side_to_move != mover
    white_mates = n > 0
    return white_mates == (mover == chess.WHITE)


def mover_cp(score: ScoreLike, mover: chess.Color, side_to_move: chess.Color) -> int:
    """White-POV score -> centipawns from the mover's POV, clamped to +-1500 (mate = +-1500)."""
    kind, n = parts = _score_parts(score)
    if kind == "mate":
        return CP_CLAMP if _mover_mates(parts, mover, side_to_move) else -CP_CLAMP
    cp = n if mover == chess.WHITE else -n
    return max(-CP_CLAMP, min(CP_CLAMP, cp))


def mover_win_pct(score: ScoreLike, mover: chess.Color, side_to_move: chess.Color) -> float:
    """White-POV score -> win% from the mover's POV (mate for the mover = 100, mated = 0)."""
    kind, n = parts = _score_parts(score)
    if kind == "mate":
        return 100.0 if _mover_mates(parts, mover, side_to_move) else 0.0
    return win_pct(n if mover == chess.WHITE else -n)


def move_accuracy(drop: float) -> float:
    """lichess per-move accuracy from the win% drop, clamped to 0..100."""
    acc = 103.1668 * math.exp(-0.04354 * drop) - 3.1669
    return max(0.0, min(100.0, acc))


def mean_accuracy(drops: Sequence[float]) -> float:
    """Plain mean of the per-move accuracies (100 when the side made no moves)."""
    if not drops:
        return 100.0
    return sum(move_accuracy(d) for d in drops) / len(drops)


def is_sacrifice(board: chess.Board, move: chess.Move) -> bool:
    """Does ``move`` give up material? (see ``sacrificed_piece``)"""
    return sacrificed_piece(board, move) is not None


def sacrificed_piece(board: chess.Board, move: chess.Move) -> chess.PieceType | None:
    """The most valuable piece ``move`` gives up, or None when it gives up no material.

    After the move, look at the moved piece and at every other piece of the mover worth >= 3: if the
    opponent can win more material on one of those squares (static exchange evaluation) than the
    move itself captured, that piece is sacrificed. Queens and rooks left en prise are covered by the
    same test.
    """
    mover = board.turn
    gained = 0
    captured = board.piece_at(move.to_square)
    if captured is not None:
        gained = PIECE_VALUES[captured.piece_type]
    elif board.is_en_passant(move):
        gained = 1
    if move.promotion:
        gained += PIECE_VALUES[move.promotion] - 1
    after = board.copy(stack=False)
    after.push(move)
    given_up: chess.PieceType | None = None
    for square, piece in after.piece_map().items():
        if piece.color != mover or piece.piece_type == chess.KING:
            continue
        value = PIECE_VALUES[piece.piece_type]
        if value < 3 or (given_up is not None and value <= PIECE_VALUES[given_up]):
            continue
        if see_gain(after, square) > gained:
            given_up = piece.piece_type
    return given_up


@dataclass(frozen=True)
class MoveFacts:
    """Everything ``classify`` needs about one move (all win% from the mover's POV)."""

    played_is_best: bool
    drop: float
    win_before: float
    second_win: float | None = None  # win% of the engine's 2nd line in the position before
    cp_before: int = 0  # mover POV, clamped
    cp_after: int = 0
    sacrifice: bool = False
    book: bool = False
    prev_gift: float | None = None  # the opponent's previous drop (what it gave the mover)


def classify(f: MoveFacts) -> str:
    if f.book:
        return "book"
    if f.played_is_best:
        if f.sacrifice and f.cp_before <= BRILLIANT_MAX_BEFORE_CP and f.cp_after >= BRILLIANT_MIN_AFTER_CP:
            return "brilliant"
        if f.second_win is not None and f.win_before - f.second_win >= GREAT_MIN_GAP and f.cp_before >= LOST_CP:
            return "great"
        return "best"
    if f.drop < 2:
        label = "excellent"
    elif f.drop < 5:
        label = "good"
    elif f.drop < 10:
        label = "inaccuracy"
    elif f.drop < 20:
        label = "mistake"
    else:
        label = "blunder"
    if (
        label in REPLACEABLE_BY_MISS
        and f.prev_gift is not None
        and f.prev_gift >= MISS_MIN_GIFT
        and f.drop >= MISS_MIN_DROP
    ):
        return "miss"
    return label


def empty_counts() -> dict[str, int]:
    return {c: 0 for c in CLASSIFICATIONS}


@dataclass(frozen=True)
class BookHit:
    why: str
    opening_id: str
    opening_name: str


def build_review_result(
    start: chess.Board,
    moves: Sequence[chess.Move],
    evals: Sequence[Sequence[EngineLine]],
    *,
    depth: int,
    engine: str,
    book: Sequence[BookHit | None] = (),
    book_max_ply: int = BOOK_MAX_PLY,
) -> ReviewResult:
    """Assemble the ReviewResult from per-position engine lines.

    ``evals[i]`` are the engine lines (best first, White POV) for the position before move ``i``;
    ``evals[len(moves)]`` is the final position. ``book[i]`` is the opening-data hit for the SAN
    path up to and including move ``i`` (or None).
    """
    if len(evals) != len(moves) + 1:
        raise ValueError(f"need {len(moves) + 1} evaluations, got {len(evals)}")
    board = start.copy()
    out: list[ReviewMove] = []
    drops: dict[chess.Color, list[float]] = {chess.WHITE: [], chess.BLACK: []}
    counts = {chess.WHITE: empty_counts(), chess.BLACK: empty_counts()}
    prev_drop: float | None = None
    last_book_ply = 0
    opening: ReviewOpening | None = None

    for i, move in enumerate(moves):
        ply = i + 1
        mover = board.turn
        before_lines, after_lines = evals[i], evals[i + 1]
        if not before_lines or not after_lines:
            raise ValueError(f"missing engine lines around ply {ply}")
        fen_before = board.fen()
        san = board.san(move)
        best_line = before_lines[0]
        best_uci = best_line.pvUci[0] if best_line.pvUci else move.uci()
        best_san = best_line.pv[0] if best_line.pv else san
        sacrificed = sacrificed_piece(board, move) if move.uci() == best_uci else None
        sacrifice = sacrificed is not None

        board.push(move)
        side_after = board.turn
        eval_before = best_line.score
        eval_after = after_lines[0].score
        win_before = mover_win_pct(eval_before, mover, mover)
        win_after = mover_win_pct(eval_after, mover, side_after)
        second_win = mover_win_pct(before_lines[1].score, mover, mover) if len(before_lines) > 1 else None
        cp_before = mover_cp(eval_before, mover, mover)
        cp_after = mover_cp(eval_after, mover, side_after)
        drop = win_before - win_after

        hit = book[i] if i < len(book) else None
        is_book = hit is not None and ply <= book_max_ply
        if hit is not None:
            last_book_ply = ply
            opening = ReviewOpening(id=hit.opening_id, name=hit.opening_name, lastBookPly=ply)

        label = classify(
            MoveFacts(
                played_is_best=move.uci() == best_uci,
                drop=drop,
                win_before=win_before,
                second_win=second_win,
                cp_before=cp_before,
                cp_after=cp_after,
                sacrifice=sacrifice,
                book=is_book,
                prev_gift=prev_drop,
            )
        )
        drops[mover].append(drop)
        counts[mover][label] += 1
        out.append(
            ReviewMove(
                ply=ply,
                san=san,
                uci=move.uci(),
                fenBefore=fen_before,
                fenAfter=board.fen(),
                color=color_name(mover),  # type: ignore[arg-type]
                evalBefore=eval_before,
                evalAfter=eval_after,
                bestMove=BestMove(san=best_san, uci=best_uci, pv=list(best_line.pv)),
                playedPv=list(after_lines[0].pv),
                winPctBefore=round(win_before, 2),
                winPctAfter=round(win_after, 2),
                cpLoss=max(0, cp_before - cp_after),
                classification=label,  # type: ignore[arg-type]
                sacrifice=chess.piece_name(sacrificed) if sacrificed else None,  # type: ignore[arg-type]
                bookWhy=(hit.why or None) if hit else None,
                bookOpening=hit.opening_name if hit else None,
            )
        )
        prev_drop = drop

    if opening is not None:
        opening = opening.model_copy(update={"lastBookPly": last_book_ply})
    return ReviewResult(
        moves=out,
        accuracy=Accuracy(
            white=round(mean_accuracy(drops[chess.WHITE]), 1),
            black=round(mean_accuracy(drops[chess.BLACK]), 1),
        ),
        counts=ClassificationCounts(white=counts[chess.WHITE], black=counts[chess.BLACK]),
        opening=opening,
        depth=depth,
        engine=engine,
    )


# ============================================================================ engine I/O


async def evaluate_position(
    engine: EngineProxy, board: chess.Board, depth: int, multipv: int = 2, *, max_seconds: float | None = None
) -> list[EngineLine]:
    """Engine lines (best first) for one position; positions without legal moves skip the engine.

    ``max_seconds`` ends the search early when reaching ``depth`` takes longer.
    """
    terminal = terminal_lines(board)
    if terminal is not None:
        return terminal
    infos = await engine.analyse(board, chess.engine.Limit(depth=depth, time=max_seconds), multipv=multipv)
    lines = infos_to_lines(board, infos)
    if not lines:  # extremely shallow search without a PV: fall back to a 1-line search
        info = await engine.analyse(board, chess.engine.Limit(depth=max(depth, 4)))
        lines = infos_to_lines(board, [info])
    if not lines:
        raise RuntimeError(f"engine returned no line for {board.fen()}")
    return lines


BookLookup = Callable[[Sequence[str]], BookHit | None]


def find_book_hits(start: chess.Board, moves: Sequence[chess.Move], lookup: Callable[[Sequence[str]], list[tuple[Any, Any]]]) -> list[BookHit | None]:
    """Per-ply book hits for a game, using ``OpeningStore.lookup``-style SAN path lookups.

    The game's opening is the one whose tree follows the game the longest (first in file order on
    ties); every ply inside that path gets that opening's node explanation.
    """
    hits: list[BookHit | None] = [None] * len(moves)
    if not is_standard_start(start):
        return hits
    board = start.copy()
    sans: list[str] = []
    deepest: list[tuple[Any, Any]] = []
    depth = 0
    for move in moves:
        sans.append(board.san(move))
        board.push(move)
        found = lookup(sans)
        if not found:
            break
        deepest = found
        depth = len(sans)
    if not deepest:
        return hits
    opening = deepest[0][0]
    for ply in range(1, depth + 1):
        node = opening.node_at(sans[:ply])
        if node is None:  # cannot happen: the deepest node implies its prefixes
            break
        hits[ply - 1] = BookHit(why=node.why, opening_id=opening.id, opening_name=opening.name)
    return hits


@dataclass
class _Job:
    id: str
    start: chess.Board
    moves: list[chess.Move]
    depth: int
    players: dict[str, str]
    # Threads and Hash for the review engine, and the time limit per position
    options: dict[str, int] = field(default_factory=dict)
    max_seconds: float | None = None
    status: str = "queued"
    progress: float = 0.0
    message: str | None = None
    result: ReviewResult | None = None
    task: asyncio.Task[None] | None = None
    subscribers: set[asyncio.Queue[ReviewJob]] = field(default_factory=set)
    created: float = field(default_factory=time.monotonic)

    def snapshot(self) -> ReviewJob:
        return ReviewJob(
            jobId=self.id,
            status=self.status,  # type: ignore[arg-type]
            progress=round(self.progress, 4),
            message=self.message,
            result=self.result,
        )

    @property
    def terminal(self) -> bool:
        return self.status in ("done", "error")


class ReviewService:
    """In-memory review jobs, each analysed by an asyncio task on the ``review`` engine."""

    def __init__(self, engines: EngineManager, openings: Any, *, max_jobs: int = 50, book_max_ply: int = BOOK_MAX_PLY) -> None:
        self._engines = engines
        self._openings = openings
        self._jobs: dict[str, _Job] = {}
        self._max_jobs = max_jobs
        self._book_max_ply = book_max_ply
        # Jobs run one at a time; each position takes the engine lock separately, so short requests
        # on the same engine (the single-move coach) get their turn between two positions.
        self._job_lock = asyncio.Lock()

    # ---------------------------------------------------------------- public API

    def engine_settings(self) -> ReviewEngineHealth:
        """The review engine's own settings, and the most the advanced settings may ask for."""
        defaults = self._engines.options("review")
        threads = int(defaults.get("Threads", 1))
        hash_mb = int(defaults.get("Hash", 16))
        return ReviewEngineHealth(
            threads=threads,
            hashMb=hash_mb,
            maxThreads=max(threads, cpu_threads()),
            maxHashMb=max(hash_mb, max_hash_mb(total_memory_mb())),
        )

    def create(self, req: ReviewRequest) -> str:
        """Validate the request and start the job. Raises ValueError on a bad FEN or move."""
        start = parse_fen(req.startFen) if req.startFen else chess.Board()
        board = start.copy()
        moves: list[chess.Move] = []
        for i, text in enumerate(req.moves, start=1):
            try:
                move = parse_move(board, text)
            except ValueError as exc:
                raise ValueError(f"move {i}: {exc}") from exc
            moves.append(move)
            board.push(move)
        players = req.players.model_dump() if req.players else {}
        limits = self.engine_settings()
        options = {
            "Threads": min(req.threads or limits.threads, limits.maxThreads),
            "Hash": min(req.hashMb or limits.hashMb, limits.maxHashMb),
        }
        job = _Job(
            id=uuid.uuid4().hex[:12],
            start=start,
            moves=moves,
            depth=req.depth,
            players=players,
            options=options,
            max_seconds=req.moveTimeMs / 1000 if req.moveTimeMs else None,
        )
        self._jobs[job.id] = job
        self._evict()
        job.task = asyncio.create_task(self._run(job), name=f"review-{job.id}")
        return job.id

    def get(self, job_id: str) -> _Job | None:
        return self._jobs.get(job_id)

    def snapshot(self, job_id: str) -> ReviewJob | None:
        job = self._jobs.get(job_id)
        return job.snapshot() if job else None

    def subscribe(self, job: _Job) -> asyncio.Queue[ReviewJob]:
        queue: asyncio.Queue[ReviewJob] = asyncio.Queue()
        job.subscribers.add(queue)
        return queue

    def unsubscribe(self, job: _Job, queue: asyncio.Queue[ReviewJob]) -> None:
        job.subscribers.discard(queue)

    def set_explanation(self, job_id: str, ply: int, text: str) -> None:
        job = self._jobs.get(job_id)
        if job and job.result and 1 <= ply <= len(job.result.moves):
            job.result.moves[ply - 1].explanation = text

    async def close(self) -> None:
        tasks = [j.task for j in self._jobs.values() if j.task and not j.task.done()]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    # ---------------------------------------------------------------- internals

    def _evict(self) -> None:
        if len(self._jobs) <= self._max_jobs:
            return
        finished = sorted((j for j in self._jobs.values() if j.terminal), key=lambda j: j.created)
        for job in finished[: len(self._jobs) - self._max_jobs]:
            self._jobs.pop(job.id, None)

    def _publish(self, job: _Job) -> None:
        snap = job.snapshot()
        for queue in list(job.subscribers):
            queue.put_nowait(snap)

    async def _restore_engine(self, job: _Job) -> None:
        """Give the review engine its own settings back: the single-move coach shares it."""
        defaults = self._engines.options("review")
        if all(defaults.get(name) == value for name, value in job.options.items()):
            return
        try:
            async with self._engines.use("review") as engine:
                await engine.configure(defaults)
        except EngineUnavailable:
            pass  # shutting down, or the engine is gone: a fresh one starts with its own settings

    def _book_hits(self, job: _Job) -> list[BookHit | None]:
        store = self._openings
        if store is None:
            return [None] * len(job.moves)
        refresh = getattr(store, "refresh_if_changed", None)
        if callable(refresh):
            refresh()
        return find_book_hits(job.start, job.moves, store.lookup)

    async def _run(self, job: _Job) -> None:
        try:
            job.message = "Waiting for the review engine"
            self._publish(job)
            async with self._job_lock:
                job.status = "running"
                job.message = "Analysing"
                self._publish(job)
                board = job.start.copy()
                positions = [board.copy()]
                for move in job.moves:
                    board.push(move)
                    positions.append(board.copy())
                total = len(positions)
                evals: list[list[EngineLine]] = []
                engine_name = self._engines.engine_name or "Stockfish"
                try:
                    for i, pos in enumerate(positions):
                        async with self._engines.use("review") as engine:
                            # sends only what changed, so after the first position this costs nothing
                            # (and it covers an engine restarted after a crash)
                            await engine.configure(job.options)
                            evals.append(await evaluate_position(engine, pos, job.depth, max_seconds=job.max_seconds))
                            engine_name = engine.name
                        job.progress = min(0.99, (i + 1) / total)
                        job.message = f"Analysed {i + 1}/{total} positions"
                        self._publish(job)
                finally:
                    await self._restore_engine(job)
            job.result = build_review_result(
                job.start,
                job.moves,
                evals,
                depth=job.depth,
                engine=engine_name,
                book=self._book_hits(job),
                book_max_ply=self._book_max_ply,
            )
            job.status = "done"
            job.progress = 1.0
            job.message = None
        except asyncio.CancelledError:
            job.status = "error"
            job.message = "Review cancelled (server shutting down)"
            raise
        except EngineUnavailable as exc:
            job.status = "error"
            job.message = str(exc)
        except Exception as exc:  # noqa: BLE001 - reported to the client
            log.exception("review job %s failed", job.id)
            job.status = "error"
            job.message = f"{type(exc).__name__}: {exc}"
        finally:
            self._publish(job)
