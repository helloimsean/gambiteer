"""Single-move coach: a Stockfish verdict for one move outside a game review (Learn tab practice).

``analyse_move`` evaluates the position before the move (MultiPV 2, needed for "great") and the
position after it on the ``review`` engine, then reuses the review pipeline's pure functions
(``build_review_result`` -> ``classify``) so the labels follow exactly the same rules as a game
review. Differences from a review:

* "book" means the move is one of ``context.bookMoves`` (matched by SAN or UCI), at any ply;
* "miss" never happens (there is no previous move to compare with);
* for an off-book move by the student, the position after the first repertoire move is evaluated
  too (only when an explanation is wanted), so the coach can compare the move with the repertoire
  move instead of only with the engine's best.

The engine lock is taken once per request, so a coach request waits for its turn while a review job
analyses a position (review jobs take the lock per position, see ``ReviewService``).
"""
from __future__ import annotations

from dataclasses import dataclass

import chess

from .chessutil import clean_san, color_name, parse_book_move, parse_fen, parse_move
from .engine import EngineManager, EngineProxy
from .review import BookHit, build_review_result, evaluate_position
from .schemas import BookMoveNote, CoachContext, CoachMove, CoachRequest, EngineLine

NO_BOOK_PLY_LIMIT = 10**6  # context.bookMoves decides "book", whatever the ply


class CoachInputError(ValueError):
    """Bad FEN or illegal move in a coach request (HTTP 400 / WS error stage "analysis")."""


@dataclass(frozen=True)
class PreparedMove:
    board: chess.Board  # position before the move
    move: chess.Move
    book_index: int | None  # index into context.bookMoves of the played move, if any
    book_moves: list[chess.Move | None]  # parsed context.bookMoves (None when not legal here)


@dataclass(frozen=True)
class CoachAnalysis:
    move: CoachMove
    # White-POV score after the first repertoire move (only for off-book student moves when an
    # explanation is wanted), so the prompt can compare the played move with the repertoire move.
    book_eval: dict[str, int] | None = None


def prepare(req: CoachRequest) -> PreparedMove:
    """Parse the request's FEN and move and match the move against ``context.bookMoves``."""
    try:
        board = parse_fen(req.fen)
    except ValueError as exc:
        raise CoachInputError(str(exc)) from exc
    try:
        move = parse_move(board, req.uci)
    except ValueError as exc:
        raise CoachInputError(str(exc)) from exc
    notes = req.context.bookMoves if req.context else []
    parsed = [parse_book_move(board, note.san, note.uci) for note in notes]
    played_san = clean_san(board.san(move))
    book_index = None
    for i, (note, parsed_move) in enumerate(zip(notes, parsed)):
        if parsed_move == move or (parsed_move is None and clean_san(note.san) == played_san):
            book_index = i
            break
    return PreparedMove(board=board, move=move, book_index=book_index, book_moves=parsed)


def student_color(context: CoachContext | None, mover: chess.Color) -> chess.Color:
    """The side the student plays (the mover when the context does not say)."""
    if context is None or context.studentSide is None:
        return mover
    return chess.WHITE if context.studentSide == "white" else chess.BLACK


def build_coach_move(
    prepared: PreparedMove,
    before_lines: list[EngineLine],
    after_lines: list[EngineLine],
    context: CoachContext | None,
    *,
    engine_name: str = "Stockfish",
    depth: int = 0,
) -> CoachMove:
    """Pure: the CoachMove from the engine lines before (best first) and after the move."""
    board, move = prepared.board, prepared.move
    notes = context.bookMoves if context else []
    hit = None
    if prepared.book_index is not None:
        note = notes[prepared.book_index]
        hit = BookHit(why=note.why, opening_id="", opening_name=(context.openingName if context else "") or "")
    result = build_review_result(
        board,
        [move],
        [before_lines, after_lines],
        depth=depth,
        engine=engine_name,
        book=[hit],
        book_max_ply=NO_BOOK_PLY_LIMIT,
    )
    rm = result.moves[0]
    book_move: BookMoveNote | None = None
    if hit is None and notes:
        first = notes[0]
        parsed = prepared.book_moves[0] if prepared.book_moves else None
        if parsed is not None:
            book_move = BookMoveNote(san=board.san(parsed), why=first.why, uci=parsed.uci())
        else:
            book_move = BookMoveNote(san=first.san, why=first.why, uci=first.uci)
    return CoachMove(
        san=rm.san,
        uci=rm.uci,
        fenBefore=rm.fenBefore,
        fenAfter=rm.fenAfter,
        color=color_name(board.turn),  # type: ignore[arg-type]
        evalBefore=rm.evalBefore,
        evalAfter=rm.evalAfter,
        bestMove=rm.bestMove,
        playedPv=rm.playedPv,
        winPctBefore=rm.winPctBefore,
        winPctAfter=rm.winPctAfter,
        cpLoss=rm.cpLoss,
        classification=rm.classification,
        inBook=hit is not None,
        bookMove=book_move,
    )


def _book_eval_from_lines(book: chess.Move, before_lines: list[EngineLine]) -> dict[str, int] | None:
    for line in before_lines:
        if line.pvUci and line.pvUci[0] == book.uci():
            return line.score.model_dump()
    return None


async def analyse_move(
    engines: EngineManager,
    req: CoachRequest,
    prepared: PreparedMove | None = None,
) -> CoachAnalysis:
    """Engine verdict for one move (raises CoachInputError, EngineUnavailable)."""
    prepared = prepared or prepare(req)
    board, move = prepared.board, prepared.move
    after = board.copy(stack=False)
    after.push(move)
    mover = board.turn
    is_student = student_color(req.context, mover) == mover
    book_target = prepared.book_moves[0] if prepared.book_moves else None
    want_book_eval = req.explain and is_student and prepared.book_index is None and book_target is not None

    async with engines.use("review") as engine:
        before_lines = await evaluate_position(engine, board, req.depth, multipv=2)
        after_lines = await evaluate_position(engine, after, req.depth, multipv=1)
        book_eval: dict[str, int] | None = None
        if want_book_eval and book_target is not None:
            book_eval = _book_eval_from_lines(book_target, before_lines)
            if book_eval is None:
                book_eval = await _eval_after(engine, board, book_target, req.depth)
        name = engine.name

    coach_move = build_coach_move(prepared, before_lines, after_lines, req.context, engine_name=name, depth=req.depth)
    return CoachAnalysis(move=coach_move, book_eval=book_eval)


async def _eval_after(engine: EngineProxy, board: chess.Board, move: chess.Move, depth: int) -> dict[str, int]:
    pos = board.copy(stack=False)
    pos.push(move)
    lines = await evaluate_position(engine, pos, depth, multipv=1)
    return lines[0].score.model_dump()

